import { useRef, useCallback } from "react";
import { useBaseDrawing, type DrawingState } from "./useBaseDrawing";
import { ActionRecorder } from "../utils/ActionRecorder";

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
  containerRef?: React.RefObject<HTMLDivElement | null>
) => {
  // Initialize replay recording
  const actionRecorderRef = useRef<ActionRecorder>(new ActionRecorder());
  const startTimeRef = useRef<number>(Date.now());
  const strokeCountRef = useRef<number>(0);
  const isFirstPointRef = useRef<boolean>(false);
  const hasCreatedStepRef = useRef<boolean>(false);

  // Helper to map brushType to lineType
  const getLineType = (
    brushType: "solid" | "halftone" | "eraser" | "fill" | "pan"
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
    }, []),

    onDrawLine: useCallback(
      (
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
        brushSize: number,
        brushType: "solid" | "halftone" | "eraser" | "fill" | "pan",
        r: number,
        g: number,
        b: number,
        opacity: number
      ) => {
        const layer = drawingState.layerType === "foreground" ? 1 : 0;
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
          strokeCountRef.current++;
          actionRecorderRef.current.step();
          hasCreatedStepRef.current = true;

          // Neo format: coordinates are duplicated (fromX, fromY, fromX, fromY)
          actionRecorderRef.current.push(
            "freeHand",
            layer,
            safeR,
            safeG,
            safeB,
            alpha,
            0, // maskR
            0, // maskG
            0, // maskB
            brushSize,
            0, // maskType (always 0)
            lineType,
            Math.round(fromX),
            Math.round(fromY),
            Math.round(fromX), // Duplicate starting position per Neo format
            Math.round(fromY)  // Duplicate starting position per Neo format
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
        brushType: "solid" | "halftone" | "eraser" | "fill" | "pan",
        r: number,
        g: number,
        b: number,
        opacity: number
      ) => {
        const layer = drawingState.layerType === "foreground" ? 1 : 0;
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
          strokeCountRef.current++;
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
          0, // maskR
          0, // maskG
          0, // maskB
          brushSize,
          0, // maskType (always 0)
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
        const layer = drawingState.layerType === "foreground" ? 1 : 0;
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
          strokeCountRef.current++;
          actionRecorderRef.current.step();
          hasCreatedStepRef.current = true;
        }
        actionRecorderRef.current.push("floodFill", layer, Math.round(x), Math.round(y), color);
      },
      [drawingState.layerType]
    ),

    onPointerUp: useCallback(() => {
      isFirstPointRef.current = false;
      hasCreatedStepRef.current = false;
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

  // Return enhanced interface with replay functionality
  return {
    ...baseDrawing,
    undo: wrappedUndo,
    redo: wrappedRedo,
    getReplayBlob: () =>
      actionRecorderRef.current.getReplayBlob(canvasWidth || 300, canvasHeight || 300),
    getStartTime: () => startTimeRef.current,
    getStrokeCount: () => strokeCountRef.current,
    addRestoreAction,
  };
};
