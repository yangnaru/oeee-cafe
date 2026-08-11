import { useEffect, useRef, useCallback } from "react";
import { DrawingEngine } from "../DrawingEngine";
import { useCanvasHistory } from "./useCanvasHistory";
import type { BrushType } from "../types/collaboration";
import {
  brushTypeFor,
  isImmediateTool,
  isRegionTool,
  isTextTool,
  type RegionTool,
  type DrawType,
  type ToolId,
} from "../neo/tools";
import { RegionDrag, type RegionRect } from "../neo/regionDrag";

export interface DrawingState {
  brushSize: number;
  opacity: number;
  color: string;
  brushType: ToolId;
  drawType?: DrawType;
  layerType: "foreground" | "background";
  fgVisible: boolean;
  bgVisible: boolean;
  isFlippedHorizontal: boolean;
}

interface DrawingEventCallbacks {
  onPointerDown?: () => void;
  onDrawLine?: (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    brushSize: number,
    brushType: BrushType,
    r: number,
    g: number,
    b: number,
    opacity: number
  ) => void;
  onDrawPoint?: (
    x: number,
    y: number,
    brushSize: number,
    brushType: BrushType,
    r: number,
    g: number,
    b: number,
    opacity: number
  ) => void;
  onFill?: (
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    opacity: number
  ) => void;
  onPointerUp?: () => void;
  /** The rubber-band rectangle as it is dragged, or null when it ends. */
  onRegionPreview?: (rect: RegionRect | null) => void;
  /** A straight line was drawn from `from` to `to`. */
  onLine?: (
    from: { x: number; y: number },
    to: { x: number; y: number },
    brushSize: number,
    brushType: BrushType,
    color: { r: number; g: number; b: number; a: number },
    layer: "foreground" | "background"
  ) => void;
  /** Endpoints while a line is dragged out, or null when it ends. */
  onLinePreview?: (
    from: { x: number; y: number } | null,
    to: { x: number; y: number } | null
  ) => void;
  /** The text tool was clicked; open an editor at this canvas point. */
  onTextPlace?: (x: number, y: number) => void;
  /** A tool that acts on click was used; record it. */
  onEraseAll?: (layer: "foreground" | "background") => void;
  /** A region tool was released over `rect`; record it. */
  onRegionCommit?: (
    tool: RegionTool,
    layer: "foreground" | "background",
    rect: RegionRect,
    color: { r: number; g: number; b: number; a: number },
    brushSize: number
  ) => void;
}

export const useBaseDrawing = (
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  appRef: React.RefObject<HTMLDivElement | null>,
  drawingState: DrawingState,
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void,
  zoomLevel?: number,
  canvasWidth?: number,
  canvasHeight?: number,
  onDrawingChange?: () => void,
  containerRef?: React.RefObject<HTMLDivElement | null>,
  isDrawingDisabled: boolean = false,
  callbacks?: DrawingEventCallbacks,
  // In remote-sync (collaborative) mode the callbacks own applying strokes to
  // the layers and undo history; this hook only tracks pointer state.
  remoteSync: boolean = false
) => {
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingEngineRef = useRef<DrawingEngine | null>(null);
  const isInitializedRef = useRef(false);
  const onHistoryChangeRef = useRef(onHistoryChange);
  const lastModifiedLayerRef = useRef<"foreground" | "background">("foreground");
  const isDrawingRef = useRef(false);

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
    if (isInitializedRef.current && drawingEngineRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = false;
    canvas.style.imageRendering = "pixelated";
    contextRef.current = ctx;

    // Create and initialize drawing engine
    drawingEngineRef.current = new DrawingEngine(canvasWidth, canvasHeight);
    drawingEngineRef.current.initialize(ctx);

    // Save initial blank state to history
    if (
      drawingEngineRef.current.layers.foreground &&
      drawingEngineRef.current.layers.background
    ) {
      history.saveBothLayers(
        drawingEngineRef.current.layers.foreground,
        drawingEngineRef.current.layers.background,
        false,
        false
      );
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
    }

    isInitializedRef.current = true;
  }, [canvasRef, history, canvasWidth, canvasHeight]);

  // Drawing state refs
  const drawingStateRef = useRef({
    isDrawing: false,
    prevX: 0,
    prevY: 0,
    currentX: 0,
    currentY: 0,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    panLastX: 0,
    panLastY: 0,
    activePointerId: null as number | null,
  });

  // Throttling refs
  const lastPointerMoveTime = useRef(0);
  const POINTER_MOVE_THROTTLE_MS = 12;
  const MIN_MOVE_DISTANCE = 1.5;

  const currentDrawingStateRef = useRef(drawingState);
  const isDrawingDisabledRef = useRef(isDrawingDisabled);
  const remoteSyncRef = useRef(remoteSync);
  // Settings captured at pointer down and held for the duration of the stroke,
  // NEO's prepareDrawing. Null between strokes.
  const strokeParamsRef = useRef<DrawingState | null>(null);
  /** Live rectangle drag for the region tools. */
  const regionDragRef = useRef<RegionDrag | null>(null);
  /** Press point while a straight line is being dragged out. */
  const lineStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    currentDrawingStateRef.current = drawingState;
  }, [drawingState]);

  useEffect(() => {
    isDrawingDisabledRef.current = isDrawingDisabled;
  }, [isDrawingDisabled]);

  useEffect(() => {
    remoteSyncRef.current = remoteSync;
  }, [remoteSync]);

  // Convert screen coordinates to canvas coordinates
  const getCanvasCoordinates = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };

    const baseCanvasWidth = canvas.width;
    const baseCanvasHeight = canvas.height;

    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;

    let x = (screenX / rect.width) * baseCanvasWidth;
    const y = (screenY / rect.height) * baseCanvasHeight;

    // Flip x-coordinate if horizontal flip is enabled
    if (currentDrawingStateRef.current.isFlippedHorizontal) {
      x = baseCanvasWidth - x - 1;
    }

    return { x: Math.round(x), y: Math.round(y) };
  }, [canvasRef]);

  // Perform drawing operation on engine
  const performDrawing = useCallback((
    operation: "point" | "line" | "fill",
    coords: { x: number; y: number; prevX?: number; prevY?: number }
  ) => {
    if (!drawingEngineRef.current) return;

    // A stroke is drawn with the settings it started with, as NEO does
    // (prepareDrawing, called from freeHandDownHandler). Both the replay frame
    // and the collaborative stroke message carry one set of parameters for the
    // whole stroke, so reading live state here would let a mid-stroke change
    // -- the [ / ] and pen hotkeys, or the toolbox -- alter the canvas in a way
    // the recording cannot express. Such a change now applies to the next
    // stroke.
    const active = strokeParamsRef.current ?? currentDrawingStateRef.current;

    const r = parseInt(active.color.slice(1, 3), 16);
    const g = parseInt(active.color.slice(3, 5), 16);
    const b = parseInt(active.color.slice(5, 7), 16);
    const effectiveOpacity = active.opacity;

    const targetLayer = drawingEngineRef.current.layers[active.layerType];

    // Callbacks run before the local apply; in remote-sync mode they fully
    // own applying the stroke (via the canvas history), so the direct engine
    // application below is skipped.
    if (operation === "fill") {
      callbacks?.onFill?.(Math.floor(coords.x), Math.floor(coords.y), r, g, b, effectiveOpacity);
      if (!remoteSyncRef.current) {
        drawingEngineRef.current.doFloodFill(
          targetLayer,
          Math.floor(coords.x),
          Math.floor(coords.y),
          r,
          g,
          b,
          effectiveOpacity
        );
      }
    } else if (operation === "point") {
      callbacks?.onDrawPoint?.(
        coords.x,
        coords.y,
        active.brushSize,
        brushTypeFor(active.brushType),
        r,
        g,
        b,
        effectiveOpacity
      );
      if (!remoteSyncRef.current) {
        drawingEngineRef.current.drawLine(
          targetLayer,
          coords.x,
          coords.y,
          coords.x,
          coords.y,
          active.brushSize,
          brushTypeFor(active.brushType),
          r,
          g,
          b,
          effectiveOpacity
        );
      }
    } else if (operation === "line" && coords.prevX !== undefined && coords.prevY !== undefined) {
      callbacks?.onDrawLine?.(
        coords.prevX,
        coords.prevY,
        coords.x,
        coords.y,
        active.brushSize,
        brushTypeFor(active.brushType),
        r,
        g,
        b,
        effectiveOpacity
      );
      if (!remoteSyncRef.current) {
        // Segments run from the NEW point back to the previous one, matching
        // NEO (freeHandMoveHandler, and freeHandFast on replay). Bresenham is
        // direction-sensitive, so drawing prev->new here would leave the live
        // canvas a few pixels off from what the recorded replay renders.
        drawingEngineRef.current.drawLine(
          targetLayer,
          coords.x,
          coords.y,
          coords.prevX,
          coords.prevY,
          active.brushSize,
          brushTypeFor(active.brushType),
          r,
          g,
          b,
          effectiveOpacity
        );
      }
    }

    lastModifiedLayerRef.current = currentDrawingStateRef.current.layerType;
    onDrawingChangeRef.current?.();
  }, [callbacks]);

  // Save current state to history
  const saveToHistory = useCallback(() => {
    if (
      drawingEngineRef.current &&
      drawingEngineRef.current.layers.foreground &&
      drawingEngineRef.current.layers.background
    ) {
      history.saveState(
        drawingEngineRef.current.layers.foreground,
        drawingEngineRef.current.layers.background,
        lastModifiedLayerRef.current,
        true,
        false,
        false
      );
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
    }
  }, [history]);

  // Handle drawing events
  const setupDrawingEvents = useCallback(() => {
    const app = appRef.current;
    if (!app) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element;
      const controlsElement = document.getElementById("controls");

      if (controlsElement?.contains(target as Node)) return;

      if (isDrawingDisabledRef.current) return;

      if (
        !(
          target.id === "canvas" ||
          target.closest("#canvas") ||
          (target.closest("#app") && !target.closest("#controls"))
        )
      ) {
        return;
      }

      e.preventDefault();

      if (
        drawingStateRef.current.activePointerId !== null &&
        drawingStateRef.current.activePointerId !== e.pointerId
      )
        return;

      drawingStateRef.current.activePointerId = e.pointerId;

      try {
        app.setPointerCapture(e.pointerId);
      } catch (error) {
        console.warn("Failed to capture pointer:", error);
      }

      if (
        e.button === 1 ||
        (e.pointerType === "touch" && e.buttons === 0) ||
        (e.button === 0 && currentDrawingStateRef.current.brushType === "pan")
      ) {
        drawingStateRef.current.isPanning = true;
        drawingStateRef.current.panStartX = e.clientX;
        drawingStateRef.current.panStartY = e.clientY;
        drawingStateRef.current.panLastX = e.clientX;
        drawingStateRef.current.panLastY = e.clientY;
        return;
      }

      if (
        (e.button === 0 || e.pointerType === "touch" || e.pointerType === "pen") &&
        currentDrawingStateRef.current.brushType !== "pan"
      ) {
        const coords = getCanvasCoordinates(e.clientX, e.clientY);
        isDrawingRef.current = true;

        // Freeze the settings this stroke will be drawn and recorded with
        strokeParamsRef.current = { ...currentDrawingStateRef.current };

        // Opens an editor at the click and commits on Enter, so the pointer
        // does nothing else here.
        if (isTextTool(strokeParamsRef.current.brushType)) {
          callbacks?.onTextPlace?.(coords.x, coords.y);
          cleanupPointerState(e.pointerId);
          return;
        }

        // Acts on the press itself, with nothing to drag out
        if (isImmediateTool(strokeParamsRef.current.brushType)) {
          const layer = strokeParamsRef.current.layerType;
          if (!remoteSyncRef.current) {
            drawingEngineRef.current?.eraseAll(layer);
            saveToHistory();
          }
          callbacks?.onEraseAll?.(layer);
          onDrawingChangeRef.current?.();
          cleanupPointerState(e.pointerId);
          return;
        }

        // A drawing tool in line mode takes two points and commits on
        // release, so it also skips the freehand path.
        if (
          strokeParamsRef.current.drawType === "line" &&
          !isRegionTool(strokeParamsRef.current.brushType)
        ) {
          lineStartRef.current = coords;
          callbacks?.onLinePreview?.(coords, coords);
          return;
        }

        // Region tools drag out a rectangle and act on release, so they take
        // none of the stroke path below.
        if (isRegionTool(strokeParamsRef.current.brushType)) {
          const drag = new RegionDrag(
            drawingEngineRef.current?.imageWidth ?? 0,
            drawingEngineRef.current?.imageHeight ?? 0
          );
          drag.begin(coords);
          regionDragRef.current = drag;
          callbacks?.onRegionPreview?.(drag.current());
          return;
        }

        // Notify callback that drawing started
        callbacks?.onPointerDown?.();

        if (currentDrawingStateRef.current.brushType === "fill") {
          performDrawing("fill", coords);
          if (!remoteSyncRef.current) {
            saveToHistory();
          }
          isDrawingRef.current = false;
        } else {
          performDrawing("point", coords);
          drawingStateRef.current.isDrawing = true;
          drawingStateRef.current.currentX = coords.x;
          drawingStateRef.current.currentY = coords.y;
          drawingStateRef.current.prevX = drawingStateRef.current.currentX;
          drawingStateRef.current.prevY = drawingStateRef.current.currentY;
        }
      }
    };

    const cleanupPointerState = (pointerId: number) => {
      if (app.hasPointerCapture(pointerId)) {
        try {
          app.releasePointerCapture(pointerId);
        } catch (error) {
          console.warn("Failed to release pointer capture:", error);
        }
      }

      if (drawingStateRef.current.activePointerId === pointerId) {
        drawingStateRef.current.activePointerId = null;
        drawingStateRef.current.isDrawing = false;
        drawingStateRef.current.isPanning = false;
        isDrawingRef.current = false;
        strokeParamsRef.current = null;
        if (lineStartRef.current) {
          lineStartRef.current = null;
          callbacks?.onLinePreview?.(null, null);
        }
        if (regionDragRef.current) {
          regionDragRef.current.cancel();
          regionDragRef.current = null;
          callbacks?.onRegionPreview?.(null);
        }

        // Canonical Neo clears the joint-dedup state at the end of every
        // stroke (tools.js freeHandUpHandler) and again after each stroke on
        // replay. Carrying it across strokes would suppress the opening dot of
        // a stroke that starts where the last one ended, while the replay --
        // which does reset -- still draws it. Remote-sync mode drives this
        // state externally per user, so leave it alone there.
        if (!remoteSyncRef.current) {
          drawingEngineRef.current?.setStrokeState(null);
        }
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (drawingStateRef.current.activePointerId !== e.pointerId) return;

      if (isDrawingDisabledRef.current && !drawingStateRef.current.isPanning) return;

      const from = lineStartRef.current;
      if (from) {
        const to = getCanvasCoordinates(e.clientX, e.clientY);
        lineStartRef.current = null;
        callbacks?.onLinePreview?.(null, null);

        const params = strokeParamsRef.current;
        if (params) {
          const color = {
            r: parseInt(params.color.slice(1, 3), 16),
            g: parseInt(params.color.slice(3, 5), 16),
            b: parseInt(params.color.slice(5, 7), 16),
            a: params.opacity,
          };
          const brush = brushTypeFor(params.brushType);
          if (!remoteSyncRef.current && drawingEngineRef.current) {
            // Drawn new -> previous, as NEO draws every segment
            drawingEngineRef.current.drawLine(
              drawingEngineRef.current.layers[params.layerType],
              to.x, to.y, from.x, from.y,
              params.brushSize, brush, color.r, color.g, color.b, color.a
            );
            drawingEngineRef.current.setStrokeState(null);
            saveToHistory();
          }
          callbacks?.onLine?.(from, to, params.brushSize, brush, color, params.layerType);
          onDrawingChangeRef.current?.();
        }
        cleanupPointerState(e.pointerId);
        return;
      }

      const drag = regionDragRef.current;
      if (drag?.active) {
        const rect = drag.commit(getCanvasCoordinates(e.clientX, e.clientY));
        regionDragRef.current = null;
        callbacks?.onRegionPreview?.(null);

        const params = strokeParamsRef.current;
        if (rect && params && isRegionTool(params.brushType)) {
          const color = {
            r: parseInt(params.color.slice(1, 3), 16),
            g: parseInt(params.color.slice(3, 5), 16),
            b: parseInt(params.color.slice(5, 7), 16),
            a: params.opacity,
          };
          if (!remoteSyncRef.current) {
            drawingEngineRef.current?.applyRegionTool(
              params.brushType,
              params.layerType,
              rect,
              color,
              params.brushSize
            );
            saveToHistory();
          }
          callbacks?.onRegionCommit?.(
            params.brushType,
            params.layerType,
            rect,
            color,
            params.brushSize
          );
          onDrawingChangeRef.current?.();
        }
        cleanupPointerState(e.pointerId);
        return;
      }

      if (e.button === 1 || drawingStateRef.current.isPanning) {
        drawingStateRef.current.isPanning = false;
      } else {
        if (
          (e.button === 0 || e.pointerType === "touch" || e.pointerType === "pen") &&
          isDrawingRef.current
        ) {
          if (!remoteSyncRef.current) {
            saveToHistory();
          }
          callbacks?.onPointerUp?.();
        }
        isDrawingRef.current = false;
      }

      cleanupPointerState(e.pointerId);
    };

    const handlePointerCancel = (e: PointerEvent) => {
      cleanupPointerState(e.pointerId);
    };

    const handlePointerLeave = (e: PointerEvent) => {
      const relatedTarget = e.relatedTarget as Element | null;
      const shouldCleanup = !relatedTarget || !app.contains(relatedTarget);

      if (shouldCleanup) {
        cleanupPointerState(e.pointerId);
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (drawingStateRef.current.activePointerId !== e.pointerId) return;

      if (drawingStateRef.current.isPanning) {
        const rawDeltaX = e.clientX - drawingStateRef.current.panLastX;
        const rawDeltaY = e.clientY - drawingStateRef.current.panLastY;

        const currentZoomScale = zoomLevel ? zoomLevel / 100 : 1;
        const deltaX = rawDeltaX / currentZoomScale;
        const deltaY = rawDeltaY / currentZoomScale;

        if (drawingEngineRef.current) {
          const container = containerRef?.current || canvasRef.current || undefined;
          drawingEngineRef.current.updatePanOffset(
            deltaX,
            deltaY,
            container,
            zoomLevel ? zoomLevel / 100 : undefined
          );
        }

        drawingStateRef.current.panLastX = e.clientX;
        drawingStateRef.current.panLastY = e.clientY;
        return;
      }

      if (lineStartRef.current) {
        callbacks?.onLinePreview?.(
          lineStartRef.current,
          getCanvasCoordinates(e.clientX, e.clientY)
        );
        return;
      }

      if (lineStartRef.current) {
        callbacks?.onLinePreview?.(
          lineStartRef.current,
          getCanvasCoordinates(e.clientX, e.clientY)
        );
        return;
      }

      const drag = regionDragRef.current;
      if (drag?.active) {
        drag.move(getCanvasCoordinates(e.clientX, e.clientY));
        callbacks?.onRegionPreview?.(drag.current());
        return;
      }

      if (
        !drawingStateRef.current.isDrawing ||
        currentDrawingStateRef.current.brushType === "fill" ||
        currentDrawingStateRef.current.brushType === "pan" ||
        isDrawingDisabledRef.current
      )
        return;

      const now = Date.now();
      const coords = getCanvasCoordinates(e.clientX, e.clientY);

      if (now - lastPointerMoveTime.current < POINTER_MOVE_THROTTLE_MS) {
        return;
      }

      const dx = coords.x - drawingStateRef.current.currentX;
      const dy = coords.y - drawingStateRef.current.currentY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < MIN_MOVE_DISTANCE) {
        return;
      }

      lastPointerMoveTime.current = now;

      drawingStateRef.current.prevX = drawingStateRef.current.currentX;
      drawingStateRef.current.prevY = drawingStateRef.current.currentY;
      drawingStateRef.current.currentX = coords.x;
      drawingStateRef.current.currentY = coords.y;

      performDrawing("line", {
        x: drawingStateRef.current.currentX,
        y: drawingStateRef.current.currentY,
        prevX: drawingStateRef.current.prevX,
        prevY: drawingStateRef.current.prevY,
      });
    };

    app.addEventListener("pointerdown", handlePointerDown);
    app.addEventListener("pointerup", handlePointerUp);
    app.addEventListener("pointermove", handlePointerMove);
    app.addEventListener("pointercancel", handlePointerCancel);
    app.addEventListener("pointerleave", handlePointerLeave);

    const preventTouchOnCanvas = (e: TouchEvent) => {
      const target = e.target as Element;
      if (
        target.id === "canvas" ||
        target.closest("#canvas") ||
        (target.closest("#app") && !target.closest("#controls"))
      ) {
        e.preventDefault();
      }
    };

    app.addEventListener("touchstart", preventTouchOnCanvas, { passive: false });
    app.addEventListener("touchmove", preventTouchOnCanvas, { passive: false });
    app.addEventListener("touchend", preventTouchOnCanvas, { passive: false });

    return () => {
      app.removeEventListener("pointerdown", handlePointerDown);
      app.removeEventListener("pointerup", handlePointerUp);
      app.removeEventListener("pointermove", handlePointerMove);
      app.removeEventListener("pointercancel", handlePointerCancel);
      app.removeEventListener("pointerleave", handlePointerLeave);

      app.removeEventListener("touchstart", preventTouchOnCanvas);
      app.removeEventListener("touchmove", preventTouchOnCanvas);
      app.removeEventListener("touchend", preventTouchOnCanvas);
    };
  }, [
    appRef,
    canvasRef,
    containerRef,
    zoomLevel,
    getCanvasCoordinates,
    performDrawing,
    saveToHistory,
    callbacks,
  ]);

  useEffect(() => {
    initializeDrawing();
  }, [initializeDrawing]);

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
  const handleUndo = useCallback(() => {
    const previousState = history.undo();
    if (previousState && contextRef.current && drawingEngineRef.current) {
      drawingEngineRef.current.layers.foreground.set(previousState.foreground);
      drawingEngineRef.current.layers.background.set(previousState.background);

      drawingEngineRef.current.queueLayerUpdate("foreground");
      drawingEngineRef.current.queueLayerUpdate("background");

      onDrawingChange?.();
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
    }
  }, [history, onDrawingChange]);

  // Redo function
  const handleRedo = useCallback(() => {
    const nextState = history.redo();
    if (nextState && contextRef.current && drawingEngineRef.current) {
      drawingEngineRef.current.layers.foreground.set(nextState.foreground);
      drawingEngineRef.current.layers.background.set(nextState.background);

      drawingEngineRef.current.queueLayerUpdate("foreground");
      drawingEngineRef.current.queueLayerUpdate("background");

      onDrawingChange?.();
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
    }
  }, [history, onDrawingChange]);

  // Update canvas zoom
  useEffect(() => {
    if (canvasRef.current && zoomLevel && canvasWidth && canvasHeight) {
      const canvas = canvasRef.current;
      canvas.style.width = `${canvasWidth}px`;
      canvas.style.height = `${canvasHeight}px`;
    }
  }, [zoomLevel, canvasRef, canvasWidth, canvasHeight]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (drawingEngineRef.current) {
        drawingEngineRef.current.dispose();
        drawingEngineRef.current = null;
      }
    };
  }, []);

  return {
    context: contextRef.current,
    drawingEngine: drawingEngineRef.current,
    initializeDrawing,
    undo: handleUndo,
    redo: handleRedo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    history,
    isDrawingRef,
  };
};
