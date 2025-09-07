import { useCallback, useState, useEffect, startTransition } from "react";
import { type DrawingState } from "../types/collaboration";

// Zoom constants
const zoomMin = 0.5;
const zoomMax = 4.0;
let cachedZoomLevels: number[] = [];

const getZoomLevels = (): number[] => {
  if (cachedZoomLevels.length === 0) {
    const steps = 2;
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

  const handleZoomIn = useCallback(
    (pointerX?: number, pointerY?: number) => {
      if (currentZoomIndex < zoomLevels.length - 1) {
        const oldZoom = zoomLevels[currentZoomIndex];
        const newIndex = currentZoomIndex + 1;
        const newZoom = zoomLevels[newIndex];

        // Calculate pan offset before state updates if coordinates provided
        let deltaX = 0;
        let deltaY = 0;
        if (
          pointerX !== undefined &&
          pointerY !== undefined &&
          canvasContainerRef.current
        ) {
          const canvas = canvasContainerRef.current;
          const rect = canvas.getBoundingClientRect();

          // Get current pan offset from transform
          const computedStyle = window.getComputedStyle(canvas);
          const transform = computedStyle.transform;
          let currentPanX = 0;
          let currentPanY = 0;

          if (transform && transform !== "none") {
            const matrix = new DOMMatrix(transform);
            currentPanX = matrix.m41;
            currentPanY = matrix.m42;
          }

          // Convert screen coordinates to canvas-relative coordinates (accounting for current pan)
          const canvasX = pointerX - rect.left - currentPanX;
          const canvasY = pointerY - rect.top - currentPanY;

          // Calculate the zoom scale factor
          const zoomScale = newZoom / oldZoom;

          // Calculate how much the point should move due to zoom
          deltaX = canvasX * (1 - zoomScale);
          deltaY = canvasY * (1 - zoomScale);
        }

        // Batch state updates to prevent flicker
        startTransition(() => {
          setCurrentZoomIndex(newIndex);
          setDrawingState((prev: DrawingState) => ({
            ...prev,
            zoomLevel: Math.round(newZoom * 100),
            pendingPanDeltaX: deltaX !== 0 ? deltaX : undefined,
            pendingPanDeltaY: deltaY !== 0 ? deltaY : undefined,
          }));
        });
      }
    },
    [currentZoomIndex, zoomLevels, canvasContainerRef, setDrawingState]
  );

  const handleZoomOut = useCallback(
    (pointerX?: number, pointerY?: number) => {
      if (currentZoomIndex > 0) {
        const oldZoom = zoomLevels[currentZoomIndex];
        const newIndex = currentZoomIndex - 1;
        const newZoom = zoomLevels[newIndex];

        // Calculate pan offset before state updates if coordinates provided
        let deltaX = 0;
        let deltaY = 0;
        if (
          pointerX !== undefined &&
          pointerY !== undefined &&
          canvasContainerRef.current
        ) {
          const canvas = canvasContainerRef.current;
          const rect = canvas.getBoundingClientRect();

          // Get current pan offset from transform
          const computedStyle = window.getComputedStyle(canvas);
          const transform = computedStyle.transform;
          let currentPanX = 0;
          let currentPanY = 0;

          if (transform && transform !== "none") {
            const matrix = new DOMMatrix(transform);
            currentPanX = matrix.m41;
            currentPanY = matrix.m42;
          }

          // Convert screen coordinates to canvas-relative coordinates (accounting for current pan)
          const canvasX = pointerX - rect.left - currentPanX;
          const canvasY = pointerY - rect.top - currentPanY;

          // Calculate the zoom scale factor
          const zoomScale = newZoom / oldZoom;

          // Calculate how much the point should move due to zoom
          deltaX = canvasX * (1 - zoomScale);
          deltaY = canvasY * (1 - zoomScale);
        }

        // Batch state updates to prevent flicker
        startTransition(() => {
          setCurrentZoomIndex(newIndex);
          setDrawingState((prev: DrawingState) => ({
            ...prev,
            zoomLevel: Math.round(newZoom * 100),
            pendingPanDeltaX: deltaX !== 0 ? deltaX : undefined,
            pendingPanDeltaY: deltaY !== 0 ? deltaY : undefined,
          }));
        });
      }
    },
    [currentZoomIndex, zoomLevels, canvasContainerRef, setDrawingState]
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

  // Add scroll wheel zoom functionality
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // Only zoom when cursor is over the canvas or app area
      const target = e.target as Element;
      const isOverCanvas = target.id === "canvas" || target.closest("#app");

      if (isOverCanvas) {
        e.preventDefault();

        if (e.deltaY < 0) {
          // Zoom out with pointer coordinates
          handleZoomOut(e.clientX, e.clientY);
        } else if (e.deltaY > 0) {
          // Zoom in with pointer coordinates
          handleZoomIn(e.clientX, e.clientY);
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
  };
};