import type { RegionRect } from "./regionDrag";

/**
 * Draws the rubber-band rectangle a region tool is being dragged out over.
 *
 * NEO draws this with an XOR raster op, which is what makes it legible over
 * any artwork -- a plain black outline vanishes on black, a white one on white.
 * Canvas has no XOR, but `difference` compositing inverts what is underneath in
 * the same way, so the outline stays visible whatever it crosses.
 *
 * Drawn on its own overlay rather than into a layer: it is a cursor, not part
 * of the drawing, and nothing about it is recorded.
 */
export function drawRegionPreview(
  ctx: CanvasRenderingContext2D,
  rect: RegionRect | null,
  scale = 1
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!rect || rect.width <= 0 || rect.height <= 0) return;

  ctx.save();
  ctx.globalCompositeOperation = "difference";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  // Half-pixel offset so a 1px stroke lands on the pixel grid rather than
  // straddling it and rendering as two grey lines.
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(
    rect.x * scale + 0.5,
    rect.y * scale + 0.5,
    rect.width * scale - 1,
    rect.height * scale - 1
  );
  ctx.restore();
}
