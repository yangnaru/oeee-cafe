import { useRef, useCallback } from "react";

export interface CanvasState {
  foreground: Uint8ClampedArray;
  background: Uint8ClampedArray;
  timestamp: number;
}

export const useCanvasHistory = (maxHistorySize: number = 30) => {
  const historyRef = useRef<CanvasState[]>([]);
  const currentIndexRef = useRef(-1);
  const hasDrawingActionsRef = useRef(false);

  const saveState = useCallback(
    (
      foreground: Uint8ClampedArray,
      background: Uint8ClampedArray,
      isDrawingAction: boolean = true
    ) => {
      const newState: CanvasState = {
        foreground: new Uint8ClampedArray(foreground),
        background: new Uint8ClampedArray(background),
        timestamp: Date.now(),
      };

      // Remove any states after current index (when user made new changes after undo)
      if (currentIndexRef.current < historyRef.current.length - 1) {
        historyRef.current = historyRef.current.slice(
          0,
          currentIndexRef.current + 1
        );
      }

      // Add new state
      historyRef.current.push(newState);

      // Track if this is a drawing action
      if (isDrawingAction) {
        hasDrawingActionsRef.current = true;
      }

      // Limit history size
      if (historyRef.current.length > maxHistorySize) {
        historyRef.current = historyRef.current.slice(-maxHistorySize);
        currentIndexRef.current = maxHistorySize - 1;
      } else {
        currentIndexRef.current = historyRef.current.length - 1;
      }
    },
    [maxHistorySize]
  );

  const undo = useCallback((): CanvasState | null => {
    if (currentIndexRef.current > 0) {
      currentIndexRef.current--;
      return historyRef.current[currentIndexRef.current];
    }
    return null;
  }, []);

  const redo = useCallback((): CanvasState | null => {
    if (currentIndexRef.current < historyRef.current.length - 1) {
      currentIndexRef.current++;
      return historyRef.current[currentIndexRef.current];
    }
    return null;
  }, []);

  const canUndo = useCallback((): boolean => {
    // Can undo if we have drawing actions and current index > 0
    return hasDrawingActionsRef.current && currentIndexRef.current > 0;
  }, []);

  const canRedo = useCallback((): boolean => {
    return currentIndexRef.current < historyRef.current.length - 1;
  }, []);

  const getHistoryInfo = useCallback(() => {
    return {
      currentIndex: currentIndexRef.current,
      historyLength: historyRef.current.length,
      canUndo: canUndo(),
      canRedo: canRedo(),
    };
  }, [canUndo, canRedo]);

  const clearHistory = useCallback(() => {
    historyRef.current = [];
    currentIndexRef.current = -1;
    hasDrawingActionsRef.current = false;
  }, []);

  return {
    saveState,
    undo,
    redo,
    canUndo,
    canRedo,
    getHistoryInfo,
    clearHistory,
  };
};
