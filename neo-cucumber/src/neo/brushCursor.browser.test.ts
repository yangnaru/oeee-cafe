import { describe, expect, it } from "vitest";
import { loadNeo } from "../test/neoHarness";
import { drawBrushCursor, type Backdrop } from "./brushCursor";

/**
 * The cursor is a transcription of Neo.Painter.drawXOREllipse, so it is
 * checked against that function rather than against a description of it: NEO
 * itself plots into one canvas, we plot into another, and the two must agree
 * pixel for pixel.
 *
 * Eyeballing this is what let an anti-aliased arc in HTML-hex colours pass for
 * NEO's hard cyan ring for a while.
 */

const W = 64;
const H = 64;

function canvas(): CanvasRenderingContext2D {
  const el = document.createElement("canvas");
  el.width = W;
  el.height = H;
  const ctx = el.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  return ctx;
}

/** NEO's own cursor, drawn over a backdrop of the given colour. */
function neoCursor(
  at: { x: number; y: number },
  diameter: number,
  colour: number,
  backdrop: string
): Uint8ClampedArray {
  const Neo = loadNeo();
  const ctx = canvas();
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, W, H);

  // drawXOREllipse only reaches for xorPixel when it is not filling
  const painter = {
    xorPixel: Neo.Painter.prototype.xorPixel,
    xorRect: Neo.Painter.prototype.xorRect,
  };
  const r = diameter * 0.5;
  Neo.Painter.prototype.drawXOREllipse.call(
    painter,
    ctx,
    at.x - r,
    at.y - r,
    r * 2,
    r * 2,
    false,
    colour
  );
  return ctx.getImageData(0, 0, W, H).data;
}

/** Ours, over the same backdrop expressed as a flat opaque layer. */
function ourCursor(
  at: { x: number; y: number },
  brushSize: number,
  tool: "solid" | "eraser",
  backdrop: [number, number, number]
): Uint8ClampedArray {
  const ctx = canvas();
  const layer = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < layer.length; i += 4) {
    layer[i] = backdrop[0];
    layer[i + 1] = backdrop[1];
    layer[i + 2] = backdrop[2];
    layer[i + 3] = 255;
  }
  const back: Backdrop = { width: W, height: H, layers: [layer] };

  // The cursor owns its overlay and clears it, exactly as in the app, so the
  // backdrop goes underneath rather than into the same canvas.
  const overlay = canvas();
  drawBrushCursor(overlay, at, brushSize, tool, back);

  ctx.fillStyle = `rgb(${backdrop[0]},${backdrop[1]},${backdrop[2]})`;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(overlay.canvas, 0, 0);
  return ctx.getImageData(0, 0, W, H).data;
}

function differingPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
      out.push(i / 4);
    }
  }
  return out;
}

describe("the brush cursor against NEO's own", () => {
  const at = { x: 32, y: 32 };

  // Every size the slider can reach, plus 1 which NEO draws as 2
  const sizes = [1, 2, 3, 4, 5, 7, 8, 11, 15, 19, 24, 30];

  it("plots the same pixels as drawXOREllipse over white", () => {
    for (const size of sizes) {
      const d = size === 1 ? 2 : size;
      const mine = ourCursor(at, size, "solid", [255, 255, 255]);
      const theirs = neoCursor(at, d, 0xffff7f, "#ffffff");
      expect(
        differingPixels(theirs, mine),
        `size ${size} over white`
      ).toEqual([]);
    }
  });

  it("plots the same pixels over black", () => {
    for (const size of sizes) {
      const d = size === 1 ? 2 : size;
      const mine = ourCursor(at, size, "solid", [0, 0, 0]);
      const theirs = neoCursor(at, d, 0xffff7f, "#000000");
      expect(
        differingPixels(theirs, mine),
        `size ${size} over black`
      ).toEqual([]);
    }
  });

  /**
   * The case a `difference` blend got wrong. XOR and |a - b| agree at the
   * extremes and part company in between, so a mid-grey backdrop is where an
   * approximation shows up.
   */
  it("plots the same pixels over a mid-tone, where XOR is not difference", () => {
    for (const size of [7, 19]) {
      const mine = ourCursor(at, size, "solid", [200, 100, 60]);
      const theirs = neoCursor(at, size, 0xffff7f, "rgb(200,100,60)");
      expect(
        differingPixels(theirs, mine),
        `size ${size} over a mid-tone`
      ).toEqual([]);
    }
  });

  it("uses NEO's eraser colour, which is red rather than blue", () => {
    const mine = ourCursor(at, 19, "eraser", [255, 255, 255]);
    const theirs = neoCursor(at, 19, 0x0000ff, "#ffffff");
    expect(differingPixels(theirs, mine)).toEqual([]);

    // Guard the byte order directly: over white the eraser ring is cyan,
    // because 0x0000ff is r=ff in NEO's buffer and white XOR red is cyan.
    const ring = mine.slice(0);
    let sawCyan = false;
    for (let i = 0; i < ring.length; i += 4) {
      if (ring[i] === 0 && ring[i + 1] === 255 && ring[i + 2] === 255) {
        sawCyan = true;
        break;
      }
    }
    expect(sawCyan).toBe(true);
  });

  it("draws a 1px brush as NEO's 2px circle", () => {
    const one = ourCursor(at, 1, "solid", [255, 255, 255]);
    const two = ourCursor(at, 2, "solid", [255, 255, 255]);
    expect(differingPixels(one, two)).toEqual([]);
  });
});

/**
 * The overlay is cleared where the cursor was, not everywhere.
 *
 * Clearing the whole canvas was three million pixels on a large canvas at 2x,
 * on every pointer move, to move a ring of a few hundred -- so the clear now
 * covers only where the ring actually was. That is only correct if it really
 * covers it: a clear that missed would leave a trail of rings behind the pen,
 * and a stroke would end up drawing over its own cursor.
 */
describe("the brush cursor overlay", () => {
  const blank = (data: Uint8ClampedArray, at: { x: number; y: number }) => {
    const i = (at.y * W + at.x) * 4;
    return data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 0;
  };
  const painted = (data: Uint8ClampedArray) => {
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) count++;
    return count;
  };
  const flatBackdrop = (): Backdrop => {
    const layer = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < layer.length; i += 4) {
      layer[i] = 255;
      layer[i + 1] = 255;
      layer[i + 2] = 255;
      layer[i + 3] = 255;
    }
    return { width: W, height: H, layers: [layer] };
  };

  it("leaves nothing behind when the cursor moves away", () => {
    const overlay = canvas();
    const back = flatBackdrop();

    drawBrushCursor(overlay, { x: 16, y: 16 }, 8, "solid", back);
    const afterFirst = painted(overlay.getImageData(0, 0, W, H).data);
    expect(afterFirst).toBeGreaterThan(0);

    drawBrushCursor(overlay, { x: 48, y: 48 }, 8, "solid", back);
    const data = overlay.getImageData(0, 0, W, H).data;

    // The old ring is gone entirely...
    for (let y = 8; y < 25; y++) {
      for (let x = 8; x < 25; x++) {
        expect(blank(data, { x, y }), `stale pixel at ${x},${y}`).toBe(true);
      }
    }
    // ...and exactly one ring is on the overlay, the new one.
    expect(painted(data)).toBe(afterFirst);
  });

  it("clears the last cursor when the pointer leaves the canvas", () => {
    const overlay = canvas();
    const back = flatBackdrop();

    drawBrushCursor(overlay, { x: 32, y: 32 }, 8, "solid", back);
    expect(painted(overlay.getImageData(0, 0, W, H).data)).toBeGreaterThan(0);

    drawBrushCursor(overlay, null, 8, "solid", back);
    expect(painted(overlay.getImageData(0, 0, W, H).data)).toBe(0);
  });

  it("clears the last cursor when the tool stops having one", () => {
    const overlay = canvas();
    const back = flatBackdrop();

    drawBrushCursor(overlay, { x: 32, y: 32 }, 8, "solid", back);
    expect(painted(overlay.getImageData(0, 0, W, H).data)).toBeGreaterThan(0);

    // Fill has no brush footprint, so its cursor is nothing at all.
    drawBrushCursor(overlay, { x: 32, y: 32 }, 8, "fill", back);
    expect(painted(overlay.getImageData(0, 0, W, H).data)).toBe(0);
  });
});
