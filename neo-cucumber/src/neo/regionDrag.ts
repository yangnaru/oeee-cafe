/**
 * Turning a drag into the rectangle a region tool acts on, following NEO's
 * EffectToolBase.
 *
 * The details are load-bearing and none of them are obvious:
 *
 * - Pointer coordinates are clamped to `[0, canvasWidth]` -- to the far edge
 *   itself, not to the last pixel -- before anything else happens. That extra
 *   column is what lets a drag off the right edge still cover the last pixel.
 * - The rectangle is *inclusive* of both endpoints, so its size is
 *   `|start - end| + 1`. A press with no movement is a 1x1 rectangle, not an
 *   empty one, and clicking with the erase-rect tool erases a pixel.
 * - Coordinates are floored before the rectangle is derived, not after.
 * - The origin is clamped to zero first, and only then is the size trimmed to
 *   fit. Upstream does not pull the far edge back in when it moves the origin,
 *   so a drag starting off-canvas covers slightly more than the pointer did.
 *   Kept, because a recorded region has to mean the same thing here as it does
 *   in a NEO replay.
 */

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** NEO's clipMouseX/clipMouseY: clamped to the canvas, far edge included. */
export function clipToCanvas(
  point: Point,
  canvasWidth: number,
  canvasHeight: number
): Point {
  return {
    x: Math.max(Math.min(canvasWidth, point.x), 0),
    y: Math.max(Math.min(canvasHeight, point.y), 0),
  };
}

/**
 * The rectangle a drag from `start` to `end` covers, or null when it collapses
 * to nothing and the tool should not run.
 *
 * Both points are expected to have been through `clipToCanvas` already, as
 * they have in NEO by the time a tool sees them.
 */
export function regionRectFrom(
  start: Point,
  end: Point,
  canvasWidth: number,
  canvasHeight: number
): RegionRect | null {
  const startX = Math.floor(start.x);
  const startY = Math.floor(start.y);
  const endX = Math.floor(end.x);
  const endY = Math.floor(end.y);

  let x = Math.min(startX, endX);
  let y = Math.min(startY, endY);
  let width = Math.abs(startX - endX) + 1;
  let height = Math.abs(startY - endY) + 1;

  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + width > canvasWidth) width = canvasWidth - x;
  if (y + height > canvasHeight) height = canvasHeight - y;

  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Tracks one drag. Held separately from the pointer plumbing so the geometry
 * can be tested without a browser, and so the preview and the committed
 * rectangle are derived from the same place -- if they disagreed, the shape
 * someone dragged would not be the shape they got.
 */
export class RegionDrag {
  private start: Point | null = null;
  private end: Point | null = null;

  private readonly canvasWidth: number;
  private readonly canvasHeight: number;

  constructor(canvasWidth: number, canvasHeight: number) {
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
  }

  get active(): boolean {
    return this.start !== null;
  }

  begin(point: Point): void {
    const clipped = clipToCanvas(point, this.canvasWidth, this.canvasHeight);
    this.start = clipped;
    this.end = clipped;
  }

  move(point: Point): void {
    if (!this.start) return;
    this.end = clipToCanvas(point, this.canvasWidth, this.canvasHeight);
  }

  /** The rectangle as it stands, for drawing the preview. */
  current(): RegionRect | null {
    if (!this.start || !this.end) return null;
    return regionRectFrom(
      this.start,
      this.end,
      this.canvasWidth,
      this.canvasHeight
    );
  }

  /** Ends the drag and returns the rectangle to act on, if any. */
  commit(point?: Point): RegionRect | null {
    if (point) this.move(point);
    const rect = this.current();
    this.start = null;
    this.end = null;
    return rect;
  }

  cancel(): void {
    this.start = null;
    this.end = null;
  }
}
