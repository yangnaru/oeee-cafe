import { useRef, useCallback } from 'react';

export interface CanvasState {
  foreground: Uint8ClampedArray;        // Complete foreground layer data
  background: Uint8ClampedArray;        // Complete background layer data
  modifiedLayer: "foreground" | "background" | "both"; // Which layer(s) were changed
  timestamp: number;
  isContentSnapshot?: boolean; // True if this snapshot contains actual content (BG/FG layers)
  isRemote?: boolean; // True if this came from a remote user (don't include in undo history)
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

  const saveState = useCallback((
    foreground: Uint8ClampedArray, 
    background: Uint8ClampedArray, 
    modifiedLayer: "foreground" | "background" | "both" = "both",
    isDrawingAction: boolean = true, 
    isContentSnapshot: boolean = false,
    isRemote: boolean = false
  ) => {
    // Don't add remote snapshots to undo history
    if (isRemote) {
      console.log(`Skipping remote ${modifiedLayer} snapshot - not adding to undo history`);
      return;
    }

    // Every stroke gets an entry, even one that changed no pixels. Canonical
    // Neo registers an undo step unconditionally at stroke start (tools.js
    // freeHandDownHandler), and the action recorder likewise emits one frame
    // per stroke. Skipping "duplicate" states here desynchronised the two: the
    // recorder's head advanced while the history index did not, so undoing
    // back past an inert stroke left the replay one stroke ahead of the canvas
    // and of the saved PNG.

    const newState: CanvasState = {
      foreground: new Uint8ClampedArray(foreground),
      background: new Uint8ClampedArray(background),
      modifiedLayer,
      timestamp: Date.now(),
      isContentSnapshot,
      isRemote
    };

    // Update our current state tracking
    currentStateRef.current.foreground = new Uint8ClampedArray(foreground);
    currentStateRef.current.background = new Uint8ClampedArray(background);

    // Remove any states after current index (when user made new changes after undo)
    if (currentIndexRef.current < historyRef.current.length - 1) {
      historyRef.current = historyRef.current.slice(0, currentIndexRef.current + 1);
    }

    // Add new state
    historyRef.current.push(newState);
    console.log(`Saved complete canvas state to history (index: ${historyRef.current.length - 1}, modified: ${modifiedLayer}, drawing action: ${isDrawingAction}, content snapshot: ${isContentSnapshot})`);

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

  // Helper method to save both layers (for backward compatibility)
  const saveBothLayers = useCallback((foreground: Uint8ClampedArray, background: Uint8ClampedArray, isDrawingAction: boolean = true, isContentSnapshot: boolean = false) => {
    saveState(foreground, background, "both", isDrawingAction, isContentSnapshot, false);
  }, [saveState]);

  const undo = useCallback((): CanvasState | null => {
    if (currentIndexRef.current > 0) {
      currentIndexRef.current--;
      const previousState = historyRef.current[currentIndexRef.current];
      
      // Update our current state tracking with both layers
      if (previousState) {
        currentStateRef.current.foreground = new Uint8ClampedArray(previousState.foreground);
        currentStateRef.current.background = new Uint8ClampedArray(previousState.background);
      }
      
      return previousState;
    }
    return null;
  }, []);

  const redo = useCallback((): CanvasState | null => {
    if (currentIndexRef.current < historyRef.current.length - 1) {
      currentIndexRef.current++;
      const nextState = historyRef.current[currentIndexRef.current];
      
      // Update our current state tracking with both layers
      if (nextState) {
        currentStateRef.current.foreground = new Uint8ClampedArray(nextState.foreground);
        currentStateRef.current.background = new Uint8ClampedArray(nextState.background);
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