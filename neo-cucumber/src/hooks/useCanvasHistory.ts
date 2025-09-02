import { useRef, useCallback } from 'react';

export interface CanvasState {
  foreground: Uint8ClampedArray;
  background: Uint8ClampedArray;
  timestamp: number;
  isContentSnapshot?: boolean; // True if this snapshot contains actual content (BG/FG layers)
}

export const useCanvasHistory = (maxHistorySize: number = 30) => {
  const historyRef = useRef<CanvasState[]>([]);
  const currentIndexRef = useRef(-1);
  const hasDrawingActionsRef = useRef(false);

  const saveState = useCallback((foreground: Uint8ClampedArray, background: Uint8ClampedArray, isDrawingAction: boolean = true, isContentSnapshot: boolean = false) => {
    const newState: CanvasState = {
      foreground: new Uint8ClampedArray(foreground),
      background: new Uint8ClampedArray(background),
      timestamp: Date.now(),
      isContentSnapshot
    };

    // Remove any states after current index (when user made new changes after undo)
    if (currentIndexRef.current < historyRef.current.length - 1) {
      historyRef.current = historyRef.current.slice(0, currentIndexRef.current + 1);
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
  }, [maxHistorySize]);

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
    // Can't undo if we don't have drawing actions or are at the beginning
    if (!hasDrawingActionsRef.current || currentIndexRef.current <= 0) {
      return false;
    }

    // Find the last content snapshot (BG/FG layers received from collaboration)
    let lastContentSnapshotIndex = -1;
    for (let i = historyRef.current.length - 1; i >= 0; i--) {
      if (historyRef.current[i].isContentSnapshot) {
        lastContentSnapshotIndex = i;
        break;
      }
    }

    // If there's a content snapshot, prevent undoing past it
    if (lastContentSnapshotIndex !== -1) {
      return currentIndexRef.current > lastContentSnapshotIndex;
    }

    // Otherwise, can undo as long as we're not at the beginning
    return currentIndexRef.current > 0;
  }, []);

  const canRedo = useCallback((): boolean => {
    return currentIndexRef.current < historyRef.current.length - 1;
  }, []);

  const getHistoryInfo = useCallback(() => {
    return {
      currentIndex: currentIndexRef.current,
      historyLength: historyRef.current.length,
      canUndo: canUndo(),
      canRedo: canRedo()
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
    clearHistory
  };
};