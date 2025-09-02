import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import "./App.css";
import { Chat } from "./components/Chat";
import { SessionExpiredModal } from "./components/SessionExpiredModal";
import { SessionHeader } from "./components/SessionHeader";
import { ToolboxPanel } from "./components/ToolboxPanel";
import { DrawingEngine } from "./DrawingEngine";
import { useDrawing } from "./hooks/useDrawing";
import { messages as enMessages } from "./locales/en/messages";
import { messages as jaMessages } from "./locales/ja/messages";
import { messages as koMessages } from "./locales/ko/messages";
import { messages as zhMessages } from "./locales/zh/messages";
import {
  decodeMessage,
  encodeEndSession,
  encodeJoin,
} from "./utils/binaryProtocol";
import { pngDataToLayer } from "./utils/canvasSnapshot";

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

const zoomMin = 0.5;
const zoomMax = 4.0;
let cachedZoomLevels: number[] = [];

const getZoomLevels = (): number[] => {
  if (cachedZoomLevels.length === 0) {
    const steps = 2;
    const k = steps / Math.LN2;

    const first = Math.ceil(Math.log(zoomMin) * k);
    const size = Math.floor(Math.log(zoomMax) * k) - first + 1;
    cachedZoomLevels = new Array(size);

    // enforce zoom levels relating to thirds (33.33%, 66.67%, ...)
    const snap = new Array(steps).fill(0);
    if (steps > 1) {
      const third = Math.log(4.0 / 3.0) * k;
      const i = Math.round(third);
      snap[(i - first) % steps] = third - i;
    }

    const kInverse = 1.0 / k;
    for (let i = 0; i < steps; i++) {
      let f = Math.exp((i + first + snap[i]) * kInverse);
      f = Math.floor(f * Math.pow(2, 48) + 0.5) / Math.pow(2, 48); // round off inaccuracies
      for (let j = i; j < size; j += steps, f *= 2.0) {
        cachedZoomLevels[j] = f;
      }
    }
  }

  return cachedZoomLevels;
};
// SPDX-SnippetEnd

type BrushType = "solid" | "halftone" | "eraser" | "fill" | "pan";
type LayerType = "foreground" | "background";

interface DrawingState {
  brushSize: number;
  opacity: number;
  color: string;
  brushType: BrushType;
  layerType: LayerType;
  zoomLevel: number;
  fgVisible: boolean;
  bgVisible: boolean;
  pendingPanDeltaX?: number;
  pendingPanDeltaY?: number;
}

const DEFAULT_PALETTE_COLORS = [
  "#ffffff",
  "#000000",
  "#888888",
  "#b47575",
  "#c096c0",
  "#fa9696",
  "#8080ff",
  "#ffb6ff",
  "#e7e58d",
  "#25c7c9",
  "#99cb7b",
  "#e7962d",
  "#f9ddcf",
  "#fcece2",
];

// Interface for collaboration meta data
interface CollaborationMeta {
  title: string;
  width: number;
  height: number;
  ownerId: string;
  savedPostId?: string;
  ownerLoginName: string;
  maxUsers: number;
  currentUserCount: number;
}

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
  const { t } = useLingui();

  // State for canvas dimensions and meta information
  const [canvasMeta, setCanvasMeta] = useState<CollaborationMeta | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(
    null
  );

  // Canvas dimensions - only available when meta is loaded
  const CANVAS_WIDTH = canvasMeta?.width;
  const CANVAS_HEIGHT = canvasMeta?.height;

  const [selectedPaletteIndex, setSelectedPaletteIndex] = useState(1); // Start with black selected
  const [paletteColors, setPaletteColors] = useState(DEFAULT_PALETTE_COLORS);

  const [drawingState, setDrawingState] = useState<DrawingState>({
    brushSize: 1,
    opacity: 255,
    color: "#000000",
    brushType: "solid",
    layerType: "foreground",
    zoomLevel: 100,
    fgVisible: true,
    bgVisible: true,
  });

  const [historyState, setHistoryState] = useState({
    canUndo: false,
    canRedo: false,
  });

  // Track catching up state - when true, drawing should be disabled
  const [isCatchingUp, setIsCatchingUp] = useState(true);
  const catchupTimeoutRef = useRef<number | null>(null);

  // Message queue for sequential processing during catch-up
  const messageQueueRef = useRef<any[]>([]);
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

  // Chat message handler
  const handleChatMessage = useCallback((_message: any) => {
    // Chat messages are handled entirely by the Chat component
    // This callback is here for future extensions if needed
  }, []);

  // Track user IDs and their drawing engines (using ref to avoid re-renders)
  const userEnginesRef = useRef<
    Map<
      string,
      { engine: DrawingEngine; firstSeen: number; canvas: HTMLCanvasElement }
    >
  >(new Map());

  // Track server-provided user order for layer compositing
  const userOrderRef = useRef<string[]>([]);

  // Dirty flag to track when recomposition is needed
  const needsRecompositionRef = useRef(false);

  // Cached temporary canvas for local user compositing (performance optimization for Safari)
  const tempCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const tempCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Safari detection for performance optimizations
  const isSafari = useRef(
    /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  );

  // Initialize cached temporary canvas for performance
  const initTempCanvas = useCallback(() => {
    if (!tempCanvasRef.current && CANVAS_WIDTH && CANVAS_HEIGHT) {
      tempCanvasRef.current = document.createElement("canvas");
      tempCanvasRef.current.width = CANVAS_WIDTH;
      tempCanvasRef.current.height = CANVAS_HEIGHT;
      tempCtxRef.current = tempCanvasRef.current.getContext("2d");
      if (tempCtxRef.current) {
        tempCtxRef.current.imageSmoothingEnabled = false;
      }
    }
  }, [CANVAS_WIDTH, CANVAS_HEIGHT]);

  // Function to create drawing engine for a new user
  const createUserEngine = useCallback(
    (userId: string) => {
      // Only create user engines when canvas dimensions are available
      if (!CANVAS_WIDTH || !CANVAS_HEIGHT) {
        return;
      }

      // Check if user already exists
      if (userEnginesRef.current.has(userId)) {
        return;
      }

      // Create new DrawingEngine for this user
      const engine = new DrawingEngine(CANVAS_WIDTH, CANVAS_HEIGHT);
      const firstSeen = Date.now();

      // Create offscreen canvas for this user
      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_WIDTH;
      canvas.height = CANVAS_HEIGHT;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = false;
        engine.initialize(ctx);
      }

      userEnginesRef.current.set(userId, { engine, firstSeen, canvas });
      needsRecompositionRef.current = true;
    },
    [CANVAS_WIDTH, CANVAS_HEIGHT]
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const userIdRef = useRef<string>("");
  const userLoginNameRef = useRef<string>("");
  const localUserJoinTimeRef = useRef<number>(0);

  // Check if current user is the session owner
  const isOwner = canvasMeta && userIdRef.current === canvasMeta.ownerId;

  const updateBrushType = useCallback((type: BrushType) => {
    setDrawingState((prev) => {
      let newOpacity = prev.opacity;
      if (type === "halftone") newOpacity = 23;
      else if (["solid", "eraser", "fill", "pan"].includes(type))
        newOpacity = 255;

      return { ...prev, brushType: type, opacity: newOpacity };
    });
  }, []);

  const updateColor = useCallback(
    (newColor: string) => {
      setDrawingState((prev) => ({ ...prev, color: newColor }));

      window.dispatchEvent(
        new CustomEvent("colorChanged", { detail: { color: newColor } })
      );

      const matchingIndex = paletteColors.indexOf(newColor);
      if (matchingIndex !== -1) {
        setSelectedPaletteIndex(matchingIndex);
      }
    },
    [paletteColors]
  );

  // Handle color picker changes - updates palette if a palette slot is selected
  const handleColorPickerChange = useCallback(
    (newColor: string) => {
      // If a palette color is currently selected, update that palette slot
      if (
        selectedPaletteIndex >= 0 &&
        selectedPaletteIndex < paletteColors.length
      ) {
        const newPaletteColors = [...paletteColors];
        newPaletteColors[selectedPaletteIndex] = newColor;
        setPaletteColors(newPaletteColors);
      }

      // Update the current color
      updateColor(newColor);
    },
    [selectedPaletteIndex, paletteColors, updateColor]
  );

  // Zoom level management using engine's getZoomLevels function
  const zoomLevels = getZoomLevels();
  const [currentZoomIndex, setCurrentZoomIndex] = useState(
    zoomLevels.findIndex((level) => level >= 1.0)
  );
  const currentZoom = zoomLevels[currentZoomIndex];

  const handleZoomIn = useCallback(
    (pointerX?: number, pointerY?: number) => {
      if (currentZoomIndex < zoomLevels.length - 1) {
        const oldZoom = zoomLevels[currentZoomIndex];
        const newIndex = currentZoomIndex + 1;
        const newZoom = zoomLevels[newIndex];

        // Calculate pan offset before state updates if coordinates provided
        let deltaX = 0;
        let deltaY = 0;
        if (
          pointerX !== undefined &&
          pointerY !== undefined &&
          canvasRef.current
        ) {
          const canvas = canvasRef.current;
          const rect = canvas.getBoundingClientRect();

          // Get current pan offset from transform
          const computedStyle = window.getComputedStyle(canvas);
          const transform = computedStyle.transform;
          let currentPanX = 0;
          let currentPanY = 0;

          if (transform && transform !== "none") {
            const matrix = new DOMMatrix(transform);
            currentPanX = matrix.m41;
            currentPanY = matrix.m42;
          }

          // Convert screen coordinates to canvas-relative coordinates (accounting for current pan)
          const canvasX = pointerX - rect.left - currentPanX;
          const canvasY = pointerY - rect.top - currentPanY;

          // Calculate the zoom scale factor
          const zoomScale = newZoom / oldZoom;

          // Calculate how much the point should move due to zoom
          deltaX = canvasX * (1 - zoomScale);
          deltaY = canvasY * (1 - zoomScale);
        }

        // Batch state updates to prevent flicker
        startTransition(() => {
          setCurrentZoomIndex(newIndex);
          setDrawingState((prev) => ({
            ...prev,
            zoomLevel: Math.round(newZoom * 100),
            pendingPanDeltaX: deltaX !== 0 ? deltaX : undefined,
            pendingPanDeltaY: deltaY !== 0 ? deltaY : undefined,
          }));
        });
      }
    },
    [currentZoomIndex, zoomLevels, canvasRef]
  );

  const handleZoomOut = useCallback(
    (pointerX?: number, pointerY?: number) => {
      if (currentZoomIndex > 0) {
        const oldZoom = zoomLevels[currentZoomIndex];
        const newIndex = currentZoomIndex - 1;
        const newZoom = zoomLevels[newIndex];

        // Calculate pan offset before state updates if coordinates provided
        let deltaX = 0;
        let deltaY = 0;
        if (
          pointerX !== undefined &&
          pointerY !== undefined &&
          canvasRef.current
        ) {
          const canvas = canvasRef.current;
          const rect = canvas.getBoundingClientRect();

          // Get current pan offset from transform
          const computedStyle = window.getComputedStyle(canvas);
          const transform = computedStyle.transform;
          let currentPanX = 0;
          let currentPanY = 0;

          if (transform && transform !== "none") {
            const matrix = new DOMMatrix(transform);
            currentPanX = matrix.m41;
            currentPanY = matrix.m42;
          }

          // Convert screen coordinates to canvas-relative coordinates (accounting for current pan)
          const canvasX = pointerX - rect.left - currentPanX;
          const canvasY = pointerY - rect.top - currentPanY;

          // Calculate the zoom scale factor
          const zoomScale = newZoom / oldZoom;

          // Calculate how much the point should move due to zoom
          deltaX = canvasX * (1 - zoomScale);
          deltaY = canvasY * (1 - zoomScale);
        }

        // Batch state updates to prevent flicker
        startTransition(() => {
          setCurrentZoomIndex(newIndex);
          setDrawingState((prev) => ({
            ...prev,
            zoomLevel: Math.round(newZoom * 100),
            pendingPanDeltaX: deltaX !== 0 ? deltaX : undefined,
            pendingPanDeltaY: deltaY !== 0 ? deltaY : undefined,
          }));
        });
      }
    },
    [currentZoomIndex, zoomLevels, canvasRef]
  );

  // History change callback
  const handleHistoryChange = useCallback(
    (canUndo: boolean, canRedo: boolean) => {
      setHistoryState({ canUndo, canRedo });
    },
    []
  );

  // Ref to store the compositing function for the callback
  const compositeCallbackRef = useRef<(() => void) | null>(null);

  // Callback to trigger unified compositing when local drawing changes
  const handleLocalDrawingChange = useCallback(() => {
    // Mark for recomposition (RAF loop will handle it)
    needsRecompositionRef.current = true;
  }, []);

  // Use the drawing hook
  const { undo, redo, drawingEngine, addSnapshotToHistory } = useDrawing(
    canvasRef,
    appRef,
    drawingState,
    handleHistoryChange,
    Math.round(currentZoom * 100),
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    wsRef,
    userIdRef,
    handleLocalDrawingChange,
    isCatchingUp,
    connectionState
  );

  // Function to handle manual reconnection
  const handleManualReconnect = useCallback(async () => {
    console.log("Manual reconnection triggered");

    // Clear auth error state
    setAuthError(false);

    // Clear canvas states before reconnecting
    if (drawingEngine) {
      drawingEngine.layers.foreground.fill(0);
      drawingEngine.layers.background.fill(0);
      drawingEngine.compositeLayers(true, true);
    }
    userEnginesRef.current.clear();
    // Note: Keep localUserJoinTimeRef.current for historical purposes, but don't rely on it for ordering
    needsRecompositionRef.current = true;

    // Re-initialize the app before reconnecting
    const initialized = await initializeApp();
    if (initialized) {
      // Reconnect after successful initialization
      shouldConnectRef.current = true;
      connectWebSocket();
    }
  }, [drawingEngine]);

  // Function to download current canvas as PNG
  const downloadCanvasAsPNG = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !CANVAS_WIDTH || !CANVAS_HEIGHT) return;

    try {
      // Create a temporary canvas for download to ensure we get the current state
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = CANVAS_WIDTH;
      tempCanvas.height = CANVAS_HEIGHT;
      const tempCtx = tempCanvas.getContext("2d");

      if (!tempCtx) return;

      // Copy the current canvas content
      tempCtx.drawImage(canvas, 0, 0);

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
  }, [CANVAS_WIDTH, CANVAS_HEIGHT]);

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

      // Step 1: Get canvas as PNG blob
      const canvas = canvasRef.current;
      if (!canvas) {
        throw new Error("Canvas not available");
      }

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
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
  }, [isSaving]);

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
      let wsUrl;

      wsUrl = `${protocol}//${host}/collaborate/${sessionId}/ws`;

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

      setCanvasMeta(meta);

      // Update document title
      const sessionTitle =
        meta.title && meta.title.trim() ? meta.title : "No Title";
      document.title = `${t`Oeee Cafe`} - ${sessionTitle}`;

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
          // Trigger re-compositing with proper timestamp
          needsRecompositionRef.current = true;
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

          if (isCatchingUp) {
            // During catch-up, queue messages for sequential processing
            messageQueueRef.current.push(message);
            processMessageQueue();
          } else {
            // During normal operation, process immediately
            // Create drawing engine for new user if they don't exist (skip for messages without userId)
            if ("userId" in message && message.userId) {
              createUserEngine(message.userId);
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

          if (isCatchingUp) {
            // During catch-up, queue messages for sequential processing
            messageQueueRef.current.push(message);
            processMessageQueue();
          } else {
            // During normal operation, process immediately
            // Create drawing engine for new user if they don't exist (skip for messages without userId)
            if ("userId" in message && message.userId) {
              createUserEngine(message.userId);
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
        connectionState: connectionState,
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
    const handleBinaryMessage = async (message: any) => {
      try {
        // Handle different message types
        switch (message.type) {
          case "drawLine": {
            console.log("Drawing event - drawLine", message);
            // Check if this is the local user's drawing event
            if (message.userId === userIdRef.current && drawingEngine) {
              const targetLayer =
                message.layer === "foreground"
                  ? drawingEngine.layers.foreground
                  : drawingEngine.layers.background;

              drawingEngine.drawLine(
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

              // Notify parent component that drawing has changed
              handleLocalDrawingChange();
              needsRecompositionRef.current = true;
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

                // Mark for recomposition - RAF loop will handle compositing
                needsRecompositionRef.current = true;
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
            if (message.userId === userIdRef.current && drawingEngine) {
              const targetLayer =
                message.layer === "foreground"
                  ? drawingEngine.layers.foreground
                  : drawingEngine.layers.background;

              drawingEngine.drawLine(
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

              // Notify parent component that drawing has changed
              handleLocalDrawingChange();
              needsRecompositionRef.current = true;
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

                // Mark for recomposition - RAF loop will handle compositing
                needsRecompositionRef.current = true;
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
            if (message.userId === userIdRef.current && drawingEngine) {
              const targetLayer =
                message.layer === "foreground"
                  ? drawingEngine.layers.foreground
                  : drawingEngine.layers.background;

              drawingEngine.doFloodFill(
                targetLayer,
                message.x,
                message.y,
                message.color.r,
                message.color.g,
                message.color.b,
                message.color.a
              );

              // Notify parent component that drawing has changed
              handleLocalDrawingChange();
              needsRecompositionRef.current = true;
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

                // Mark for recomposition - RAF loop will handle compositing
                needsRecompositionRef.current = true;
              }
            }
            break;
          }

          case "join": {
            const userEngine = userEnginesRef.current.get(message.userId);
            if (userEngine) {
              userEngine.firstSeen = message.timestamp;
              needsRecompositionRef.current = true;
            }

            // Add join message to chat when someone joins
            if (
              (window as any).addChatMessage &&
              message.userId !== userIdRef.current
            ) {
              (window as any).addChatMessage({
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
              createUserEngine(userId);
            });

            // Mark for recomposition to update layer order
            needsRecompositionRef.current = true;
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

            // Add leave message to chat when someone leaves
            if ((window as any).addChatMessage) {
              (window as any).addChatMessage({
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
            // Add chat message to chat component
            if ((window as any).addChatMessage) {
              (window as any).addChatMessage({
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
            if ((window as any).handleSnapshotRequest) {
              (window as any).handleSnapshotRequest(message.timestamp);
            }
            break;
          }

          case "pointerup": {
            break;
          }

          case "snapshot": {
            console.log("Drawing event - snapshot", message);
            if (!CANVAS_WIDTH || !CANVAS_HEIGHT) {
              console.warn(
                "Canvas dimensions not available for snapshot processing"
              );
              break;
            }
            try {
              const layerData = await pngDataToLayer(
                message.pngData,
                CANVAS_WIDTH,
                CANVAS_HEIGHT
              );

              // Check if this snapshot is for the local user
              if (message.userId === userIdRef.current && drawingEngine) {
                // Apply to local user's canvas
                const targetLayer =
                  message.layer === "foreground"
                    ? drawingEngine.layers.foreground
                    : drawingEngine.layers.background;

                targetLayer.set(layerData);

                // Add received snapshot to undo history (useful when refreshing the page)
                addSnapshotToHistory();

                // Notify parent component that drawing has changed
                handleLocalDrawingChange();
                needsRecompositionRef.current = true;
              } else {
                // Apply to remote user's canvas
                const userEngine = userEnginesRef.current.get(message.userId);
                if (userEngine) {
                  const targetLayer =
                    message.layer === "foreground"
                      ? userEngine.engine.layers.foreground
                      : userEngine.engine.layers.background;

                  targetLayer.set(layerData);
                  needsRecompositionRef.current = true;
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
    drawingEngine,
    handleLocalDrawingChange,
  ]);

  // RAF-based compositing system for better performance
  const compositeAllUserLayers = useCallback(() => {
    const canvas = canvasRef.current;
    if (
      !canvas ||
      !needsRecompositionRef.current ||
      !CANVAS_WIDTH ||
      !CANVAS_HEIGHT
    )
      return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Safari optimization: reduce compositing frequency for better performance
    if (isSafari.current) {
      // Clear the canvas more efficiently for Safari
      ctx.globalCompositeOperation = "copy";
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.globalCompositeOperation = "source-over";
    } else {
      // Standard clear for other browsers
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    // Create a combined array including all users
    const allUsers: Array<{
      userId: string;
      engine: DrawingEngine;
      firstSeen: number;
      canvas?: HTMLCanvasElement;
    }> = [];

    // Add remote users
    userEnginesRef.current.forEach((userData, userId) => {
      allUsers.push({ userId, ...userData });
    });

    // Add local user if drawingEngine exists
    if (drawingEngine) {
      allUsers.push({
        userId: userIdRef.current,
        engine: drawingEngine,
        firstSeen: localUserJoinTimeRef.current,
      });
    }

    // Sort users by server-provided order (from JOIN_RESPONSE)
    // Later users should be drawn first (underneath earlier users)
    // This ensures first user to join appears on top, latest user appears on bottom
    allUsers.sort((a, b) => {
      const indexA = userOrderRef.current.indexOf(a.userId);
      const indexB = userOrderRef.current.indexOf(b.userId);

      // If both users are in the server order, sort by REVERSE order
      // Higher index (later join) should be drawn first (underneath)
      if (indexA !== -1 && indexB !== -1) {
        return indexB - indexA;
      }

      // If only one is in server order, prioritize that one
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;

      // If neither is in server order, fall back to UUID comparison
      return a.userId.localeCompare(b.userId);
    });

    // Composite each user's canvas onto the main canvas using Canvas API (much faster!)
    allUsers.forEach(({ userId, engine, canvas }) => {
      const isLocalUser = userId === userIdRef.current;

      if (isLocalUser) {
        // For local user, composite layers and use cached temporary canvas
        engine.compositeLayers(drawingState.fgVisible, drawingState.bgVisible);

        // Initialize cached canvas if needed
        initTempCanvas();

        // Use cached temporary canvas
        if (
          tempCtxRef.current &&
          tempCanvasRef.current &&
          CANVAS_WIDTH &&
          CANVAS_HEIGHT
        ) {
          const compositeData = engine.compositeBuffer;
          const imageData = new ImageData(
            compositeData,
            CANVAS_WIDTH,
            CANVAS_HEIGHT
          );
          tempCtxRef.current.putImageData(imageData, 0, 0);

          // Draw cached temp canvas onto main canvas
          ctx.drawImage(tempCanvasRef.current, 0, 0);
        }
      } else if (canvas && CANVAS_WIDTH && CANVAS_HEIGHT) {
        // For remote users, update their offscreen canvas first
        const userCtx = canvas.getContext("2d");
        if (userCtx) {
          userCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          engine.compositeLayers(true, true); // Always show both layers for remote users

          // Get the composite data and draw to user's offscreen canvas
          const compositeData = engine.compositeBuffer;
          const imageData = new ImageData(
            compositeData,
            CANVAS_WIDTH,
            CANVAS_HEIGHT
          );
          userCtx.putImageData(imageData, 0, 0);

          // Draw user's canvas onto main canvas
          ctx.drawImage(canvas, 0, 0);
        }
      }
    });

    needsRecompositionRef.current = false;
  }, [drawingEngine, drawingState.fgVisible, drawingState.bgVisible]);

  // Set the compositing callback ref after compositeAllUserLayers is defined
  useEffect(() => {
    compositeCallbackRef.current = compositeAllUserLayers;
  }, [compositeAllUserLayers]);

  // RAF-based rendering loop with Safari optimization
  const rafId = useRef<number | null>(null);
  const lastRenderTime = useRef<number>(0);
  const startRenderLoop = useCallback(() => {
    const render = (currentTime: number) => {
      // Safari optimization: throttle rendering to 30fps instead of 60fps for better performance
      const targetFPS = isSafari.current ? 30 : 60;
      const targetInterval = 1000 / targetFPS;

      if (currentTime - lastRenderTime.current >= targetInterval) {
        if (needsRecompositionRef.current) {
          compositeAllUserLayers();
        }
        lastRenderTime.current = currentTime;
      }

      rafId.current = requestAnimationFrame(render);
    };
    rafId.current = requestAnimationFrame(render);
  }, [compositeAllUserLayers]);

  const stopRenderLoop = useCallback(() => {
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
  }, []);

  // Start/stop render loop based on canvas availability
  useEffect(() => {
    if (canvasRef.current) {
      startRenderLoop();
    }
    return stopRenderLoop;
  }, [startRenderLoop, stopRenderLoop]);

  const handleZoomReset = useCallback(() => {
    const resetIndex = zoomLevels.findIndex((level) => level >= 1.0);
    setCurrentZoomIndex(resetIndex);
    setDrawingState((prev) => ({ ...prev, zoomLevel: 100 }));

    // Reset pan offset as well
    if (drawingEngine) {
      drawingEngine.resetPan(canvasRef.current || undefined);
    }
  }, [zoomLevels, drawingEngine]);

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

  // Initialize canvas dimensions when canvas meta is available
  useEffect(() => {
    if (canvasRef.current && canvasMeta && CANVAS_WIDTH && CANVAS_HEIGHT) {
      canvasRef.current.width = CANVAS_WIDTH;
      canvasRef.current.height = CANVAS_HEIGHT;

      // Connect to WebSocket now that everything is initialized
      if (shouldConnectRef.current) {
        connectWebSocket();
      }
    }
  }, [canvasMeta, CANVAS_WIDTH, CANVAS_HEIGHT, connectWebSocket]);

  // Add scroll wheel zoom functionality
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // Only zoom when cursor is over the canvas or app area
      const target = e.target as Element;
      const isOverCanvas = target.id === "canvas" || target.closest("#app");

      if (isOverCanvas) {
        e.preventDefault();

        if (e.deltaY < 0) {
          // Zoom out with pointer coordinates
          handleZoomOut(e.clientX, e.clientY);
        } else if (e.deltaY > 0) {
          // Zoom in with pointer coordinates
          handleZoomIn(e.clientX, e.clientY);
        }
      }
    };

    // Add event listener to the app container
    const appElement = appRef.current;
    if (appElement) {
      appElement.addEventListener("wheel", handleWheel, { passive: false });
      return () => appElement.removeEventListener("wheel", handleWheel);
    }
  }, [handleZoomIn, handleZoomOut, appRef]);

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
            canvasRef.current || undefined
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
  ]);

  // Update canvas when layer visibility changes
  useEffect(() => {
    // Mark for recomposition (RAF loop will handle it)
    needsRecompositionRef.current = true;
  }, [drawingState.fgVisible, drawingState.bgVisible, drawingEngine]);

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
        {initializationError && (
          <div className="fixed inset-0 bg-black bg-opacity-70 flex justify-center items-center z-[9999]">
            <div className="bg-main text-main p-8 rounded-lg border-2 border-main text-center max-w-sm shadow-lg">
              <h2 className="text-highlight mt-0 mb-4 text-xl font-bold">
                <Trans>Initialization Failed</Trans>
              </h2>
              <p className="mb-6 leading-relaxed">{initializationError}</p>
              <button
                onClick={() => window.location.reload()}
                className="bg-highlight text-white border-0 px-6 py-3 rounded cursor-pointer text-base font-sans transition-colors hover:bg-orange-600"
              >
                <Trans>Retry</Trans>
              </button>
            </div>
          </div>
        )}

        {!canvasMeta && !initializationError && (
          <div className="fixed inset-0 bg-black bg-opacity-70 flex justify-center items-center z-[9999]">
            <div className="bg-main text-main p-8 rounded-lg border-2 border-main text-center max-w-sm shadow-lg">
              <h2 className="text-xl font-bold mb-4">
                <Trans>Loading...</Trans>
              </h2>
              <p>
                <Trans>Initializing collaboration session...</Trans>
              </p>
            </div>
          </div>
        )}

        {authError && (
          <div className="fixed inset-0 bg-black bg-opacity-70 flex justify-center items-center z-[9999]">
            <div className="bg-main text-main p-8 rounded-lg border-2 border-main text-center max-w-sm shadow-lg">
              <h2 className="text-highlight mt-0 mb-4 text-xl font-bold">
                <Trans>Authentication Failed</Trans>
              </h2>
              <p className="mb-6 leading-relaxed">
                <Trans>
                  Unable to authenticate your session. Either the session
                  doesn't exist, or it has expired. Please return to the lobby.
                </Trans>
              </p>
              <button
                onClick={() => (window.location.href = "/collaborate")}
                className="bg-highlight text-white border-0 px-6 py-3 rounded cursor-pointer text-base font-sans transition-colors hover:bg-orange-600"
              >
                <Trans>Go to Lobby</Trans>
              </button>
            </div>
          </div>
        )}

        {roomFullError && (
          <div className="fixed inset-0 bg-black bg-opacity-70 flex justify-center items-center z-[9999]">
            <div className="bg-main text-main p-8 rounded-lg border-2 border-main text-center max-w-md shadow-lg">
              <h2 className="text-highlight mt-0 mb-4 text-xl font-bold">
                <Trans>Session Full</Trans>
              </h2>
              <p className="mb-6 leading-relaxed">
                <Trans>
                  This session is full ({roomFullError.currentUserCount}/
                  {roomFullError.maxUsers} users). Only the first{" "}
                  {roomFullError.maxUsers} users can join a session.
                </Trans>
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => (window.location.href = "/collaborate")}
                  className="bg-highlight text-white border-0 px-6 py-3 rounded cursor-pointer text-base font-sans transition-colors hover:bg-orange-600"
                >
                  <Trans>Go to Lobby</Trans>
                </button>
                <button
                  onClick={() => window.location.reload()}
                  className="bg-gray-500 text-white border-0 px-6 py-3 rounded cursor-pointer text-base font-sans transition-colors hover:bg-gray-600"
                >
                  <Trans>Retry</Trans>
                </button>
              </div>
            </div>
          </div>
        )}

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
              username={userLoginNameRef.current}
              onChatMessage={handleChatMessage}
              onMinimizedChange={setIsChatMinimized}
            />
          </div>

          {/* Main Content Area */}
          <div className="flex-1 relative overflow-hidden">
            <div
              className="flex gap-4 flex-row w-full h-full bg-main items-center justify-center"
              ref={appRef}
            >
              {isCatchingUp && (
                <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[1000] bg-black bg-opacity-80 text-white p-5 text-center shadow-lg backdrop-blur-sm">
                  <div className="text-5xl mb-3 animate-spin-slow">🥒</div>
                  <div className="text-base font-bold animate-pulse-slow">
                    <Trans>LOADING...</Trans>
                  </div>
                </div>
              )}
              {connectionState !== "connected" && !isCatchingUp && (
                <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[1000] bg-main text-main p-6 border-2 border-main text-center shadow-lg min-w-80 font-sans touch-auto select-auto">
                  {connectionState === "disconnected" && (
                    <>
                      <div className="text-base mb-6 leading-relaxed text-main">
                        <Trans>
                          Connection lost. Your work is saved locally.
                        </Trans>
                      </div>
                      <div className="flex gap-4 justify-center">
                        <button
                          className="px-4 py-2 border border-main bg-main text-main cursor-pointer text-sm font-sans transition-colors hover:bg-highlight hover:text-white"
                          onClick={handleManualReconnect}
                        >
                          <Trans>Reconnect</Trans>
                        </button>
                        <button
                          className="px-4 py-2 border border-main bg-main text-main cursor-pointer text-sm font-sans transition-colors hover:bg-highlight hover:text-white"
                          onClick={downloadCanvasAsPNG}
                        >
                          <Trans>Download PNG</Trans>
                        </button>
                      </div>
                    </>
                  )}
                  {connectionState === "connecting" && (
                    <>
                      <div className="text-3xl mb-3 animate-spin">🥒</div>
                      <div>
                        <Trans>Connecting...</Trans>
                      </div>
                    </>
                  )}
                </div>
              )}
              {CANVAS_WIDTH && CANVAS_HEIGHT && (
                <canvas
                  id="canvas"
                  ref={canvasRef}
                  width={CANVAS_WIDTH}
                  height={CANVAS_HEIGHT}
                  className={`mx-auto border border-main bg-white touch-none cursor-crosshair select-none canvas-bg ${
                    drawingState.brushType === "pan"
                      ? "cursor-grab active:cursor-grabbing"
                      : ""
                  }`}
                ></canvas>
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

            {/* Session ending notification for non-owners */}
            {sessionEnded && (
              <div className="fixed inset-0 w-screen h-screen bg-black bg-opacity-80 flex items-center justify-center z-[99999] pointer-events-auto">
                <div className="bg-main text-main p-8 rounded-xl border-2 border-main text-center max-w-md shadow-2xl">
                  <div className="text-5xl mb-2 animate-spin">🥒</div>
                  <div className="text-lg mb-4 leading-relaxed">
                    <Trans>
                      Session is ending. The drawing is being saved to the
                      gallery...
                    </Trans>
                  </div>
                  <div className="text-sm opacity-80 mt-2">
                    <Trans>
                      You'll be redirected to the post page shortly.
                    </Trans>
                  </div>
                </div>
              </div>
            )}
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
