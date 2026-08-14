import { useCallback, useEffect, useRef, useState } from "react";
import {
  mount,
  type CanonicalPainterOperation,
  type LocalPainterOperation,
  type PainterCheckpoint,
  type PainterHandle,
} from "neo-cucumber";
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
  encodeMovePointer,
  encodePainterOperation,
  encodePointerUp,
  encodeResetBegin,
  encodeSnapshot,
  type DecodedMessage,
} from "./binaryProtocol";
import { useWebSocket, type ConnectionState, type SyncProgress } from "./hooks/useWebSocket";
import { useRemoteCursors } from "./hooks/useRemoteCursors";
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
  const [sessionEnding, setSessionEnding] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({
    phase: "joining", receivedSequence: 0, appliedSequence: 0, targetSequence: null,
  });
  const [synchronizationError, setSynchronizationError] = useState<string | null>(null);

  const painterElementRef = useRef<HTMLDivElement>(null);
  const painterRef = useRef<PainterHandle | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const saveProxyRef = useRef<HTMLButtonElement | null>(null);
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
  const pointerFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ x: number; y: number } | null>(null);
  const expectedSequenceRef = useRef(1);
  const appliedSequenceRef = useRef(0);
  const canonicalOperationsRef = useRef(new Map<number, CanonicalPainterOperation>());
  const snapshotPairsRef = useRef(new Map<number, Partial<Pick<PainterCheckpoint, "background" | "foreground">>>());
  const canonicalDrainRef = useRef<Promise<void>>(Promise.resolve());
  const { createOrUpdateCursor, hideCursor, clearCursors } = useRemoteCursors(
    painterElementRef, localIdRef,
  );
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

  const onLocalPointerUp = useCallback(() => {
    const ws = wsRef.current;
    const localId = localIdRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || localId === null) return;
    ws.send(encodePointerUp(localId));
  // wsRef is created by the WebSocket hook below and is stable for its lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onLocalPointerMove = useCallback((position: { x: number; y: number } | null) => {
    if (!position) {
      pendingPointerRef.current = null;
      if (pointerFrameRef.current !== null) cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
      onLocalPointerUp();
      return;
    }
    pendingPointerRef.current = position;
    if (pointerFrameRef.current !== null) return;
    pointerFrameRef.current = requestAnimationFrame(() => {
      pointerFrameRef.current = null;
      const point = pendingPointerRef.current;
      const ws = wsRef.current;
      const localId = localIdRef.current;
      if (point && ws?.readyState === WebSocket.OPEN && localId !== null) {
        ws.send(encodeMovePointer(localId, point.x, point.y));
      }
    });
  // wsRef is created by the WebSocket hook below and is stable for its lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLocalPointerUp]);

  useEffect(() => {
    const element = painterElementRef.current;
    if (!element || !canvasMeta || painterRef.current) return;
    const painter = mount(element, {
      width: canvasMeta.width,
      height: canvasMeta.height,
      mode: { kind: "standard" },
      controls: { kind: "toolbox" },
      synchronization: {
        actorId: userIdRef.current,
        onOperation: onLocalOperation,
        onPointerMove: onLocalPointerMove,
        onPointerUp: onLocalPointerUp,
      },
    });
    painterRef.current = painter;
    void painter.ready.then(() => painter.setInteractionEnabled(false));
    return () => {
      painter.unmount();
      if (painterRef.current === painter) painterRef.current = null;
    };
  }, [canvasMeta, onLocalOperation, onLocalPointerMove, onLocalPointerUp]);

  useEffect(() => () => {
    if (pointerFrameRef.current !== null) cancelAnimationFrame(pointerFrameRef.current);
  }, []);

  useEffect(() => {
    painterRef.current?.setInteractionEnabled(
      connectionState === "connected" && !isCatchingUp && !sessionEnding && !sessionExpired,
    );
  }, [connectionState, isCatchingUp, sessionEnding, sessionExpired]);

  const drainCanonical = useCallback(async () => {
    canonicalDrainRef.current = canonicalDrainRef.current.then(async () => {
      const painter = painterRef.current;
      if (!painter || !canvasMeta) return;
      while (true) {
        const expected = expectedSequenceRef.current;
        const operation = canonicalOperationsRef.current.get(expected);
        if (operation) {
          canonicalOperationsRef.current.delete(expected);
          await painter.applyCanonicalOperation(operation);
          appliedSequenceRef.current = expected;
          expectedSequenceRef.current = expected + 1;
          continue;
        }

        // A checkpoint is a legal jump over compacted history. Both layers
        // must arrive before it replaces the canvas and advances the sequence.
        const checkpointSequence = [...snapshotPairsRef.current.entries()]
          .filter(([sequence, pair]) =>
            sequence >= expected && pair.background && pair.foreground,
          )
          .map(([sequence]) => sequence)
          .sort((a, b) => a - b)[0];
        if (checkpointSequence === undefined) break;
        const pair = snapshotPairsRef.current.get(checkpointSequence)!;
        await painter.applyCheckpoint({
          sequence: checkpointSequence,
          width: canvasMeta.width,
          height: canvasMeta.height,
          background: pair.background!,
          foreground: pair.foreground!,
        });
        snapshotPairsRef.current.delete(checkpointSequence);
        for (const sequence of canonicalOperationsRef.current.keys()) {
          if (sequence <= checkpointSequence) canonicalOperationsRef.current.delete(sequence);
        }
        appliedSequenceRef.current = checkpointSequence;
        expectedSequenceRef.current = checkpointSequence + 1;
      }
    });
    await canonicalDrainRef.current;
  }, [canvasMeta]);

  const onCanvasMessage = useCallback(async (
    message: DecodedMessage, raw: Uint8Array, sequence?: number,
  ) => {
    if (sequence === undefined) {
      throw new Error("Received an unsequenced canvas-history message");
    }
    if (message.type === "snapshot") {
      const pngBytes = new Uint8Array(message.pngData).slice();
      const pair = snapshotPairsRef.current.get(sequence) ?? {};
      pair[message.layer] = new Blob([pngBytes.buffer as ArrayBuffer], { type: "image/png" });
      snapshotPairsRef.current.set(sequence, pair);
      await drainCanonical();
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
    canonicalOperationsRef.current.set(sequence, canonical);
    await drainCanonical();
  }, [drainCanonical]);

  const onReconnectCanvas = useCallback(async (
    reconnecting: boolean, resumeSequence: number | null,
  ) => {
    clearCursors();
    pendingIdsRef.current.clear();
    canonicalOperationsRef.current.clear();
    snapshotPairsRef.current.clear();
    if (reconnecting && resumeSequence !== null) {
      expectedSequenceRef.current = resumeSequence + 1;
      appliedSequenceRef.current = resumeSequence;
      return;
    }
    expectedSequenceRef.current = 1;
    appliedSequenceRef.current = 0;
    if (!reconnecting || !canvasMeta || !painterRef.current) return;
    const layer = await blankLayer(canvasMeta.width, canvasMeta.height);
    const checkpoint: PainterCheckpoint = {
      sequence: 0, width: canvasMeta.width, height: canvasMeta.height,
      background: layer, foreground: layer,
    };
    await painterRef.current.applyCheckpoint(checkpoint);
  }, [canvasMeta, clearCursors]);

  const handleResetPoint = useCallback(async (baseSequence: number, sequence?: number) => {
    const painter = painterRef.current;
    if (!painter) return;
    await drainCanonical();
    await painter.compactCanonicalHistory(baseSequence);
    if (sequence !== undefined) {
      appliedSequenceRef.current = sequence;
      expectedSequenceRef.current = sequence + 1;
    }
  }, [drainCanonical]);

  const verifyCanonicalPosition = useCallback(async (): Promise<boolean> => {
    await drainCanonical();
    return appliedSequenceRef.current >= lastSeqRef.current;
  }, [drainCanonical]);

  const canResumeCanonicalPosition = useCallback((): boolean =>
    painterRef.current?.isSynchronizationSettled() ?? false,
  []);

  const handleSynchronizationError = useCallback((error: Error | null) => {
    setSynchronizationError(error?.message ?? null);
  }, []);

  const handleSessionEnded = useCallback((postUrl: string) => {
    setSessionEnding(true);
    window.location.assign(postUrl);
  }, []);

  const handleSessionExpired = useCallback(() => {
    setSessionExpired(true);
    painterRef.current?.setInteractionEnabled(false);
  }, []);

  const handleResetRequest = useCallback(async () => {
    const painter = painterRef.current;
    const ws = wsRef.current;
    const localId = localIdRef.current;
    if (!painter || !ws || ws.readyState !== WebSocket.OPEN || localId === null) return;
    // A reset checkpoint must describe confirmed canonical state, never a
    // pointer gesture or optimistic fork the server has not sequenced yet.
    for (let attempt = 0; attempt < 40; attempt++) {
      await drainCanonical();
      if (
        painter.isSynchronizationSettled() &&
        appliedSequenceRef.current >= lastSeqRef.current
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (
      !painter.isSynchronizationSettled() ||
      appliedSequenceRef.current < lastSeqRef.current
    ) return;
    const checkpoint = await painter.exportCheckpoint(appliedSequenceRef.current);
    const snapshots = await Promise.all([
      encodeSnapshot(localId, "background", checkpoint.background),
      encodeSnapshot(localId, "foreground", checkpoint.foreground),
    ]);
    ws.send(encodeResetBegin(checkpoint.sequence, snapshots.length));
    snapshots.forEach((snapshot) => ws.send(snapshot));
  // wsRef is created by the WebSocket hook below and is stable for its lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drainCanonical]);

  const { wsRef, connectWebSocket } = useWebSocket({
    canvasMeta, userIdRef, userLoginNameRef, localUserJoinTimeRef,
    participantsRef, localIdRef, lastSeqRef, shouldConnectRef,
    catchupTimeoutRef, processingMessageRef, isCatchingUpRef,
    setConnectionState, setIsCatchingUp,
    setSyncProgress,
    onSynchronizationError: handleSynchronizationError,
    createOrUpdateCursor, hideCursor,
    addParticipant, clearParticipants,
    addChatMessage: (message) => chatAddMessageRef.current?.(message),
    handleResetRequest, onReconnectCanvas, onCanvasMessage,
    onWelcome: (id) => { localIdRef.current = id; },
    onResetPoint: handleResetPoint,
    verifyCanonicalPosition,
    canResumeCanonicalPosition,
    onSessionEnded: handleSessionEnded,
    onSessionExpired: handleSessionExpired,
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
    setSessionEnding(true);
    painterRef.current.setInteractionEnabled(false);
    try {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Reconnect before saving the collaborative session");
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        await drainCanonical();
        if (
          painterRef.current.isSynchronizationSettled() &&
          appliedSequenceRef.current >= lastSeqRef.current
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (
        !painterRef.current.isSynchronizationSettled() ||
        appliedSequenceRef.current < lastSeqRef.current
      ) {
        throw new Error("The shared drawing is still synchronizing; please try again");
      }
      const png = await painterRef.current.exportPng();
      const response = await fetch(`/collaborate/${getSessionId()}`, {
        method: "POST", body: png, headers: { "Content-Type": "image/png" }, credentials: "include",
      });
      if (!response.ok) throw new Error(`Failed to save drawing: ${response.status}`);
      const result = await response.json();
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("The session was saved, but the connection closed before finalization; reload to continue");
      }
      // The server echoes END_SESSION only after accepting the authoritative
      // lifecycle transition. Navigation happens in handleSessionEnded.
      socket.send(encodeEndSession(userIdRef.current, result.post_url));
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
      setIsSaving(false);
      setSessionEnding(false);
    }
  }, [drainCanonical, isSaving, wsRef]);

  const isOwner = canvasMeta?.ownerId === userIdRef.current;

  useEffect(() => {
    const painter = painterRef.current;
    const saveButton = saveButtonRef.current;
    const painterElement = painterElementRef.current;
    if (!painter || !painterElement) return;
    let proxy: HTMLButtonElement | null = null;
    let helpProxy: HTMLButtonElement | null = null;
    let helpButton: HTMLButtonElement | null = null;
    let cancelled = false;

    void painter.ready.then(() => {
      if (cancelled) return;
      const colorInput = painterElement.querySelector<HTMLInputElement>(
        'input[type="color"]',
      );
      const extraTools = colorInput?.parentElement;
      const toolboxButton =
        extraTools?.querySelector<HTMLButtonElement>("button.w-full");
      helpButton = painterElement.querySelector<HTMLButtonElement>(
        'button[aria-label="Keyboard shortcuts"]',
      );
      if (!extraTools || !toolboxButton || !helpButton) return;

      helpProxy = document.createElement("button");
      helpProxy.type = "button";
      helpProxy.className = toolboxButton.className;
      helpProxy.textContent = "Help";
      helpProxy.title = helpButton.title;
      helpProxy.setAttribute(
        "aria-label",
        helpButton.getAttribute("aria-label") ?? "Help",
      );
      helpProxy.addEventListener("click", () => helpButton?.click());

      extraTools.append(helpProxy);
      helpButton.hidden = true;
      if (isOwner && saveButton) {
        proxy = document.createElement("button");
        proxy.type = "button";
        proxy.className = toolboxButton.className;
        proxy.textContent = saveButton.textContent;
        proxy.disabled = saveButton.disabled;
        proxy.addEventListener("click", () => saveButton.click());
        extraTools.append(proxy);
        saveButton.hidden = true;
        saveProxyRef.current = proxy;
      }
    });

    return () => {
      cancelled = true;
      helpProxy?.remove();
      proxy?.remove();
      if (helpButton) helpButton.hidden = false;
      if (saveButton) saveButton.hidden = false;
      if (saveProxyRef.current === proxy) saveProxyRef.current = null;
    };
  }, [isOwner]);

  useEffect(() => {
    const proxy = saveProxyRef.current;
    if (!proxy) return;
    proxy.disabled = isSaving;
    proxy.textContent = isSaving ? "Saving…" : "Save to gallery";
  }, [isSaving]);

  return <>
    <div className="w-full app-container flex flex-col">
      <InitializationErrorModal isOpen={!!initializationError} errorMessage={initializationError ?? ""} onRetry={() => location.reload()} />
      <LoadingModal isOpen={!canvasMeta && !initializationError} />
      <AuthErrorModal isOpen={authError} onGoToLobby={() => { location.href = "/collaborate"; }} />
      <RoomFullModal isOpen={!!roomFullError} currentUserCount={roomFullError?.currentUserCount ?? 0} maxUsers={roomFullError?.maxUsers ?? 0} onGoToLobby={() => { location.href = "/collaborate"; }} onRetry={() => location.reload()} />
      {canvasMeta && <SessionHeader canvasMeta={canvasMeta} connectionState={connectionState} isCatchingUp={isCatchingUp} />}
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute left-4 top-4 z-40 h-[469px] w-56 resize overflow-auto border border-main bg-main">
          <Chat wsRef={wsRef} userId={userIdRef.current} participants={participants} connectionState={connectionState} onChatMessage={() => {}} onAddMessage={(add) => { chatAddMessageRef.current = add; }} />
        </div>
        <div ref={painterElementRef} className="h-full w-full" />
        <ConnectionStatusModal isCatchingUp={isCatchingUp} connectionState={connectionState} syncProgress={syncProgress} synchronizationError={synchronizationError} onReconnect={() => location.reload()} onDownloadPNG={downloadPng} />
        {isOwner && <button ref={saveButtonRef} type="button" disabled={isSaving} onClick={() => void saveCollaborativeDrawing()} className="absolute bottom-4 right-12 z-50 rounded bg-green-700 px-4 py-2 text-white disabled:opacity-50">{isSaving ? "Saving…" : "Save to gallery"}</button>}
        <SessionEndingModal isOpen={sessionEnding} />
      </div>
    </div>
    <SessionExpiredModal isOpen={sessionExpired} isOwner={!!isOwner} canvasMeta={canvasMeta} isSaving={isSaving} onClose={() => {}} onSaveToGallery={saveCollaborativeDrawing} onDownloadPNG={downloadPng} onReturnToLobby={() => { location.href = "/collaborate"; }} />
  </>;
}
