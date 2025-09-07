import { i18n } from "@lingui/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { type CollaborationMeta, type Participant } from "./types/collaboration";
import { ToolboxPanel } from "./components/ToolboxPanel";
import { DrawingEngine } from "./DrawingEngine";
import { useDrawing } from "./hooks/useDrawing";
import { useDrawingState } from "./hooks/useDrawingState";
import { useZoomControls } from "./hooks/useZoomControls";
import { messages as enMessages } from "./locales/en/messages";
import { messages as jaMessages } from "./locales/ja/messages";
import { messages as koMessages } from "./locales/ko/messages";
import { messages as zhMessages } from "./locales/zh/messages";
import {
  decodeMessage,
  encodeEndSession,
  encodeJoin,
  type DecodedMessage,
} from "./utils/binaryProtocol";
import { pngDataToLayer } from "./utils/canvasSnapshot";
import { getUserBackgroundColor } from "./utils/userColors";

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

  // Keep ref in sync with state
  useEffect(() => {
    isCatchingUpRef.current = isCatchingUp;
  }, [isCatchingUp]);

  // Message queue for sequential processing during catch-up
  const messageQueueRef = useRef<DecodedMessage[]>([]);
  const processingMessageRef = useRef(false);

  // Track connection state for reconnection logic
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const shouldConnectRef = useRef(false);

  // Track authentication state
  const [authError, setAuthError] = useState(false);
  const [roomFullError, setRoomFullError] = useState<{
    currentUserCount: number;
    maxUsers: number;
  } | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
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

  // Track active drawing cursors for remote users
  const activeCursorsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  // Track server-provided user order for layer compositing
  const userOrderRef = useRef<string[]>([]);

  // Function to create DOM canvas elements for a user (foreground and background)
  const createUserCanvasElements = useCallback(
    (userId: string, insertionIndex: number) => {
      console.log("createUserCanvasElements called for:", userId, {
        containerExists: !!canvasContainerRef.current,
        canvasWidth: canvasMeta?.width,
        canvasHeight: canvasMeta?.height,
      });

      if (
        !canvasContainerRef.current ||
        !canvasMeta?.width ||
        !canvasMeta?.height
      ) {
        console.log("Cannot create canvases - missing requirements");
        return null;
      }

      // Create background canvas
      const bgCanvas = document.createElement("canvas");
      bgCanvas.width = canvasMeta.width;
      bgCanvas.height = canvasMeta.height;
      bgCanvas.className = "absolute top-0 left-0 canvas-bg";
      bgCanvas.style.pointerEvents = "none"; // Background never handles events
      bgCanvas.style.width = `${canvasMeta.width}px`; // Set base dimensions - container handles zoom
      bgCanvas.style.height = `${canvasMeta.height}px`;
      bgCanvas.id = `bg-${userId}`;

      const bgCtx = bgCanvas.getContext("2d");
      if (bgCtx) {
        bgCtx.imageSmoothingEnabled = false;
      }

      // Create foreground canvas
      const fgCanvas = document.createElement("canvas");
      fgCanvas.width = canvasMeta.width;
      fgCanvas.height = canvasMeta.height;
      fgCanvas.className = "absolute top-0 left-0 canvas-bg";
      fgCanvas.style.pointerEvents = "none"; // Events handled by interaction canvas
      fgCanvas.style.width = `${canvasMeta.width}px`; // Set base dimensions - container handles zoom
      fgCanvas.style.height = `${canvasMeta.height}px`;
      fgCanvas.id = `fg-${userId}`;

      const fgCtx = fgCanvas.getContext("2d");
      if (fgCtx) {
        fgCtx.imageSmoothingEnabled = false;
      }

      console.log(
        `Creating canvases for user ${userId}, inserting at position ${insertionIndex}`
      );

      const container = canvasContainerRef.current;
      const interactionCanvas = container.querySelector("#canvas"); // Find interaction canvas

      // Set z-index based on user order from server
      // Earlier users (lower index in userOrderRef) should appear on top (higher z-index)
      // Later users (higher index in userOrderRef) should appear below (lower z-index)
      const userIndex = userOrderRef.current.indexOf(userId);
      const baseZIndex = userIndex !== -1 ? 1000 - userIndex * 10 : 100; // Higher index = lower z-index

      // Background layer gets base z-index, foreground gets +1
      bgCanvas.style.zIndex = baseZIndex.toString();
      fgCanvas.style.zIndex = (baseZIndex + 1).toString();

      // Simple insertion before interaction canvas
      if (interactionCanvas) {
        container.insertBefore(bgCanvas, interactionCanvas);
        container.insertBefore(fgCanvas, interactionCanvas);
      } else {
        container.appendChild(bgCanvas);
        container.appendChild(fgCanvas);
      }

      // Store both canvases
      userCanvasRefs.current.set(`${userId}-bg`, bgCanvas);
      userCanvasRefs.current.set(`${userId}-fg`, fgCanvas);

      console.log(`Created canvases for user ${userId}`);

      return { bgCanvas, fgCanvas };
    },
    [canvasMeta?.width, canvasMeta?.height]
  );

  // Function to create drawing engine for a new user
  const createUserEngine = useCallback(
    (userId: string, username?: string) => {
      // Only create user engines when canvas dimensions are available
      if (!canvasMeta?.width || !canvasMeta?.height) {
        return;
      }

      // Check if user already exists
      const existingUser = userEnginesRef.current.get(userId);
      if (existingUser) {
        // Update username if provided
        if (username && existingUser.username !== username) {
          existingUser.username = username;
        }
        return;
      }

      // Create new DrawingEngine for this user
      const engine = new DrawingEngine(canvasMeta.width, canvasMeta.height);
      const firstSeen = Date.now();

      // Create DOM canvases for this user and attach to container (only if they don't exist)
      const existingBgCanvas = userCanvasRefs.current.get(`${userId}-bg`);
      const existingFgCanvas = userCanvasRefs.current.get(`${userId}-fg`);

      let canvasElements = null;
      if (!existingBgCanvas || !existingFgCanvas) {
        canvasElements = createUserCanvasElements(userId, 0);
      } else {
        canvasElements = {
          bgCanvas: existingBgCanvas,
          fgCanvas: existingFgCanvas,
        };
      }

      if (canvasElements) {
        // Attach DOM canvases to the drawing engine
        engine.attachDOMCanvases(
          canvasElements.bgCanvas,
          canvasElements.fgCanvas
        );

        // Update DOM canvases to show any existing content (immediate for initialization)
        engine.updateAllDOMCanvasesImmediate();

        // Set up initial layer visibility (local user visibility will be managed by separate useEffect)
        canvasElements.bgCanvas.style.display = "block";
        canvasElements.fgCanvas.style.display = "block";
      }

      // Create offscreen canvas for this user (still needed for drawing operations)
      const canvas = document.createElement("canvas");
      canvas.width = canvasMeta.width;
      canvas.height = canvasMeta.height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = false;
        engine.initialize(ctx);
      }

      userEnginesRef.current.set(userId, {
        engine,
        firstSeen,
        canvas,
        username: username || userId,
      });
    },
    [canvasMeta?.width, canvasMeta?.height, createUserCanvasElements]
  );

  // Function to update z-indices for all existing canvases based on current user order
  const updateCanvasZIndices = useCallback(() => {
    userCanvasRefs.current.forEach((canvas, key) => {
      const userId = key.replace(/-(bg|fg)$/, "");
      const isBackground = key.endsWith("-bg");
      const userIndex = userOrderRef.current.indexOf(userId);

      if (userIndex !== -1) {
        const baseZIndex = 1000 - userIndex * 10;
        canvas.style.zIndex = (baseZIndex + (isBackground ? 0 : 1)).toString();
        console.log(`Updated z-index for ${key}: ${canvas.style.zIndex}`);
      }
    });
  }, []);

  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const userCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const localUserCanvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const userIdRef = useRef<string>("");
  const userLoginNameRef = useRef<string>("");
  const localUserJoinTimeRef = useRef<number>(0);

  // Check if current user is the session owner
  const isOwner = canvasMeta && userIdRef.current === canvasMeta.ownerId;

  // Function to create or update cursor icon for a remote user
  const createOrUpdateCursor = useCallback(
    (userId: string, x: number, y: number, username: string) => {
      if (!canvasContainerRef.current || userId === userIdRef.current) {
        return; // Don't show cursor for local user
      }

      const container = canvasContainerRef.current;
      let cursorElement = activeCursorsRef.current.get(userId);

      if (!cursorElement) {
        // Create new cursor element container
        cursorElement = document.createElement("div");
        cursorElement.className =
          "absolute pointer-events-none z-[2000] flex flex-col items-center";
        cursorElement.style.transition = "opacity 0.3s ease-out";
        cursorElement.style.opacity = "1";

        // Create username label
        const userLabel = document.createElement("div");
        userLabel.className =
          "text-xs font-bold px-2 py-1 rounded mb-1 whitespace-nowrap";
        userLabel.textContent = username;
        const userBackgroundColor = getUserBackgroundColor(username);
        console.log(
          `Cursor getUserBackgroundColor for "${username}":`,
          userBackgroundColor
        ); // Debug logging
        userLabel.style.color = userBackgroundColor;
        userLabel.style.backgroundColor = "rgba(255, 255, 255, 0.9)";
        userLabel.style.border = `1px solid ${userBackgroundColor}`;
        userLabel.style.fontSize = "10px";
        userLabel.setAttribute("data-username-element", "true"); // Mark this as the username element
        cursorElement.appendChild(userLabel);

        // Create icon element
        const iconElement = document.createElement("div");
        iconElement.className = "flex items-center justify-center";
        iconElement.style.width = "24px";
        iconElement.style.height = "24px";
        iconElement.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24"><path fill="${getUserBackgroundColor(
          username
        )}" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5s-1.12 2.5-2.5 2.5z"/></svg>`;
        cursorElement.appendChild(iconElement);

        container.appendChild(cursorElement);
        activeCursorsRef.current.set(userId, cursorElement);
      }

      // Position the cursor (convert canvas coordinates to screen coordinates)
      const canvasStyle = window.getComputedStyle(container);

      // Get zoom level and pan offset from transform
      let scale = 1;
      let panX = 0;
      let panY = 0;

      if (canvasStyle.transform && canvasStyle.transform !== "none") {
        const matrix = new DOMMatrix(canvasStyle.transform);
        scale = matrix.a; // Get scale from transform matrix
        panX = matrix.e; // Get X translation
        panY = matrix.f; // Get Y translation
      }

      // Position cursor at the drawing coordinate, accounting for zoom and pan
      const screenX = x * scale + panX;
      const screenY = y * scale + panY;

      // Get the actual size of the cursor element to center it properly
      const cursorRect = cursorElement.getBoundingClientRect();
      const cursorWidth = cursorRect.width || 24; // Fallback to 24px if not measured yet

      // Position the cursor so the pin point of the location icon is exactly at the drawing coordinates
      // The location icon has its pin point at approximately 75% down from the top of the icon
      // Username label is ~16px height (10px font + 6px padding), icon is 24px height
      const usernameLabelHeight = 16; // More accurate measurement
      const iconHeight = 24;
      const pinPointOffset = iconHeight * 1.3; // Pin point is at ~75% down from top of icon

      const totalOffsetY = usernameLabelHeight + pinPointOffset;
      cursorElement.style.left = `${screenX - cursorWidth / 2}px`; // Center horizontally
      cursorElement.style.top = `${screenY - totalOffsetY}px`; // Position so the pin point is at the drawing coordinates
      cursorElement.style.opacity = "1";

      // Update username label if we have a different/better username
      const userLabel = cursorElement.querySelector(
        '[data-username-element="true"]'
      ) as HTMLElement;
      if (userLabel && userLabel.textContent !== username) {
        userLabel.textContent = username;
        userLabel.style.color = getUserBackgroundColor(username);
        userLabel.style.border = `1px solid ${getUserBackgroundColor(
          username
        )}`;

        // Also update the icon color
        const svgPath = cursorElement.querySelector(
          "svg path"
        ) as SVGPathElement;
        if (svgPath) {
          svgPath.setAttribute("fill", getUserBackgroundColor(username));
        }
      }

      // Clear any existing fadeout timeout
      const timeoutId = cursorElement.dataset.timeoutId;
      if (timeoutId) {
        clearTimeout(parseInt(timeoutId));
        delete cursorElement.dataset.timeoutId;
      }
    },
    []
  );

  // Function to hide cursor with fadeout effect
  const hideCursor = useCallback((userId: string) => {
    const cursorElement = activeCursorsRef.current.get(userId);
    if (cursorElement && cursorElement.style.opacity !== "0") {
      cursorElement.style.opacity = "0";

      // Remove element after fadeout completes
      const timeoutId = setTimeout(() => {
        if (cursorElement.parentNode) {
          cursorElement.parentNode.removeChild(cursorElement);
        }
        activeCursorsRef.current.delete(userId);
      }, 300); // Match CSS transition duration

      cursorElement.dataset.timeoutId = timeoutId.toString();
    }
  }, []);

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

  // Callback to trigger unified compositing when local drawing changes
  const handleLocalDrawingChange = useCallback(() => {
    console.log("Local drawing changed");
    // No longer needed - browser handles compositing automatically
  }, []);

  // Use the drawing hook with local user canvas
  const {
    undo,
    redo,
    drawingEngine,
    addSnapshotToHistory,
    markDrawingComplete,
    handleSnapshotRequest,
  } = useDrawing(
    localUserCanvasRef,
    appRef,
    drawingState,
    handleHistoryChange,
    100, // Default zoom level, will be updated by zoom controls
    canvasMeta?.width,
    canvasMeta?.height,
    wsRef,
    userIdRef,
    handleLocalDrawingChange,
    isCatchingUp,
    connectionState,
    canvasContainerRef
  );

  // Zoom controls
  const { currentZoom, handleZoomIn, handleZoomOut, handleZoomReset } =
    useZoomControls({
      canvasContainerRef,
      appRef,
      drawingEngine,
      setDrawingState,
    });

  // Keep drawingEngine ref in sync to avoid circular dependencies
  const drawingEngineRef = useRef(drawingEngine);
  useEffect(() => {
    drawingEngineRef.current = drawingEngine;
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

  // Function to composite all canvases for export only
  const compositeCanvasesForExport = useCallback(() => {
    if (!canvasMeta?.width || !canvasMeta?.height) return null;

    // Create a temporary canvas for compositing
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvasMeta.width;
    tempCanvas.height = canvasMeta.height;
    const tempCtx = tempCanvas.getContext("2d");

    if (!tempCtx) return null;

    // Composite all user layer canvases onto the temp canvas in z-index order
    const canvasElements = Array.from(userCanvasRefs.current.entries()).map(
      ([key, canvas]) => ({
        key,
        canvas,
        zIndex: parseInt(canvas.style.zIndex) || 0,
        isBackground: key.endsWith("-bg"),
      })
    );

    // Sort by z-index (lower z-index drawn first, appears below)
    canvasElements.sort((a, b) => a.zIndex - b.zIndex);

    // Draw all layers in z-index order
    canvasElements.forEach(({ canvas }) => {
      if (canvas.style.display !== "none") {
        tempCtx.drawImage(canvas, 0, 0);
      }
    });

    return tempCanvas;
  }, [canvasMeta]);

  // Function to download current canvas as PNG
  const downloadCanvasAsPNG = useCallback(() => {
    if (!canvasMeta?.width || !canvasMeta?.height) return;

    try {
      // Use the composite function to create a single canvas with all layers
      const tempCanvas = compositeCanvasesForExport();
      if (!tempCanvas) return;

      // Create download link
      const link = document.createElement("a");
      link.download = `canvas-${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/:/g, "-")}.png`;
      link.href = tempCanvas.toDataURL("image/png");

      // Trigger download
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("Error in downloadCanvasAsPNG:", error);
    }
  }, [compositeCanvasesForExport, canvasMeta?.width, canvasMeta?.height]);

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
  }, [isSaving, compositeCanvasesForExport]);

  // Function to get WebSocket URL dynamically
  const getWebSocketUrl = useCallback(() => {
    console.log("Generating WebSocket URL:", {
      currentUrl: window.location.href,
      pathname: window.location.pathname,
      protocol: window.location.protocol,
      host: window.location.host,
      isDev: import.meta.env.DEV,
      viteWsUrl: import.meta.env.VITE_WS_URL,
    });

    // Option 1: Use environment variable if set
    if (import.meta.env.VITE_WS_URL) {
      console.log(
        "Using environment WebSocket URL:",
        import.meta.env.VITE_WS_URL
      );
      return import.meta.env.VITE_WS_URL;
    }

    // Option 2: Build dynamically from current location
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;

    // Extract session UUID from path (/collaborate/{uuid})
    const pathSegments = window.location.pathname.split("/");
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    console.log("URL path analysis:", {
      pathSegments: pathSegments,
      sessionSegment: pathSegments[2],
      isValidUuid: pathSegments[2] ? uuidPattern.test(pathSegments[2]) : false,
    });

    if (
      pathSegments[1] === "collaborate" &&
      pathSegments[2] &&
      uuidPattern.test(pathSegments[2])
    ) {
      const sessionId = pathSegments[2];
      const wsUrl = `${protocol}//${host}/collaborate/${sessionId}/ws`;

      console.log("Generated WebSocket URL:", wsUrl);
      return wsUrl;
    }

    // Fallback - should not happen in normal usage
    const error = new Error("Invalid collaborative session URL");
    console.error("Failed to generate WebSocket URL:", {
      error: error.message,
      pathname: window.location.pathname,
      pathSegments: pathSegments,
    });
    throw error;
  }, []);

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
  }, []);

  const connectWebSocket = useCallback(async () => {
    console.log("WebSocket connection attempt started:", {
      shouldConnect: shouldConnectRef.current,
      existingConnection: !!wsRef.current,
      currentUser: userIdRef.current,
      timestamp: new Date().toISOString(),
    });

    // Only connect if we should be connecting
    if (!shouldConnectRef.current && wsRef.current) {
      console.log("Connection attempt aborted - should not connect");
      return;
    }

    // Clean up any existing connection
    if (wsRef.current) {
      console.log("Cleaning up existing WebSocket connection");
      wsRef.current.close();
      wsRef.current = null;
    }

    setConnectionState("connecting");

    // Check if we have user ID and canvas meta - don't proceed if not initialized
    if (!userIdRef.current || !canvasMeta) {
      console.error(
        "App not properly initialized - missing user ID or canvas meta"
      );
      setConnectionState("disconnected");
      return;
    }

    console.log("Using initialized user ID:", userIdRef.current);

    try {
      const wsUrl = getWebSocketUrl();
      console.log("Creating WebSocket connection to:", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
    } catch (error) {
      console.error("Failed to create WebSocket:", {
        error: error,
        message: error instanceof Error ? error.message : String(error),
      });
      setConnectionState("disconnected");
      return;
    }

    const ws = wsRef.current!;

    ws.onopen = () => {
      console.log("WebSocket connected successfully:", {
        url: ws.url,
        readyState: ws.readyState,
        timestamp: new Date().toISOString(),
      });
      setConnectionState("connected");

      // Add current user to participants
      addParticipant(userIdRef.current, userLoginNameRef.current, Date.now());

      // Send initial join message to establish user presence and layer order
      try {
        const binaryMessage = encodeJoin(userIdRef.current, Date.now());
        ws.send(binaryMessage);
      } catch (error) {
        console.error("Failed to send join message:", error);
      }

      // Start catching up phase - drawing will be disabled
      setIsCatchingUp(true);

      // Set a timeout to end catching up phase if no more messages arrive
      if (catchupTimeoutRef.current) {
        clearTimeout(catchupTimeoutRef.current);
      }
      catchupTimeoutRef.current = window.setTimeout(() => {
        setIsCatchingUp(false);
        console.log("Catch-up phase completed");
      }, 1000); // 1 second timeout for catch-up

      // Set join timestamp after a short delay to let stored messages arrive first
      setTimeout(() => {
        if (localUserJoinTimeRef.current === 0) {
          // Only set if not already set
          localUserJoinTimeRef.current = Date.now();
        }
      }, 100); // 100ms should be enough for stored messages
    };

    ws.onmessage = async (event) => {
      try {
        // Reset catch-up timeout on any message received
        if (catchupTimeoutRef.current) {
          clearTimeout(catchupTimeoutRef.current);
          catchupTimeoutRef.current = window.setTimeout(() => {
            setIsCatchingUp(false);
            console.log("Catch-up phase completed");
          }, 500); // 500ms timeout after last message
        }

        // Handle binary messages (can be ArrayBuffer or Blob)
        if (event.data instanceof ArrayBuffer) {
          const message = decodeMessage(event.data);
          if (!message) {
            return;
          }

          if (isCatchingUpRef.current) {
            // During catch-up, queue messages for sequential processing
            messageQueueRef.current.push(message);
            processMessageQueue();
          } else {
            // During normal operation, process immediately
            // Create drawing engine for new user if they don't exist (skip for messages without userId)
            if ("userId" in message && message.userId) {
              const username =
                "username" in message ? message.username : message.userId;
              createUserEngine(message.userId, username);
            }

            // Handle message types
            await handleBinaryMessage(message);
          }
        } else if (event.data instanceof Blob) {
          const arrayBuffer = await event.data.arrayBuffer();
          const message = decodeMessage(arrayBuffer);
          if (!message) {
            return;
          }

          if (isCatchingUpRef.current) {
            // During catch-up, queue messages for sequential processing
            messageQueueRef.current.push(message);
            processMessageQueue();
          } else {
            // During normal operation, process immediately
            // Create drawing engine for new user if they don't exist (skip for messages without userId)
            if ("userId" in message && message.userId) {
              const username =
                "username" in message ? message.username : message.userId;
              createUserEngine(message.userId, username);
            }

            // Handle message types
            await handleBinaryMessage(message);
          }
        }
      } catch (error) {
        console.error("Failed to decode WebSocket message:", error);
      }
    };

    ws.onerror = (event) => {
      console.error("WebSocket error details:", {
        readyState: ws.readyState,
        url: ws.url,
        event: event,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
      });
      setConnectionState("disconnected");
    };

    ws.onclose = (event) => {
      console.log("WebSocket closed details:", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        url: ws.url,
        timestamp: new Date().toISOString(),
        readyState: ws.readyState,
        shouldConnect: shouldConnectRef.current,
      });
      setConnectionState("disconnected");
      // No automatic reconnection - user must manually reconnect
    };

    // Process messages sequentially from the queue during catch-up
    const processMessageQueue = async () => {
      if (
        processingMessageRef.current ||
        messageQueueRef.current.length === 0
      ) {
        return;
      }

      processingMessageRef.current = true;

      while (messageQueueRef.current.length > 0) {
        const message = messageQueueRef.current.shift()!;

        // Create drawing engine for new user if they don't exist (skip for messages without userId)
        if ("userId" in message && message.userId) {
          createUserEngine(message.userId);
        }

        // Handle message types sequentially
        await handleBinaryMessage(message);
      }

      processingMessageRef.current = false;
    };

    // Helper function to handle decoded binary messages (moved inside connectWebSocket)
    const handleBinaryMessage = async (message: DecodedMessage) => {
      try {
        // Handle different message types
        switch (message.type) {
          case "drawLine": {
            console.log("Drawing event - drawLine", message);
            // Check if this is the local user's drawing event
            if (
              message.userId === userIdRef.current &&
              drawingEngineRef.current
            ) {
              const targetLayer =
                message.layer === "foreground"
                  ? drawingEngineRef.current.layers.foreground
                  : drawingEngineRef.current.layers.background;

              drawingEngineRef.current.drawLine(
                targetLayer,
                message.fromX,
                message.fromY,
                message.toX,
                message.toY,
                message.brushSize,
                message.brushType,
                message.color.r,
                message.color.g,
                message.color.b,
                message.color.a
              );

              // Queue DOM canvases for batched update for local drawing
              drawingEngineRef.current.queueLayerUpdate(
                message.layer as "foreground" | "background"
              );

              // Mark drawing operation as complete to prevent double-saving in pointerup
              markDrawingComplete();

              // Notify parent component that drawing has changed
              handleLocalDrawingChange();
            } else {
              // Handle remote user's drawing event
              const userEngine = userEnginesRef.current.get(message.userId);
              if (userEngine) {
                const engine = userEngine.engine;
                const targetLayer =
                  message.layer === "foreground"
                    ? engine.layers.foreground
                    : engine.layers.background;

                engine.drawLine(
                  targetLayer,
                  message.fromX,
                  message.fromY,
                  message.toX,
                  message.toY,
                  message.brushSize,
                  message.brushType,
                  message.color.r,
                  message.color.g,
                  message.color.b,
                  message.color.a
                );

                // Queue DOM canvases for batched update for remote drawing
                engine.queueLayerUpdate(
                  message.layer as "foreground" | "background"
                );

                // Show cursor at the end position of the line
                const participant = participantsRef.current.get(message.userId);
                const username = participant?.username || userEngine.username;
                createOrUpdateCursor(
                  message.userId,
                  message.toX,
                  message.toY,
                  username
                );
              }
            }
            break;
          }

          case "drawPoint": {
            console.log("Drawing event - drawPoint:", {
              userId: message.userId.substring(0, 8),
              isLocalUser: message.userId === userIdRef.current,
              layer: message.layer,
              point: { x: message.x, y: message.y },
              brushSize: message.brushSize,
              brushType: message.brushType,
              color: message.color,
            });

            // Check if this is the local user's drawing event
            if (
              message.userId === userIdRef.current &&
              drawingEngineRef.current
            ) {
              const targetLayer =
                message.layer === "foreground"
                  ? drawingEngineRef.current.layers.foreground
                  : drawingEngineRef.current.layers.background;

              drawingEngineRef.current.drawLine(
                targetLayer,
                message.x,
                message.y,
                message.x,
                message.y,
                message.brushSize,
                message.brushType,
                message.color.r,
                message.color.g,
                message.color.b,
                message.color.a
              );

              // Queue DOM canvases for batched update for local drawing
              drawingEngineRef.current.queueLayerUpdate(
                message.layer as "foreground" | "background"
              );

              // Mark drawing operation as complete to prevent double-saving in pointerup
              markDrawingComplete();

              // Notify parent component that drawing has changed
              handleLocalDrawingChange();
            } else {
              // Handle remote user's drawing event
              const userEngine = userEnginesRef.current.get(message.userId);
              if (userEngine) {
                const engine = userEngine.engine;
                const targetLayer =
                  message.layer === "foreground"
                    ? engine.layers.foreground
                    : engine.layers.background;

                engine.drawLine(
                  targetLayer,
                  message.x,
                  message.y,
                  message.x,
                  message.y,
                  message.brushSize,
                  message.brushType,
                  message.color.r,
                  message.color.g,
                  message.color.b,
                  message.color.a
                );

                // Queue DOM canvases for batched update for remote drawing
                engine.queueLayerUpdate(
                  message.layer as "foreground" | "background"
                );

                // Show cursor at the drawing point
                const participant = participantsRef.current.get(message.userId);
                const username = participant?.username || userEngine.username;
                createOrUpdateCursor(
                  message.userId,
                  message.x,
                  message.y,
                  username
                );
              }
            }
            break;
          }

          case "fill": {
            console.log("Drawing event - fill:", {
              userId: message.userId.substring(0, 8),
              isLocalUser: message.userId === userIdRef.current,
              layer: message.layer,
              point: { x: message.x, y: message.y },
              color: message.color,
            });

            // Check if this is the local user's drawing event
            if (
              message.userId === userIdRef.current &&
              drawingEngineRef.current
            ) {
              const targetLayer =
                message.layer === "foreground"
                  ? drawingEngineRef.current.layers.foreground
                  : drawingEngineRef.current.layers.background;

              drawingEngineRef.current.doFloodFill(
                targetLayer,
                message.x,
                message.y,
                message.color.r,
                message.color.g,
                message.color.b,
                message.color.a
              );

              // Queue DOM canvases for batched update for local drawing
              drawingEngineRef.current.queueLayerUpdate(
                message.layer as "foreground" | "background"
              );

              // Notify parent component that drawing has changed
              handleLocalDrawingChange();
            } else {
              // Handle remote user's drawing event
              const userEngine = userEnginesRef.current.get(message.userId);
              if (userEngine) {
                const engine = userEngine.engine;
                const targetLayer =
                  message.layer === "foreground"
                    ? engine.layers.foreground
                    : engine.layers.background;

                engine.doFloodFill(
                  targetLayer,
                  message.x,
                  message.y,
                  message.color.r,
                  message.color.g,
                  message.color.b,
                  message.color.a
                );

                // Queue DOM canvases for batched update for remote drawing
                engine.queueLayerUpdate(
                  message.layer as "foreground" | "background"
                );

                // Show cursor at the fill point
                const participant = participantsRef.current.get(message.userId);
                const username = participant?.username || userEngine.username;
                createOrUpdateCursor(
                  message.userId,
                  message.x,
                  message.y,
                  username
                );
              }
            }
            break;
          }

          case "join": {
            const userEngine = userEnginesRef.current.get(message.userId);
            if (userEngine) {
              userEngine.firstSeen = message.timestamp;
              userEngine.username = message.username; // Update username when user joins

              // Update any existing cursor to show the proper username
              const cursorElement = activeCursorsRef.current.get(
                message.userId
              );
              if (cursorElement) {
                const userLabel = cursorElement.querySelector(
                  '[data-username-element="true"]'
                ) as HTMLElement;
                if (userLabel) {
                  userLabel.textContent = message.username;
                  userLabel.style.color = getUserBackgroundColor(
                    message.username
                  );
                  userLabel.style.border = `1px solid ${getUserBackgroundColor(
                    message.username
                  )}`;

                  // Also update the icon color
                  const svgPath = cursorElement.querySelector(
                    "svg path"
                  ) as SVGPathElement;
                  if (svgPath) {
                    svgPath.setAttribute(
                      "fill",
                      getUserBackgroundColor(message.username)
                    );
                  }
                }
              }
            }

            // Add participant to centralized state
            addParticipant(message.userId, message.username, message.timestamp);

            // Add join message to chat when someone joins
            if (
              chatAddMessageRef.current &&
              message.userId !== userIdRef.current
            ) {
              chatAddMessageRef.current({
                id: `join-${message.userId}-${message.timestamp}`,
                type: "join",
                userId: message.userId,
                username: message.username,
                message: "",
                timestamp: message.timestamp,
              });
            }
            break;
          }

          case "joinResponse": {
            // Store the server-provided user order
            userOrderRef.current = [...message.userIds];

            // Initialize drawing engines for all users in the list
            message.userIds.forEach((userId: string) => {
              createUserEngine(userId); // Username will be updated when join messages arrive
            });

            // Update z-indices for all existing canvases now that we have proper user order
            updateCanvasZIndices();
            break;
          }

          case "endSession": {
            console.log("END_SESSION received:", {
              userId: message.userId.substring(0, 8),
              postUrl: message.postUrl,
              isFromOwner: message.userId !== userIdRef.current,
            });

            if (message.userId !== userIdRef.current) {
              // Show notification to non-owners
              setSessionEnded(true);

              // Redirect immediately to the post URL
              window.location.href = message.postUrl;
            }
            break;
          }

          case "sessionExpired": {
            console.log("SESSION_EXPIRED received:", {
              sessionId: message.sessionId.substring(0, 8),
            });

            // Show session expired alert to all users
            setSessionExpired(true);
            break;
          }

          case "leave": {
            console.log("LEAVE received:", {
              userId: message.userId.substring(0, 8),
              username: message.username,
              timestamp: message.timestamp,
            });

            // Clean up cursor when user leaves
            hideCursor(message.userId);

            // Remove participant from centralized state
            removeParticipant(message.userId);

            // Add leave message to chat when someone leaves
            if (chatAddMessageRef.current) {
              chatAddMessageRef.current({
                id: `leave-${message.userId}-${message.timestamp}`,
                type: "leave",
                userId: message.userId,
                username: message.username,
                message: "",
                timestamp: message.timestamp,
              });
            }
            break;
          }

          case "chat": {
            // Add participant if not already tracked (for chat messages)
            addParticipant(message.userId, message.username, message.timestamp);

            // Add chat message to chat component
            if (chatAddMessageRef.current) {
              chatAddMessageRef.current({
                id: `chat-${message.userId}-${message.timestamp}`,
                type: "user",
                userId: message.userId,
                username: message.username,
                message: message.message,
                timestamp: message.timestamp,
              });
            }
            break;
          }

          case "snapshotRequest": {
            // Forward snapshot request to drawing hook
            if (handleSnapshotRequestRef.current) {
              handleSnapshotRequestRef.current();
            }
            break;
          }

          case "pointerup": {
            // Hide cursor for remote users when they stop drawing
            if (message.userId !== userIdRef.current) {
              hideCursor(message.userId);
            }
            break;
          }

          case "snapshot": {
            console.log("Drawing event - snapshot", message);
            if (!canvasMeta?.width || !canvasMeta?.height) {
              console.warn(
                "Canvas dimensions not available for snapshot processing"
              );
              break;
            }
            try {
              const layerData = await pngDataToLayer(
                message.pngData,
                canvasMeta.width,
                canvasMeta.height
              );

              // Check if this snapshot is for the local user
              if (
                message.userId === userIdRef.current &&
                drawingEngineRef.current
              ) {
                // Apply to local user's canvas
                const targetLayer =
                  message.layer === "foreground"
                    ? drawingEngineRef.current.layers.foreground
                    : drawingEngineRef.current.layers.background;

                targetLayer.set(layerData);

                // Add received snapshot to undo history (useful when refreshing the page)
                addSnapshotToHistory(message.layer);

                // Queue DOM canvases for batched update for local snapshots
                drawingEngineRef.current.queueLayerUpdate(
                  message.layer as "foreground" | "background"
                );

                // Notify parent component that drawing has changed
                handleLocalDrawingChange();
              } else {
                // Apply to remote user's canvas
                const userEngine = userEnginesRef.current.get(message.userId);
                if (userEngine) {
                  const targetLayer =
                    message.layer === "foreground"
                      ? userEngine.engine.layers.foreground
                      : userEngine.engine.layers.background;

                  targetLayer.set(layerData);

                  // Queue DOM canvases for batched update for remote snapshots
                  userEngine.engine.queueLayerUpdate(
                    message.layer as "foreground" | "background"
                  );
                }
              }
            } catch (error) {
              console.error("Failed to process snapshot:", error);
            }
            break;
          }
        }
      } catch (error) {
        console.error("Failed to handle binary message:", error);
      }
    };
  }, [
    getWebSocketUrl,
    createUserEngine,
    canvasMeta,
    handleLocalDrawingChange,
    updateCanvasZIndices,
    addSnapshotToHistory,
    markDrawingComplete,
    createOrUpdateCursor,
    hideCursor,
    addParticipant,
    removeParticipant,
  ]);

  // Keep connectWebSocket ref to avoid circular dependencies in useEffect
  const connectWebSocketRef = useRef(connectWebSocket);
  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
  }, [connectWebSocket]);


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
  }, [initializeApp]);

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
  }, [canvasMeta]);


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
  ]);

  // Update canvas when layer visibility changes
  useEffect(() => {
    // Update visibility for local user canvases only
    const localUserId = userIdRef.current;
    if (localUserId) {
      const localBgCanvas = userCanvasRefs.current.get(`${localUserId}-bg`);
      const localFgCanvas = userCanvasRefs.current.get(`${localUserId}-fg`);

      if (localBgCanvas) {
        localBgCanvas.style.display = drawingState.bgVisible ? "block" : "none";
      }
      if (localFgCanvas) {
        localFgCanvas.style.display = drawingState.fgVisible ? "block" : "none";
      }
    }
  }, [drawingState.fgVisible, drawingState.bgVisible]);

  // Trigger initial compositing when drawing engine is ready
  useEffect(() => {
    if (drawingEngine && userIdRef.current) {
      // Set up DOM canvases for local user (only once, avoid duplicates)
      const localUserId = userIdRef.current;
      const existingBgCanvas = userCanvasRefs.current.get(`${localUserId}-bg`);
      const existingFgCanvas = userCanvasRefs.current.get(`${localUserId}-fg`);

      let canvasElements = null;
      if (!existingBgCanvas || !existingFgCanvas) {
        canvasElements = createUserCanvasElements(localUserId, 0);
      } else {
        canvasElements = {
          bgCanvas: existingBgCanvas,
          fgCanvas: existingFgCanvas,
        };
      }

      if (canvasElements) {
        // Attach DOM canvases to the local drawing engine
        drawingEngine.attachDOMCanvases(
          canvasElements.bgCanvas,
          canvasElements.fgCanvas
        );

        // Update DOM canvases to show any existing content (immediate for initialization)
        drawingEngine.updateAllDOMCanvasesImmediate();

        // Set up initial layer visibility for local user
        canvasElements.bgCanvas.style.display = drawingState.bgVisible
          ? "block"
          : "none";
        canvasElements.fgCanvas.style.display = drawingState.fgVisible
          ? "block"
          : "none";
      }
    }
  }, [
    drawingEngine,
    createUserCanvasElements,
    drawingState.bgVisible,
    drawingState.fgVisible,
  ]);

  // Update canvas transform when zoom changes
  useEffect(() => {
    if (drawingEngine && canvasContainerRef.current) {
      drawingEngine.adjustPanForZoom(
        0,
        0,
        canvasContainerRef.current,
        currentZoom
      );
    }
  }, [currentZoom, drawingEngine]);

  // Force drawing system initialization when local canvas is ready
  useEffect(() => {
    if (localUserCanvasRef.current && canvasMeta?.width && canvasMeta?.height) {
      // The useDrawing hook should pick this up and initialize
    }
  }, [canvasMeta?.width, canvasMeta?.height]);

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

        <LoadingModal
          isOpen={!canvasMeta && !initializationError}
        />

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
                    ref={localUserCanvasRef}
                    width={canvasMeta.width}
                    height={canvasMeta.height}
                    className="absolute top-0 left-0 pointer-events-auto canvas-bg"
                    style={{
                      opacity: 0,
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
