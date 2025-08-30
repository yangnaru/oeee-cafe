/**
 * Utility functions for compressing and decompressing canvas layers
 */

/**
 * Compress a canvas layer to a base64 PNG string
 */
export function compressLayer(
  layer: Uint8ClampedArray,
  width: number,
  height: number
): string {
  // Create a temporary canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }
  
  // Create ImageData from the layer
  const imageData = new ImageData(layer, width, height);
  ctx.putImageData(imageData, 0, 0);
  
  // Convert to base64 PNG (removes 'data:image/png;base64,' prefix for smaller payload)
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.substring(22); // Remove 'data:image/png;base64,' prefix
}

/**
 * Decompress a base64 PNG string back to a Uint8ClampedArray layer
 */
export async function decompressLayer(
  snapshot: string,
  width: number,
  height: number
): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    
    img.onload = () => {
      // Create a temporary canvas to extract pixel data
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
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
      reject(new Error('Failed to load image from snapshot'));
    };
    
    // Load the image from base64 (add back the prefix)
    img.src = `data:image/png;base64,${snapshot}`;
  });
}