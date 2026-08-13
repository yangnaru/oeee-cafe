import { describe, expect, it } from "vitest";
import { createCanonicalPainter } from "../test/neoHarness";
import {
  drawBezierPreview,
  drawLinePreview,
  drawRegionPreview,
  type Backdrop,
} from "./regionPreview";
import type { ToolId } from "./tools";

const W = 72;
const H = 56;

function context(): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  return ctx;
}

function artwork(): CanvasRenderingContext2D {
  const ctx = context();
  ctx.fillStyle = "rgb(187,93,41)";
  ctx.fillRect(0, 0, W / 2, H);
  ctx.fillStyle = "rgb(31,142,203)";
  ctx.fillRect(W / 2, 0, W / 2, H);
  return ctx;
}

function backdrop(ctx: CanvasRenderingContext2D): Backdrop {
  return {
    width: W,
    height: H,
    layers: [new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data)],
  };
}

function ours(
  draw: (ctx: CanvasRenderingContext2D, back: Backdrop) => void
): Uint8ClampedArray {
  const art = artwork();
  const overlay = context();
  draw(overlay, backdrop(art));
  art.drawImage(overlay.canvas, 0, 0);
  return new Uint8ClampedArray(art.getImageData(0, 0, W, H).data);
}

function canonical(
  draw: (painter: ReturnType<typeof createCanonicalPainter>["painter"], ctx: CanvasRenderingContext2D) => void
): Uint8ClampedArray {
  const cp = createCanonicalPainter(W, H);
  const ctx = artwork();
  draw(cp.painter, ctx);
  return new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data);
}

function expectPixels(actual: Uint8ClampedArray, expected: Uint8ClampedArray) {
  expect(actual).toEqual(expected);
}

describe("interactive previews against canonical NEO", () => {
  it("draws the straight-line cursor exactly", () => {
    const from = { x: 3, y: 46 };
    const to = { x: 68, y: 4 };
    expectPixels(
      ours((ctx, back) => drawLinePreview(ctx, from, to, back)),
      canonical((p, ctx) => p.drawXORLine(ctx, from.x, from.y, to.x, to.y))
    );
  });

  it("draws every region cursor exactly", () => {
    const rect = { x: 7, y: 5, width: 51, height: 39 };
    const cases: Array<[ToolId, boolean, boolean]> = [
      ["rect", false, false],
      ["rectFill", false, true],
      ["ellipse", true, false],
      ["ellipseFill", true, true],
    ];

    for (const [tool, ellipse, fill] of cases) {
      const actual = ours((ctx, back) =>
        drawRegionPreview(ctx, rect, back, tool)
      );
      const expected = canonical((p, ctx) => {
        const method = ellipse ? p.drawXOREllipse : p.drawXORRect;
        method.call(p, ctx, rect.x, rect.y, rect.width, rect.height, fill);
      });
      expect(actual, tool).toEqual(expected);
    }
  });

  const points = [8, 38, 18, 4, 55, 50, 65, 15];
  const style = { color: [73, 19, 211, 96] as [number, number, number, number], width: 7 };

  function canonicalBezier(step: 1 | 2): Uint8ClampedArray {
    return canonical((p, ctx) => {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = points;
      p._currentColor = [...style.color];
      p._currentWidth = style.width;
      if (step === 1) {
        p.drawXORLine(ctx, x0, y0, x1, y1);
        p.drawXOREllipse(ctx, x1 - 4, y1 - 4, 8, 8);
        p.drawXOREllipse(ctx, x0 - 4, y0 - 4, 8, 8);
        p.drawBezier(ctx, x0, y0, x1, y1, x1, y1, x3, y3, 1, false, true);
      } else {
        p.drawXORLine(ctx, x3, y3, x2, y2);
        p.drawXOREllipse(ctx, x2 - 4, y2 - 4, 8, 8);
        p.drawXORLine(ctx, x0, y0, x1, y1);
        p.drawXOREllipse(ctx, x1 - 4, y1 - 4, 8, 8);
        p.drawXOREllipse(ctx, x0 - 4, y0 - 4, 8, 8);
        p.drawBezier(ctx, x0, y0, x1, y1, x2, y2, x3, y3, 1, false, true);
      }
    });
  }

  it("draws the first bezier-handle phase exactly", () => {
    expectPixels(
      ours((ctx, back) => drawBezierPreview(ctx, points, back, 1, style)),
      canonicalBezier(1)
    );
  });

  it("draws the second bezier-handle phase exactly", () => {
    expectPixels(
      ours((ctx, back) => drawBezierPreview(ctx, points, back, 2, style)),
      canonicalBezier(2)
    );
  });
});
