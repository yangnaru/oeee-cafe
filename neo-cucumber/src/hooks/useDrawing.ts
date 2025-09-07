import { useEffect, useRef, useCallback } from "react";
import { DrawingEngine } from "../DrawingEngine";
import { useCanvasHistory } from "./useCanvasHistory";
import { layerToPngBlob } from "../utils/canvasSnapshot";
import {
  encodeSnapshot,
  encodeDrawLine,
  encodeDrawPoint,
  encodeFill,
  encodePointerUp,
} from "../utils/binaryProtocol";

interface DrawingState {
  brushSize: number;
  opacity: number;
  color: string;
  brushType: "solid" | "halftone" | "eraser" | "fill" | "pan";
  layerType: "foreground" | "background";
  fgVisible: boolean;
  bgVisible: boolean;
}

export const useDrawing = (
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  appRef: React.RefObject<HTMLDivElement | null>,
  drawingState: DrawingState,
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void,
  zoomLevel?: number,
  canvasWidth?: number,
  canvasHeight?: number,
  wsRef?: React.RefObject<WebSocket | null>,
  userIdRef?: React.RefObject<string>,
  onDrawingChange?: () => void,
  isCatchingUp: boolean = false,
  connectionState: "connecting" | "connected" | "disconnected" = "connected",
  containerRef?: React.RefObject<HTMLDivElement | null>
) => {
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingEngineRef = useRef<DrawingEngine | null>(null);
  const isInitializedRef = useRef(false);
  const onHistoryChangeRef = useRef(onHistoryChange);
  const lastModifiedLayerRef = useRef<"foreground" | "background">(
    "foreground"
  );
  const isDrawingRef = useRef(false);
  const pendingSnapshotRequestRef = useRef(false);
  const sendSnapshotRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const history = useCanvasHistory(30);

  // Update the ref when callback changes
  const onDrawingChangeRef = useRef(onDrawingChange);
  useEffect(() => {
    onHistoryChangeRef.current = onHistoryChange;
    onDrawingChangeRef.current = onDrawingChange;
  }, [onHistoryChange, onDrawingChange]);

  // Initialize drawing engine
  const initializeDrawing = useCallback(() => {
    if (!canvasRef.current || !canvasWidth || !canvasHeight) return;
    if (isInitializedRef.current && drawingEngineRef.current) return; // Only skip if both initialized AND engine exists

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = false;
    canvas.style.imageRendering = "pixelated";
    contextRef.current = ctx;


    // Create and initialize drawing engine
    drawingEngineRef.current = new DrawingEngine(canvasWidth, canvasHeight);
    drawingEngineRef.current.initialize(ctx);

    // Save initial blank state to history so first stroke can be undone
    if (
      drawingEngineRef.current.layers.foreground &&
      drawingEngineRef.current.layers.background
    ) {
      history.saveBothLayers(
        drawingEngineRef.current.layers.foreground,
        drawingEngineRef.current.layers.background,
        false, // This is not a drawing action, just initial state
        false  // This is not a content snapshot
      );
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
    }

    isInitializedRef.current = true;
  }, [
    canvasRef,
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

  // Throttling refs for pointer move events
  const lastPointerMoveTime = useRef(0);
  const POINTER_MOVE_THROTTLE_MS = 12; // ~83 FPS for smooth drawing
  const MIN_MOVE_DISTANCE = 1.5; // pixels - minimum movement to process

  // Refs to access current values in event handlers without causing re-renders
  const currentDrawingStateRef = useRef(drawingState);
  const isCatchingUpRef = useRef(isCatchingUp);
  const connectionStateRef = useRef(connectionState);
  
  // Update the refs whenever values change
  useEffect(() => {
    currentDrawingStateRef.current = drawingState;
  }, [drawingState]);
  
  useEffect(() => {
    isCatchingUpRef.current = isCatchingUp;
  }, [isCatchingUp]);
  
  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

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

      // Calculate base canvas dimensions (without zoom)
      const baseCanvasWidth = canvas.width;
      const baseCanvasHeight = canvas.height;
      
      // Convert screen coordinates to canvas coordinates
      // rect already includes all transforms (zoom + pan), so we just need to calculate the ratio
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      
      // Convert from screen space to canvas space
      // The rect dimensions include zoom, so we can directly calculate the ratio
      const x = (screenX / rect.width) * baseCanvasWidth;
      const y = (screenY / rect.height) * baseCanvasHeight;

      // Clamp coordinates to canvas bounds
      const clampedX = Math.max(0, Math.min(baseCanvasWidth - 1, Math.round(x)));
      const clampedY = Math.max(0, Math.min(baseCanvasHeight - 1, Math.round(y)));

      return { x: clampedX, y: clampedY };
    };

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element;
      const controlsElement = document.getElementById("controls");

      // Don't interfere with controls interaction
      if (controlsElement?.contains(target as Node)) return;

      // Disable drawing while catching up to stored messages or when disconnected
      if (isCatchingUpRef.current || connectionStateRef.current !== "connected") return;

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
      
      // Try to capture pointer, but don't fail if it doesn't work
      try {
        app.setPointerCapture(e.pointerId);
      } catch (error) {
        console.warn("Failed to capture pointer:", error);
        // Continue anyway - pointer events will still work without capture
      }

      if (
        e.button === 1 ||
        (e.pointerType === "touch" && e.buttons === 0) ||
        (e.button === 0 && currentDrawingStateRef.current.brushType === "pan")
      ) {
        // Middle mouse button, touch, or pan tool selected (for panning)
        drawingStateRef.current.isPanning = true;
        drawingStateRef.current.panStartX = e.clientX;
        drawingStateRef.current.panStartY = e.clientY;
        return;
      }

      if (
        (e.button === 0 ||
          e.pointerType === "touch" ||
          e.pointerType === "pen") &&
        currentDrawingStateRef.current.brushType !== "pan"
      ) {
        const coords = getCanvasCoordinates(e.clientX, e.clientY);

        // Mark drawing as active
        isDrawingRef.current = true;

        if (currentDrawingStateRef.current.brushType === "fill") {
          if (!drawingEngineRef.current) {
            return;
          }

          // Perform flood fill
          const r = parseInt(currentDrawingStateRef.current.color.slice(1, 3), 16);
          const g = parseInt(currentDrawingStateRef.current.color.slice(3, 5), 16);
          const b = parseInt(currentDrawingStateRef.current.color.slice(5, 7), 16);

          drawingEngineRef.current.doFloodFill(
            drawingEngineRef.current.layers[currentDrawingStateRef.current.layerType],
            Math.floor(coords.x),
            Math.floor(coords.y),
            r,
            g,
            b,
            currentDrawingStateRef.current.opacity
          );

          // Track which layer was modified
          lastModifiedLayerRef.current = currentDrawingStateRef.current.layerType;

          // Send fill event through WebSocket
          if (
            wsRef?.current &&
            wsRef.current.readyState === WebSocket.OPEN &&
            userIdRef?.current
          ) {
            try {
              const binaryMessage = encodeFill(
                userIdRef.current,
                currentDrawingStateRef.current.layerType,
                Math.floor(coords.x),
                Math.floor(coords.y),
                r,
                g,
                b,
                currentDrawingStateRef.current.opacity
              );
              wsRef.current.send(binaryMessage);
            } catch (error) {
              console.error("Failed to send fill event:", error);
            }
          }

          // Mark for recomposition - RAF loop will handle compositing
          onDrawingChangeRef.current?.(); // Still notify parent for RAF loop triggering

          // Save state after fill operation
          if (
            drawingEngineRef.current.layers.foreground &&
            drawingEngineRef.current.layers.background
          ) {
            console.log(`Saving fill operation state for ${currentDrawingStateRef.current.layerType} layer`);
            history.saveState(
              currentDrawingStateRef.current.layerType,
              drawingEngineRef.current.layers[currentDrawingStateRef.current.layerType],
              true,  // This is a drawing action
              false  // This is not a content snapshot
            );
            onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
          }

          // Mark fill operation as complete to prevent double-saving in pointerup
          isDrawingRef.current = false;
        } else {
          if (!drawingEngineRef.current) {
            return;
          }

          // Draw at the initial click position
          const r = parseInt(currentDrawingStateRef.current.color.slice(1, 3), 16);
          const g = parseInt(currentDrawingStateRef.current.color.slice(3, 5), 16);
          const b = parseInt(currentDrawingStateRef.current.color.slice(5, 7), 16);

          // Use standard opacity
          const effectiveOpacity = currentDrawingStateRef.current.opacity;

          // Draw single point using drawLine method (works for all brush types)
          drawingEngineRef.current.drawLine(
            drawingEngineRef.current.layers[currentDrawingStateRef.current.layerType],
            coords.x,
            coords.y,
            coords.x,
            coords.y,
            currentDrawingStateRef.current.brushSize,
            currentDrawingStateRef.current.brushType,
            r,
            g,
            b,
            effectiveOpacity
          );

          // Track which layer was modified
          lastModifiedLayerRef.current = currentDrawingStateRef.current.layerType;

          // Mark for recomposition - RAF loop will handle compositing
          onDrawingChangeRef.current?.(); // Still notify parent for RAF loop triggering

          // Send single click drawing event through WebSocket
          if (
            wsRef?.current &&
            wsRef.current.readyState === WebSocket.OPEN &&
            userIdRef?.current
          ) {
            try {
              const binaryMessage = encodeDrawPoint(
                userIdRef.current,
                currentDrawingStateRef.current.layerType,
                coords.x,
                coords.y,
                currentDrawingStateRef.current.brushSize,
                currentDrawingStateRef.current.brushType,
                r,
                g,
                b,
                effectiveOpacity,
                e.pointerType as "mouse" | "pen" | "touch"
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

    const cleanupPointerState = (pointerId: number) => {
      // Release pointer capture if we have it
      if (app.hasPointerCapture(pointerId)) {
        try {
          app.releasePointerCapture(pointerId);
        } catch (error) {
          console.warn("Failed to release pointer capture:", error);
        }
      }
      
      // Reset state only if this is the active pointer
      if (drawingStateRef.current.activePointerId === pointerId) {
        drawingStateRef.current.activePointerId = null;
        drawingStateRef.current.isDrawing = false;
        drawingStateRef.current.isPanning = false;
        isDrawingRef.current = false;
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      // Only handle the active pointer
      if (drawingStateRef.current.activePointerId !== e.pointerId) return;

      // Disable drawing while catching up to stored messages or when disconnected
      if (isCatchingUpRef.current || connectionStateRef.current !== "connected") return;

      if (e.button === 1 || drawingStateRef.current.isPanning) {
        // Handle panning end - don't send WebSocket events for panning
        drawingStateRef.current.isPanning = false;
      } else {
        // Send pointerup event through WebSocket only for drawing operations
        console.log("Attempting to send pointerup event:", {
          hasWsRef: !!wsRef?.current,
          wsState: wsRef?.current?.readyState,
          hasUserId: !!userIdRef?.current,
          connectionReady: wsRef?.current?.readyState === WebSocket.OPEN
        });
        if (
          wsRef?.current &&
          wsRef.current.readyState === WebSocket.OPEN &&
          userIdRef?.current
        ) {
          const coords = getCanvasCoordinates(e.clientX, e.clientY);
          try {
            const binaryMessage = encodePointerUp(
              userIdRef.current,
              coords.x,
              coords.y,
              e.button,
              e.pointerType as "mouse" | "pen" | "touch"
            );
            wsRef.current.send(binaryMessage);
          } catch (error) {
            console.error("Failed to send pointerup event:", error);
          }
        }

        // Save state after stroke ends (before marking as inactive)
        if (
          (e.button === 0 ||
            e.pointerType === "touch" ||
            e.pointerType === "pen") &&
          isDrawingRef.current &&
          drawingEngineRef.current &&
          drawingEngineRef.current.layers.foreground &&
          drawingEngineRef.current.layers.background
        ) {
          console.log(`Saving drawing stroke state for ${lastModifiedLayerRef.current} layer (pointer up)`);
          history.saveState(
            lastModifiedLayerRef.current,
            drawingEngineRef.current.layers[lastModifiedLayerRef.current],
            true,  // This is a drawing action
            false  // This is not a content snapshot
          );
          onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
        }

        // Mark drawing as inactive for drawing operations
        isDrawingRef.current = false;

        // Check for pending snapshot request
        if (pendingSnapshotRequestRef.current && sendSnapshotRef.current) {
          sendSnapshotRef.current();
          pendingSnapshotRequestRef.current = false;
        }
      }

      // Clean up pointer state
      cleanupPointerState(e.pointerId);
    };

    const handlePointerCancel = (e: PointerEvent) => {
      console.log("pointercancel event", {
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        activePointerId: drawingStateRef.current.activePointerId,
        isDrawing: drawingStateRef.current.isDrawing,
        isPanning: drawingStateRef.current.isPanning
      });
      // Clean up when pointer is cancelled (e.g., browser takes over, touch cancelled)
      cleanupPointerState(e.pointerId);
    };

    const handlePointerLeave = (e: PointerEvent) => {
      // Only clean up if pointer leaves the app area completely
      const relatedTarget = e.relatedTarget as Element | null;
      const shouldCleanup = !relatedTarget || !app.contains(relatedTarget);
      
      console.log("pointerleave event", {
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        activePointerId: drawingStateRef.current.activePointerId,
        isDrawing: drawingStateRef.current.isDrawing,
        isPanning: drawingStateRef.current.isPanning,
        relatedTarget: relatedTarget?.tagName,
        shouldCleanup
      });
      
      if (shouldCleanup) {
        cleanupPointerState(e.pointerId);
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      // Only handle the active pointer
      if (drawingStateRef.current.activePointerId !== e.pointerId) return;

      // Disable drawing while catching up to stored messages or when disconnected (allow panning though)
      if (
        (isCatchingUpRef.current || connectionStateRef.current !== "connected") &&
        !drawingStateRef.current.isPanning
      )
        return;

      if (drawingStateRef.current.isPanning) {
        const deltaX = e.clientX - drawingStateRef.current.panStartX;
        const deltaY = e.clientY - drawingStateRef.current.panStartY;

        // Update the engine's pan offset
        if (drawingEngineRef.current) {
          drawingEngineRef.current.updatePanOffset(
            deltaX,
            deltaY,
            containerRef?.current || canvasRef.current || undefined,
            zoomLevel ? zoomLevel / 100 : undefined
          );
        }

        drawingStateRef.current.panStartX = e.clientX;
        drawingStateRef.current.panStartY = e.clientY;
        return;
      }

      if (
        !drawingStateRef.current.isDrawing ||
        currentDrawingStateRef.current.brushType === "fill" ||
        currentDrawingStateRef.current.brushType === "pan"
      )
        return;

      // Hybrid throttling: time-based + distance-based
      const now = Date.now();
      const coords = getCanvasCoordinates(e.clientX, e.clientY);

      // Time throttling check
      if (now - lastPointerMoveTime.current < POINTER_MOVE_THROTTLE_MS) {
        return; // Skip this event - too soon since last processed event
      }

      // Distance throttling check - calculate movement distance
      const dx = coords.x - drawingStateRef.current.currentX;
      const dy = coords.y - drawingStateRef.current.currentY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < MIN_MOVE_DISTANCE) {
        return; // Skip this event - movement too small
      }

      // Update throttling timestamp
      lastPointerMoveTime.current = now;

      // Update drawing state with new coordinates (coords already calculated above)
      drawingStateRef.current.prevX = drawingStateRef.current.currentX;
      drawingStateRef.current.prevY = drawingStateRef.current.currentY;
      drawingStateRef.current.currentX = coords.x;
      drawingStateRef.current.currentY = coords.y;

      if (!drawingEngineRef.current) {
        return;
      }

      const r = parseInt(currentDrawingStateRef.current.color.slice(1, 3), 16);
      const g = parseInt(currentDrawingStateRef.current.color.slice(3, 5), 16);
      const b = parseInt(currentDrawingStateRef.current.color.slice(5, 7), 16);

      // Use standard opacity
      const effectiveOpacity = currentDrawingStateRef.current.opacity;

      drawingEngineRef.current.drawLine(
        drawingEngineRef.current.layers[currentDrawingStateRef.current.layerType],
        drawingStateRef.current.prevX,
        drawingStateRef.current.prevY,
        drawingStateRef.current.currentX,
        drawingStateRef.current.currentY,
        currentDrawingStateRef.current.brushSize,
        currentDrawingStateRef.current.brushType,
        r,
        g,
        b,
        effectiveOpacity
      );

      // Track which layer was modified
      lastModifiedLayerRef.current = currentDrawingStateRef.current.layerType;

      // Send drawLine event through WebSocket
      console.log("Attempting to send drawLine event:", {
        hasWsRef: !!wsRef?.current,
        wsState: wsRef?.current?.readyState,
        hasUserId: !!userIdRef?.current,
        connectionReady: wsRef?.current?.readyState === WebSocket.OPEN
      });
      if (
        wsRef?.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        userIdRef?.current
      ) {
        try {
          const binaryMessage = encodeDrawLine(
            userIdRef.current,
            currentDrawingStateRef.current.layerType,
            drawingStateRef.current.prevX,
            drawingStateRef.current.prevY,
            drawingStateRef.current.currentX,
            drawingStateRef.current.currentY,
            currentDrawingStateRef.current.brushSize,
            currentDrawingStateRef.current.brushType,
            r,
            g,
            b,
            effectiveOpacity,
            e.pointerType as "mouse" | "pen" | "touch"
          );
          wsRef.current.send(binaryMessage);
        } catch (error) {
          console.error("Failed to send drawLine event:", error);
        }
      }

      // Mark for recomposition - RAF loop will handle compositing
      onDrawingChangeRef.current?.(); // Still notify parent for RAF loop triggering
    };

    // Add pointer event listeners (handles mouse, touch, and pen)
    app.addEventListener("pointerdown", handlePointerDown);
    app.addEventListener("pointerup", handlePointerUp);
    app.addEventListener("pointermove", handlePointerMove);
    app.addEventListener("pointercancel", handlePointerCancel);
    app.addEventListener("pointerleave", handlePointerLeave);

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
      app.removeEventListener("pointercancel", handlePointerCancel);
      app.removeEventListener("pointerleave", handlePointerLeave);

      // Clean up touch event listeners
      app.removeEventListener("touchstart", preventTouchOnCanvas);
      app.removeEventListener("touchmove", preventTouchOnCanvas);
      app.removeEventListener("touchend", preventTouchOnCanvas);
    };
  }, [appRef, canvasRef, history, wsRef, userIdRef, containerRef, zoomLevel]);

  useEffect(() => {
    initializeDrawing();
  }, [initializeDrawing]);

  // Additional effect to force initialization once refs are available
  useEffect(() => {
    if (canvasRef.current && !isInitializedRef.current) {
      initializeDrawing();
    }
  }, [canvasRef, initializeDrawing]);

  useEffect(() => {
    const cleanup = setupDrawingEvents();
    return cleanup;
  }, [setupDrawingEvents]);

  // Undo function
  const handleUndo = useCallback(async () => {
    console.log(`Attempting undo - can undo: ${history.canUndo()}`);
    const previousState = history.undo();
    if (previousState && contextRef.current && drawingEngineRef.current) {
      console.log(`Undoing to previous ${previousState.layer} layer state (timestamp: ${previousState.timestamp})`);
      // Restore the specific layer that was undone
      drawingEngineRef.current.layers[previousState.layer].set(previousState.data);

      // Queue DOM canvases for batched update to show the restored state
      drawingEngineRef.current.queueLayerUpdate(previousState.layer);

      // Update display
      // Notify parent component that drawing has changed
      onDrawingChange?.();
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());

      // Send snapshot over WebSocket - use the layer from history, not lastModifiedLayerRef
      if (
        wsRef?.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        userIdRef?.current &&
        canvasWidth &&
        canvasHeight
      ) {
        try {
          const pngBlob = await layerToPngBlob(
            previousState.data,
            canvasWidth,
            canvasHeight
          );
          const binaryMessage = await encodeSnapshot(
            userIdRef.current,
            previousState.layer, // Use the layer from history, not lastModifiedLayerRef
            pngBlob
          );

          wsRef.current.send(binaryMessage);
        } catch (error) {
          console.error("Failed to send undo snapshot:", error);
        }
      }
    } else {
      console.log("Undo failed - no previous state or missing components");
    }
  }, [history, canvasWidth, canvasHeight, wsRef, userIdRef, onDrawingChange]);

  // Redo function
  const handleRedo = useCallback(async () => {
    console.log(`Attempting redo - can redo: ${history.canRedo()}`);
    const nextState = history.redo();
    if (nextState && contextRef.current && drawingEngineRef.current) {
      console.log(`Redoing to next ${nextState.layer} layer state (timestamp: ${nextState.timestamp})`);
      // Restore the specific layer that was redone
      drawingEngineRef.current.layers[nextState.layer].set(nextState.data);

      // Queue DOM canvases for batched update to show the restored state
      drawingEngineRef.current.queueLayerUpdate(nextState.layer);

      // Update display
      // Notify parent component that drawing has changed
      onDrawingChange?.();
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());

      // Send snapshot over WebSocket - use the layer from history, not lastModifiedLayerRef
      if (
        wsRef?.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        userIdRef?.current &&
        canvasWidth &&
        canvasHeight
      ) {
        try {
          const pngBlob = await layerToPngBlob(
            nextState.data,
            canvasWidth,
            canvasHeight
          );
          const binaryMessage = await encodeSnapshot(
            userIdRef.current,
            nextState.layer, // Use the layer from history, not lastModifiedLayerRef
            pngBlob
          );

          wsRef.current.send(binaryMessage);
        } catch (error) {
          console.error("Failed to send redo snapshot:", error);
        }
      }
    } else {
      console.log("Redo failed - no next state or missing components");
    }
  }, [history, canvasWidth, canvasHeight, wsRef, userIdRef, onDrawingChange]);

  // Update canvas zoom when zoom level changes
  useEffect(() => {
    if (canvasRef.current && zoomLevel && canvasWidth && canvasHeight) {
      const canvas = canvasRef.current;

      // Don't apply zoom to individual canvas - the container handles zoom via CSS transform
      // Just ensure the canvas has the base dimensions
      canvas.style.width = `${canvasWidth}px`;
      canvas.style.height = `${canvasHeight}px`;
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

    if (!engine || !ws || ws.readyState !== WebSocket.OPEN || !userId || !canvasWidth || !canvasHeight) {
      return;
    }

    try {
      // Send foreground layer snapshot
      const fgPngBlob = await layerToPngBlob(
        engine.layers.foreground,
        canvasWidth,
        canvasHeight
      );
      const fgSnapshot = await encodeSnapshot(userId, "foreground", fgPngBlob);
      ws.send(fgSnapshot);

      // Send background layer snapshot
      const bgPngBlob = await layerToPngBlob(
        engine.layers.background,
        canvasWidth,
        canvasHeight
      );
      const bgSnapshot = await encodeSnapshot(userId, "background", bgPngBlob);
      ws.send(bgSnapshot);
    } catch (error) {
      console.error("Failed to send snapshots:", error);
    }
  }, [canvasWidth, canvasHeight, wsRef, userIdRef]);

  // Update sendSnapshot ref
  useEffect(() => {
    sendSnapshotRef.current = sendSnapshot;
  }, [sendSnapshot]);

  // Handle snapshot request from server
  const handleSnapshotRequest = useCallback(
    () => {
      if (isDrawingRef.current) {
        // Defer if currently drawing
        pendingSnapshotRequestRef.current = true;
      } else {
        // Send immediately if not drawing
        sendSnapshot();
      }
    },
    [sendSnapshot]
  );

  // handleSnapshotRequest is now returned directly from the hook

  // Function to add snapshot to history (for when we receive our own snapshot after page refresh)
  const addSnapshotToHistory = useCallback((layer?: "foreground" | "background") => {
    if (drawingEngineRef.current?.layers.foreground && drawingEngineRef.current?.layers.background) {
      if (layer) {
        // Add specific layer snapshot to history
        history.saveState(
          layer,
          drawingEngineRef.current.layers[layer],
          false, // Not a drawing action, just a received snapshot
          true   // This is a content snapshot that should be protected from undo
        );
      } else {
        // Add both layers (for initial page load scenarios)
        history.saveBothLayers(
          drawingEngineRef.current.layers.foreground,
          drawingEngineRef.current.layers.background,
          false, // Not a drawing action, just a received snapshot
          true   // This is a content snapshot that should be protected from undo
        );
      }
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
    }
  }, [history]);

  // Function to mark drawing operation as complete (prevent double-saving in pointerup)
  const markDrawingComplete = useCallback(() => {
    isDrawingRef.current = false;
  }, []);

  return {
    context: contextRef.current,
    drawingEngine: drawingEngineRef.current,
    initializeDrawing,
    undo: handleUndo,
    redo: handleRedo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    getHistoryInfo: history.getHistoryInfo,
    addSnapshotToHistory,
    markDrawingComplete,
    handleSnapshotRequest,
  };
};
