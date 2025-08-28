import {
  useState,
  useRef,
  useEffect,
  useCallback,
  startTransition,
} from "react";
import { useDrawing } from "./hooks/useDrawing";
import { DrawingEngine } from "./DrawingEngine";
import { compositeEngineLayer, compositeLayers } from "./compositing";
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

  // Track user IDs and their drawing engines
  const [userEngines, setUserEngines] = useState<Map<string, { engine: DrawingEngine, firstSeen: number }>>(new Map());

  // Function to create drawing engine for a new user
  const createUserEngine = useCallback((userId: string) => {
    setUserEngines(prev => {
      // Check if user already exists in the current state
      if (prev.has(userId)) {
        return prev; // Return unchanged state if user already exists
      }
      
      // Create new DrawingEngine for this user
      const engine = new DrawingEngine(CANVAS_WIDTH, CANVAS_HEIGHT);
      const firstSeen = Date.now();
      
      const newMap = new Map(prev);
      newMap.set(userId, { engine, firstSeen });
      
      console.log(`Created drawing engine for new user: ${userId}, first seen: ${new Date(firstSeen).toISOString()}`);
      return newMap;
    });
  }, []);


  // Function to composite all user layers to the main canvas
  const compositeAllUserLayers = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Clear the canvas
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    
    // Sort users by firstSeen timestamp (later joiners first = lower layer order)
    const sortedUsers = Array.from(userEngines.entries()).sort(
      ([, a], [, b]) => b.firstSeen - a.firstSeen
    );
    
    // Collect all user layers for proper compositing
    const allLayers: Uint8ClampedArray[] = [];
    
    // Add each user's composite layer (background + foreground) in order
    sortedUsers.forEach(([userId, userEngine]) => {
      const engine = userEngine.engine;
      
      // Composite this user's foreground and background using the same algorithm as DrawingEngine
      const userComposite = compositeEngineLayer(
        engine.layers.foreground,
        engine.layers.background,
        drawingState.fgVisible,
        drawingState.bgVisible,
        engine.imageWidth,
        engine.imageHeight
      );
      
      allLayers.push(userComposite);
      console.log(`Prepared composite for user: ${userId}`);
    });
    
    // Composite all user layers together
    const finalComposite = compositeLayers(allLayers, CANVAS_WIDTH, CANVAS_HEIGHT);
    
    // Put the final result on the main canvas
    const finalImageData = new ImageData(finalComposite, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.putImageData(finalImageData, 0, 0);
    
    console.log(`Composited ${sortedUsers.length} user layers`);
  }, [userEngines]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fgThumbnailRef = useRef<HTMLCanvasElement>(null);
  const bgThumbnailRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const userIdRef = useRef<string>(crypto.randomUUID());

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
    userIdRef
  );

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

      // Connect to WebSocket on canvas load
      const ws = new WebSocket(
        "wss://jihyeoks-macbook-air.tail2f2e3.ts.net/api/collaborate/1d57bd0d-be56-43d4-8b66-da739128fb22/ws"
      );

      // Store WebSocket reference for use in other components
      wsRef.current = ws;

      ws.onopen = (event) => {
        console.log("WebSocket connected:", event);
      };

      ws.onmessage = (event) => {
        console.log("WebSocket message received:", event);
        console.log("Message data:", event.data);
        
        try {
          const messageData = JSON.parse(event.data);
          
          // Check if message contains a userId
          if (messageData.userId && typeof messageData.userId === 'string') {
            // Create drawing engine for new user if they don't exist
            createUserEngine(messageData.userId);
            
            // Handle different event types
            if (messageData.type === 'drawLine') {
              // Apply drawing to user's engine
              setUserEngines(prev => {
                const userEngine = prev.get(messageData.userId);
                if (userEngine && messageData.color) {
                  const engine = userEngine.engine;
                  const targetLayer = messageData.layer === 'foreground' ? engine.layers.foreground : engine.layers.background;
                  
                  // Use the DrawingEngine's drawLine method
                  engine.drawLine(
                    targetLayer,
                    messageData.fromX,
                    messageData.fromY,
                    messageData.toX,
                    messageData.toY,
                    messageData.brushSize || 1,
                    messageData.brushType || 'solid',
                    messageData.color.r || 0,
                    messageData.color.g || 0,
                    messageData.color.b || 0,
                    messageData.color.a || 255
                  );
                  
                  console.log(`Applied drawLine from user ${messageData.userId} to ${messageData.layer} layer using ${messageData.brushType} brush`);
                }
                // Return a new Map to trigger re-render
                return new Map(prev);
              });
            } else if (messageData.type === 'fill') {
              // Apply fill operation to user's engine
              setUserEngines(prev => {
                const userEngine = prev.get(messageData.userId);
                if (userEngine && messageData.color) {
                  const engine = userEngine.engine;
                  const targetLayer = messageData.layer === 'foreground' ? engine.layers.foreground : engine.layers.background;
                  
                  // Use the DrawingEngine's doFloodFill method
                  engine.doFloodFill(
                    targetLayer,
                    messageData.x,
                    messageData.y,
                    messageData.color.r || 0,
                    messageData.color.g || 0,
                    messageData.color.b || 0,
                    messageData.color.a || 255
                  );
                  
                  console.log(`Applied fill from user ${messageData.userId} to ${messageData.layer} layer at (${messageData.x}, ${messageData.y})`);
                }
                // Return a new Map to trigger re-render
                return new Map(prev);
              });
            } else if (messageData.type === 'drawPoint') {
              // Apply single point drawing to user's engine
              setUserEngines(prev => {
                const userEngine = prev.get(messageData.userId);
                if (userEngine && messageData.color) {
                  const engine = userEngine.engine;
                  const targetLayer = messageData.layer === 'foreground' ? engine.layers.foreground : engine.layers.background;
                  
                  // Use the DrawingEngine's drawLine method with same start/end point
                  engine.drawLine(
                    targetLayer,
                    messageData.x,
                    messageData.y,
                    messageData.x,
                    messageData.y,
                    messageData.brushSize || 1,
                    messageData.brushType || 'solid',
                    messageData.color.r || 0,
                    messageData.color.g || 0,
                    messageData.color.b || 0,
                    messageData.color.a || 255
                  );
                  
                  console.log(`Applied drawPoint from user ${messageData.userId} to ${messageData.layer} layer using ${messageData.brushType} brush at (${messageData.x}, ${messageData.y})`);
                }
                // Return a new Map to trigger re-render
                return new Map(prev);
              });
            } else if (messageData.type === 'pointerup') {
              // Handle pointerup events (could be used for stroke completion, etc.)
              console.log(`Received pointerup from user ${messageData.userId} at (${messageData.x}, ${messageData.y})`);
            }
          }
        } catch (error) {
          console.error("Failed to parse WebSocket message:", error);
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

  // Update canvas when layer visibility changes or user layers change
  useEffect(() => {
    if (drawingEngine) {
      const fgCtx = fgThumbnailRef.current?.getContext("2d");
      const bgCtx = bgThumbnailRef.current?.getContext("2d");
      const canvasCtx = canvasRef.current?.getContext("2d");

      // Update layer thumbnails and composite
      drawingEngine.updateLayerThumbnails(fgCtx, bgCtx);
      drawingEngine.compositeLayers(
        drawingState.fgVisible,
        drawingState.bgVisible
      );

      // Update main canvas with drawing engine composite
      if (canvasCtx && drawingEngine.compositeBuffer) {
        canvasCtx.putImageData(
          new ImageData(
            drawingEngine.compositeBuffer,
            drawingEngine.imageWidth,
            drawingEngine.imageHeight
          ),
          0,
          0
        );
      }
    }
    
    // Composite all user layers on top
    compositeAllUserLayers();
  }, [drawingState.fgVisible, drawingState.bgVisible, drawingEngine, userEngines, compositeAllUserLayers]);

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
