/**
 * NEO's brush cursor, ported rather than approximated.
 *
 * DrawToolBase.drawCursor plots a circle with a Bresenham ellipse and XORs
 * each pixel against the composited artwork underneath. Three details of that
 * are load bearing, and all three were wrong when this was a `ctx.arc()`:
 *
 * - It is plotted pixel by pixel, so it is hard-edged. An anti-aliased arc
 *   reads as a soft grey ring next to NEO's crisp one.
 * - Its colours are raw uint32 in RGBA byte order, not HTML hex. NEO's
 *   `0xffff7f` is r=7f g=ff b=ff -- pale cyan, not yellow -- and the eraser's
 *   `0x0000ff` is red, not blue.
 * - It is a true XOR of the pixel underneath. `difference` compositing agrees
 *   with XOR wherever the backdrop is black or white, which is why it looked
 *   plausible, and diverges over everything in between.
 */
import { isRegionTool, isTextTool, type ToolId } from "./tools";
import { backdropAt, type Backdrop } from "./xorOverlay";

/**
 * The cursor colours, as NEO writes them: a uint32 XORed into a little-endian
 * RGBA buffer, so the low byte is red.
 */
const CURSOR_RGB = 0xffff7f;
const ERASER_CURSOR_RGB = 0x0000ff;

/** Splits one of NEO's constants into channels the way its buffer reads it. */
function channels(c: number): { r: number; g: number; b: number } {
  return { r: c & 0xff, g: (c >> 8) & 0xff, b: (c >> 16) & 0xff };
}

/** The composited artwork the cursor inverts against. */
export type { Backdrop } from "./xorOverlay";

/**
 * Whether a tool shows the circle.
 *
 * Only NEO's drawing tools do. Region tools draw the rectangle being dragged
 * instead (EffectToolBase has its own drawCursor), and fill, text and our own
 * pan have no brush footprint to preview.
 */
export function hasBrushCursor(tool: ToolId): boolean {
  if (isRegionTool(tool) || isTextTool(tool)) return false;
  return tool !== "fill" && tool !== "pan" && tool !== "eraseAll";
}

/**
 * Neo.Painter.drawXOREllipse with isFill false, transcribed.
 *
 * Plots the four mirrored points of each step and calls back with every pixel
 * it touches. The arithmetic is NEO's, including `b1` being reused as a step
 * increment partway through.
 */
function plotEllipse(
  left: number,
  top: number,
  width: number,
  height: number,
  plot: (x: number, y: number) => void
): void {
  if (width === 0 || height === 0) return;

  let a = width - 1;
  const b = height - 1;
  let b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  let e2;

  let x0 = left;
  let y0 = top;
  let x1 = x0 + a;
  let y1 = y0 + b;

  if (x0 > x1) {
    x0 = x1;
    x1 += a;
  }
  if (y0 > y1) y0 = y1;
  y0 += Math.floor((b + 1) / 2);
  y1 = y0 - b1;
  a *= 8 * a;
  b1 = 8 * b * b;

  do {
    plot(x1, y0);
    if (x0 !== x1) plot(x0, y0);
    if (y0 !== y1) {
      plot(x0, y1);
      if (x0 !== x1) plot(x1, y1);
    }
    e2 = 2 * err;
    if (e2 <= dy) {
      y0++;
      y1--;
      err += dy += a;
    }
    if (e2 >= dx || 2 * err > dy) {
      x0++;
      x1--;
      err += dx += b1;
    }
  } while (x0 <= x1);
}

/**
 * Paints the cursor onto its own overlay.
 *
 * The overlay is opaque where the circle is and clear everywhere else: the
 * XOR is computed here against `backdrop` rather than left to a CSS blend
 * mode, so the result is NEO's pixels and not something that resembles them.
 */
export function drawBrushCursor(
  ctx: CanvasRenderingContext2D,
  at: { x: number; y: number } | null,
  brushSize: number,
  tool: ToolId,
  backdrop: Backdrop | null
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  if (!at || !backdrop || !hasBrushCursor(tool)) return;

  // NEO: "1pxの時は2px相当の円カーソルを表示"
  const scale = backdrop.scale ?? 1;
  const d = (brushSize === 1 ? 2 : brushSize) * scale;
  const r = d * 0.5;
  const left = Math.round(at.x * scale - r);
  const top = Math.round(at.y * scale - r);
  const size = Math.round(d);
  if (size <= 0) return;

  const c = channels(tool === "eraser" ? ERASER_CURSOR_RGB : CURSOR_RGB);

  // One ImageData over the circle's bounding box, as NEO reads one over its
  // own. Clipped to the canvas so an edge-of-canvas cursor cannot wrap.
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(width, left + size);
  const y1 = Math.min(height, top + size);
  if (x1 <= x0 || y1 <= y0) return;

  const image = ctx.createImageData(x1 - x0, y1 - y0);
  const data = image.data;

  plotEllipse(left, top, size, size, (px, py) => {
    if (px < x0 || py < y0 || px >= x1 || py >= y1) return;
    if (px >= backdrop.width * scale || py >= backdrop.height * scale) return;

    const under = backdropAt(backdrop, px, py);
    const i = ((py - y0) * (x1 - x0) + (px - x0)) * 4;
    data[i] = under.r ^ c.r;
    data[i + 1] = under.g ^ c.g;
    data[i + 2] = under.b ^ c.b;
    data[i + 3] = 255;
  });

  ctx.putImageData(image, x0, y0);
}
