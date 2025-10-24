/**
 * Shared utilities for canvas export functionality
 */

/**
 * Create a composite canvas with white background and draw provided layers
 */
export function compositeLayersToCanvas(
  width: number,
  height: number,
  layers: HTMLCanvasElement[]
): HTMLCanvasElement | null {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = width;
  exportCanvas.height = height;
  const ctx = exportCanvas.getContext("2d");

  if (!ctx) return null;

  // Create white background
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);

  // Draw all layers in order
  for (const layer of layers) {
    if (layer.style.display !== "none") {
      ctx.drawImage(layer, 0, 0);
    }
  }

  return exportCanvas;
}

/**
 * Download a canvas as PNG file
 */
export function downloadCanvasAsPNG(
  canvas: HTMLCanvasElement,
  filename?: string
): void {
  canvas.toBlob((blob) => {
    if (blob) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      link.download = filename || `drawing-${timestamp}.png`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    }
  }, "image/png");
}
