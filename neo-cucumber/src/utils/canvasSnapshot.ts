/**
 * Turning a layer into a PNG and back.
 *
 * This is what a checkpoint is made of, and a checkpoint covers a layer pair
 * per participant -- sixteen of these at the largest session size, in one go,
 * on whoever the room asked. So the copies matter: the PNG itself is encoded
 * and decoded off the main thread by the browser, and what is left here is
 * pixel shuffling that has to be worth doing.
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

  // The layer buffer itself: `ImageData` wraps what it is handed, and
  // `putImageData` has read it by the time it returns, so copying the layer
  // first only moved a few megabytes for the sake of it.
  // The cast is the `SharedArrayBuffer` case `ImageDataArray` excludes; layers
  // are allocated as plain `new Uint8ClampedArray(n)` and never shared.
  const imageData = new ImageData(
    layer as Uint8ClampedArray<ArrayBuffer>,
    width,
    height,
  );
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
  const blob = new Blob([pngData as unknown as BlobPart], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to load image from PNG data"));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

    // Disable image smoothing to preserve pixel-perfect data
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  } finally {
    URL.revokeObjectURL(url);
  }
}
