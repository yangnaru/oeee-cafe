/**
 * The region of canvas each operation can touch.
 *
 * The collaborative history uses this to decide whether a remote message can
 * be applied directly or whether the local fork has to be replayed on top of
 * it. The failure modes are lopsided: an extent that is too large costs an
 * unnecessary replay, while one that is too small lets two operations that
 * genuinely overlap be treated as concurrent, and the clients then diverge
 * permanently with nothing to signal it.
 *
 * So every extent here is a conservative superset, and it covers the pixels an
 * operation *depends on*, not only the ones it writes -- reordering two
 * operations changes the result if one reads what the other wrote.
 *
 * extents.browser.test.ts checks each of these against what the kernel
 * actually changes, so a new tool cannot quietly understate itself.
 */

export const LAYER_INDEX = { BACKGROUND: 0, FOREGROUND: 1 } as const;

export interface Extent {
  /** Layer indices the operation reads or writes. */
  layers: number[];
  /** Inclusive pixel bounds. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Covers the whole of the given layers. */
export function wholeLayers(width: number, height: number, layers: number[]): Extent {
  return { layers, x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
}

function rect(layers: number[], x: number, y: number, w: number, h: number): Extent {
  return {
    layers,
    x0: Math.floor(x),
    y0: Math.floor(y),
    x1: Math.ceil(x + w) - 1,
    y1: Math.ceil(y + h) - 1,
  };
}

/**
 * A freehand stroke: the bounding box of its points, inflated by the brush
 * size.
 *
 * Half of that would cover the footprint, since the brush is centred. The
 * other half is deliberate rather than slack: blur reads a one-pixel halo
 * around each stamp (`index ± 4`, `index ± width * 4`), so its dependency
 * region is wider than its footprint.
 */
export function strokeExtent(
  layer: number,
  points: readonly { x: number; y: number }[],
  brushSize: number
): Extent {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const pad = brushSize;
  return {
    layers: [layer],
    x0: Math.floor(x0 - pad),
    y0: Math.floor(y0 - pad),
    x1: Math.ceil(x1 + pad),
    y1: Math.ceil(y1 + pad),
  };
}

export function eraseRectExtent(layer: number, x: number, y: number, w: number, h: number): Extent {
  return rect([layer], x, y, w, h);
}

export function blurRectExtent(layer: number, x: number, y: number, w: number, h: number): Extent {
  // Reads one pixel beyond each edge, same halo as the blur brush
  return rect([layer], x - 1, y - 1, w + 2, h + 2);
}

export function flipExtent(layer: number, x: number, y: number, w: number, h: number): Extent {
  return rect([layer], x, y, w, h);
}

/**
 * The turn tool reads `w x h` and writes back `h x w` at the same origin, so
 * its region is the square that contains both. Sending the source rectangle
 * would understate it for every selection that is not already square.
 */
export function turnExtent(layer: number, x: number, y: number, w: number, h: number): Extent {
  const side = Math.max(w, h);
  return rect([layer], x, y, side, side);
}

/**
 * Merge composites one layer onto the other and clears the source, so it
 * touches both. A single-layer extent would be reported as concurrent with
 * everything on the other layer, which is precisely backwards.
 */
export function mergeExtent(x: number, y: number, w: number, h: number): Extent {
  return rect([LAYER_INDEX.BACKGROUND, LAYER_INDEX.FOREGROUND], x, y, w, h);
}

/** Paste writes at the offset position, not at the source rectangle. */
export function pasteExtent(
  layer: number,
  x: number,
  y: number,
  w: number,
  h: number,
  dx: number,
  dy: number
): Extent {
  return rect([layer], x + dx, y + dy, w, h);
}

export function fillExtent(layer: number, x: number, y: number, w: number, h: number): Extent {
  return rect([layer], x, y, w, h);
}

/** A flood fill can reach anywhere connected to its seed. */
export function floodFillExtent(layer: number, width: number, height: number): Extent {
  return wholeLayers(width, height, [layer]);
}

export function eraseAllExtent(layer: number, width: number, height: number): Extent {
  return wholeLayers(width, height, [layer]);
}

export function clearCanvasExtent(width: number, height: number): Extent {
  return wholeLayers(width, height, [
    LAYER_INDEX.BACKGROUND,
    LAYER_INDEX.FOREGROUND,
  ]);
}

/** True when `x, y` falls inside the extent's bounds. */
export function extentContains(extent: Extent, x: number, y: number): boolean {
  return x >= extent.x0 && x <= extent.x1 && y >= extent.y0 && y <= extent.y1;
}
