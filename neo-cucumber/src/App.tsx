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
import { encodeJoin, decodeMessage } from "./utils/binaryProtocol";
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

type BrushType = "solid" | "halftone" | "eraser" | "fill";
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

const CANVAS_WIDTH = 500;
const CANVAS_HEIGHT = 500;

function App() {
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

  // Dirty flag to track when recomposition is needed
  const needsRecompositionRef = useRef(false);

  // Function to create drawing engine for a new user
  const createUserEngine = useCallback((userId: string) => {
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
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fgThumbnailRef = useRef<HTMLCanvasElement>(null);
  const bgThumbnailRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const userIdRef = useRef<string>(crypto.randomUUID());
  const localUserJoinTimeRef = useRef<number>(0);

  const updateBrushType = useCallback((type: BrushType) => {
    setDrawingState((prev) => {
      let newOpacity = prev.opacity;
      if (type === "halftone") newOpacity = 23;
      else if (["solid", "eraser", "fill"].includes(type)) newOpacity = 255;

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
  const { undo, redo, drawingEngine } = useDrawing(
    canvasRef,
    appRef,
    fgThumbnailRef,
    bgThumbnailRef,
    drawingState,
    handleHistoryChange,
    Math.round(currentZoom * 100),
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    wsRef,
    userIdRef,
    handleLocalDrawingChange
  );

  // RAF-based compositing system for better performance
  const compositeAllUserLayers = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !needsRecompositionRef.current) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear the canvas
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

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

    // Sort users by firstSeen timestamp (later joiners first = lower layer order)
    allUsers.sort((a, b) => b.firstSeen - a.firstSeen);

    // Composite each user's canvas onto the main canvas using Canvas API (much faster!)
    allUsers.forEach(({ userId, engine, canvas }) => {
      const isLocalUser = userId === userIdRef.current;

      if (isLocalUser) {
        // For local user, composite layers and create temporary canvas
        engine.compositeLayers(drawingState.fgVisible, drawingState.bgVisible);

        // Create temporary canvas to draw composite buffer
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = CANVAS_WIDTH;
        tempCanvas.height = CANVAS_HEIGHT;
        const tempCtx = tempCanvas.getContext("2d");
        if (tempCtx) {
          const compositeData = engine.compositeBuffer;
          const imageData = new ImageData(
            compositeData,
            CANVAS_WIDTH,
            CANVAS_HEIGHT
          );
          tempCtx.putImageData(imageData, 0, 0);

          // Draw temp canvas onto main canvas
          ctx.drawImage(tempCanvas, 0, 0);
        }
      } else if (canvas) {
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

  // RAF-based rendering loop
  const rafId = useRef<number | null>(null);
  const startRenderLoop = useCallback(() => {
    const render = () => {
      if (needsRecompositionRef.current) {
        compositeAllUserLayers();
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

  // Initialize canvas dimensions and thumbnails
  useEffect(() => {
    if (canvasRef.current) {
      canvasRef.current.width = CANVAS_WIDTH;
      canvasRef.current.height = CANVAS_HEIGHT;

      // Set thumbnail dimensions to match canvas aspect ratio
      setThumbnailDimensions(
        canvasRef.current,
        fgThumbnailRef.current,
        bgThumbnailRef.current
      );

      // Function to get WebSocket URL dynamically
      const getWebSocketUrl = () => {
        // Option 1: Use environment variable if set
        if (import.meta.env.VITE_WS_URL) {
          return import.meta.env.VITE_WS_URL;
        }

        // Option 2: Build dynamically from current location
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const host = window.location.host;

        // Extract room ID from path (last UUID in path)
        const pathSegments = window.location.pathname.split("/");
        const uuidPattern =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let roomId = "00000000-0000-0000-0000-000000000000"; // default fallback (all zero uuid)

        // Find the last UUID in the path
        for (let i = pathSegments.length - 1; i >= 0; i--) {
          if (uuidPattern.test(pathSegments[i])) {
            roomId = pathSegments[i];
            break;
          }
        }

        return `${protocol}//${host}/api/collaborate/${roomId}/ws`;
      };

      // Connect to WebSocket on canvas load
      const ws = new WebSocket(getWebSocketUrl());

      // Store WebSocket reference for use in other components
      wsRef.current = ws;

      ws.onopen = () => {
        // Send initial join message to establish user presence and layer order
        try {
          const binaryMessage = encodeJoin(userIdRef.current, Date.now());
          ws.send(binaryMessage);
        } catch (error) {
          console.error("Failed to send join message:", error);
        }

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

      // Helper function to handle decoded binary messages
      const handleBinaryMessage = async (message: any) => {
        try {
          // Handle different message types
          switch (message.type) {
            case "drawLine": {
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

                // Update thumbnails for the remote user's engine
                engine.updateLayerThumbnails();

                // CRITICAL: Update composite buffer for remote engine
                engine.compositeLayers(true, true);

                needsRecompositionRef.current = true;
              }
              break;
            }

            case "drawPoint": {
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

                // Update thumbnails and composite buffer for remote engine
                engine.updateLayerThumbnails();
                engine.compositeLayers(true, true);

                needsRecompositionRef.current = true;
              }
              break;
            }

            case "fill": {
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

                // Update thumbnails and composite buffer for remote engine
                engine.updateLayerThumbnails();
                engine.compositeLayers(true, true);

                needsRecompositionRef.current = true;
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
              if (userEngine) {
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

      ws.onerror = (event) => {
        console.error("WebSocket error:", event);
      };

      ws.onclose = (event) => {
        console.log("WebSocket closed:", event);
      };

      // Clean up WebSocket connection when component unmounts
      return () => {
        wsRef.current = null;
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      };
    }
  }, []);

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
      <div className="drawing-area">
        <Chat
          wsRef={wsRef}
          userId={userIdRef.current}
          onChatMessage={handleChatMessage}
        />
        <div id="app" ref={appRef}>
          <canvas
            id="canvas"
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            style={{ imageRendering: "pixelated" }}
          ></canvas>
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
              {(["solid", "halftone", "eraser", "fill"] as BrushType[]).map(
                (type) => (
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
                )
              )}
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
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
