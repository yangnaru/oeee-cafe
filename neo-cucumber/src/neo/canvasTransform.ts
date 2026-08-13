export interface CanvasBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Convert a pointer in viewport pixels to a logical artwork pixel. The live
 * bounding rectangle already includes CSS zoom and pan, so this ratio is the
 * one authoritative inverse transform. Flip is applied inside the frame and
 * therefore remains an explicit artwork-axis operation.
 */
export function screenToArtwork(
  point: Point,
  bounds: CanvasBounds,
  artworkWidth: number,
  artworkHeight: number,
  flippedHorizontal = false
): Point {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 };

  let x = ((point.x - bounds.left) / bounds.width) * artworkWidth;
  const y = ((point.y - bounds.top) / bounds.height) * artworkHeight;
  if (flippedHorizontal) x = artworkWidth - x - 1;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Convert logical artwork coordinates to the zoom-resolution overlay. */
export function artworkToOverlay(point: Point, zoom: number): Point {
  return { x: point.x * zoom, y: point.y * zoom };
}
