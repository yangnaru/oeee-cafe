import { useEffect, useRef, useCallback } from "react";
import { DrawingEngine } from "../DrawingEngine";
import { useCanvasHistory } from "./useCanvasHistory";
import { layerToPngBlob } from "../utils/canvasSnapshot";
import { 
  encodeSnapshot, 
  encodeDrawLine, 
  encodeDrawPoint, 
  encodeFill, 
  encodePointerUp 
} from "../utils/binaryProtocol";

interface DrawingState {
  brushSize: number;
  opacity: number;
  color: string;
  brushType: "solid" | "halftone" | "eraser" | "fill";
  layerType: "foreground" | "background";
  fgVisible: boolean;
  bgVisible: boolean;
}

export const useDrawing = (
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  appRef: React.RefObject<HTMLDivElement | null>,
  fgThumbnailRef: React.RefObject<HTMLCanvasElement | null>,
  bgThumbnailRef: React.RefObject<HTMLCanvasElement | null>,
  drawingState: DrawingState,
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void,
  zoomLevel?: number,
  canvasWidth: number = 500,
  canvasHeight: number = 500,
  wsRef?: React.RefObject<WebSocket | null>,
  userIdRef?: React.RefObject<string>,
  onDrawingChange?: () => void
) => {
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingEngineRef = useRef<DrawingEngine | null>(null);
  const isInitializedRef = useRef(false);
  const onHistoryChangeRef = useRef(onHistoryChange);
  const lastModifiedLayerRef = useRef<"foreground" | "background">("foreground");
  const isDrawingRef = useRef(false);
  const pendingSnapshotRequestRef = useRef(false);
  const history = useCanvasHistory(30);

  // Update the ref when callback changes
  const onDrawingChangeRef = useRef(onDrawingChange);
  useEffect(() => {
    onHistoryChangeRef.current = onHistoryChange;
    onDrawingChangeRef.current = onDrawingChange;
  }, [onHistoryChange, onDrawingChange]);

  // Initialize drawing engine
  const initializeDrawing = useCallback(() => {
    if (!canvasRef.current) return;
    if (isInitializedRef.current && drawingEngineRef.current) return; // Only skip if both initialized AND engine exists

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = false;
    canvas.style.imageRendering = "pixelated";
    contextRef.current = ctx;

    // Set up thumbnail canvases
    if (fgThumbnailRef.current) {
      const fgCtx = fgThumbnailRef.current.getContext("2d");
      if (fgCtx) fgCtx.imageSmoothingEnabled = false;
    }
    if (bgThumbnailRef.current) {
      const bgCtx = bgThumbnailRef.current.getContext("2d");
      if (bgCtx) bgCtx.imageSmoothingEnabled = false;
    }

    // Create and initialize drawing engine
    drawingEngineRef.current = new DrawingEngine(canvasWidth, canvasHeight);
    drawingEngineRef.current.initialize(
      ctx,
      fgThumbnailRef.current || undefined,
      bgThumbnailRef.current || undefined
    );

    // Save initial state to history
    if (
      drawingEngineRef.current.layers.foreground &&
      drawingEngineRef.current.layers.background
    ) {
      history.saveState(
        drawingEngineRef.current.layers.foreground,
        drawingEngineRef.current.layers.background
      );
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
    }

    isInitializedRef.current = true;
  }, [
    canvasRef,
    fgThumbnailRef,
    bgThumbnailRef,
    history,
    canvasWidth,
    canvasHeight,
  ]);

  // Drawing state refs to prevent recreation on re-renders
  const drawingStateRef = useRef({
    isDrawing: false,
    prevX: 0,
    prevY: 0,
    currentX: 0,
    currentY: 0,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    activePointerId: null as number | null,
  });

  // Handle drawing events
  const setupDrawingEvents = useCallback(() => {
    const app = appRef.current;
    if (!app) return;

    // Convert screen coordinates to canvas coordinates
    const getCanvasCoordinates = (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };

      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };

      // Calculate the scale between canvas internal coordinates and displayed size
      const cssScaleX = canvas.width / rect.width;
      const cssScaleY = canvas.height / rect.height;

      // Convert screen coordinates to canvas coordinates
      // The CSS transform (pan) is already included in rect.left/rect.top,
      // so we don't need to manually account for it here
      const x = (clientX - rect.left) * cssScaleX;
      const y = (clientY - rect.top) * cssScaleY;

      return { x: Math.round(x), y: Math.round(y) };
    };

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element;
      const controlsElement = document.getElementById("controls");

      // Don't interfere with controls interaction
      if (controlsElement?.contains(target as Node)) return;

      // Only handle drawing area interactions
      if (
        !(
          target.id === "canvas" ||
          target.closest("#canvas") ||
          (target.closest("#app") && !target.closest("#controls"))
        )
      ) {
        return;
      }

      // Prevent default touch behaviors like scrolling for drawing area only
      e.preventDefault();

      // Only handle one pointer at a time
      if (
        drawingStateRef.current.activePointerId !== null &&
        drawingStateRef.current.activePointerId !== e.pointerId
      )
        return;

      drawingStateRef.current.activePointerId = e.pointerId;
      app.setPointerCapture(e.pointerId);

      if (e.button === 1 || (e.pointerType === "touch" && e.buttons === 0)) {
        // Middle mouse button or touch (for panning)
        drawingStateRef.current.isPanning = true;
        drawingStateRef.current.panStartX = e.clientX;
        drawingStateRef.current.panStartY = e.clientY;
        return;
      }

      if (
        e.button === 0 ||
        e.pointerType === "touch" ||
        e.pointerType === "pen"
      ) {
        const coords = getCanvasCoordinates(e.clientX, e.clientY);

        // Mark drawing as active
        isDrawingRef.current = true;

        if (drawingState.brushType === "fill") {
          if (!drawingEngineRef.current) {
            return;
          }

          // Perform flood fill
          const r = parseInt(drawingState.color.slice(1, 3), 16);
          const g = parseInt(drawingState.color.slice(3, 5), 16);
          const b = parseInt(drawingState.color.slice(5, 7), 16);

          drawingEngineRef.current.doFloodFill(
            drawingEngineRef.current.layers[drawingState.layerType],
            Math.floor(coords.x),
            Math.floor(coords.y),
            r,
            g,
            b,
            drawingState.opacity
          );

          // Track which layer was modified
          lastModifiedLayerRef.current = drawingState.layerType;

          // Send fill event through WebSocket
          if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN && userIdRef?.current) {
            try {
              const binaryMessage = encodeFill(
                userIdRef.current,
                drawingState.layerType,
                Math.floor(coords.x),
                Math.floor(coords.y),
                r, g, b, drawingState.opacity
              );
              wsRef.current.send(binaryMessage);
            } catch (error) {
              console.error("Failed to send fill event:", error);
            }
          }

          drawingEngineRef.current.updateLayerThumbnails(
            fgThumbnailRef.current?.getContext("2d") || undefined,
            bgThumbnailRef.current?.getContext("2d") || undefined
          );
          // Notify parent component that drawing has changed
          onDrawingChangeRef.current?.();

          // Save state after fill operation
          if (
            drawingEngineRef.current.layers.foreground &&
            drawingEngineRef.current.layers.background
          ) {
            history.saveState(
              drawingEngineRef.current.layers.foreground,
              drawingEngineRef.current.layers.background
            );
            onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
          }
        } else {
          if (!drawingEngineRef.current) {
            return;
          }

          // Draw at the initial click position
          const r = parseInt(drawingState.color.slice(1, 3), 16);
          const g = parseInt(drawingState.color.slice(3, 5), 16);
          const b = parseInt(drawingState.color.slice(5, 7), 16);

          // Use standard opacity
          const effectiveOpacity = drawingState.opacity;

          // Draw single point using drawLine method (works for all brush types)
          drawingEngineRef.current.drawLine(
            drawingEngineRef.current.layers[drawingState.layerType],
            coords.x,
            coords.y,
            coords.x,
            coords.y,
            drawingState.brushSize,
            drawingState.brushType,
            r,
            g,
            b,
            effectiveOpacity
          );

          // Track which layer was modified
          lastModifiedLayerRef.current = drawingState.layerType;

          // Update thumbnails and composite
          drawingEngineRef.current.updateLayerThumbnails(
            fgThumbnailRef.current?.getContext("2d") || undefined,
            bgThumbnailRef.current?.getContext("2d") || undefined
          );
          // Notify parent component that drawing has changed
          onDrawingChangeRef.current?.();

          // Send single click drawing event through WebSocket
          if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN && userIdRef?.current) {
            try {
              const binaryMessage = encodeDrawPoint(
                userIdRef.current,
                drawingState.layerType,
                coords.x, coords.y,
                drawingState.brushSize,
                drawingState.brushType,
                r, g, b, effectiveOpacity,
                e.pointerType as 'mouse' | 'pen' | 'touch'
              );
              wsRef.current.send(binaryMessage);
            } catch (error) {
              console.error("Failed to send drawPoint event:", error);
            }
          }

          drawingStateRef.current.isDrawing = true;
          drawingStateRef.current.currentX = coords.x;
          drawingStateRef.current.currentY = coords.y;
          drawingStateRef.current.prevX = drawingStateRef.current.currentX;
          drawingStateRef.current.prevY = drawingStateRef.current.currentY;
        }
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      // Only handle the active pointer
      if (drawingStateRef.current.activePointerId !== e.pointerId) return;

      // Send pointerup event through WebSocket
      if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN && userIdRef?.current) {
        const coords = getCanvasCoordinates(e.clientX, e.clientY);
        try {
          const binaryMessage = encodePointerUp(
            userIdRef.current,
            coords.x, coords.y,
            e.button,
            e.pointerType as 'mouse' | 'pen' | 'touch'
          );
          wsRef.current.send(binaryMessage);
        } catch (error) {
          console.error("Failed to send pointerup event:", error);
        }
      }

      if (e.button === 1 || drawingStateRef.current.isPanning) {
        drawingStateRef.current.isPanning = false;
      } else {
        // Mark drawing as inactive for drawing operations
        isDrawingRef.current = false;
        
        // Check for pending snapshot request
        if (pendingSnapshotRequestRef.current) {
          sendSnapshot();
          pendingSnapshotRequestRef.current = false;
        }
      }

      if (
        (e.button === 0 ||
          e.pointerType === "touch" ||
          e.pointerType === "pen") &&
        drawingStateRef.current.isDrawing
      ) {
        // Save state after stroke ends
        if (
          drawingEngineRef.current &&
          drawingEngineRef.current.layers.foreground &&
          drawingEngineRef.current.layers.background
        ) {
          history.saveState(
            drawingEngineRef.current.layers.foreground,
            drawingEngineRef.current.layers.background
          );
          onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
        }

        drawingStateRef.current.isDrawing = false;
      }

      // Release pointer capture
      if (app.hasPointerCapture(e.pointerId)) {
        app.releasePointerCapture(e.pointerId);
      }
      drawingStateRef.current.activePointerId = null;
    };

    const handlePointerMove = (e: PointerEvent) => {
      // Only handle the active pointer
      if (drawingStateRef.current.activePointerId !== e.pointerId) return;

      if (drawingStateRef.current.isPanning) {
        const deltaX = e.clientX - drawingStateRef.current.panStartX;
        const deltaY = e.clientY - drawingStateRef.current.panStartY;

        // Update the engine's pan offset
        if (drawingEngineRef.current) {
          drawingEngineRef.current.updatePanOffset(
            deltaX,
            deltaY,
            canvasRef.current || undefined
          );
        }

        drawingStateRef.current.panStartX = e.clientX;
        drawingStateRef.current.panStartY = e.clientY;
        return;
      }

      if (
        !drawingStateRef.current.isDrawing ||
        drawingState.brushType === "fill"
      )
        return;

      drawingStateRef.current.prevX = drawingStateRef.current.currentX;
      drawingStateRef.current.prevY = drawingStateRef.current.currentY;
      const coords = getCanvasCoordinates(e.clientX, e.clientY);
      drawingStateRef.current.currentX = coords.x;
      drawingStateRef.current.currentY = coords.y;

      if (!drawingEngineRef.current) {
        return;
      }

      const r = parseInt(drawingState.color.slice(1, 3), 16);
      const g = parseInt(drawingState.color.slice(3, 5), 16);
      const b = parseInt(drawingState.color.slice(5, 7), 16);

      // Use standard opacity
      const effectiveOpacity = drawingState.opacity;

      drawingEngineRef.current.drawLine(
        drawingEngineRef.current.layers[drawingState.layerType],
        drawingStateRef.current.prevX,
        drawingStateRef.current.prevY,
        drawingStateRef.current.currentX,
        drawingStateRef.current.currentY,
        drawingState.brushSize,
        drawingState.brushType,
        r,
        g,
        b,
        effectiveOpacity
      );

      // Track which layer was modified
      lastModifiedLayerRef.current = drawingState.layerType;

      // Send drawLine event through WebSocket
      if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN && userIdRef?.current) {
        try {
          const binaryMessage = encodeDrawLine(
            userIdRef.current,
            drawingState.layerType,
            drawingStateRef.current.prevX,
            drawingStateRef.current.prevY,
            drawingStateRef.current.currentX,
            drawingStateRef.current.currentY,
            drawingState.brushSize,
            drawingState.brushType,
            r, g, b, effectiveOpacity,
            e.pointerType as 'mouse' | 'pen' | 'touch'
          );
          wsRef.current.send(binaryMessage);
        } catch (error) {
          console.error("Failed to send drawLine event:", error);
        }
      }

      drawingEngineRef.current.updateLayerThumbnails(
        fgThumbnailRef.current?.getContext("2d") || undefined,
        bgThumbnailRef.current?.getContext("2d") || undefined
      );
      // Notify parent component that drawing has changed
      onDrawingChange?.();
    };

    // Add pointer event listeners (handles mouse, touch, and pen)
    app.addEventListener("pointerdown", handlePointerDown);
    app.addEventListener("pointerup", handlePointerUp);
    app.addEventListener("pointermove", handlePointerMove);

    // Prevent touch behaviors that interfere with drawing - only on canvas area
    const preventTouchOnCanvas = (e: TouchEvent) => {
      const target = e.target as Element;
      // Only prevent touch events if they're on the canvas or drawing area, not on controls
      if (
        target.id === "canvas" ||
        target.closest("#canvas") ||
        (target.closest("#app") && !target.closest("#controls"))
      ) {
        e.preventDefault();
      }
    };

    app.addEventListener("touchstart", preventTouchOnCanvas, {
      passive: false,
    });
    app.addEventListener("touchmove", preventTouchOnCanvas, { passive: false });
    app.addEventListener("touchend", preventTouchOnCanvas, { passive: false });

    return () => {
      app.removeEventListener("pointerdown", handlePointerDown);
      app.removeEventListener("pointerup", handlePointerUp);
      app.removeEventListener("pointermove", handlePointerMove);

      // Clean up touch event listeners
      app.removeEventListener("touchstart", preventTouchOnCanvas);
      app.removeEventListener("touchmove", preventTouchOnCanvas);
      app.removeEventListener("touchend", preventTouchOnCanvas);
    };
  }, [appRef, canvasRef, drawingState, history, wsRef, userIdRef]);

  useEffect(() => {
    initializeDrawing();
  }, [initializeDrawing]);

  // Additional effect to force initialization once refs are available
  useEffect(() => {
    if (canvasRef.current && !isInitializedRef.current) {
      initializeDrawing();
    }
  }, [canvasRef.current, appRef.current]);

  useEffect(() => {
    const cleanup = setupDrawingEvents();
    return cleanup;
  }, [setupDrawingEvents]);

  // Undo function
  const handleUndo = useCallback(async () => {
    const previousState = history.undo();
    if (previousState && contextRef.current && drawingEngineRef.current) {
      // Restore layer states
      drawingEngineRef.current.layers.foreground.set(previousState.foreground);
      drawingEngineRef.current.layers.background.set(previousState.background);

      // Update display
      drawingEngineRef.current.updateLayerThumbnails(
        fgThumbnailRef.current?.getContext("2d") || undefined,
        bgThumbnailRef.current?.getContext("2d") || undefined
      );
      // Notify parent component that drawing has changed
      onDrawingChange?.();
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());

      // Send snapshot over WebSocket
      if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN && userIdRef?.current) {
        try {
          const layerToSend = lastModifiedLayerRef.current;
          const layerData = drawingEngineRef.current.layers[layerToSend];
          const pngBlob = await layerToPngBlob(layerData, canvasWidth, canvasHeight);
          const binaryMessage = await encodeSnapshot(userIdRef.current, layerToSend, pngBlob);

          wsRef.current.send(binaryMessage);
        } catch (error) {
          console.error("Failed to send undo snapshot:", error);
        }
      }
    }
  }, [history, canvasWidth, canvasHeight, wsRef, userIdRef]);

  // Redo function
  const handleRedo = useCallback(async () => {
    const nextState = history.redo();
    if (nextState && contextRef.current && drawingEngineRef.current) {
      // Restore layer states
      drawingEngineRef.current.layers.foreground.set(nextState.foreground);
      drawingEngineRef.current.layers.background.set(nextState.background);

      // Update display
      drawingEngineRef.current.updateLayerThumbnails(
        fgThumbnailRef.current?.getContext("2d") || undefined,
        bgThumbnailRef.current?.getContext("2d") || undefined
      );
      // Notify parent component that drawing has changed
      onDrawingChange?.();
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());

      // Send snapshot over WebSocket
      if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN && userIdRef?.current) {
        try {
          const layerToSend = lastModifiedLayerRef.current;
          const layerData = drawingEngineRef.current.layers[layerToSend];
          const pngBlob = await layerToPngBlob(layerData, canvasWidth, canvasHeight);
          const binaryMessage = await encodeSnapshot(userIdRef.current, layerToSend, pngBlob);

          wsRef.current.send(binaryMessage);
        } catch (error) {
          console.error("Failed to send redo snapshot:", error);
        }
      }
    }
  }, [history, canvasWidth, canvasHeight, wsRef, userIdRef]);

  // Update canvas zoom when zoom level changes
  useEffect(() => {
    if (canvasRef.current && zoomLevel) {
      const canvas = canvasRef.current;
      const zoom = zoomLevel / 100; // Convert percentage to decimal

      // The drawing engine doesn't need zoom state since React handles sizing

      // Use React-provided canvas dimensions instead of DOM properties
      const displayWidth = canvasWidth * zoom;
      const displayHeight = canvasHeight * zoom;

      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
    }
  }, [zoomLevel, canvasRef, canvasWidth, canvasHeight]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      if (drawingEngineRef.current) {
        drawingEngineRef.current.dispose();
        drawingEngineRef.current = null;
      }
    };
  }, []); // Empty dependency array - only runs on unmount

  // Send snapshot of current canvas state
  const sendSnapshot = useCallback(async () => {
    const engine = drawingEngineRef.current;
    const ws = wsRef?.current;
    const userId = userIdRef?.current;
    
    if (!engine || !ws || ws.readyState !== WebSocket.OPEN || !userId) {
      return;
    }

    try {
      // Send foreground layer snapshot
      const fgPngBlob = await layerToPngBlob(
        engine.layers.foreground,
        canvasWidth,
        canvasHeight
      );
      const fgSnapshot = await encodeSnapshot(userId, 'foreground', fgPngBlob);
      ws.send(fgSnapshot);

      // Send background layer snapshot
      const bgPngBlob = await layerToPngBlob(
        engine.layers.background,
        canvasWidth,
        canvasHeight
      );
      const bgSnapshot = await encodeSnapshot(userId, 'background', bgPngBlob);
      ws.send(bgSnapshot);
    } catch (error) {
      console.error("Failed to send snapshots:", error);
    }
  }, [canvasWidth, canvasHeight, wsRef, userIdRef]);

  // Handle snapshot request from server
  const handleSnapshotRequest = useCallback((_timestamp: number) => {
    if (isDrawingRef.current) {
      // Defer if currently drawing
      pendingSnapshotRequestRef.current = true;
    } else {
      // Send immediately if not drawing
      sendSnapshot();
    }
  }, [sendSnapshot]);

  // Expose snapshot request handler to window for App.tsx
  useEffect(() => {
    (window as any).handleSnapshotRequest = handleSnapshotRequest;
    return () => {
      delete (window as any).handleSnapshotRequest;
    };
  }, [handleSnapshotRequest]);

  return {
    context: contextRef.current,
    drawingEngine: drawingEngineRef.current,
    initializeDrawing,
    undo: handleUndo,
    redo: handleRedo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    getHistoryInfo: history.getHistoryInfo,
  };
};
