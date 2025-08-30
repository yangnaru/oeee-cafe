import {
  useState,
  useRef,
  useEffect,
  useCallback,
  startTransition,
} from "react";
import { useDrawing } from "./hooks/useDrawing";
import { DrawingEngine } from "./DrawingEngine";
import { pngDataToLayer } from "./utils/canvasSnapshot";
import { encodeJoin, encodeEndSession, decodeMessage } from "./utils/binaryProtocol";
import { Chat } from "./components/Chat";
import "./App.css";

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

// Utility function to set thumbnail dimensions based on canvas aspect ratio
const setThumbnailDimensions = (
  canvas: HTMLCanvasElement,
  fgThumbnail: HTMLCanvasElement | null,
  bgThumbnail: HTMLCanvasElement | null
) => {
  const thumbnailHeight = 50;
  const aspectRatio = canvas.width / canvas.height;
  const thumbnailWidth = Math.round(thumbnailHeight * aspectRatio);

  if (fgThumbnail) {
    fgThumbnail.width = thumbnailWidth;
    fgThumbnail.height = thumbnailHeight;
  }
  if (bgThumbnail) {
    bgThumbnail.width = thumbnailWidth;
    bgThumbnail.height = thumbnailHeight;
  }
};

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

function App() {
  // Canvas dimensions will be set when JOIN_RESPONSE is received
  const [canvasDimensions, setCanvasDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const CANVAS_WIDTH = canvasDimensions?.width || 0;
  const CANVAS_HEIGHT = canvasDimensions?.height || 0;

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

  // Track connection state for reconnection logic
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const shouldConnectRef = useRef(false);

  // Track authentication state
  const [authError, setAuthError] = useState(false);

  // Track whether JOIN_RESPONSE has been received
  const [joinResponseReceived, setJoinResponseReceived] = useState(false);

  // Track session ownership and saving state
  const [isSessionOwner, setIsSessionOwner] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);

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
    if (!tempCanvasRef.current && CANVAS_WIDTH > 0 && CANVAS_HEIGHT > 0) {
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
    (userId: string, width?: number, height?: number) => {
      // Check if user already exists
      if (userEnginesRef.current.has(userId)) {
        return;
      }

      // Use server dimensions if provided, otherwise fall back to current canvas dimensions
      const engineWidth = width || CANVAS_WIDTH;
      const engineHeight = height || CANVAS_HEIGHT;

      // Don't create engine if dimensions are not available yet
      if (engineWidth <= 0 || engineHeight <= 0) {
        return;
      }

      // Create new DrawingEngine for this user
      const engine = new DrawingEngine(engineWidth, engineHeight);
      const firstSeen = Date.now();

      // Create offscreen canvas for this user
      const canvas = document.createElement("canvas");
      canvas.width = engineWidth;
      canvas.height = engineHeight;
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
  const fgThumbnailRef = useRef<HTMLCanvasElement>(null);
  const bgThumbnailRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const userIdRef = useRef<string>("");
  const localUserJoinTimeRef = useRef<number>(0);

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

  // Use the drawing hook - pass safe defaults when dimensions are not available
  // Disable drawing until JOIN_RESPONSE is received
  const drawingDisabled = isCatchingUp || !joinResponseReceived;

  const { undo, redo, drawingEngine } = useDrawing(
    canvasRef,
    appRef,
    fgThumbnailRef,
    bgThumbnailRef,
    drawingState,
    handleHistoryChange,
    Math.round(currentZoom * 100),
    Math.max(CANVAS_WIDTH, 1), // Use minimum 1x1 when not available
    Math.max(CANVAS_HEIGHT, 1), // Use minimum 1x1 when not available
    wsRef,
    userIdRef,
    handleLocalDrawingChange,
    drawingDisabled,
    connectionState
  );

  // Function to handle manual reconnection
  const handleManualReconnect = useCallback(() => {
    console.log("Manual reconnection triggered");

    // Clear auth error state
    setAuthError(false);

    // Reset JOIN_RESPONSE state to wait for new response
    setJoinResponseReceived(false);
    setCanvasDimensions(null);
    setIsCatchingUp(true);

    // Clear canvas states before reconnecting
    if (drawingEngine) {
      drawingEngine.layers.foreground.fill(0);
      drawingEngine.layers.background.fill(0);
      drawingEngine.compositeLayers(true, true);
    }
    userEnginesRef.current.clear();
    // Note: Keep localUserJoinTimeRef.current for historical purposes, but don't rely on it for ordering
    needsRecompositionRef.current = true;

    // Reconnect immediately
    shouldConnectRef.current = true;
    connectWebSocket();
  }, [drawingEngine]);

  // Function to download current canvas as PNG
  const downloadCanvasAsPNG = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

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
  }, []);

  // Function to save collaborative drawing to gallery
  const saveCollaborativeDrawing = useCallback(async () => {
    if (!isSessionOwner || isSaving || !canvasDimensions) {
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
        }, 'image/png');
      });

      // Step 2: Send POST request to save
      const response = await fetch(`/collaborate/${sessionId}`, {
        method: 'POST',
        body: blob,
        headers: {
          'Content-Type': 'image/png',
        },
        credentials: 'include',
      });

      if (response.ok) {
        const result = await response.json();
        console.log("Drawing saved successfully:", result);
        
        // Step 3: Send END_SESSION message with actual post URL after successful save
        const endSessionMsg = encodeEndSession(userIdRef.current, result.post_url);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(endSessionMsg);
          console.log("END_SESSION message sent to all participants with post URL:", result.post_url);
        }
        
        // Redirect owner to the post page to add description
        window.location.href = result.post_url;
      } else {
        const errorText = await response.text();
        throw new Error(`Failed to save drawing: ${response.status} ${errorText}`);
      }
    } catch (error) {
      console.error('Save failed:', error);
      alert(`Failed to save drawing: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsSaving(false);
    }
  }, [isSessionOwner, isSaving, canvasDimensions]);

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

      // Use different paths for dev vs prod
      if (import.meta.env.DEV) {
        // Development: use /api prefix which gets proxied
        wsUrl = `${protocol}//${host}/api/collaborate/${sessionId}/ws`;
      } else {
        // Production: direct path
        wsUrl = `${protocol}//${host}/collaborate/${sessionId}/ws`;
      }

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

  // Function to establish WebSocket connection
  const fetchAuthInfo = useCallback(async (): Promise<boolean> => {
    try {
      console.log("Attempting to fetch auth info from /api/auth");
      const response = await fetch("/api/auth", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        console.error("Auth request failed:", {
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: Object.fromEntries(response.headers.entries()),
        });
        throw new Error(
          `Auth failed: ${response.status} ${response.statusText}`
        );
      }

      const authInfo = await response.json();
      userIdRef.current = authInfo.user_id;
      console.log("Authentication successful:", {
        loginName: authInfo.login_name,
        userId: authInfo.user_id,
        timestamp: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      console.error("Failed to fetch auth info:", {
        error: error,
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
        currentUrl: window.location.href,
      });
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

    // Fetch user ID if not already set - don't proceed if auth fails
    if (!userIdRef.current) {
      console.log("No user ID found, fetching authentication info");
      const authSuccess = await fetchAuthInfo();
      if (!authSuccess) {
        console.error(
          "Authentication failed, cannot establish WebSocket connection"
        );
        setConnectionState("disconnected");
        return;
      }
    } else {
      console.log("Using existing user ID:", userIdRef.current);
    }

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

          // Create drawing engine for new user if they don't exist (skip for messages without userId)
          if ("userId" in message && message.userId) {
            createUserEngine(message.userId);
          }

          // Handle message types
          await handleBinaryMessage(message);
        } else if (event.data instanceof Blob) {
          const arrayBuffer = await event.data.arrayBuffer();
          const message = decodeMessage(arrayBuffer);
          if (!message) {
            return;
          }

          // Create drawing engine for new user if they don't exist (skip for messages without userId)
          if ("userId" in message && message.userId) {
            createUserEngine(message.userId);
          }

          // Handle message types
          await handleBinaryMessage(message);
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

    // Helper function to handle decoded binary messages (moved inside connectWebSocket)
    const handleBinaryMessage = async (message: any) => {
      try {
        // Handle different message types
        switch (message.type) {
          case "drawLine": {
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

              // Update thumbnails for the local engine
              drawingEngine.updateLayerThumbnails(
                fgThumbnailRef.current?.getContext("2d") || undefined,
                bgThumbnailRef.current?.getContext("2d") || undefined
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

                // Update thumbnails for the remote user's engine (throttled for Safari)
                if (!isSafari.current || Math.random() < 0.3) {
                  engine.updateLayerThumbnails();
                }

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

              // Update thumbnails for the local engine
              drawingEngine.updateLayerThumbnails(
                fgThumbnailRef.current?.getContext("2d") || undefined,
                bgThumbnailRef.current?.getContext("2d") || undefined
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

                // Update thumbnails for remote engine (throttled for Safari)
                if (!isSafari.current || Math.random() < 0.3) {
                  engine.updateLayerThumbnails();
                }

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

              // Update thumbnails for the local engine
              drawingEngine.updateLayerThumbnails(
                fgThumbnailRef.current?.getContext("2d") || undefined,
                bgThumbnailRef.current?.getContext("2d") || undefined
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

                // Update thumbnails for remote engine (throttled for Safari)
                if (!isSafari.current || Math.random() < 0.3) {
                  engine.updateLayerThumbnails();
                }

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

            // Add system message to chat when someone joins
            if (
              (window as any).addChatMessage &&
              message.userId !== userIdRef.current
            ) {
              (window as any).addChatMessage({
                id: `join-${message.userId}-${message.timestamp}`,
                type: "system",
                userId: "system",
                username: "System",
                message: `User ${message.userId.substring(0, 8)} joined`,
                timestamp: message.timestamp,
              });
            }
            break;
          }

          case "joinResponse": {
            console.log("JOIN_RESPONSE received:", {
              width: message.width,
              height: message.height,
              userCount: message.userIds.length,
              users: message.userIds.map((id: string) => id.substring(0, 8)),
            });

            // Determine if current user is the session owner (first in the ordered list)
            const isOwner = message.userIds.length > 0 && message.userIds[0] === userIdRef.current;
            setIsSessionOwner(isOwner);
            console.log("Session ownership:", { isOwner, currentUser: userIdRef.current.substring(0, 8) });

            // Only update canvas dimensions if they haven't been set yet
            if (!joinResponseReceived) {
              setCanvasDimensions({
                width: message.width,
                height: message.height,
              });
              setJoinResponseReceived(true);

              // End catching up phase since we now have the essential JOIN_RESPONSE
              setIsCatchingUp(false);
              if (catchupTimeoutRef.current) {
                clearTimeout(catchupTimeoutRef.current);
                catchupTimeoutRef.current = null;
              }
              console.log("JOIN_RESPONSE received - ready for drawing");

              // Reinitialize local drawing engine with server dimensions
              if (drawingEngine) {
                drawingEngine.reinitialize(message.width, message.height);
              }
            }

            // Store the server-provided user order
            userOrderRef.current = [...message.userIds];

            // Initialize drawing engines for all users in the list with server dimensions
            message.userIds.forEach((userId: string) => {
              createUserEngine(userId, message.width, message.height);
            });

            // Mark for recomposition to update layer order
            needsRecompositionRef.current = true;
            break;
          }

          case "endSession": {
            console.log("END_SESSION received:", {
              userId: message.userId.substring(0, 8),
              postUrl: message.postUrl,
              isFromOwner: message.userId !== userIdRef.current
            });

            if (message.userId !== userIdRef.current) {
              // Show notification to non-owners
              setSessionEnded(true);
              
              // Redirect immediately to the post URL
              window.location.href = message.postUrl;
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
                username: message.userId.substring(0, 8),
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
            const userEngine = userEnginesRef.current.get(message.userId);
            if (userEngine && CANVAS_WIDTH > 0 && CANVAS_HEIGHT > 0) {
              try {
                pngDataToLayer(message.pngData, CANVAS_WIDTH, CANVAS_HEIGHT)
                  .then((layerData) => {
                    const targetLayer =
                      message.layer === "foreground"
                        ? userEngine.engine.layers.foreground
                        : userEngine.engine.layers.background;

                    targetLayer.set(layerData);
                    needsRecompositionRef.current = true;
                  })
                  .catch((error) => {
                    console.error("Failed to decompress snapshot:", error);
                  });
              } catch (error) {
                console.error("Failed to process snapshot:", error);
              }
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
    fetchAuthInfo,
    drawingEngine,
    handleLocalDrawingChange,
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
  ]);

  // RAF-based compositing system for better performance
  const compositeAllUserLayers = useCallback(() => {
    const canvas = canvasRef.current;
    if (
      !canvas ||
      !needsRecompositionRef.current ||
      CANVAS_WIDTH <= 0 ||
      CANVAS_HEIGHT <= 0
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
        if (tempCtxRef.current && tempCanvasRef.current) {
          const compositeData = engine.compositeBuffer;
          const imageData = new ImageData(
            compositeData,
            engine.imageWidth,
            engine.imageHeight
          );
          tempCtxRef.current.putImageData(imageData, 0, 0);

          // Draw cached temp canvas onto main canvas
          ctx.drawImage(tempCanvasRef.current, 0, 0);
        }
      } else if (canvas) {
        // For remote users, update their offscreen canvas first
        const userCtx = canvas.getContext("2d");
        if (userCtx) {
          userCtx.clearRect(0, 0, engine.imageWidth, engine.imageHeight);
          engine.compositeLayers(true, true); // Always show both layers for remote users

          // Get the composite data and draw to user's offscreen canvas
          const compositeData = engine.compositeBuffer;
          const imageData = new ImageData(
            compositeData,
            engine.imageWidth,
            engine.imageHeight
          );
          userCtx.putImageData(imageData, 0, 0);

          // Draw user's canvas onto main canvas
          ctx.drawImage(canvas, 0, 0);
        }
      }
    });

    needsRecompositionRef.current = false;
  }, [
    drawingEngine,
    drawingState.fgVisible,
    drawingState.bgVisible,
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
  ]);

  // Set the compositing callback ref after compositeAllUserLayers is defined
  useEffect(() => {
    compositeCallbackRef.current = compositeAllUserLayers;
  }, [compositeAllUserLayers]);

  // RAF-based rendering loop with Safari optimization
  const rafId = useRef<number | null>(null);
  const lastRenderTime = useRef<number>(0);
  const startRenderLoop = useCallback(() => {
    const render = (currentTime: number) => {
      const targetFPS = 60;
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

  // Initialize WebSocket connection on component mount
  useEffect(() => {
    // Enable connection and connect to WebSocket
    shouldConnectRef.current = true;
    // Defer WebSocket connection until we have user authentication
    const initConnection = async () => {
      const authSuccess = await fetchAuthInfo();
      if (authSuccess) {
        connectWebSocket();
      }
    };
    initConnection();

    // Clean up WebSocket connection when component unmounts
    return () => {
      shouldConnectRef.current = false;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectWebSocket, fetchAuthInfo]);

  // Initialize canvas dimensions and thumbnails when dimensions are received
  useEffect(() => {
    if (canvasRef.current && canvasDimensions) {
      canvasRef.current.width = CANVAS_WIDTH;
      canvasRef.current.height = CANVAS_HEIGHT;

      // Set thumbnail dimensions to match canvas aspect ratio
      setThumbnailDimensions(
        canvasRef.current,
        fgThumbnailRef.current,
        bgThumbnailRef.current
      );
    }
  }, [canvasDimensions, CANVAS_WIDTH, CANVAS_HEIGHT]);

  // Add scroll wheel zoom functionality
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // Only zoom when cursor is over the canvas or app area
      const target = e.target as Element;
      const isOverCanvas = target.id === "canvas" || target.closest("#app");

      if (isOverCanvas) {
        e.preventDefault();

        if (e.deltaY > 0) {
          // Zoom out with pointer coordinates
          handleZoomOut(e.clientX, e.clientY);
        } else if (e.deltaY < 0) {
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
    if (drawingEngine) {
      const fgCtx = fgThumbnailRef.current?.getContext("2d");
      const bgCtx = bgThumbnailRef.current?.getContext("2d");

      // Update layer thumbnails only
      drawingEngine.updateLayerThumbnails(fgCtx, bgCtx);
    }

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
    <div className="drawing-session-container">
      {authError && (
        <div className="auth-error-dialog">
          <div className="auth-error-content">
            <h2>Authentication Failed</h2>
            <p>
              Unable to authenticate your session. Please return to the home
              page to log in.
            </p>
            <button
              onClick={() => (window.location.href = "/")}
              className="auth-error-button"
            >
              Go to Home Page
            </button>
          </div>
        </div>
      )}
      <div className="drawing-area">
        <Chat
          wsRef={wsRef}
          userId={userIdRef.current}
          onChatMessage={handleChatMessage}
        />
        <div id="app" ref={appRef}>
          {isCatchingUp && (
            <div className="catching-up-indicator">
              <div className="catching-up-cucumber">🥒</div>
              <div className="catching-up-message">LOADING...</div>
            </div>
          )}
          {connectionState !== "connected" && !isCatchingUp && (
            <div className="connection-status-indicator">
              {connectionState === "disconnected" && (
                <>
                  <div className="disconnect-message">
                    Connection lost. Your work is saved locally.
                  </div>
                  <div className="disconnect-actions">
                    <button
                      className="reconnect-btn"
                      onClick={handleManualReconnect}
                    >
                      Reconnect
                    </button>
                    <button
                      className="download-btn"
                      onClick={downloadCanvasAsPNG}
                    >
                      Download PNG
                    </button>
                  </div>
                </>
              )}
              {connectionState === "connecting" && (
                <>
                  <div className="reconnecting-spinner">🥒</div>
                  <div>Connecting...</div>
                </>
              )}
            </div>
          )}
          {canvasDimensions ? (
            <canvas
              id="canvas"
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              className={drawingState.brushType === "pan" ? "pan-cursor" : ""}
              style={{ imageRendering: "pixelated" }}
            ></canvas>
          ) : (
            <div className="canvas-loading">
              <div className="canvas-loading-spinner">🥒</div>
              <div>Waiting for canvas dimensions...</div>
            </div>
          )}
          <div id="controls">
            <div id="history-controls">
              <button
                id="undo-btn"
                type="button"
                onClick={undo}
                disabled={!historyState.canUndo}
              >
                Undo
              </button>
              <button
                id="redo-btn"
                type="button"
                onClick={redo}
                disabled={!historyState.canRedo}
              >
                Redo
              </button>
            </div>
            <div id="brush-type-controls">
              {(
                ["solid", "halftone", "eraser", "fill", "pan"] as BrushType[]
              ).map((type) => (
                <label key={type}>
                  <input
                    type="radio"
                    name="brushType"
                    value={type}
                    checked={drawingState.brushType === type}
                    onChange={() => updateBrushType(type)}
                  />
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </label>
              ))}
            </div>
            <div id="color-picker-container">
              <div id="color-palette">
                {paletteColors.map((paletteColor, index) => (
                  <button
                    key={index}
                    className={`color-btn ${
                      selectedPaletteIndex === index ? "selected" : ""
                    }`}
                    style={{ backgroundColor: paletteColor }}
                    onClick={() => {
                      setSelectedPaletteIndex(index);
                      updateColor(paletteColor);
                    }}
                    title={`Palette color ${index + 1}${
                      selectedPaletteIndex === index
                        ? " (selected - edit with color picker below)"
                        : ""
                    }`}
                    data-color={paletteColor}
                  />
                ))}
              </div>
              <input
                id="color-picker"
                type="color"
                value={drawingState.color}
                onChange={(e) => handleColorPickerChange(e.target.value)}
                aria-label="Custom color picker - edits selected palette color"
                title={
                  selectedPaletteIndex >= 0
                    ? `Edit palette color ${selectedPaletteIndex + 1}`
                    : "Custom color picker"
                }
              />
            </div>

            <div id="size-controls">
              <label>
                Size
                <input
                  id="brush-size-slider"
                  type="range"
                  min="1"
                  max="30"
                  value={drawingState.brushSize}
                  onChange={(e) =>
                    setDrawingState((prev) => ({
                      ...prev,
                      brushSize: parseInt(e.target.value),
                    }))
                  }
                />
              </label>
            </div>

            <div id="opacity-controls">
              <label>
                Opacity
                <input
                  id="opacity-slider"
                  type="range"
                  min="1"
                  max="255"
                  value={drawingState.opacity}
                  onChange={(e) =>
                    setDrawingState((prev) => ({
                      ...prev,
                      opacity: parseInt(e.target.value),
                    }))
                  }
                />
              </label>
            </div>

            <div id="layer-controls">
              {(["foreground", "background"] as LayerType[]).map((layer) => (
                <label key={layer}>
                  <input
                    type="radio"
                    name="layerType"
                    value={layer}
                    checked={drawingState.layerType === layer}
                    onChange={() =>
                      setDrawingState((prev) => ({ ...prev, layerType: layer }))
                    }
                  />
                  <canvas
                    className="layer-thumbnail"
                    id={`${layer === "foreground" ? "fg" : "bg"}-thumbnail`}
                    ref={
                      layer === "foreground" ? fgThumbnailRef : bgThumbnailRef
                    }
                    onContextMenu={(e) => {
                      e.preventDefault(); // Prevent browser context menu
                      // Toggle layer visibility
                      if (layer === "foreground") {
                        setDrawingState((prev) => ({
                          ...prev,
                          fgVisible: !prev.fgVisible,
                        }));
                      } else {
                        setDrawingState((prev) => ({
                          ...prev,
                          bgVisible: !prev.bgVisible,
                        }));
                      }
                    }}
                    title={`Left click to select layer, right click to toggle visibility`}
                  ></canvas>
                  {layer === "foreground" ? "FG" : "BG"}
                  <input
                    type="checkbox"
                    checked={
                      layer === "foreground"
                        ? drawingState.fgVisible
                        : drawingState.bgVisible
                    }
                    onChange={(e) => {
                      if (layer === "foreground") {
                        setDrawingState((prev) => ({
                          ...prev,
                          fgVisible: e.target.checked,
                        }));
                      } else {
                        setDrawingState((prev) => ({
                          ...prev,
                          bgVisible: e.target.checked,
                        }));
                      }
                    }}
                    title={`${
                      layer === "foreground"
                        ? "Show/hide foreground"
                        : "Show/hide background"
                    } layer`}
                  />
                </label>
              ))}
            </div>

            <div id="zoom-controls">
              <button
                id="zoom-out-btn"
                type="button"
                onClick={() => handleZoomOut()}
              >
                -
              </button>
              <span id="zoom-level">{Math.round(currentZoom * 100)}%</span>
              <button
                id="zoom-in-btn"
                type="button"
                onClick={() => handleZoomIn()}
              >
                +
              </button>
              <button
                id="zoom-reset-btn"
                type="button"
                onClick={handleZoomReset}
              >
                Reset
              </button>
            </div>

            {/* Save button - only show for session owner */}
            {isSessionOwner && (
              <div id="save-controls">
                <button
                  id="save-btn"
                  type="button"
                  onClick={saveCollaborativeDrawing}
                  disabled={isSaving || sessionEnded || !joinResponseReceived}
                  title={
                    isSaving 
                      ? "Saving drawing..." 
                      : sessionEnded 
                        ? "Session ended" 
                        : !joinResponseReceived 
                          ? "Loading..." 
                          : "Save drawing to gallery"
                  }
                >
                  {isSaving ? "Saving..." : "💾 Save to Gallery"}
                </button>
              </div>
            )}
          </div>

          {/* Session ending notification for non-owners */}
          {sessionEnded && !isSessionOwner && (
            <div className="session-ending-overlay">
              <div className="session-ending-content">
                <div className="session-ending-spinner">🥒</div>
                <div className="session-ending-message">
                  Session is ending. The drawing is being saved to the gallery...
                </div>
                <div className="session-ending-redirect">
                  You'll be redirected to the post page shortly.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
