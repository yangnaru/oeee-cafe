/**
 * Utility functions for compressing and decompressing canvas layers using PNG blobs
 */

/**
 * Convert a canvas layer to a PNG Blob
 */
export async function layerToPngBlob(
  layer: Uint8ClampedArray,
  width: number,
  height: number
): Promise<Blob> {
  // Create a temporary canvas
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Failed to get canvas context");
  }

  // Create ImageData from the layer
  const imageData = new ImageData(new Uint8ClampedArray(layer), width, height);
  ctx.putImageData(imageData, 0, 0);

  // Convert to PNG blob
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Failed to create PNG blob"));
      }
    }, "image/png");
  });
}

/**
 * Convert PNG data (Uint8Array) back to a Uint8ClampedArray layer
 */
export async function pngDataToLayer(
  pngData: Uint8Array,
  width: number,
  height: number
): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      // Create a temporary canvas to extract pixel data
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }

      // Disable image smoothing to preserve pixel-perfect data
      ctx.imageSmoothingEnabled = false;

      // Draw the image onto the canvas
      ctx.drawImage(img, 0, 0);

      // Extract the pixel data
      const imageData = ctx.getImageData(0, 0, width, height);
      resolve(imageData.data);
    };

    img.onerror = () => {
      reject(new Error("Failed to load image from PNG data"));
    };

    // Create blob URL from PNG data
    const blob = new Blob([new Uint8Array(pngData)], { type: "image/png" });
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(url); // Clean up
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, width, height);
      resolve(imageData.data);
    };

    img.src = url;
  });
}
