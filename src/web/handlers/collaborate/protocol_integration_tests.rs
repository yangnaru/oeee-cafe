use std::process::{Child, Command, Stdio};
use std::time::Duration;

use axum::extract::ws::Message as AxumMessage;
use bb8_redis::{bb8::Pool, RedisConnectionManager};
use futures_util::{SinkExt, StreamExt};
use redis::AsyncCommands;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_tungstenite::{accept_async, connect_async, tungstenite::Message};
use uuid::Uuid;

use super::redis_messages::RedisMessageStore;
use super::redis_state::{RedisStateManager, RoomBroadcast};
use super::websocket::{valid_reset_payloads, wrap_sequenced};
use crate::redis::RedisPool;

const SEQUENCED: u8 = 0x0a;
const CAUGHT_UP: u8 = 0x0f;

struct RedisProcess(Option<Child>);

impl Drop for RedisProcess {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct Harness {
    _redis: RedisProcess,
    server: JoinHandle<()>,
    url: String,
    pool: RedisPool,
    room: Uuid,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Position {
    history_id: Uuid,
    sequence: u64,
    payload: Vec<u8>,
}

fn unused_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("bind ephemeral port")
        .local_addr()
        .expect("ephemeral address")
        .port()
}

async fn start_redis() -> (RedisProcess, String) {
    if let Ok(url) = std::env::var("OEEE_TEST_REDIS_URL") {
        wait_for_redis(&url).await;
        return (RedisProcess(None), url);
    }
    let port = unused_port();
    let child = Command::new("redis-server")
        .args([
            "--bind",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--save",
            "",
            "--appendonly",
            "no",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("redis-server must be installed for collaboration protocol tests");
    let redis = RedisProcess(Some(child));
    let url = format!("redis://127.0.0.1:{port}/");
    wait_for_redis(&url).await;
    (redis, url)
}

async fn wait_for_redis(url: &str) {
    let client = redis::Client::open(url).expect("valid Redis URL");
    for _ in 0..100 {
        if client.get_multiplexed_async_connection().await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("collaboration test Redis did not become ready at {url}");
}

async fn redis_pool(url: &str) -> RedisPool {
    let manager = RedisConnectionManager::new(url).expect("Redis manager");
    Pool::builder().build(manager).await.expect("Redis pool")
}

fn room_message(payload: Vec<u8>) -> RoomBroadcast {
    RoomBroadcast {
        from_connection: Uuid::new_v4().to_string(),
        target_connection: None,
        seq: None,
        history_id: None,
        payload,
    }
}

async fn serve_connection(stream: TcpStream, pool: RedisPool, redis_url: String, room: Uuid) {
    let socket = accept_async(stream).await.expect("WebSocket handshake");
    let (mut sink, mut source) = socket.split();
    let channel = format!("oeee:pubsub:{room}");
    let client = redis::Client::open(redis_url).expect("Redis client");
    let mut subscriber = client.get_async_pubsub().await.expect("Redis PubSub");
    subscriber
        .subscribe(&channel)
        .await
        .expect("subscribe room");

    // Subscribe before taking the snapshot. The live feed may overlap replay,
    // and the client can deduplicate that overlap by canonical position.
    let store = RedisMessageStore::new(pool.clone());
    let (replay_history_id, history) = store
        .get_history_snapshot(room)
        .await
        .expect("history snapshot");
    let mut last_sequence = 0;
    for (sequence, message) in history {
        if let AxumMessage::Binary(payload) = message {
            sink.send(Message::Binary(
                wrap_sequenced(replay_history_id, sequence, &payload).into(),
            ))
            .await
            .expect("send replay");
            last_sequence = sequence;
        }
    }
    let mut caught_up = vec![CAUGHT_UP];
    caught_up.extend_from_slice(replay_history_id.as_bytes());
    caught_up.extend_from_slice(&last_sequence.to_le_bytes());
    sink.send(Message::Binary(caught_up.into()))
        .await
        .expect("send caught-up marker");

    let outgoing = tokio::spawn(async move {
        let mut messages = subscriber.on_message();
        while let Some(message) = messages.next().await {
            let framed: Vec<u8> = message.get_payload().expect("PubSub frame");
            let envelope = RoomBroadcast::decode(&framed).expect("room envelope");
            if let (Some(history_id), Some(sequence)) = (envelope.history_id, envelope.seq) {
                if history_id == replay_history_id && sequence <= last_sequence {
                    continue;
                }
                if sink
                    .send(Message::Binary(
                        wrap_sequenced(history_id, sequence, &envelope.payload).into(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    });

    while let Some(Ok(Message::Binary(payload))) = source.next().await {
        let envelope = room_message(payload.to_vec());
        store
            .sequence_and_publish(room, &payload, &envelope.from_connection, &channel)
            .await
            .expect("sequence client operation");
    }
    outgoing.abort();
}

async fn start_harness() -> Harness {
    let (redis, redis_url) = start_redis().await;
    let pool = redis_pool(&redis_url).await;
    let room = Uuid::new_v4();
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("WebSocket listener");
    let address = listener.local_addr().expect("listener address");
    let server_pool = pool.clone();
    let server = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_connection(
                stream,
                server_pool.clone(),
                redis_url.clone(),
                room,
            ));
        }
    });
    Harness {
        _redis: redis,
        server,
        url: format!("ws://{address}"),
        pool,
        room,
    }
}

fn decode_position(message: Message) -> Position {
    let Message::Binary(bytes) = message else {
        panic!("expected binary WebSocket message")
    };
    assert_eq!(bytes[0], SEQUENCED);
    Position {
        history_id: Uuid::from_slice(&bytes[1..17]).expect("history UUID"),
        sequence: u64::from_le_bytes(bytes[17..25].try_into().expect("sequence")),
        payload: bytes[25..].to_vec(),
    }
}

async fn caught_up<S>(socket: &mut S) -> (Uuid, u64)
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let message = socket
            .next()
            .await
            .expect("socket remains open")
            .expect("WebSocket message");
        let Message::Binary(bytes) = message else {
            continue;
        };
        if bytes.first() == Some(&CAUGHT_UP) {
            return (
                Uuid::from_slice(&bytes[1..17]).expect("history UUID"),
                u64::from_le_bytes(bytes[17..25].try_into().expect("last sequence")),
            );
        }
    }
}

async fn replay_through_caught_up<S>(socket: &mut S) -> (Vec<Position>, Uuid, u64)
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let mut replay = Vec::new();
    loop {
        let message = socket
            .next()
            .await
            .expect("socket remains open")
            .expect("WebSocket message");
        let Message::Binary(bytes) = &message else {
            continue;
        };
        if bytes.first() == Some(&CAUGHT_UP) {
            return (
                replay,
                Uuid::from_slice(&bytes[1..17]).expect("history UUID"),
                u64::from_le_bytes(bytes[17..25].try_into().expect("last sequence")),
            );
        }
        replay.push(decode_position(message));
    }
}

#[tokio::test]
async fn multiple_clients_share_one_canonical_order_and_late_join_replay() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let harness = start_harness().await;
        let (mut alice, _) = connect_async(&harness.url).await.expect("Alice connects");
        let (mut bob, _) = connect_async(&harness.url).await.expect("Bob connects");
        let alice_start = caught_up(&mut alice).await;
        let bob_start = caught_up(&mut bob).await;
        assert_eq!(alice_start, bob_start);
        assert_eq!(alice_start.1, 0);

        alice
            .send(Message::Binary(vec![0x12, 1, 0xaa].into()))
            .await
            .expect("Alice draws");
        bob.send(Message::Binary(vec![0x12, 2, 0xbb].into()))
            .await
            .expect("Bob draws");

        let mut alice_history = Vec::new();
        let mut bob_history = Vec::new();
        for _ in 0..2 {
            alice_history.push(decode_position(
                alice
                    .next()
                    .await
                    .unwrap()
                    .expect("Alice receives operation"),
            ));
            bob_history.push(decode_position(
                bob.next().await.unwrap().expect("Bob receives operation"),
            ));
        }
        assert_eq!(alice_history, bob_history);
        assert_eq!(
            alice_history
                .iter()
                .map(|entry| entry.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(alice_history
            .iter()
            .all(|entry| entry.history_id == alice_start.0));

        let (mut late_joiner, _) = connect_async(&harness.url)
            .await
            .expect("late joiner connects");
        let replay = vec![
            decode_position(late_joiner.next().await.unwrap().unwrap()),
            decode_position(late_joiner.next().await.unwrap().unwrap()),
        ];
        assert_eq!(replay, alice_history);
        assert_eq!(caught_up(&mut late_joiner).await, (alice_start.0, 2));
    })
    .await
    .expect("collaboration protocol scenario timed out");
}

/// A flood fill, which travels as a rectangle of compressed coverage rather
/// than as a seed point, and is by far the largest thing we put on the wire.
///
/// What this reaches is the store: real sequencing, real history, real
/// late-join replay. It does not reach the connection loop -- `serve_connection`
/// above is the harness's own, so who gets an echo is settled by the unit tests
/// in `websocket.rs` and not here.
///
/// So the claim is a narrow one, and it is about size. Every other test in this
/// file sequences three bytes. A fill is kilobytes, and nothing until now has
/// pushed one through Redis storage and got it back byte for byte, in order,
/// with a mark on each side of it.
#[tokio::test]
async fn a_fill_sized_payload_survives_sequencing_and_replay_intact() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let harness = start_harness().await;
        let (mut alice, _) = connect_async(&harness.url).await.expect("Alice connects");
        let start = caught_up(&mut alice).await;

        // [0x1d][author][target][layer][x:2][y:2][w:2][h:2][rgba:4][len:4][coverage]
        let mut fill = vec![0x1d, 1, 7, 0];
        fill.extend_from_slice(&5u16.to_le_bytes());
        fill.extend_from_slice(&6u16.to_le_bytes());
        fill.extend_from_slice(&600u16.to_le_bytes());
        fill.extend_from_slice(&800u16.to_le_bytes());
        fill.extend_from_slice(&[200, 100, 50, 255]);
        // A coverage mask the size a full-canvas fill deflates to, and not a
        // run of one byte: Redis is told this is binary, and a payload that
        // happens to be uniform would not notice if it were not.
        let coverage: Vec<u8> = (0..16_384u32)
            .map(|index| (index.wrapping_mul(2_654_435_761) >> 24) as u8)
            .collect();
        fill.extend_from_slice(&(coverage.len() as u32).to_le_bytes());
        fill.extend_from_slice(&coverage);

        let before = vec![0x16, 1, 0xaa];
        let after = vec![0x16, 1, 0xbb];
        for payload in [&before, &fill, &after] {
            alice
                .send(Message::Binary(payload.clone().into()))
                .await
                .expect("Alice draws");
        }

        let live: Vec<Position> = {
            let mut seen = Vec::new();
            for _ in 0..3 {
                seen.push(decode_position(alice.next().await.unwrap().expect("mark")));
            }
            seen
        };
        assert_eq!(
            live.iter().map(|entry| entry.sequence).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "the fill did not take an ordinary place in the order"
        );
        // Compared by hand rather than with `assert_eq!`: these are kilobytes,
        // and a failure that prints both of them in full is a failure nobody
        // reads. Length first, because truncation is the likely way to fail.
        assert_eq!(
            live[1].payload.len(),
            fill.len(),
            "the fill came back a different size"
        );
        let differs = live[1]
            .payload
            .iter()
            .zip(&fill)
            .position(|(got, want)| got != want);
        assert!(
            differs.is_none(),
            "the fill was corrupted in storage, first at byte {:?}",
            differs
        );

        // And the same again for someone arriving afterwards, who gets it out
        // of history rather than off the wire.
        let (mut late, _) = connect_async(&harness.url)
            .await
            .expect("late joiner connects");
        let replayed: Vec<Position> = {
            let mut seen = Vec::new();
            for _ in 0..3 {
                seen.push(decode_position(late.next().await.unwrap().expect("replay")));
            }
            seen
        };
        assert!(replayed == live, "replay did not match what was broadcast");
        assert_eq!(caught_up(&mut late).await, (start.0, 3));
    })
    .await
    .expect("collaboration protocol scenario timed out");
}

#[tokio::test]
async fn reconnect_replays_missed_operations_once_and_reports_exact_position() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let harness = start_harness().await;
        let (mut client, _) = connect_async(&harness.url).await.expect("client connects");
        let initial = caught_up(&mut client).await;

        client
            .send(Message::Binary(vec![0x12, 1, 0x11].into()))
            .await
            .expect("first operation");
        assert_eq!(
            decode_position(client.next().await.unwrap().unwrap()).sequence,
            1
        );
        client.close(None).await.expect("disconnect client");

        let store = RedisMessageStore::new(harness.pool.clone());
        let channel = format!("oeee:pubsub:{}", harness.room);
        let payload = vec![0x12, 2, 0x22];
        let envelope = room_message(payload.clone());
        store
            .sequence_and_publish(harness.room, &payload, &envelope.from_connection, &channel)
            .await
            .expect("operation while disconnected");

        let (mut reconnected, _) = connect_async(&harness.url)
            .await
            .expect("client reconnects");
        let (replay, history_id, last_sequence) = replay_through_caught_up(&mut reconnected).await;
        assert_eq!(history_id, initial.0);
        assert_eq!(last_sequence, 2);
        assert_eq!(
            replay
                .iter()
                .map(|entry| entry.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(replay[1].payload, payload);

        // No replay entry is delivered again through the overlapping PubSub
        // subscription after CAUGHT_UP.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), reconnected.next())
                .await
                .is_err()
        );
    })
    .await
    .expect("reconnect scenario timed out");
}

#[tokio::test]
async fn recent_chat_is_bounded_and_removed_with_the_room() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let harness = start_harness().await;
        let store = RedisMessageStore::new(harness.pool.clone());
        for index in 0..105u8 {
            store
                .append_chat_message(harness.room, &[0x03, index])
                .await
                .expect("append recent chat");
        }

        let chat = store.get_recent_chat(harness.room).await.expect("recent chat");
        assert_eq!(chat.len(), 100);
        assert_eq!(chat.first(), Some(&vec![0x03, 5]));
        assert_eq!(chat.last(), Some(&vec![0x03, 104]));

        store.cleanup_room(harness.room).await.expect("cleanup room");
        assert!(store.get_recent_chat(harness.room).await.unwrap().is_empty());
    })
    .await
    .expect("recent chat scenario timed out");
}

#[tokio::test]
async fn checkpoint_compaction_keeps_operations_that_race_after_its_base() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let harness = start_harness().await;
        let store = RedisMessageStore::new(harness.pool.clone());
        let channel = format!("oeee:pubsub:{}", harness.room);

        for marker in [0x11, 0x22] {
            let payload = vec![0x12, 1, marker];
            let envelope = room_message(payload.clone());
            store
                .sequence_and_publish(harness.room, &payload, &envelope.from_connection, &channel)
                .await
                .expect("seed canonical operation");
        }

        let snapshots = [vec![0x02, 1, 1, 0xaa], vec![0x02, 1, 0, 0xbb]];
        let newer_payload = vec![0x12, 2, 0x33];
        let newer_envelope = room_message(newer_payload.clone());
        let publish_newer = store.sequence_and_publish(
            harness.room,
            &newer_payload,
            &newer_envelope.from_connection,
            &channel,
        );
        let apply_checkpoint = store.apply_reset(harness.room, 2, &snapshots);
        let (published, compacted) = tokio::join!(publish_newer, apply_checkpoint);
        assert_eq!(published.expect("newer operation sequenced"), 3);
        compacted.expect("checkpoint applied");

        let (mut late_joiner, _) = connect_async(&harness.url)
            .await
            .expect("late joiner connects");
        let (replay, _, last_sequence) = replay_through_caught_up(&mut late_joiner).await;
        assert_eq!(last_sequence, 3);
        assert_eq!(
            replay
                .iter()
                .map(|entry| entry.sequence)
                .collect::<Vec<_>>(),
            vec![2, 2, 3]
        );
        assert_eq!(replay[0].payload, snapshots[0]);
        assert_eq!(replay[1].payload, snapshots[1]);
        assert_eq!(replay[2].payload, newer_payload);
    })
    .await
    .expect("checkpoint race scenario timed out");
}

#[tokio::test]
async fn future_checkpoint_is_rejected_without_mutating_history() {
    let harness = start_harness().await;
    let store = RedisMessageStore::new(harness.pool.clone());
    let channel = format!("oeee:pubsub:{}", harness.room);
    let payload = vec![0x12, 1, 0x11];
    let envelope = room_message(payload.clone());
    store
        .sequence_and_publish(harness.room, &payload, &envelope.from_connection, &channel)
        .await
        .expect("seed operation");

    let snapshots = [vec![0x02, 1, 1], vec![0x02, 1, 0]];
    assert!(store
        .apply_reset(harness.room, 99, &snapshots)
        .await
        .is_err());
    let (_, history) = store
        .get_history_snapshot(harness.room)
        .await
        .expect("history remains readable");
    assert_eq!(history.len(), 1);
    assert!(matches!(&history[0], (1, AxumMessage::Binary(bytes)) if bytes == &payload));
}

#[tokio::test]
async fn replacing_history_changes_identity_instead_of_reusing_sequence_space() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let harness = start_harness().await;
        let (mut observer, _) = connect_async(&harness.url)
            .await
            .expect("observer connects");
        let old_position = caught_up(&mut observer).await;

        let store = RedisMessageStore::new(harness.pool.clone());
        store
            .cleanup_room(harness.room)
            .await
            .expect("replace history");
        let channel = format!("oeee:pubsub:{}", harness.room);
        let payload = vec![0x12, 1, 0x44];
        let envelope = room_message(payload.clone());
        store
            .sequence_and_publish(harness.room, &payload, &envelope.from_connection, &channel)
            .await
            .expect("first operation in replacement history");

        let replacement = decode_position(observer.next().await.unwrap().unwrap());
        assert_eq!(replacement.sequence, 1);
        assert_ne!(replacement.history_id, old_position.0);

        let (mut late_joiner, _) = connect_async(&harness.url)
            .await
            .expect("late joiner connects to replacement history");
        let (replay, history_id, last_sequence) = replay_through_caught_up(&mut late_joiner).await;
        assert_eq!(history_id, replacement.history_id);
        assert_eq!(last_sequence, 1);
        assert_eq!(replay, vec![replacement]);
    })
    .await
    .expect("history replacement scenario timed out");
}

#[tokio::test]
async fn concurrent_clients_receive_the_same_contiguous_high_contention_history() {
    tokio::time::timeout(Duration::from_secs(15), async {
        const CLIENTS: usize = 4;
        const OPERATIONS_PER_CLIENT: usize = 25;
        let harness = start_harness().await;
        let mut clients = Vec::new();
        for _ in 0..CLIENTS {
            let (mut client, _) = connect_async(&harness.url).await.expect("client connects");
            assert_eq!(caught_up(&mut client).await.1, 0);
            clients.push(client);
        }

        futures_util::future::join_all(clients.iter_mut().enumerate().map(
            |(client_index, client)| async move {
                for operation_index in 0..OPERATIONS_PER_CLIENT {
                    client
                        .send(Message::Binary(
                            vec![0x12, client_index as u8, operation_index as u8].into(),
                        ))
                        .await
                        .expect("publish concurrent operation");
                }
            },
        ))
        .await;

        let expected_count = CLIENTS * OPERATIONS_PER_CLIENT;
        let mut observed_histories = Vec::new();
        for client in &mut clients {
            let mut history = Vec::with_capacity(expected_count);
            for _ in 0..expected_count {
                history.push(decode_position(client.next().await.unwrap().unwrap()));
            }
            observed_histories.push(history);
        }

        for history in &observed_histories[1..] {
            assert_eq!(history, &observed_histories[0]);
        }
        assert_eq!(
            observed_histories[0]
                .iter()
                .map(|entry| entry.sequence)
                .collect::<Vec<_>>(),
            (1..=expected_count as u64).collect::<Vec<_>>()
        );
        let history_id = observed_histories[0][0].history_id;
        assert!(observed_histories[0]
            .iter()
            .all(|entry| entry.history_id == history_id));
    })
    .await
    .expect("high-contention collaboration scenario timed out");
}

#[tokio::test]
async fn reset_upload_authority_is_bound_to_one_selected_connection() {
    let (redis, redis_url) = start_redis().await;
    let pool = redis_pool(&redis_url).await;
    let state = RedisStateManager::new(pool);
    let room = Uuid::new_v4();
    let _redis = redis;

    assert!(state
        .try_acquire_reset_pending(room)
        .await
        .expect("acquire reset lease"));
    assert!(!state
        .is_reset_uploader(room, "alice")
        .await
        .expect("unassigned lease"));
    state
        .assign_reset_uploader(room, "alice")
        .await
        .expect("select uploader");
    assert!(state
        .is_reset_uploader(room, "alice")
        .await
        .expect("selected uploader"));
    assert!(!state
        .is_reset_uploader(room, "bob")
        .await
        .expect("different connection"));
    state
        .clear_reset_pending(room)
        .await
        .expect("clear reset lease");
    assert!(!state
        .is_reset_uploader(room, "alice")
        .await
        .expect("expired authority"));
}

#[test]
fn reset_checkpoint_requires_one_snapshot_for_each_layer_of_each_participant() {
    // [type][author][target owner][layer]. One connection uploads the whole
    // canvas, so the author byte is the same throughout and the owner byte is
    // what makes each pair a different participant's.
    assert!(valid_reset_payloads(&[
        vec![0x02, 1, 1, 1, 0xaa],
        vec![0x02, 1, 1, 0, 0xbb],
    ]));
    // Two participants, both pairs complete
    assert!(valid_reset_payloads(&[
        vec![0x02, 1, 1, 1, 0xaa],
        vec![0x02, 1, 1, 0, 0xbb],
        vec![0x02, 1, 7, 1, 0xcc],
        vec![0x02, 1, 7, 0, 0xdd],
    ]));
    // A participant with only one of their two layers
    assert!(!valid_reset_payloads(&[
        vec![0x02, 1, 1, 1, 0xaa],
        vec![0x02, 1, 1, 0, 0xbb],
        vec![0x02, 1, 7, 1, 0xcc],
        vec![0x02, 1, 7, 1, 0xdd],
    ]));
    assert!(!valid_reset_payloads(&[]));
    assert!(!valid_reset_payloads(&[vec![0x02, 1, 1, 1]]));
    // The same layer twice for one participant
    assert!(!valid_reset_payloads(&[
        vec![0x02, 1, 1, 1],
        vec![0x02, 1, 1, 1],
    ]));
    // Not a snapshot
    assert!(!valid_reset_payloads(&[
        vec![0x02, 1, 1, 0],
        vec![0x12, 1, 1, 1],
    ]));
    // Not a layer
    assert!(!valid_reset_payloads(&[
        vec![0x02, 1, 1, 0],
        vec![0x02, 1, 1, 2],
    ]));
}

#[tokio::test]
async fn touching_live_history_refreshes_every_canonical_key_lifetime() {
    let (redis, redis_url) = start_redis().await;
    let pool = redis_pool(&redis_url).await;
    let store = RedisMessageStore::new(pool.clone());
    let room = Uuid::new_v4();
    let _redis = redis;
    let channel = format!("oeee:pubsub:{room}");
    let payload = vec![0x12, 1, 0x11];
    let envelope = room_message(payload.clone());
    store
        .sequence_and_publish(room, &payload, &envelope.from_connection, &channel)
        .await
        .expect("seed live history");

    let keys = [
        format!("oeee:msg_history:v4:{room}"),
        format!("oeee:msg_seq:v4:{room}"),
        format!("oeee:msg_history_id:v4:{room}"),
    ];
    let mut connection = pool.get().await.expect("Redis connection");
    for key in &keys {
        connection
            .expire::<_, ()>(key, 1)
            .await
            .expect("shorten test TTL");
    }
    store
        .touch_history(room)
        .await
        .expect("refresh live history");
    for key in &keys {
        let ttl: i64 = connection.ttl(key).await.expect("read refreshed TTL");
        assert!(ttl > 3500, "{key} was only refreshed to {ttl} seconds");
    }
}
