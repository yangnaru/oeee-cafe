import { useRef, useCallback } from 'react';

export interface CanvasState {
  layer: "foreground" | "background";  // Which layer was modified
  data: Uint8ClampedArray;              // Only the modified layer data
  timestamp: number;
  isContentSnapshot?: boolean; // True if this snapshot contains actual content (BG/FG layers)
}

export const useCanvasHistory = (maxHistorySize: number = 30) => {
  const historyRef = useRef<CanvasState[]>([]);
  const currentIndexRef = useRef(-1);
  const hasDrawingActionsRef = useRef(false);
  
  // Keep track of the current full state of both layers for reconstruction
  const currentStateRef = useRef<{
    foreground: Uint8ClampedArray | null;
    background: Uint8ClampedArray | null;
  }>({
    foreground: null,
    background: null,
  });

  const saveState = useCallback((layer: "foreground" | "background", data: Uint8ClampedArray, isDrawingAction: boolean = true, isContentSnapshot: boolean = false) => {
    const newState: CanvasState = {
      layer,
      data: new Uint8ClampedArray(data),
      timestamp: Date.now(),
      isContentSnapshot
    };

    // Update our current state tracking
    currentStateRef.current[layer] = new Uint8ClampedArray(data);

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

  // Helper method to save both layers (for initial state)
  const saveBothLayers = useCallback((foreground: Uint8ClampedArray, background: Uint8ClampedArray, isDrawingAction: boolean = true, isContentSnapshot: boolean = false) => {
    // Update our current state tracking
    currentStateRef.current.foreground = new Uint8ClampedArray(foreground);
    currentStateRef.current.background = new Uint8ClampedArray(background);
    
    // Save foreground first, then background
    saveState("foreground", foreground, isDrawingAction, isContentSnapshot);
    saveState("background", background, isDrawingAction, isContentSnapshot);
  }, [saveState]);

  const undo = useCallback((): CanvasState | null => {
    if (currentIndexRef.current > 0) {
      currentIndexRef.current--;
      const previousState = historyRef.current[currentIndexRef.current];
      
      // Update our current state tracking
      if (previousState) {
        currentStateRef.current[previousState.layer] = new Uint8ClampedArray(previousState.data);
      }
      
      return previousState;
    }
    return null;
  }, []);

  const redo = useCallback((): CanvasState | null => {
    if (currentIndexRef.current < historyRef.current.length - 1) {
      currentIndexRef.current++;
      const nextState = historyRef.current[currentIndexRef.current];
      
      // Update our current state tracking
      if (nextState) {
        currentStateRef.current[nextState.layer] = new Uint8ClampedArray(nextState.data);
      }
      
      return nextState;
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
    currentStateRef.current.foreground = null;
    currentStateRef.current.background = null;
  }, []);

  return {
    saveState,
    saveBothLayers, // Expose the helper for initial state
    undo,
    redo,
    canUndo,
    canRedo,
    getHistoryInfo,
    clearHistory
  };
};