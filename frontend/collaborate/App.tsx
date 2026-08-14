import { useCallback, useEffect, useRef, useState } from "react";
import {
  mount,
  type CanonicalPainterOperation,
  type LocalPainterOperation,
  type PainterCheckpoint,
  type PainterHandle,
} from "neo-cucumber";
import "neo-cucumber/style.css";
import "./app.css";
import { Chat } from "./components/Chat";
import { SessionExpiredModal } from "./components/SessionExpiredModal";
import { SessionHeader } from "./components/SessionHeader";
import { AuthErrorModal } from "./components/modals/AuthErrorModal";
import { ConnectionStatusModal } from "./components/modals/ConnectionStatusModal";
import { InitializationErrorModal } from "./components/modals/InitializationErrorModal";
import { LoadingModal } from "./components/modals/LoadingModal";
import { RoomFullModal } from "./components/modals/RoomFullModal";
import { SessionEndingModal } from "./components/modals/SessionEndingModal";
import {
  decodePainterOperation,
  encodeEndSession,
  encodePainterOperation,
  encodeResetBegin,
  encodeSnapshot,
  type DecodedMessage,
} from "./binaryProtocol";
import { useWebSocket, type ConnectionState } from "./hooks/useWebSocket";
import type { CollaborationMeta, Participant } from "./types";

const getSessionId = (): string => {
  const id = window.location.pathname.split("/")[2];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? "")) {
    throw new Error("Invalid session ID in URL");
  }
  return id;
};

const bytesId = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

const blankLayer = (width: number, height: number): Promise<Blob> => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not create blank layer")), "image/png"),
  );
};

export default function App() {
  const [canvasMeta, setCanvasMeta] = useState<CollaborationMeta | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Map<string, Participant>>(new Map());
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [isCatchingUp, setIsCatchingUp] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [roomFullError, setRoomFullError] = useState<{ currentUserCount: number; maxUsers: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  const painterElementRef = useRef<HTMLDivElement>(null);
  const painterRef = useRef<PainterHandle | null>(null);
  const userIdRef = useRef("");
  const userLoginNameRef = useRef("");
  const localUserJoinTimeRef = useRef(0);
  const localIdRef = useRef<number | null>(null);
  const lastSeqRef = useRef(0);
  const participantsRef = useRef(participants);
  const shouldConnectRef = useRef(false);
  const catchupTimeoutRef = useRef<number | null>(null);
  const processingMessageRef = useRef(false);
  const isCatchingUpRef = useRef(true);
  const pendingIdsRef = useRef(new Map<string, string[]>());
  const chatAddMessageRef = useRef<((message: {
    id: string; type: "join" | "leave" | "user"; userId: string;
    username: string; message: string; timestamp: number;
  }) => void) | null>(null);

  useEffect(() => { participantsRef.current = participants; }, [participants]);
  useEffect(() => { isCatchingUpRef.current = isCatchingUp; }, [isCatchingUp]);

  const clearParticipants = useCallback(() => setParticipants(new Map()), []);
  const addParticipant = useCallback((userId: string, username: string, joinedAt: number) => {
    setParticipants((current) => new Map(current).set(userId, { userId, username, joinedAt }));
  }, []);

  const onLocalOperation = useCallback((entry: LocalPainterOperation) => {
    const ws = wsRef.current;
    const localId = localIdRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || localId === null || isCatchingUpRef.current) return;
    const encoded = encodePainterOperation(localId, entry.operation);
    const wireId = bytesId(new Uint8Array(encoded));
    const queue = pendingIdsRef.current.get(wireId) ?? [];
    queue.push(entry.id);
    pendingIdsRef.current.set(wireId, queue);
    ws.send(encoded);
  // wsRef is created by the WebSocket hook below and is stable for its lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const element = painterElementRef.current;
    if (!element || !canvasMeta || painterRef.current) return;
    const painter = mount(element, {
      width: canvasMeta.width,
      height: canvasMeta.height,
      mode: { kind: "standard" },
      controls: { kind: "toolbox" },
      synchronization: { actorId: userIdRef.current, onOperation: onLocalOperation },
    });
    painterRef.current = painter;
    void painter.ready.then(() => painter.setInteractionEnabled(false));
    return () => {
      painter.unmount();
      if (painterRef.current === painter) painterRef.current = null;
    };
  }, [canvasMeta, onLocalOperation]);

  useEffect(() => {
    painterRef.current?.setInteractionEnabled(
      connectionState === "connected" && !isCatchingUp,
    );
  }, [connectionState, isCatchingUp]);

  const applySnapshot = useCallback(async (
    layer: "foreground" | "background", png: Blob, sequence: number,
  ) => {
    const painter = painterRef.current;
    if (!painter) return;
    const current = await painter.exportCheckpoint(sequence);
    await painter.applyCheckpoint({ ...current, sequence, [layer]: png });
  }, []);

  const onCanvasMessage = useCallback(async (
    message: DecodedMessage, raw: Uint8Array, sequence = lastSeqRef.current + 1,
  ) => {
    if (message.type === "snapshot") {
      const pngBytes = new Uint8Array(message.pngData).slice();
      await applySnapshot(message.layer, new Blob([pngBytes.buffer as ArrayBuffer], { type: "image/png" }), sequence);
      return;
    }
    const operation = decodePainterOperation(message);
    if (!operation || !("userId" in message) || typeof message.userId !== "number") return;
    const wireId = bytesId(raw);
    const pendingIds = pendingIdsRef.current.get(wireId);
    const id = pendingIds?.shift() ?? wireId;
    if (pendingIds?.length === 0) pendingIdsRef.current.delete(wireId);
    const canonical: CanonicalPainterOperation = {
      id,
      actorId: String(message.userId),
      sequence,
      operation,
    };
    await painterRef.current?.applyCanonicalOperation(canonical);
  }, [applySnapshot]);

  const onReconnectCanvas = useCallback(async (reconnecting: boolean) => {
    pendingIdsRef.current.clear();
    if (!reconnecting || !canvasMeta || !painterRef.current) return;
    const layer = await blankLayer(canvasMeta.width, canvasMeta.height);
    const checkpoint: PainterCheckpoint = {
      sequence: 0, width: canvasMeta.width, height: canvasMeta.height,
      background: layer, foreground: layer,
    };
    await painterRef.current.applyCheckpoint(checkpoint);
  }, [canvasMeta]);

  const handleResetPoint = useCallback(async (baseSequence: number) => {
    const painter = painterRef.current;
    if (!painter) return;
    await painter.applyCheckpoint(await painter.exportCheckpoint(baseSequence));
  }, []);

  const handleResetRequest = useCallback(async () => {
    const painter = painterRef.current;
    const ws = wsRef.current;
    const localId = localIdRef.current;
    if (!painter || !ws || ws.readyState !== WebSocket.OPEN || localId === null) return;
    const checkpoint = await painter.exportCheckpoint(lastSeqRef.current);
    const snapshots = await Promise.all([
      encodeSnapshot(localId, "background", checkpoint.background),
      encodeSnapshot(localId, "foreground", checkpoint.foreground),
    ]);
    ws.send(encodeResetBegin(checkpoint.sequence, snapshots.length));
    snapshots.forEach((snapshot) => ws.send(snapshot));
  // wsRef is created by the WebSocket hook below and is stable for its lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { wsRef, connectWebSocket } = useWebSocket({
    canvasMeta, userIdRef, userLoginNameRef, localUserJoinTimeRef,
    participantsRef, localIdRef, lastSeqRef, shouldConnectRef,
    catchupTimeoutRef, processingMessageRef, isCatchingUpRef,
    setConnectionState, setIsCatchingUp,
    createOrUpdateCursor: () => {}, hideCursor: () => {},
    addParticipant, clearParticipants,
    addChatMessage: (message) => chatAddMessageRef.current?.(message),
    handleResetRequest, onReconnectCanvas, onCanvasMessage,
    onWelcome: (id) => { localIdRef.current = id; },
    onResetPoint: handleResetPoint,
  });

  const initializeApp = useCallback(async () => {
    try {
      setInitializationError(null);
      const sessionId = getSessionId();
      const authResponse = await fetch("/api/auth", { credentials: "include" });
      if (authResponse.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      if (!authResponse.ok) throw new Error(`Auth failed: ${authResponse.status}`);
      const auth = await authResponse.json();
      userIdRef.current = auth.user_id;
      userLoginNameRef.current = auth.login_name;
      const response = await fetch(`/collaboration/${sessionId}/meta`, { credentials: "include" });
      if (!response.ok) throw new Error(`Failed to fetch collaboration meta: ${response.status}`);
      const meta: CollaborationMeta = await response.json();
      if (meta.savedPostId) {
        window.location.href = `/@${meta.ownerLoginName}/${meta.savedPostId}`;
        return;
      }
      if (meta.currentUserCount >= meta.maxUsers && meta.ownerId !== auth.user_id) {
        setRoomFullError({ currentUserCount: meta.currentUserCount, maxUsers: meta.maxUsers });
        return;
      }
      document.title = `Oeee Cafe - ${meta.title?.trim() || "No Title"}`;
      setCanvasMeta(meta);
      shouldConnectRef.current = true;
    } catch (error) {
      setInitializationError(error instanceof Error ? error.message : String(error));
      setAuthError(true);
    }
  }, []);

  useEffect(() => { void initializeApp(); }, [initializeApp]);
  useEffect(() => {
    if (canvasMeta && painterRef.current && shouldConnectRef.current) void connectWebSocket();
  }, [canvasMeta, connectWebSocket]);
  useEffect(() => () => { shouldConnectRef.current = false; wsRef.current?.close(); }, [wsRef]);

  const downloadPng = useCallback(async () => {
    const png = await painterRef.current?.exportPng();
    if (png) downloadBlob(png, "collaboration.png");
  }, []);

  const saveCollaborativeDrawing = useCallback(async () => {
    if (isSaving || !painterRef.current) return;
    setIsSaving(true);
    try {
      const png = await painterRef.current.exportPng();
      const response = await fetch(`/collaborate/${getSessionId()}`, {
        method: "POST", body: png, headers: { "Content-Type": "image/png" }, credentials: "include",
      });
      if (!response.ok) throw new Error(`Failed to save drawing: ${response.status}`);
      const result = await response.json();
      wsRef.current?.send(encodeEndSession(userIdRef.current, result.post_url));
      window.location.href = result.post_url;
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
      setIsSaving(false);
    }
  }, [isSaving, wsRef]);

  const isOwner = canvasMeta?.ownerId === userIdRef.current;

  return <>
    <div className="w-full app-container flex flex-col">
      <InitializationErrorModal isOpen={!!initializationError} errorMessage={initializationError ?? ""} onRetry={() => location.reload()} />
      <LoadingModal isOpen={!canvasMeta && !initializationError} />
      <AuthErrorModal isOpen={authError} onGoToLobby={() => { location.href = "/collaborate"; }} />
      <RoomFullModal isOpen={!!roomFullError} currentUserCount={roomFullError?.currentUserCount ?? 0} maxUsers={roomFullError?.maxUsers ?? 0} onGoToLobby={() => { location.href = "/collaborate"; }} onRetry={() => location.reload()} />
      {canvasMeta && <SessionHeader canvasMeta={canvasMeta} connectionState={connectionState} isCatchingUp={isCatchingUp} />}
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute left-4 top-4 z-40 h-[469px] w-56 resize overflow-auto border border-main bg-main">
          <Chat wsRef={wsRef} userId={userIdRef.current} participants={participants} onChatMessage={() => {}} onAddMessage={(add) => { chatAddMessageRef.current = add; }} />
        </div>
        <div ref={painterElementRef} className="h-full w-full" />
        <ConnectionStatusModal isCatchingUp={isCatchingUp} connectionState={connectionState} onReconnect={() => location.reload()} onDownloadPNG={downloadPng} />
        {isOwner && <button type="button" disabled={isSaving} onClick={() => void saveCollaborativeDrawing()} className="absolute bottom-4 right-12 z-50 rounded bg-green-700 px-4 py-2 text-white disabled:opacity-50">{isSaving ? "Saving…" : "Save to gallery"}</button>}
        <SessionEndingModal isOpen={false} />
      </div>
    </div>
    <SessionExpiredModal isOpen={sessionExpired} isOwner={!!isOwner} canvasMeta={canvasMeta} isSaving={isSaving} onClose={() => setSessionExpired(false)} onSaveToGallery={saveCollaborativeDrawing} onDownloadPNG={downloadPng} onReturnToLobby={() => { location.href = "/collaborate"; }} />
  </>;
}
