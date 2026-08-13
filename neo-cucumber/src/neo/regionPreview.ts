import type { RegionRect } from "./regionDrag";
import { isRegionTool, isTextTool, type ToolId } from "./tools";

/**
 * Whether a tool shows NEO's circle cursor.
 *
 * Only its drawing tools do. Region tools draw the rectangle being dragged
 * instead (EffectToolBase has its own drawCursor), and fill, text and our own
 * pan have no brush footprint to preview.
 */
export function hasBrushCursor(tool: ToolId): boolean {
  if (isRegionTool(tool) || isTextTool(tool)) return false;
  return tool !== "fill" && tool !== "pan" && tool !== "eraseAll";
}

/**
 * NEO's brush cursor: a circle the width of the brush, centred on the pointer.
 *
 * From DrawToolBase.drawCursor. A 1px brush is drawn as a 2px circle, because
 * a 1px circle is a dot indistinguishable from the pointer itself. The colour
 * is NEO's: blue for the eraser, so it reads as "removing", and pale yellow
 * for everything else.
 *
 * NEO XORs it over the artwork, which is what keeps it visible on any colour.
 * The overlay carries `mix-blend-mode: difference` for the same reason, so the
 * circle inverts what it crosses rather than vanishing into it.
 */
export function drawBrushCursor(
  ctx: CanvasRenderingContext2D,
  at: { x: number; y: number } | null,
  brushSize: number,
  tool: ToolId,
  scale = 1
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!at || !hasBrushCursor(tool)) return;

  // NEO: "1pxの時は2px相当の円カーソルを表示"
  const d = brushSize === 1 ? 2 : brushSize;
  const r = (d * 0.5) * scale;
  if (r <= 0) return;

  ctx.save();
  ctx.globalCompositeOperation = "difference";
  ctx.strokeStyle = tool === "eraser" ? "#0000ff" : "#ffff7f";
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Half-pixel offset so a 1px stroke lands on the grid instead of
  // straddling it and rendering as two grey lines
  ctx.arc(
    Math.floor(at.x * scale) + 0.5,
    Math.floor(at.y * scale) + 0.5,
    r,
    0,
    Math.PI * 2
  );
  ctx.stroke();
  ctx.restore();
}

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

/** The straight line being dragged out, drawn the same legible way. */
export function drawLinePreview(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number } | null,
  to: { x: number; y: number } | null,
  scale = 1
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!from || !to) return;

  ctx.save();
  ctx.globalCompositeOperation = "difference";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(from.x * scale + 0.5, from.y * scale + 0.5);
  ctx.lineTo(to.x * scale + 0.5, to.y * scale + 0.5);
  ctx.stroke();
  ctx.restore();
}

/** The bezier being built, drawn the same legible way as the other previews. */
export function drawBezierPreview(
  ctx: CanvasRenderingContext2D,
  points: number[] | null,
  scale = 1
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!points || points.length < 4) return;

  ctx.save();
  ctx.globalCompositeOperation = "difference";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const s = (v: number) => v * scale + 0.5;
  if (points.length === 4) {
    // Only the chord so far: its two endpoints
    ctx.moveTo(s(points[0]), s(points[1]));
    ctx.lineTo(s(points[2]), s(points[3]));
  } else {
    ctx.moveTo(s(points[0]), s(points[1]));
    ctx.bezierCurveTo(
      s(points[2]), s(points[3]),
      s(points[4]), s(points[5]),
      s(points[6]), s(points[7])
    );
  }
  ctx.stroke();
  ctx.restore();
}
