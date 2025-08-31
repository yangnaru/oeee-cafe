// Utility functions for layer compositing
// Extracted from DrawingEngine to avoid code duplication

/**
 * Alpha composite two RGBA pixel values using the "source over" blending mode
 * @param sourceR Source red (0-255)
 * @param sourceG Source green (0-255)
 * @param sourceB Source blue (0-255)
 * @param sourceA Source alpha (0-255)
 * @param destR Destination red (0-255)
 * @param destG Destination green (0-255)
 * @param destB Destination blue (0-255)
 * @param destA Destination alpha (0-255)
 * @returns [r, g, b, a] composited pixel values
 */
export function compositePixels(
  sourceR: number,
  sourceG: number,
  sourceB: number,
  sourceA: number,
  destR: number,
  destG: number,
  destB: number,
  destA: number
): [number, number, number, number] {
  // Normalize alpha values to 0-1 range
  const srcA = sourceA / 255;
  const dstA = destA / 255;

  // Alpha composite: source over destination
  const outA = srcA + dstA * (1 - srcA);

  if (outA > 0) {
    const r = Math.round((sourceR * srcA + destR * dstA * (1 - srcA)) / outA);
    const g = Math.round((sourceG * srcA + destG * dstA * (1 - srcA)) / outA);
    const b = Math.round((sourceB * srcA + destB * dstA * (1 - srcA)) / outA);
    const a = Math.round(outA * 255);

    return [r, g, b, a];
  } else {
    return [0, 0, 0, 0];
  }
}

/**
 * Composite multiple layers using alpha blending
 * @param layers Array of Uint8ClampedArray layers in bottom-to-top order
 * @param width Image width
 * @param height Image height
 * @returns Composited Uint8ClampedArray result
 */
export function compositeLayers(
  layers: Uint8ClampedArray[],
  width: number,
  height: number
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(width * height * 4);

  // Initialize with transparent pixels
  result.fill(0);

  // Composite each layer on top of the result
  for (const layer of layers) {
    for (let i = 0; i < result.length; i += 4) {
      const layerR = layer[i];
      const layerG = layer[i + 1];
      const layerB = layer[i + 2];
      const layerA = layer[i + 3];

      // Skip transparent pixels for performance
      if (layerA === 0) continue;

      const resultR = result[i];
      const resultG = result[i + 1];
      const resultB = result[i + 2];
      const resultA = result[i + 3];

      const [newR, newG, newB, newA] = compositePixels(
        layerR,
        layerG,
        layerB,
        layerA,
        resultR,
        resultG,
        resultB,
        resultA
      );

      result[i] = newR;
      result[i + 1] = newG;
      result[i + 2] = newB;
      result[i + 3] = newA;
    }
  }

  return result;
}

/**
 * Composite foreground and background layers (matches DrawingEngine.compositeLayers)
 * @param foreground Foreground layer
 * @param background Background layer
 * @param fgVisible Whether foreground is visible
 * @param bgVisible Whether background is visible
 * @param width Image width
 * @param height Image height
 * @returns Composited result
 */
export function compositeEngineLayer(
  foreground: Uint8ClampedArray,
  background: Uint8ClampedArray,
  fgVisible: boolean = true,
  bgVisible: boolean = true,
  width: number,
  height: number
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < result.length; i += 4) {
    // Get background layer values (only if visible)
    const bgR = bgVisible ? background[i] : 0;
    const bgG = bgVisible ? background[i + 1] : 0;
    const bgB = bgVisible ? background[i + 2] : 0;
    const bgA = bgVisible ? background[i + 3] : 0;

    // Get foreground layer values (only if visible)
    const fgR = fgVisible ? foreground[i] : 0;
    const fgG = fgVisible ? foreground[i + 1] : 0;
    const fgB = fgVisible ? foreground[i + 2] : 0;
    const fgA = fgVisible ? foreground[i + 3] : 0;

    const [r, g, b, a] = compositePixels(
      fgR,
      fgG,
      fgB,
      fgA,
      bgR,
      bgG,
      bgB,
      bgA
    );

    result[i] = r;
    result[i + 1] = g;
    result[i + 2] = b;
    result[i + 3] = a;
  }

  return result;
}
