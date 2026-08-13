import { useRef, useCallback } from "react";
import { useBaseDrawing, type DrawingState } from "./useBaseDrawing";
import { ActionRecorder, NO_MASK, type MaskState } from "../utils/ActionRecorder";
import type { BrushType } from "../types/collaboration";
import { frameShapeFor, type RegionTool } from "../neo/tools";
import type { RegionRect } from "../neo/regionDrag";

// Constants matching Neo's LINETYPE values
const LINETYPE_PEN = 1;
const LINETYPE_ERASER = 2;
const LINETYPE_TONE = 4;

export const useOfflineDrawing = (
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  appRef: React.RefObject<HTMLDivElement | null>,
  drawingState: DrawingState,
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void,
  zoomLevel?: number,
  canvasWidth?: number,
  canvasHeight?: number,
  onDrawingChange?: () => void,
  containerRef?: React.RefObject<HTMLDivElement | null>,
  /** Called with the rubber-band rectangle while a region tool is dragged. */
  onRegionPreview?: (rect: RegionRect | null) => void,
  /** Called with the endpoints while a straight line is dragged out. */
  onLinePreview?: (
    from: { x: number; y: number } | null,
    to: { x: number; y: number } | null
  ) => void,
  /** Called when the text tool is clicked, to open an editor there. */
  onTextPlace?: (x: number, y: number) => void,
  /** Called with the curve so far while a bezier is being built. */
  onBezierPreview?: (points: number[] | null) => void
) => {
  // Initialize replay recording
  const actionRecorderRef = useRef<ActionRecorder>(new ActionRecorder());
  const startTimeRef = useRef<number>(Date.now());
  const isFirstPointRef = useRef<boolean>(false);
  const hasCreatedStepRef = useRef<boolean>(false);
  // Layer captured at pointer down, alongside the settings useBaseDrawing
  // freezes for the stroke, so the frame header cannot disagree with the
  // layer the engine actually drew into.
  const strokeLayerRef = useRef<number | null>(null);
  /**
   * The mask the stroke started with, frozen alongside the layer. A stroke is
   * drawn with the settings it opened with, so reading the live mask when the
   * frame is written could record a mask the canvas was never drawn through.
   */
  const strokeMaskRef = useRef<MaskState>(NO_MASK);

  /** The current mask as the recorder wants it: three channels and a mode. */
  const maskFrom = (state: DrawingState): MaskState => {
    const type = state.maskType ?? 0;
    if (!type) return NO_MASK;
    const hex = state.maskColor ?? "#000000";
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
      type,
    };
  };

  // Helper to map brushType to lineType
  const getLineType = (
    brushType: BrushType
  ): number => {
    switch (brushType) {
      case "eraser":
        return LINETYPE_ERASER; // 2
      case "halftone":
        return LINETYPE_TONE; // 4
      default: // 'solid' | 'fill' | 'pan'
        return LINETYPE_PEN; // 1
    }
  };

  // Callbacks for recording drawing operations
  const callbacks = {
    onPointerDown: useCallback(() => {
      // Mark that this is the start of a new stroke
      // The actual step() call will happen in onDrawLine/onDrawPoint when data is recorded
      isFirstPointRef.current = true;
      hasCreatedStepRef.current = false;
      strokeLayerRef.current =
        drawingState.layerType === "foreground" ? 1 : 0;
      strokeMaskRef.current = maskFrom(drawingState);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [drawingState.layerType, drawingState.maskType, drawingState.maskColor]),

    onDrawLine: useCallback(
      (
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
      ) => {
        const layer =
          strokeLayerRef.current ??
          (drawingState.layerType === "foreground" ? 1 : 0);
        // Opacity is already in [0, 255] range - clamp and ensure no NaN
        const alpha = Math.max(0, Math.min(255, Math.floor(opacity || 0)));
        const lineType = getLineType(brushType);

        // Ensure color values are valid
        const safeR = Math.max(0, Math.min(255, Math.floor(r || 0)));
        const safeG = Math.max(0, Math.min(255, Math.floor(g || 0)));
        const safeB = Math.max(0, Math.min(255, Math.floor(b || 0)));

        // Ensure coordinates are valid numbers (not NaN or Infinity)
        if (!Number.isFinite(fromX) || !Number.isFinite(fromY) ||
            !Number.isFinite(toX) || !Number.isFinite(toY)) {
          console.warn("Invalid coordinates in onDrawLine:", { fromX, fromY, toX, toY });
          return;
        }

        // Only create action frame and push header once per stroke
        if (!hasCreatedStepRef.current) {
          // First point of stroke - create new action frame and record full header
          actionRecorderRef.current.step();
          hasCreatedStepRef.current = true;

          // A stroke normally opens with onDrawPoint, which writes the header
          // with the press point duplicated. Reaching here means the header is
          // being opened by a segment instead, which NEO's freeHandMove
          // records as (previous, new) so the replay draws that first segment.
          actionRecorderRef.current.push(
            "freeHand",
            layer,
            safeR,
            safeG,
            safeB,
            alpha,
            strokeMaskRef.current.r,
            strokeMaskRef.current.g,
            strokeMaskRef.current.b,
            brushSize,
            strokeMaskRef.current.type,
            lineType,
            Math.round(fromX),
            Math.round(fromY),
            Math.round(toX),
            Math.round(toY)
          );
        } else {
          // Subsequent points - just record coordinates
          actionRecorderRef.current.push(Math.round(toX), Math.round(toY));
        }
      },
      [drawingState.layerType]
    ),

    onDrawPoint: useCallback(
      (
        x: number,
        y: number,
        brushSize: number,
        brushType: BrushType,
        r: number,
        g: number,
        b: number,
        opacity: number
      ) => {
        const layer =
          strokeLayerRef.current ??
          (drawingState.layerType === "foreground" ? 1 : 0);
        // Opacity is already in [0, 255] range - clamp and ensure no NaN
        const alpha = Math.max(0, Math.min(255, Math.floor(opacity || 0)));
        const lineType = getLineType(brushType);

        // Ensure color values are valid
        const safeR = Math.max(0, Math.min(255, Math.floor(r || 0)));
        const safeG = Math.max(0, Math.min(255, Math.floor(g || 0)));
        const safeB = Math.max(0, Math.min(255, Math.floor(b || 0)));

        // Ensure coordinates are valid numbers (not NaN or Infinity)
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          console.warn("Invalid coordinates in onDrawPoint:", { x, y });
          return;
        }

        // Single point stroke - create new action frame
        if (!hasCreatedStepRef.current) {
          actionRecorderRef.current.step();
          hasCreatedStepRef.current = true;
        }
        actionRecorderRef.current.push(
          "freeHand",
          layer,
          safeR,
          safeG,
          safeB,
          alpha,
          strokeMaskRef.current.r,
          strokeMaskRef.current.g,
          strokeMaskRef.current.b,
          brushSize,
          strokeMaskRef.current.type,
          lineType,
          Math.round(x),
          Math.round(y),
          Math.round(x),
          Math.round(y)
        );
      },
      [drawingState.layerType]
    ),

    onFill: useCallback(
      (x: number, y: number, r: number, g: number, b: number, opacity: number) => {
        const layer =
          strokeLayerRef.current ??
          (drawingState.layerType === "foreground" ? 1 : 0);
        // Opacity is already in [0, 255] range - clamp and ensure no NaN
        const alpha = Math.max(0, Math.min(255, Math.floor(opacity || 0)));

        // Ensure color values are valid
        const safeR = Math.max(0, Math.min(255, Math.floor(r || 0)));
        const safeG = Math.max(0, Math.min(255, Math.floor(g || 0)));
        const safeB = Math.max(0, Math.min(255, Math.floor(b || 0)));

        // Ensure coordinates are valid numbers (not NaN or Infinity)
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          console.warn("Invalid coordinates in onFill:", { x, y });
          return;
        }

        // ABGR format: (alpha << 24) | (blue << 16) | (green << 8) | red
        const color = (alpha << 24) | (safeB << 16) | (safeG << 8) | safeR;

        if (!hasCreatedStepRef.current) {
          actionRecorderRef.current.step();
          hasCreatedStepRef.current = true;
        }
        actionRecorderRef.current.push("floodFill", layer, Math.round(x), Math.round(y), color);
      },
      [drawingState.layerType]
    ),

    onRegionPreview,
    onLinePreview,
    onTextPlace,
    onBezierPreview,

    onBezier: useCallback(
      (
        points: number[],
        brushSize: number,
        brushType: BrushType,
        color: { r: number; g: number; b: number; a: number },
        layer: "foreground" | "background"
      ) => {
        actionRecorderRef.current.pushBezier(
          layer === "foreground" ? 1 : 0,
          getLineType(brushType),
          points,
          color,
          brushSize,
          strokeMaskRef.current
        );
      },
      []
    ),

    onLine: useCallback(
      (
        from: { x: number; y: number },
        to: { x: number; y: number },
        brushSize: number,
        brushType: BrushType,
        color: { r: number; g: number; b: number; a: number },
        layer: "foreground" | "background"
      ) => {
        actionRecorderRef.current.pushLine(
          layer === "foreground" ? 1 : 0,
          getLineType(brushType),
          from,
          to,
          color,
          brushSize,
          strokeMaskRef.current
        );
      },
      []
    ),

    /** NEO records a cleared layer as ["eraseAll", layer]. */
    onEraseAll: useCallback((layer: "foreground" | "background") => {
      actionRecorderRef.current.step();
      actionRecorderRef.current.push(
        "eraseAll",
        layer === "foreground" ? 1 : 0
      );
    }, []),

    /**
     * A region tool was applied; record it as its own frame. The verb and
     * whether it carries the drawing state come from the tool table, since
     * getting that boundary wrong shifts every field after it.
     */
    onRegionCommit: useCallback(
      (
        tool: RegionTool,
        layer: "foreground" | "background",
        rect: RegionRect,
        color: { r: number; g: number; b: number; a: number },
        brushSize: number
      ) => {
        const shape = frameShapeFor(tool);
        if (!shape) return;
        actionRecorderRef.current.pushRegion(
          shape.verb,
          shape.carriesDrawingState,
          layer === "foreground" ? 1 : 0,
          rect,
          color,
          brushSize,
          // paste's frame ends with the offset it was dropped at; we drop it
          // where it was dragged, so that offset is zero.
          tool === "paste" ? [0, 0] : [],
          strokeMaskRef.current
        );
      },
      []
    ),

    onPointerUp: useCallback(() => {
      isFirstPointRef.current = false;
      hasCreatedStepRef.current = false;
      strokeLayerRef.current = null;
    }, []),
  };

  // Get base drawing functionality
  const baseDrawing = useBaseDrawing(
    canvasRef,
    appRef,
    drawingState,
    onHistoryChange,
    zoomLevel,
    canvasWidth,
    canvasHeight,
    onDrawingChange,
    containerRef,
    false, // isDrawingDisabled - always enabled in offline mode
    callbacks
  );

  // Wrap undo to sync with ActionRecorder
  const wrappedUndo = useCallback(() => {
    baseDrawing.undo();
    actionRecorderRef.current.back();
  }, [baseDrawing]);

  // Wrap redo to sync with ActionRecorder
  const wrappedRedo = useCallback(() => {
    baseDrawing.redo();
    actionRecorderRef.current.forward();
  }, [baseDrawing]);

  // Add restore action with final layer states
  const addRestoreAction = useCallback(() => {
    const engine = baseDrawing.drawingEngine;
    if (!engine) return;

    // Get both layer canvases and convert to data URLs
    const bgCanvas = engine.getLayerCanvas("background");
    const fgCanvas = engine.getLayerCanvas("foreground");

    if (bgCanvas && fgCanvas) {
      const bgDataURL = bgCanvas.toDataURL("image/png");
      const fgDataURL = fgCanvas.toDataURL("image/png");
      actionRecorderRef.current.addRestoreAction(bgDataURL, fgDataURL);
    }
  }, [baseDrawing.drawingEngine]);

  // Track if we've already initialized to prevent double-init
  const hasInitializedTwoToneRef = useRef(false);

  // Initialize two-tone canvas with background color fill
  const initializeTwoToneCanvas = useCallback((backgroundColor: string) => {
    console.log("initializeTwoToneCanvas called with backgroundColor:", backgroundColor);

    // Guard against double initialization
    if (hasInitializedTwoToneRef.current) {
      console.log("Already initialized two-tone canvas, skipping");
      return;
    }

    const engine = baseDrawing.drawingEngine;
    const history = baseDrawing.history;
    if (!engine || !history) {
      console.log("Engine or history not ready yet");
      return;
    }

    hasInitializedTwoToneRef.current = true;

    const bgLayer = engine.layers.background;
    const r = parseInt(backgroundColor.slice(1, 3), 16);
    const g = parseInt(backgroundColor.slice(3, 5), 16);
    const b = parseInt(backgroundColor.slice(5, 7), 16);
    console.log("Parsed RGB values:", { r, g, b });

    // Fill entire canvas with background color (floodFill at 0,0)
    // Opacity must be in 0-255 range, not 0-1
    engine.doFloodFill(bgLayer, 0, 0, r, g, b, 255);
    console.log("After doFloodFill, checking bgLayer canvas:");
    const bgCanvas = engine.getLayerCanvas("background");
    if (bgCanvas) {
      const ctx = bgCanvas.getContext("2d");
      if (ctx) {
        const pixelData = ctx.getImageData(10, 10, 1, 1).data;
        console.log("Sample pixel at (10,10):", { r: pixelData[0], g: pixelData[1], b: pixelData[2], a: pixelData[3] });
      }
    }

    engine.updateAllDOMCanvasesImmediate();
    console.log("Canvas filled and updated");

    // Save canvas state to history after fill
    // saveState takes (foreground, background) -- passing them the other way
    // round stored the fill under the foreground layer, so undoing back to this
    // entry left an opaque fill on top and hid every subsequent stroke.
    history.saveState(engine.layers.foreground, engine.layers.background, "both", true);
    console.log("Saved canvas state to history after fill");

    // Record in replay - ABGR format
    const color = (255 << 24) | (b << 16) | (g << 8) | r;
    actionRecorderRef.current.step();
    actionRecorderRef.current.push("floodFill", 0, 0, 0, color);
  }, [baseDrawing.drawingEngine, baseDrawing.history]);

  // Return enhanced interface with replay functionality
  return {
    ...baseDrawing,
    undo: wrappedUndo,
    redo: wrappedRedo,
    getReplayBlob: () =>
      actionRecorderRef.current.getReplayBlob(canvasWidth || 300, canvasHeight || 300),
    getStartTime: () => startTimeRef.current,
    getActionCount: () => actionRecorderRef.current.getActionCount(),
    /** NEO's frame: ["text", layer, x, y, color, alpha, string, size, family] */
    recordText: (
      layer: "foreground" | "background",
      x: number,
      y: number,
      packedColor: number,
      alpha: number,
      text: string,
      fontSize: string,
      fontFamily: string
    ) => {
      actionRecorderRef.current.step();
      actionRecorderRef.current.push(
        "text",
        layer === "foreground" ? 1 : 0,
        x, y, packedColor, alpha, text, fontSize, fontFamily
      );
    },
    addRestoreAction,
    initializeTwoToneCanvas,
  };
};
