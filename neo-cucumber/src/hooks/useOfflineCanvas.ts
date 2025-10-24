import { useRef, useEffect, useCallback } from "react";
import { DrawingEngine } from "../DrawingEngine";
import {
  compositeLayersToCanvas,
  downloadCanvasAsPNG as downloadCanvas,
} from "../utils/canvasExport";

interface UseOfflineCanvasParams {
  canvasWidth: number;
  canvasHeight: number;
  drawingEngine: DrawingEngine | null;
  currentZoom: number;
}

export const useOfflineCanvas = ({
  canvasWidth,
  canvasHeight,
  drawingEngine,
  currentZoom,
}: UseOfflineCanvasParams) => {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const foregroundCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Initialize DOM canvases for layers
  useEffect(() => {
    if (!canvasContainerRef.current || !drawingEngine) return;

    const container = canvasContainerRef.current;

    // Create background canvas
    if (!backgroundCanvasRef.current) {
      const bgCanvas = document.createElement("canvas");
      bgCanvas.width = canvasWidth;
      bgCanvas.height = canvasHeight;
      bgCanvas.className = "absolute top-0 left-0 pointer-events-none";
      bgCanvas.style.width = `${canvasWidth}px`;
      bgCanvas.style.height = `${canvasHeight}px`;
      bgCanvas.style.zIndex = "1";
      container.appendChild(bgCanvas);
      backgroundCanvasRef.current = bgCanvas;
    }

    // Create foreground canvas
    if (!foregroundCanvasRef.current) {
      const fgCanvas = document.createElement("canvas");
      fgCanvas.width = canvasWidth;
      fgCanvas.height = canvasHeight;
      fgCanvas.className = "absolute top-0 left-0 pointer-events-none";
      fgCanvas.style.width = `${canvasWidth}px`;
      fgCanvas.style.height = `${canvasHeight}px`;
      fgCanvas.style.zIndex = "2";
      container.appendChild(fgCanvas);
      foregroundCanvasRef.current = fgCanvas;
    }

    // Attach DOM canvases to drawing engine
    if (backgroundCanvasRef.current && foregroundCanvasRef.current) {
      drawingEngine.attachDOMCanvases(
        backgroundCanvasRef.current,
        foregroundCanvasRef.current
      );

      // Force initial render
      drawingEngine.updateAllDOMCanvasesImmediate();
    }
  }, [canvasWidth, canvasHeight, drawingEngine]);

  // Update canvas zoom
  useEffect(() => {
    if (canvasContainerRef.current) {
      const container = canvasContainerRef.current;
      container.style.transform = `scale(${currentZoom})`;
    }
  }, [currentZoom]);

  // Composite all canvases for export
  const compositeCanvasesForExport =
    useCallback((): HTMLCanvasElement | null => {
      if (!drawingEngine) return null;

      const bgLayerCanvas = drawingEngine.getLayerCanvas("background");
      const fgLayerCanvas = drawingEngine.getLayerCanvas("foreground");

      const layers = [bgLayerCanvas, fgLayerCanvas].filter(
        (canvas): canvas is HTMLCanvasElement => canvas !== null
      );

      return compositeLayersToCanvas(canvasWidth, canvasHeight, layers);
    }, [drawingEngine, canvasWidth, canvasHeight]);

  // Download canvas as PNG
  const downloadCanvasAsPNG = useCallback(() => {
    const exportCanvas = compositeCanvasesForExport();
    if (!exportCanvas) {
      console.error("Failed to create export canvas");
      return;
    }

    downloadCanvas(exportCanvas);
  }, [compositeCanvasesForExport]);

  return {
    canvasContainerRef,
    compositeCanvasesForExport,
    downloadCanvasAsPNG,
  };
};
