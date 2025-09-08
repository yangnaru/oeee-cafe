import { i18n } from "@lingui/core";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { ToolboxPanel } from "./components/ToolboxPanel";
import { DrawingEngine } from "./DrawingEngine";
import { useDrawing } from "./hooks/useDrawing";
import { useDrawingState } from "./hooks/useDrawingState";
import { useZoomControls } from "./hooks/useZoomControls";
import { useCanvas } from "./hooks/useCanvas";
import { useWebSocket, type ConnectionState } from "./hooks/useWebSocket";
import { useCursor } from "./hooks/useCursor";
import { messages as enMessages } from "./locales/en/messages";
import { messages as jaMessages } from "./locales/ja/messages";
import { messages as koMessages } from "./locales/ko/messages";
import { messages as zhMessages } from "./locales/zh/messages";
import { encodeEndSession } from "./utils/binaryProtocol";

// Initialize i18n with locale messages
const localeMessages = {
  en: enMessages,
  ko: koMessages,
  ja: jaMessages,
  zh: zhMessages,
};

const setupI18n = (locale: string) => {
  const messages =
    localeMessages[locale as keyof typeof localeMessages] || localeMessages.en;
  i18n.load(locale, messages);
  i18n.activate(locale);
};

// Initialize i18n with default locale (English) to prevent destructuring errors
setupI18n("en");

/*
 * Backend endpoints required:
 *
 * GET /api/auth
 * - Returns: { user_id: string, login_name: string } on success (200)
 * - Returns: { error: string } on auth failure (401)
 * - Used to authenticate and get user information
 * - On 401 response, automatically redirects to login page
 *
 * GET /api/collaboration/{uuid}/meta
 * - Returns: { title: string, width: number, height: number, ownerId: string, savedPostId?: string, ownerLoginName: string }
 * - Used to get collaboration session metadata including canvas dimensions
 * - If savedPostId is not null, the session has been saved and should redirect
 * - This replaces getting dimensions from URL query parameters
 */

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
    handleColorPickerChange,
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
  const [isChatMinimized, setIsChatMinimized] = useState(false);

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

  // Track user IDs and their drawing engines (using ref to avoid re-renders)
  const userEnginesRef = useRef<
    Map<
      string,
      {
        engine: DrawingEngine;
        firstSeen: number;
        canvas: HTMLCanvasElement;
        username: string;
      }
    >
  >(new Map());

  // Track server-provided user order for layer compositing
  const userOrderRef = useRef<string[]>([]);

  const appRef = useRef<HTMLDivElement>(null);
  const userIdRef = useRef<string>("");
  const userLoginNameRef = useRef<string>("");
  const localUserJoinTimeRef = useRef<number>(0);

  // Check if current user is the session owner
  const isOwner = canvasMeta && userIdRef.current === canvasMeta.ownerId;

  // Participant management functions (moved from Chat.tsx)
  const addParticipant = useCallback(
    (userId: string, username: string, timestamp: number) => {
      setParticipants((prev) => {
        const newParticipants = new Map(prev);
        newParticipants.set(userId, { userId, username, joinedAt: timestamp });
        return newParticipants;
      });
    },
    []
  );

  const removeParticipant = useCallback((userId: string) => {
    setParticipants((prev) => {
      const newParticipants = new Map(prev);
      newParticipants.delete(userId);
      return newParticipants;
    });
  }, []);

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

  // Create a stable wsRef that will be populated by useWebSocket
  const drawingWsRef = useRef<WebSocket | null>(null);

  // Use the drawing hook with stable wsRef
  const {
    undo,
    redo,
    drawingEngine,
    addSnapshotToHistory,
    markDrawingComplete,
    handleSnapshotRequest,
  } = useDrawing(
    tempLocalUserCanvasRef,
    appRef,
    drawingState,
    handleHistoryChange,
    100, // Default zoom level, will be updated by zoom controls
    canvasMeta?.width,
    canvasMeta?.height,
    drawingWsRef, // Stable wsRef that gets populated later
    userIdRef,
    handleLocalDrawingChange,
    isCatchingUp,
    connectionState,
    tempCanvasContainerRef
  );

  // Zoom controls
  const { currentZoom, handleZoomIn, handleZoomOut, handleZoomReset } =
    useZoomControls({
      canvasContainerRef: tempCanvasContainerRef,
      appRef,
      drawingEngine,
      setDrawingState,
    });

  // Canvas management (after drawing engine is available)
  const {
    canvasContainerRef,
    createUserEngine,
    compositeCanvasesForExport,
    downloadCanvasAsPNG,
  } = useCanvas({
    canvasMeta,
    userOrderRef,
    userEnginesRef,
    drawingEngine,
    userIdRef,
    currentZoom,
    drawingState,
  });

  // Keep drawingEngine ref in sync to avoid circular dependencies
  const drawingEngineRef = useRef(drawingEngine);
  useEffect(() => {
    drawingEngineRef.current = drawingEngine;
  }, [drawingEngine]);

  // Cursor management
  const { createOrUpdateCursor, hideCursor } = useCursor({
    canvasContainerRef,
    userIdRef,
  });

  // WebSocket management
  const { wsRef, connectWebSocket } = useWebSocket({
    canvasMeta,
    userIdRef,
    userLoginNameRef,
    localUserJoinTimeRef,
    drawingEngineRef,
    userEnginesRef,
    participantsRef,
    shouldConnectRef,
    catchupTimeoutRef,
    processingMessageRef,
    isCatchingUpRef,
    setConnectionState,
    setIsCatchingUp,
    createUserEngine,
    handleLocalDrawingChange,
    addSnapshotToHistory,
    markDrawingComplete,
    createOrUpdateCursor,
    hideCursor,
    addParticipant,
    removeParticipant,
    addChatMessage: (message) => {
      if (chatAddMessageRef.current) {
        chatAddMessageRef.current(message);
      }
    },
    handleSnapshotRequest,
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
    });
    drawingWsRef.current = wsRef.current;
  }, [wsRef]);

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

  // Keep handleSnapshotRequest ref in sync to avoid circular dependencies
  const handleSnapshotRequestRef = useRef(handleSnapshotRequest);
  useEffect(() => {
    handleSnapshotRequestRef.current = handleSnapshotRequest;
  }, [handleSnapshotRequest]);

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

      // Set up internationalization with preferred locale
      if (authInfo.preferred_locale) {
        setupI18n(authInfo.preferred_locale);
      }

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

  // Apply pending pan adjustments after zoom level changes
  useEffect(() => {
    if (
      drawingState.pendingPanDeltaX !== undefined ||
      drawingState.pendingPanDeltaY !== undefined
    ) {
      // Use requestAnimationFrame to ensure canvas has been resized first
      requestAnimationFrame(() => {
        if (drawingEngine) {
          drawingEngine.adjustPanForZoom(
            drawingState.pendingPanDeltaX || 0,
            drawingState.pendingPanDeltaY || 0,
            canvasContainerRef.current || undefined,
            currentZoom
          );
        }

        // Clear the pending deltas
        setDrawingState((prev) => ({
          ...prev,
          pendingPanDeltaX: undefined,
          pendingPanDeltaY: undefined,
        }));
      });
    }
  }, [
    drawingState.pendingPanDeltaX,
    drawingState.pendingPanDeltaY,
    drawingState.zoomLevel,
    drawingEngine,
    currentZoom,
    setDrawingState,
    canvasContainerRef,
  ]);

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
          {/* Left Sidebar */}
          <div
            className={`${
              isChatMinimized ? "w-12" : "w-72"
            } bg-main border-r border-main flex flex-col transition-all duration-300`}
          >
            <Chat
              wsRef={wsRef}
              userId={userIdRef.current}
              participants={participants}
              onChatMessage={handleChatMessage}
              onMinimizedChange={setIsChatMinimized}
              onAddMessage={handleChatAddMessage}
            />
          </div>

          {/* Main Content Area */}
          <div className="flex-1 relative overflow-hidden">
            <div
              className="flex gap-4 flex-row w-full h-full bg-main justify-center items-center"
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
                </div>
              )}
              <ToolboxPanel
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
                onColorPickerChange={handleColorPickerChange}
                onSetSelectedPaletteIndex={setSelectedPaletteIndex}
                onZoomIn={() => handleZoomIn()}
                onZoomOut={() => handleZoomOut()}
                onZoomReset={handleZoomReset}
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
