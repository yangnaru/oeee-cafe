/**
 * The previews NEO draws while a shape is being dragged out, XORed over the
 * artwork exactly as it draws them.
 *
 * These used to be dashed white strokes with `globalCompositeOperation =
 * "difference"` on a transparent overlay -- which composites only within that
 * canvas, so they were plain white lines that vanished on white. Three things
 * were wrong beyond the colour: NEO's previews are solid, its region preview
 * is an *ellipse* for the ellipse tools and *filled* for the fill variants,
 * and its bezier preview carries handles.
 */
import type { RegionRect } from "./regionDrag";
import { XorOverlay, type Backdrop } from "./xorOverlay";
import type { ToolId } from "./tools";
import { LINETYPE, NeoPainter } from "./NeoPainter";

export type { Backdrop } from "./xorOverlay";

/** NEO's EffectTool shapes: which are round, and which are filled. */
const ELLIPSE_TOOLS = new Set<string>(["ellipse", "ellipseFill"]);
const FILLED_TOOLS = new Set<string>(["ellipseFill", "rectFill"]);

function clear(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/**
 * The rubber band a region tool is being dragged out over.
 *
 * EffectToolBase.drawCursor picks the shape from the tool and passes its
 * `isFill` straight through, so the preview shows what the tool will actually
 * lay down rather than always outlining a rectangle.
 */
export function drawRegionPreview(
  ctx: CanvasRenderingContext2D,
  rect: RegionRect | null,
  backdrop: Backdrop | null,
  tool?: ToolId
): void {
  clear(ctx);
  if (!rect || !backdrop || rect.width <= 0 || rect.height <= 0) return;

  const overlay = new XorOverlay(ctx, backdrop);
  const scale = backdrop.scale ?? 1;
  const fill = tool !== undefined && FILLED_TOOLS.has(tool);
  if (tool !== undefined && ELLIPSE_TOOLS.has(tool)) {
    overlay.ellipse(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale, fill);
  } else {
    overlay.rect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale, fill);
  }
  overlay.commit();
}

/** The straight line being dragged out: DrawToolBase.drawLineCursor. */
export function drawLinePreview(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number } | null,
  to: { x: number; y: number } | null,
  backdrop: Backdrop | null
): void {
  clear(ctx);
  if (!from || !to || !backdrop) return;

  const overlay = new XorOverlay(ctx, backdrop);
  const scale = backdrop.scale ?? 1;
  overlay.line(from.x * scale, from.y * scale, to.x * scale, to.y * scale);
  overlay.commit();
}

/** The radius of the grab handles NEO draws on a bezier, from its 8x8 box. */
const HANDLE = 4;

export interface BezierPreviewStyle {
  color: [number, number, number, number];
  width: number;
}

/**
 * The bezier being built.
 *
 * NEO shows the curve *and* its handles: drawBezierCursor1 draws a line from
 * the start to the pointer with a ring at each end, and drawBezierCursor2 adds
 * the second handle from the end point. The rings are how you see which
 * control point you are dragging, and they were missing entirely.
 */
export function drawBezierPreview(
  ctx: CanvasRenderingContext2D,
  points: number[] | null,
  backdrop: Backdrop | null,
  step = 0,
  style: BezierPreviewStyle = { color: [0, 0, 0, 255], width: 1 }
): void {
  clear(ctx);
  if (!points || points.length < 4 || !backdrop) return;

  const overlay = new XorOverlay(ctx, backdrop);
  const scale = backdrop.scale ?? 1;
  points = points.map((point) => point * scale);
  const ring = (x: number, y: number) =>
    overlay.ellipse(x - HANDLE, y - HANDLE, HANDLE * 2, HANDLE * 2);

  if (points.length === 4) {
    // Still setting the chord: NEO draws the plain line cursor for this step.
    overlay.line(points[0], points[1], points[2], points[3]);
    overlay.commit();
  } else {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = points;

    if (step <= 1) {
      // drawBezierCursor1: only the first handle is being placed.
      overlay.line(x0, y0, x1, y1);
      ring(x1, y1);
      ring(x0, y0);
    } else {
      // drawBezierCursor2: the first handle is fixed and the second is live.
      overlay.line(x3, y3, x2, y2);
      ring(x2, y2);
      overlay.line(x0, y0, x1, y1);
      ring(x1, y1);
      ring(x0, y0);
    }
    overlay.commit();

    // Neo draws the handles into its destination first, then draws the curve
    // from tempCanvas over them. Use the verified rasterizer for that curve;
    // preview mode deliberately forces full alpha and disables masking.
    const painter = new NeoPainter(ctx.canvas.width, ctx.canvas.height);
    painter._currentColor = [...style.color];
    painter._currentWidth = style.width * scale;
    painter.drawBezier(
      ctx, x0, y0, x1, y1,
      step <= 1 ? x1 : x2, step <= 1 ? y1 : y2,
      x3, y3, LINETYPE.PEN, true
    );
  }
}
