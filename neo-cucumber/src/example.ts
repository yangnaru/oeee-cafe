import {
  mount as mountPainter,
  type CanonicalPainterOperation,
  type LocalPainterOperation,
} from "./public";
import { mount as mountViewer, type MountedViewer } from "./viewer/embed";
import "./viewer/viewer.css";

const painterElement = document.getElementById("painter")!;
const viewerElement = document.getElementById("viewer")!;
const statusElement = document.getElementById("status")!;
const openInput = document.getElementById("open") as HTMLInputElement;
const identityElement = document.getElementById("identity")!;
const peerLink = document.getElementById("peer") as HTMLAnchorElement;

const params = new URLSearchParams(location.search);
const room = params.get("room") || "default";
const actorId = crypto.randomUUID();
const channelName = `neo-cucumber-example:${room}`;
const historyKey = `${channelName}:history`;
const lockName = `${channelName}:sequencer`;
const channel = new BroadcastChannel(channelName);

identityElement.textContent = `room: ${room} · actor: ${actorId.slice(0, 8)}`;
peerLink.href = `${location.pathname}?room=${encodeURIComponent(room)}`;

type ChannelMessage =
  | { type: "canonical"; entry: CanonicalPainterOperation }
  | { type: "reset" };

function readHistory(): CanonicalPainterOperation[] {
  const stored = localStorage.getItem(historyKey);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let nextSequence = 1;
let applicationChain = Promise.resolve();
const pending = new Map<number, CanonicalPainterOperation>();

function drainCanonical(): void {
  const entry = pending.get(nextSequence);
  if (!entry) return;
  pending.delete(nextSequence);
  nextSequence += 1;
  applicationChain = applicationChain
    .then(() => painter.applyCanonicalOperation(entry))
    .then(drainCanonical)
    .catch((error) => {
      statusElement.textContent = String(error);
    });
}

function receiveCanonical(entry: CanonicalPainterOperation): void {
  if (entry.sequence < nextSequence) return;
  pending.set(entry.sequence, entry);
  drainCanonical();
}

async function publish(operation: LocalPainterOperation): Promise<void> {
  if (!navigator.locks) {
    throw new Error("This collaborative example requires the Web Locks API");
  }
  await navigator.locks.request(lockName, async () => {
    const history = readHistory();
    const sequence = (history.at(-1)?.sequence ?? 0) + 1;
    const entry: CanonicalPainterOperation = { ...operation, sequence };
    history.push(entry);
    localStorage.setItem(historyKey, JSON.stringify(history));
    receiveCanonical(entry);
    channel.postMessage({ type: "canonical", entry } satisfies ChannelMessage);
  });
}

const painter = mountPainter(painterElement, {
  width: 300,
  height: 300,
  locale: "en",
  mode: { kind: "standard" },
  controls: { kind: "toolbox" },
  synchronization: {
    actorId,
    onOperation: (operation) => {
      void publish(operation).catch((error) => {
        statusElement.textContent = String(error);
      });
    },
  },
});

channel.addEventListener("message", (event: MessageEvent<ChannelMessage>) => {
  if (event.data.type === "reset") {
    location.reload();
  } else {
    receiveCanonical(event.data.entry);
  }
});

let viewer: MountedViewer | null = null;
let replayUrl: string | null = null;

function clearViewer(): void {
  viewer?.dispose();
  viewer = null;
  if (replayUrl) URL.revokeObjectURL(replayUrl);
  replayUrl = null;
}

async function showReplay(blob: Blob, width: number, height: number): Promise<void> {
  clearViewer();
  replayUrl = URL.createObjectURL(blob);
  viewer = mountViewer(viewerElement, { replay: replayUrl, width, height });
  statusElement.textContent = `${width}×${height}, ${blob.size.toLocaleString()} bytes`;
}

document.getElementById("replay")!.addEventListener("click", () => {
  void painter.save().then(({ replay, width, height }) =>
    showReplay(replay, width, height),
  );
});

document.getElementById("download")!.addEventListener("click", () => {
  void painter.exportReplay().then((replay) => {
    const url = URL.createObjectURL(replay);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "example.pch";
    anchor.click();
    URL.revokeObjectURL(url);
  });
});

document.getElementById("reset")!.addEventListener("click", () => {
  void navigator.locks.request(lockName, () => {
    localStorage.removeItem(historyKey);
    channel.postMessage({ type: "reset" } satisfies ChannelMessage);
    setTimeout(() => location.reload(), 20);
  });
});

openInput.addEventListener("change", () => {
  const file = openInput.files?.[0];
  if (!file) return;
  void file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 12 || new TextDecoder().decode(bytes.slice(0, 4)) !== "NEO ") {
      throw new Error("Not a NEO replay");
    }
    return showReplay(file, bytes[4] | (bytes[5] << 8), bytes[6] | (bytes[7] << 8));
  }).catch((error) => {
    statusElement.textContent = String(error);
  });
});

void painter.ready.then(async () => {
  painter.setInteractionEnabled(false);
  if (!navigator.locks) throw new Error("This collaborative example requires the Web Locks API");
  await navigator.locks.request(lockName, async () => {
    const history = readHistory();
    for (const entry of history) receiveCanonical(entry);
    await applicationChain;
  });
  painter.setInteractionEnabled(true);
  statusElement.textContent = `Synchronized through operation ${nextSequence - 1}`;
}).catch((error) => {
  statusElement.textContent = String(error);
});

window.addEventListener("beforeunload", () => {
  clearViewer();
  channel.close();
  painter.unmount();
});
