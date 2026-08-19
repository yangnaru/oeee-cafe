import { useCallback, useState, useEffect, startTransition } from "react";
import { type DrawingState } from "../types/drawing";

// Zoom constants
const zoomMin = 0.5;
const zoomMax = 4.0;
let cachedZoomLevels: number[] = [];

const getZoomLevels = (): number[] => {
  if (cachedZoomLevels.length === 0) {
    // Eight steps per doubling makes wheel zoom feel continuous while still
    // keeping the full 50%–400% range practical to traverse with buttons.
    const steps = 8;
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

/**
 * The rung of the ladder closest to a continuous scale.
 *
 * Closest by ratio, not by difference: zoom reads multiplicatively, so 0.9x
 * and 1.11x are the same distance from 1x, while `Math.abs` would call the
 * first one nearer and make a pinch snap down more readily than up.
 */
export const nearestZoomIndex = (levels: number[], scale: number): number => {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const distance = Math.abs(Math.log(levels[i] / scale));
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * How far to shift the canvas so the point under (`pointerX`, `pointerY`)
 * stays under it across a zoom change.
 *
 * Shared by the buttons, the wheel and the pinch. It was written out twice
 * before -- once for zoom in and once for zoom out, identically -- which is
 * two chances for the anchor point to drift apart between the directions.
 */
const panDeltaForZoom = (
  canvas: HTMLDivElement | null,
  oldZoom: number,
  newZoom: number,
  pointerX?: number,
  pointerY?: number
): { x: number; y: number } => {
  if (pointerX === undefined || pointerY === undefined || !canvas) {
    return { x: 0, y: 0 };
  }

  const rect = canvas.getBoundingClientRect();

  // Get current pan offset from transform
  const transform = window.getComputedStyle(canvas).transform;
  let currentPanX = 0;
  let currentPanY = 0;
  if (transform && transform !== "none") {
    const matrix = new DOMMatrix(transform);
    currentPanX = matrix.m41;
    currentPanY = matrix.m42;
  }

  // Where the pointer is over the canvas, with the pan already taken out
  const canvasX = pointerX - rect.left - currentPanX;
  const canvasY = pointerY - rect.top - currentPanY;

  // How far that point would travel under the zoom, and so how far back the
  // canvas has to be moved to leave it where it was
  const zoomScale = newZoom / oldZoom;
  return { x: canvasX * (1 - zoomScale), y: canvasY * (1 - zoomScale) };
};

interface UseZoomControlsProps {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  appRef: React.RefObject<HTMLDivElement | null>;
  drawingEngine?: {
    resetPan: (container: HTMLDivElement | undefined, zoom: number) => void;
  } | null;
  setDrawingState: (updater: (prev: DrawingState) => DrawingState) => void;
}

export const useZoomControls = ({
  canvasContainerRef,
  appRef,
  drawingEngine,
  setDrawingState,
}: UseZoomControlsProps) => {
  // Zoom level management using engine's getZoomLevels function
  const zoomLevels = getZoomLevels();
  const [currentZoomIndex, setCurrentZoomIndex] = useState(
    zoomLevels.findIndex((level) => level >= 1.0)
  );
  const currentZoom = zoomLevels[currentZoomIndex];

  /**
   * Move to a rung of the ladder, keeping the point under the pointer still.
   *
   * The pan the zoom needs is left in `pendingPanDelta*` for `useCanvasView`
   * to apply on the next frame, so the scale and the shift that compensates
   * for it land together rather than a frame apart.
   */
  const applyZoomIndex = useCallback(
    (newIndex: number, pointerX?: number, pointerY?: number) => {
      if (newIndex < 0 || newIndex >= zoomLevels.length) return;
      if (newIndex === currentZoomIndex) return;

      const newZoom = zoomLevels[newIndex];
      const delta = panDeltaForZoom(
        canvasContainerRef.current,
        zoomLevels[currentZoomIndex],
        newZoom,
        pointerX,
        pointerY
      );

      // Batch state updates to prevent flicker
      startTransition(() => {
        setCurrentZoomIndex(newIndex);
        setDrawingState((prev: DrawingState) => ({
          ...prev,
          zoomLevel: Math.round(newZoom * 100),
          pendingPanDeltaX: delta.x !== 0 ? delta.x : undefined,
          pendingPanDeltaY: delta.y !== 0 ? delta.y : undefined,
        }));
      });
    },
    [currentZoomIndex, zoomLevels, canvasContainerRef, setDrawingState]
  );

  const handleZoomIn = useCallback(
    (pointerX?: number, pointerY?: number) =>
      applyZoomIndex(currentZoomIndex + 1, pointerX, pointerY),
    [applyZoomIndex, currentZoomIndex]
  );

  const handleZoomOut = useCallback(
    (pointerX?: number, pointerY?: number) =>
      applyZoomIndex(currentZoomIndex - 1, pointerX, pointerY),
    [applyZoomIndex, currentZoomIndex]
  );

  /**
   * Zoom to whatever rung is nearest a continuous scale, for a pinch.
   *
   * A pinch asks for any scale at all, and the answer is still one of the
   * ladder's steps: the overlays are sized in whole zoomed pixels and the
   * brush cursor is rasterised at the zoom, so a truly continuous scale would
   * mean reallocating both on every touch sample. Eight steps to a doubling
   * is fine enough that a pinch reads as smooth.
   */
  const zoomToScale = useCallback(
    (scale: number, pointerX?: number, pointerY?: number) => {
      const clamped = Math.min(
        Math.max(scale, zoomLevels[0]),
        zoomLevels[zoomLevels.length - 1]
      );
      applyZoomIndex(nearestZoomIndex(zoomLevels, clamped), pointerX, pointerY);
    },
    [applyZoomIndex, zoomLevels]
  );

  const handleZoomReset = useCallback(() => {
    const resetIndex = zoomLevels.findIndex((level) => level >= 1.0);
    setCurrentZoomIndex(resetIndex);
    setDrawingState((prev: DrawingState) => ({ ...prev, zoomLevel: 100 }));

    // Reset pan offset as well
    if (drawingEngine) {
      drawingEngine.resetPan(canvasContainerRef.current || undefined, 1.0);
    }
  }, [zoomLevels, drawingEngine, canvasContainerRef, setDrawingState]);

  /**
   * Zoom so the whole drawing is on screen.
   *
   * `reservedWidth` is horizontal space the caller knows is spoken for --
   * floating panels, which are not in the layout and so do not shrink the
   * viewport the way a docked column would. `maximumZoom` is for fitting on
   * open: a small canvas on a large display should stay at 100%, not be blown
   * up to fill the window.
   */
  const zoomToFit = useCallback(
    (options?: { reservedWidth?: number; maximumZoom?: number }) => {
    const canvas = canvasContainerRef.current;
    const viewport = appRef.current;
    if (!canvas || !viewport) return;

    // Leave a little room around the drawing so the border remains visible.
    const padding = 32;
    const fitScale = Math.min(
      (viewport.clientWidth - padding - (options?.reservedWidth ?? 0)) /
        canvas.offsetWidth,
      (viewport.clientHeight - padding) / canvas.offsetHeight,
      options?.maximumZoom ?? Infinity
    );
    const fitIndex = zoomLevels.reduce(
      (best, level, index) =>
        level <= fitScale && level > zoomLevels[best] ? index : best,
      0
    );
    const fitZoom = zoomLevels[fitIndex];

    setCurrentZoomIndex(fitIndex);
    setDrawingState((prev: DrawingState) => ({
      ...prev,
      zoomLevel: Math.round(fitZoom * 100),
      pendingPanDeltaX: undefined,
      pendingPanDeltaY: undefined,
    }));
    drawingEngine?.resetPan(canvas, fitZoom);
    },
    [appRef, canvasContainerRef, drawingEngine, setDrawingState, zoomLevels]
  );

  const handleZoomFit = useCallback(() => zoomToFit(), [zoomToFit]);

  // Add scroll wheel zoom functionality
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // Only zoom when cursor is over the canvas or app area
      const target = e.target as Element;
      const isOverCanvas = target.id === "canvas" || target.closest("#app");

      if (isOverCanvas) {
        e.preventDefault();

        if (e.deltaY < 0) {
          // Scroll up follows the common map/canvas convention: zoom in.
          handleZoomIn(e.clientX, e.clientY);
        } else if (e.deltaY > 0) {
          handleZoomOut(e.clientX, e.clientY);
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

  return {
    // State
    currentZoom,
    currentZoomIndex,
    zoomLevels,

    // Actions
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    handleZoomFit,
    zoomToFit,
    zoomToScale,
  };
};
