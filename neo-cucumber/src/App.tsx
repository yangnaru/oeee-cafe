import { useCallback, useEffect, useRef, useState } from "react";
import { useCanvasView, useDeferredHandler } from "./hooks/useCanvasView";
import "./App.css";
import { Chat } from "./components/Chat";
import { SessionExpiredModal } from "./components/SessionExpiredModal";
import { InitializationErrorModal } from "./components/modals/InitializationErrorModal";
import { LoadingModal } from "./components/modals/LoadingModal";
import { AuthErrorModal } from "./components/modals/AuthErrorModal";
import { RoomFullModal } from "./components/modals/RoomFullModal";
import { ConnectionStatusModal } from "./components/modals/ConnectionStatusModal";
import { SessionEndingModal } from "./components/modals/SessionEndingModal";
import { SessionHeader } from "./components/SessionHeader";
import {
  type CollaborationMeta,
  type Participant,
} from "./types/collaboration";
import { ToolboxPanels } from "./components/ToolboxPanels";
import { NeoWindow } from "./components/neo/NeoWindow";
import { Trans } from "@lingui/react/macro";
import { SHARED_TOOLS } from "./constants/drawing";
import { useDrawing } from "./hooks/useDrawing";
import { useDrawingState } from "./hooks/useDrawingState";
import { useZoomControls } from "./hooks/useZoomControls";
import { useCanvas } from "./hooks/useCanvas";
import { useWebSocket, type ConnectionState } from "./hooks/useWebSocket";
import { useCursor } from "./hooks/useCursor";
import {
  encodeEndSession,
  encodeResetBegin,
  encodeSnapshot,
} from "./utils/binaryProtocol";
import { CanvasHistory } from "./utils/canvasHistory";
import { layerToPngBlob } from "./utils/canvasSnapshot";
import {
  type Backdrop,
  type BezierPreviewStyle,
  drawBezierPreview,
  drawLinePreview,
  drawRegionPreview,
} from "./neo/regionPreview";
import type { DrawingEngine } from "./DrawingEngine";
import type { RegionRect } from "./neo/regionDrag";
import { fontSizeForBrush, TEXT_FONT_FAMILY } from "./neo/tools";
import { CANVAS_Z_INDEX } from "./neo/canvasStack";
import { previewBackdrop as backdropFromCanvasStack } from "./neo/previewBackdrop";

// Function to get session ID from URL
const getSessionId = (): string => {
  const pathSegments = window.location.pathname.split("/");
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (pathSegments.length >= 3 && uuidPattern.test(pathSegments[2])) {
    return pathSegments[2];
  }
  throw new Error("Invalid session ID in URL");
};

// Function to fetch collaboration metadata
const fetchCollaborationMeta = async (
  sessionId: string
): Promise<CollaborationMeta> => {
  const response = await fetch(`/collaboration/${sessionId}/meta`, {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch collaboration meta: ${response.status} ${response.statusText}`
    );
  }

  return response.json();
};

function App() {
  // State for canvas dimensions and meta information
  const [canvasMeta, setCanvasMeta] = useState<CollaborationMeta | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(
    null
  );

  // Participants state (moved from Chat.tsx for centralized user management)
  const [participants, setParticipants] = useState<Map<string, Participant>>(
    new Map()
  );
  const participantsRef = useRef(participants);

  // Keep participantsRef in sync with participants state
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Canvas dimensions - only available when meta is loaded

  const {
    drawingState,
    selectedPaletteIndex,
    paletteColors,
    setDrawingState,
    setSelectedPaletteIndex,
    updateBrushType,
    updateColor,
    setPaletteColor,
  } = useDrawingState();

  const [historyState, setHistoryState] = useState({
    canUndo: false,
    canRedo: false,
  });

  // Track catching up state - when true, drawing should be disabled
  const [isCatchingUp, setIsCatchingUp] = useState(true);
  const isCatchingUpRef = useRef(isCatchingUp);
  const catchupTimeoutRef = useRef<number | null>(null);
  const processingMessageRef = useRef(false);

  // Keep ref in sync with state
  useEffect(() => {
    isCatchingUpRef.current = isCatchingUp;
  }, [isCatchingUp]);

  // Track connection state for reconnection logic
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const shouldConnectRef = useRef(false);

  // Track authentication state
  const [authError, setAuthError] = useState(false);
  const [roomFullError, setRoomFullError] = useState<{
    currentUserCount: number;
    maxUsers: number;
  } | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [sessionEnded] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Store reference to chat's addMessage function
  const chatAddMessageRef = useRef<
    | ((message: {
        id: string;
        type: "join" | "leave" | "user";
        userId: string;
        username: string;
        message: string;
        timestamp: number;
      }) => void)
    | null
  >(null);

  // Chat message handler
  const handleChatMessage = useCallback(() => {
    // Chat messages are handled entirely by the Chat component
    // This callback is here for future extensions if needed
  }, []);

  // Callback to receive addMessage function from Chat component
  const handleChatAddMessage = useCallback(
    (
      addMessageFn: (message: {
        id: string;
        type: "join" | "leave" | "user";
        userId: string;
        username: string;
        message: string;
        timestamp: number;
      }) => void
    ) => {
      chatAddMessageRef.current = addMessageFn;
    },
    []
  );

  const appRef = useRef<HTMLDivElement>(null);
  const userIdRef = useRef<string>("");
  const userLoginNameRef = useRef<string>("");
  const localUserJoinTimeRef = useRef<number>(0);

  // Check if current user is the session owner
  const isOwner = canvasMeta && userIdRef.current === canvasMeta.ownerId;

  // Function to clear all participants (used before processing LAYERS message)
  const clearParticipants = useCallback(() => {
    setParticipants(new Map());
    console.log("Cleared all participants for LAYERS rebuild");
  }, []);

  // Participant management functions (moved from Chat.tsx)
  const addParticipant = useCallback(
    (userId: string, username: string, timestamp: number) => {
      setParticipants((prev) => {
        const newParticipants = new Map(prev);
        newParticipants.set(userId, { userId, username, joinedAt: timestamp });
        
        console.log(`Added participant ${userId.substring(0, 8)} with joinedAt: ${timestamp}`);
        
        return newParticipants;
      });
      
      // Keep participantsRef in sync
      participantsRef.current?.set(userId, { userId, username, joinedAt: timestamp });
      
      // Z-index updates now happen declaratively via useEffect in useCanvas
    },
    [participantsRef]
  );


  // History change callback
  const handleHistoryChange = useCallback(
    (canUndo: boolean, canRedo: boolean) => {
      setHistoryState({ canUndo, canRedo });
    },
    []
  );

  // Create a ref to hold the DOM canvas update function
  const domCanvasUpdateRef = useRef<() => void>(() => {});

  // Callback to trigger unified compositing when local drawing changes
  const handleLocalDrawingChange = useCallback(() => {
    console.log("Local drawing changed - triggering DOM canvas update");
    domCanvasUpdateRef.current();
  }, []);

  // Temporary refs for initialization order
  const tempCanvasContainerRef = useRef<HTMLDivElement>(null);
  const tempLocalUserCanvasRef = useRef<HTMLCanvasElement>(null);

  // Region drags, straight lines and beziers all preview on one overlay
  // canvas that sits above the layers and takes no pointer events.
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingEngineRef = useRef<DrawingEngine | null>(null);
  const previewBackdrop = useCallback((): Backdrop | null => {
    const engine = drawingEngineRef.current;
    if (!engine || !canvasMeta) return null;
    return backdropFromCanvasStack(
      engine,
      canvasMeta.width,
      canvasMeta.height,
      drawingState.zoomLevel / 100,
      drawingState.bgVisible,
      drawingState.fgVisible
    );
  }, [canvasMeta, drawingState.zoomLevel, drawingState.bgVisible, drawingState.fgVisible]);
  const handleRegionPreview = useCallback((rect: RegionRect | null) => {
    const ctx = previewCanvasRef.current?.getContext("2d");
    if (ctx) drawRegionPreview(ctx, rect, previewBackdrop(), drawingState.brushType);
  }, [previewBackdrop, drawingState.brushType]);
  const handleLinePreview = useCallback(
    (
      from: { x: number; y: number } | null,
      to: { x: number; y: number } | null
    ) => {
      const ctx = previewCanvasRef.current?.getContext("2d");
      if (ctx) drawLinePreview(ctx, from, to, previewBackdrop());
    },
    [previewBackdrop]
  );
  const handleBezierPreview = useCallback(
    (points: number[] | null, step: number, style: BezierPreviewStyle) => {
      const ctx = previewCanvasRef.current?.getContext("2d");
      if (ctx) drawBezierPreview(ctx, points, previewBackdrop(), step, style);
    },
    [previewBackdrop]
  );

  /*
   * The cursor is painted by useCanvasView, which needs the engine that the
   * drawing hook below creates -- so the hook is given a forwarder now and
   * pointed at the real painter once both exist.
   */
  const [handleHoverMove, setHoverHandler] = useDeferredHandler<
    { x: number; y: number } | null
  >();

  // Text is typed into a box on the canvas, as NEO does it: no font pickers,
  // because the pen size is the font size and the family is fixed.
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null);
  const textBoxRef = useRef<HTMLDivElement>(null);
  const handleTextPlace = useCallback((x: number, y: number) => {
    setTextAt({ x, y });
  }, []);

  // Create a stable wsRef that will be populated by useWebSocket
  const drawingWsRef = useRef<WebSocket | null>(null);

  // Canonical shared-canvas history (conflict resolution + collaborative undo)
  const canvasHistoryRef = useRef<CanvasHistory | null>(null);

  // 1-byte session user id assigned by the server's WELCOME message
  const localIdRef = useRef<number | null>(null);

  // Highest canonical history position fully applied to the canvases
  const lastSeqRef = useRef<number>(0);

  // Use the drawing hook with stable wsRef
  const { undo, redo, drawingEngine, isDrawingRef, sendText } = useDrawing(
    tempLocalUserCanvasRef,
    appRef,
    drawingState,
    handleHistoryChange,
    drawingState.zoomLevel, // Use zoom level from drawing state
    canvasMeta?.width,
    canvasMeta?.height,
    drawingWsRef, // Stable wsRef that gets populated later
    localIdRef,
    handleLocalDrawingChange,
    isCatchingUp,
    connectionState,
    tempCanvasContainerRef,
    canvasHistoryRef,
    handleRegionPreview,
    handleLinePreview,
    handleBezierPreview,
    handleTextPlace,
    handleHoverMove
  );

  // Focus the box as soon as it appears, so typing just works
  useEffect(() => {
    if (textAt && textBoxRef.current) textBoxRef.current.focus();
  }, [textAt]);

  /**
   * Enter commits, Escape abandons. Unlike the offline painter this does not
   * draw -- it sends, and the history applies what comes back, so every
   * participant gets the text from the same message rather than from two
   * code paths that could disagree.
   */
  const handleTextKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setTextAt(null);
        return;
      }
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();

      const value = textBoxRef.current?.textContent ?? "";
      if (textAt && value) {
        sendText(
          textAt.x,
          textAt.y,
          value,
          {
            r: parseInt(drawingState.color.slice(1, 3), 16),
            g: parseInt(drawingState.color.slice(3, 5), 16),
            b: parseInt(drawingState.color.slice(5, 7), 16),
            a: drawingState.opacity,
          },
          drawingState.brushSize,
          drawingState.layerType
        );
      }
      setTextAt(null);
    },
    [textAt, sendText, drawingState.color, drawingState.opacity,
     drawingState.brushSize, drawingState.layerType]
  );

  // Zoom controls
  const { currentZoom, handleZoomIn, handleZoomOut, handleZoomReset, handleZoomFit } =
    useZoomControls({
      canvasContainerRef: tempCanvasContainerRef,
      appRef,
      drawingEngine,
      setDrawingState,
    });

  // Canvas management (after drawing engine is available)
  const { canvasContainerRef, compositeCanvasesForExport, downloadCanvasAsPNG } =
    useCanvas({
      canvasMeta,
      drawingEngine,
      currentZoom,
      drawingState,
    });

  const { cursorCanvasRef, paintCursor } = useCanvasView({
    drawingEngine,
    drawingState,
    setDrawingState,
    canvasContainerRef,
    currentZoom,
    canvasWidth: canvasMeta?.width,
    canvasHeight: canvasMeta?.height,
  });
  setHoverHandler(paintCursor);

  // Keep drawingEngine ref in sync to avoid circular dependencies
  useEffect(() => {
    drawingEngineRef.current = drawingEngine ?? null;
  }, [drawingEngine]);

  // Create the canonical canvas history once the engine is available; the
  // local session user id is set when the server's WELCOME arrives
  useEffect(() => {
    if (drawingEngine && !canvasHistoryRef.current) {
      canvasHistoryRef.current = new CanvasHistory(
        drawingEngine,
        handleHistoryChange
      );
    }
  }, [drawingEngine, handleHistoryChange]);

  // Cursor management
  const { createOrUpdateCursor, hideCursor } = useCursor({
    canvasContainerRef,
    userIdRef,
  });

  // Responds to a server session-reset request (Drawpile-style auto-reset):
  // uploads snapshots of every participant's layers representing the exact
  // canonical state at lastSeq, so the server can replace the accumulated
  // history with them. Deferred while local strokes are unconfirmed or a
  // stroke is in progress, since the canvas must match the canonical state.
  const handleResetRequest = useCallback(() => {
    const RETRY_MS = 300;
    const MAX_RETRIES = 40;
    let retries = 0;

    const attempt = async () => {
      const ws = drawingWsRef.current;
      const engine = drawingEngineRef.current;
      const localId = localIdRef.current;
      if (
        !ws ||
        ws.readyState !== WebSocket.OPEN ||
        !engine ||
        !canvasMeta?.width ||
        !canvasMeta?.height ||
        localId == null
      ) {
        return;
      }

      const history = canvasHistoryRef.current;
      if ((history && history.hasPendingLocal) || isDrawingRef.current) {
        if (retries++ < MAX_RETRIES) {
          setTimeout(attempt, RETRY_MS);
        }
        return;
      }

      // Capture the shared layers and the history position in one synchronous
      // block so both snapshots describe the same canonical state
      const baseSeq = lastSeqRef.current;
      const captures: {
        userId: number;
        layer: "foreground" | "background";
        data: Uint8ClampedArray;
      }[] = [];
      for (const layer of ["foreground", "background"] as const) {
        captures.push({
          userId: localId,
          layer,
          data: new Uint8ClampedArray(engine.layers[layer]),
        });
      }

      try {
        const snapshots: ArrayBuffer[] = [];
        for (const capture of captures) {
          const blob = await layerToPngBlob(
            capture.data,
            canvasMeta.width,
            canvasMeta.height
          );
          snapshots.push(
            await encodeSnapshot(capture.userId, capture.layer, blob)
          );
        }

        ws.send(encodeResetBegin(baseSeq, snapshots.length));
        for (const snapshot of snapshots) {
          ws.send(snapshot);
        }
        console.log(
          `Uploaded session reset at seq ${baseSeq} (${snapshots.length} snapshots)`
        );
      } catch (error) {
        console.error("Failed to upload session reset:", error);
      }
    };

    attempt();
  }, [canvasMeta, isDrawingRef]);

  // WebSocket management
  const { wsRef, connectWebSocket } = useWebSocket({
    canvasMeta,
    userIdRef,
    userLoginNameRef,
    localUserJoinTimeRef,
    canvasHistoryRef,
    participantsRef,
    localIdRef,
    lastSeqRef,
    shouldConnectRef,
    catchupTimeoutRef,
    processingMessageRef,
    isCatchingUpRef,
    setConnectionState,
    setIsCatchingUp,
    createOrUpdateCursor,
    hideCursor,
    addParticipant,
    clearParticipants,
    addChatMessage: (message) => {
      if (chatAddMessageRef.current) {
        chatAddMessageRef.current(message);
      }
    },
    handleResetRequest,
  });

  // Keep connectWebSocket ref stable to avoid reconnection loops
  const connectWebSocketRef = useRef(connectWebSocket);
  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
  }, [connectWebSocket]);

  // Sync WebSocket from useWebSocket to drawing system
  useEffect(() => {
    console.log("Syncing WebSocket for drawing:", {
      wsConnected: !!wsRef.current,
      wsState: wsRef.current?.readyState,
      drawingWsConnected: !!drawingWsRef.current,
      connectionState,
    });
    drawingWsRef.current = wsRef.current;
  }, [wsRef, connectionState]);

  // Ensure drawing engine DOM canvases are updated when engine becomes available
  useEffect(() => {
    if (drawingEngine && userIdRef.current) {
      // Update the DOM canvas update function
      domCanvasUpdateRef.current = () => {
        drawingEngine.updateAllDOMCanvasesImmediate();
      };

      // Force an immediate update of all DOM canvases to show any existing content
      setTimeout(() => {
        drawingEngine.updateAllDOMCanvasesImmediate();
      }, 0);
    }
  }, [drawingEngine]);

  // Keep connectWebSocket ref to avoid circular dependencies in useEffect (defined after connectWebSocket)

  // Function to handle manual reconnection
  const handleManualReconnect = useCallback(() => {
    window.location.reload();
  }, []);

  // Function to save collaborative drawing to gallery
  const saveCollaborativeDrawing = useCallback(async () => {
    if (isSaving) {
      return;
    }

    try {
      setIsSaving(true);

      // Extract session ID from URL
      const pathSegments = window.location.pathname.split("/");
      const sessionId = pathSegments[2];

      if (!sessionId) {
        throw new Error("Could not determine session ID");
      }

      // Step 1: Create a composite canvas and get as PNG blob
      const tempCanvas = compositeCanvasesForExport();
      if (!tempCanvas) {
        throw new Error("Could not create composite canvas");
      }

      const blob = await new Promise<Blob>((resolve, reject) => {
        tempCanvas.toBlob((blob: Blob | null) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Failed to create blob from canvas"));
          }
        }, "image/png");
      });

      // Step 2: Send POST request to save
      const response = await fetch(`/collaborate/${sessionId}`, {
        method: "POST",
        body: blob,
        headers: {
          "Content-Type": "image/png",
        },
        credentials: "include",
      });

      if (response.ok) {
        const result = await response.json();
        console.log("Drawing saved successfully:", result);

        // Step 3: Send END_SESSION message with actual post URL after successful save
        const endSessionMsg = encodeEndSession(
          userIdRef.current,
          result.post_url
        );
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(endSessionMsg);
          console.log(
            "END_SESSION message sent to all participants with post URL:",
            result.post_url
          );
        }

        // Redirect owner to the post page to add description
        window.location.href = result.post_url;
      } else {
        const errorText = await response.text();
        throw new Error(
          `Failed to save drawing: ${response.status} ${errorText}`
        );
      }
    } catch (error) {
      console.error("Save failed:", error);
      alert(
        `Failed to save drawing: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      setIsSaving(false);
    }
  }, [isSaving, compositeCanvasesForExport, wsRef, userIdRef]);

  // New initialization function that follows the required flow
  const initializeApp = useCallback(async (): Promise<boolean> => {
    try {
      console.log("Starting app initialization...");
      setInitializationError(null);

      // Step 1: Get session ID from URL
      const sessionId = getSessionId();
      console.log("Session ID:", sessionId);

      // Step 2: Fetch auth info from /api/auth
      console.log("Fetching auth info from /api/auth");
      const authResponse = await fetch("/api/auth", {
        method: "GET",
        credentials: "include",
      });

      if (!authResponse.ok) {
        if (authResponse.status === 401) {
          // Authentication required - redirect to login with return URL
          const currentPath = encodeURIComponent(window.location.pathname);
          const loginUrl = `/login?next=${currentPath}`;
          console.log("Authentication required, redirecting to:", loginUrl);
          window.location.href = loginUrl;
          return false; // Don't continue initialization since we're redirecting
        }
        throw new Error(
          `Auth failed: ${authResponse.status} ${authResponse.statusText}`
        );
      }

      const authInfo = await authResponse.json();
      console.log("Auth info received:", {
        userId: authInfo.user_id,
        loginName: authInfo.login_name,
        preferredLocale: authInfo.preferred_locale,
      });
      userIdRef.current = authInfo.user_id;
      userLoginNameRef.current = authInfo.login_name;

      // Note: i18n is set up in main.tsx using the user's preferred locale
      // from /api/auth, so we don't need to set it up again here

      // Step 3: Fetch collaboration metadata
      console.log("Fetching collaboration metadata");
      const meta = await fetchCollaborationMeta(sessionId);
      setCanvasMeta(meta);
      console.log("Collaboration meta received:", meta);

      // Check if session has been saved and redirect if so
      if (meta.savedPostId) {
        console.log(
          "Session has been saved, redirecting to post:",
          meta.savedPostId
        );
        window.location.href = `/@${meta.ownerLoginName}/${meta.savedPostId}`;
        return false; // Don't continue initialization since we're redirecting
      }

      // Check if room is full (unless user is the owner)
      if (
        meta.currentUserCount >= meta.maxUsers &&
        meta.ownerId !== authInfo.user_id
      ) {
        // Store room full data for localized error display
        setRoomFullError({
          currentUserCount: meta.currentUserCount,
          maxUsers: meta.maxUsers,
        });
        return false;
      }

      // Update document title
      const sessionTitle =
        meta.title && meta.title.trim() ? meta.title : "No Title";
      document.title = `Oeee Cafe - ${sessionTitle}`;

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("App initialization failed:", errorMessage);

      // Room full errors are handled separately above
      setInitializationError(errorMessage);
      setAuthError(true);
      return false;
    }
  }, [setInitializationError, setCanvasMeta, setRoomFullError, setAuthError]);

  // Initialize app (auth + collaboration meta) on component mount
  useEffect(() => {
    const initApp = async () => {
      const success = await initializeApp();
      if (success) {
        shouldConnectRef.current = true;
      }
    };

    initApp();

    // Clean up WebSocket connection when component unmounts
    return () => {
      shouldConnectRef.current = false;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [initializeApp, wsRef, shouldConnectRef]);

  // Connect to WebSocket when canvas meta is available
  useEffect(() => {
    if (
      canvasContainerRef.current &&
      canvasMeta &&
      canvasMeta?.width &&
      canvasMeta?.height
    ) {
      // Connect to WebSocket now that everything is initialized
      if (shouldConnectRef.current && connectWebSocketRef.current) {
        connectWebSocketRef.current();
      }
    }
  }, [canvasMeta, canvasContainerRef]);

  // Synchronize temp container ref with real container ref
  useEffect(() => {
    if (canvasContainerRef.current) {
      tempCanvasContainerRef.current = canvasContainerRef.current;
    }
  }, [canvasContainerRef]);



  // Add keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key === "z" && !e.shiftKey) {
          e.preventDefault();
          if (historyState.canUndo) {
            undo();
          }
        } else if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
          e.preventDefault();
          if (historyState.canRedo) {
            redo();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo, historyState.canUndo, historyState.canRedo]);

  // No longer need to expose functions to window - using proper module imports

  return (
    <>
      <div className="w-full app-container flex flex-col">
        <InitializationErrorModal
          isOpen={!!initializationError}
          errorMessage={initializationError || ""}
          onRetry={() => window.location.reload()}
        />

        <LoadingModal isOpen={!canvasMeta && !initializationError} />

        <AuthErrorModal
          isOpen={authError}
          onGoToLobby={() => (window.location.href = "/collaborate")}
        />

        <RoomFullModal
          isOpen={!!roomFullError}
          currentUserCount={roomFullError?.currentUserCount || 0}
          maxUsers={roomFullError?.maxUsers || 0}
          onGoToLobby={() => (window.location.href = "/collaborate")}
          onRetry={() => window.location.reload()}
        />

        {/* Session Header */}
        {canvasMeta && (
          <SessionHeader
            canvasMeta={canvasMeta}
            connectionState={connectionState}
            isCatchingUp={isCatchingUp}
          />
        )}

        <div className="flex-1 flex overflow-hidden">
          {/* Chat travels with the toolbox so it can be moved out of the canvas. */}
          <NeoWindow
            initialPosition={{ x: 16, y: 70 }}
            className="z-40 w-56"
            title={<Trans>Chat</Trans>}
            resizable
            initialSize={{ width: 224, height: 607 }}
          >
            <Chat
              wsRef={wsRef}
              userId={userIdRef.current}
              participants={participants}
              onChatMessage={handleChatMessage}
              onAddMessage={handleChatAddMessage}
            />
          </NeoWindow>

          {/* Main Content Area */}
          <div className="flex-1 relative overflow-hidden">
            <div
              className="neo-ground flex gap-4 flex-row w-full h-full justify-center items-center"
              ref={appRef}
            >
              <ConnectionStatusModal
                isCatchingUp={isCatchingUp}
                connectionState={connectionState}
                onReconnect={handleManualReconnect}
                onDownloadPNG={downloadCanvasAsPNG}
              />
              {canvasMeta?.width && canvasMeta?.height && (
                <div
                  ref={canvasContainerRef}
                  className={`relative mx-auto border border-main bg-white touch-none select-none canvas-container ${
                    drawingState.brushType === "pan"
                      ? "cursor-grab active:cursor-grabbing"
                      : "cursor-crosshair"
                  }`}
                  style={{
                    width: `${canvasMeta.width}px`,
                    height: `${canvasMeta.height}px`,
                    minWidth: `${canvasMeta.width}px`,
                    minHeight: `${canvasMeta.height}px`,
                    maxWidth: `${canvasMeta.width}px`,
                    maxHeight: `${canvasMeta.height}px`,
                    flexShrink: 0,
                  }}
                >
                  <div className="canvas-content absolute inset-0">
                    {/* Local user interaction canvas for drawing events - positioned last in DOM to be on top */}
                    <canvas
                    id="canvas"
                    ref={tempLocalUserCanvasRef}
                    width={canvasMeta.width}
                    height={canvasMeta.height}
                    className="absolute top-0 left-0 pointer-events-auto canvas-bg"
                    style={{
                      width: `${canvasMeta.width}px`,
                      height: `${canvasMeta.height}px`,
                    }}
                    onPointerDown={() =>
                      console.log("Interaction canvas pointer down")
                    }
                    />
                  {/* Layer canvases for all users (including local) will be dynamically created here */}
                  {textAt && (
                    <div
                      ref={textBoxRef}
                      contentEditable
                      suppressContentEditableWarning
                      onKeyDown={handleTextKey}
                      onBlur={() => setTextAt(null)}
                      className="absolute whitespace-pre outline outline-1 outline-dashed outline-(--neo-tool-frame) outline-offset-[1px]"
                      style={{
                        left: `${textAt.x}px`,
                        // fillText draws from the baseline, so lift the box to
                        // sit where the glyphs will land
                        top: `${textAt.y - fontSizeForBrush(drawingState.brushSize)}px`,
                        fontFamily: TEXT_FONT_FAMILY,
                        fontSize: `${fontSizeForBrush(drawingState.brushSize)}px`,
                        lineHeight: `${fontSizeForBrush(drawingState.brushSize)}px`,
                        color: drawingState.color,
                        zIndex: CANVAS_Z_INDEX.textEditor,
                        minWidth: "1em",
                      }}
                    />
                  )}
                  <canvas
                    ref={cursorCanvasRef}
                    width={Math.max(1, Math.round(canvasMeta.width * currentZoom))}
                    height={Math.max(1, Math.round(canvasMeta.height * currentZoom))}
                    className="absolute top-0 left-0 pointer-events-none"
                    style={{
                      width: `${canvasMeta.width * currentZoom}px`,
                      height: `${canvasMeta.height * currentZoom}px`,
                      transform: `scale(${1 / currentZoom})`,
                      transformOrigin: "top left",
                      zIndex: CANVAS_Z_INDEX.cursor,
                    }}
                  />
                  <canvas
                    ref={previewCanvasRef}
                    width={Math.max(1, Math.round(canvasMeta.width * currentZoom))}
                    height={Math.max(1, Math.round(canvasMeta.height * currentZoom))}
                    className="absolute top-0 left-0 pointer-events-none"
                    style={{
                      width: `${canvasMeta.width * currentZoom}px`,
                      height: `${canvasMeta.height * currentZoom}px`,
                      transform: `scale(${1 / currentZoom})`,
                      transformOrigin: "top left",
                      zIndex: CANVAS_Z_INDEX.preview,
                    }}
                  />
                  </div>
                </div>
              )}
              <ToolboxPanels
                // Opens inside the painter area, below whatever the page
                // puts above it
                anchorRef={appRef}
                // Every tool the wire format can carry
                tools={SHARED_TOOLS}
                drawingState={drawingState}
                historyState={historyState}
                paletteColors={paletteColors}
                selectedPaletteIndex={selectedPaletteIndex}
                currentZoom={currentZoom}
                isOwner={!!isOwner}
                isSaving={isSaving}
                sessionEnded={sessionEnded}
                onUndo={undo}
                onRedo={redo}
                onUpdateBrushType={updateBrushType}
                onUpdateDrawingState={setDrawingState}
                onUpdateColor={updateColor}
                onSetSelectedPaletteIndex={setSelectedPaletteIndex}
                onSetPaletteColor={setPaletteColor}
                onZoomIn={() => handleZoomIn()}
                onZoomOut={() => handleZoomOut()}
                onZoomReset={handleZoomReset}
                onZoomFit={handleZoomFit}
                onSaveCollaborativeDrawing={saveCollaborativeDrawing}
              />
            </div>

            <SessionEndingModal isOpen={sessionEnded} />
          </div>
        </div>
      </div>

      <SessionExpiredModal
        isOpen={sessionExpired}
        isOwner={!!isOwner}
        canvasMeta={canvasMeta}
        isSaving={isSaving}
        onClose={() => setSessionExpired(false)}
        onSaveToGallery={saveCollaborativeDrawing}
        onDownloadPNG={downloadCanvasAsPNG}
        onReturnToLobby={() => (window.location.href = "/collaborate")}
      />
    </>
  );
}

export default App;
