import { describe, expect, it } from "vitest";
import { RegionDrag, clipToCanvas, regionRectFrom } from "./regionDrag";

const W = 48;
const H = 32;

const rect = (start: [number, number], end: [number, number]) =>
  regionRectFrom({ x: start[0], y: start[1] }, { x: end[0], y: end[1] }, W, H);

describe("clipToCanvas", () => {
  it("clamps to the far edge, not to the last pixel", () => {
    // The extra column is deliberate: NEO clamps to canvasWidth so a drag off
    // the right edge still covers the last pixel once the size is trimmed.
    expect(clipToCanvas({ x: 999, y: 999 }, W, H)).toEqual({ x: W, y: H });
    expect(clipToCanvas({ x: -20, y: -5 }, W, H)).toEqual({ x: 0, y: 0 });
    expect(clipToCanvas({ x: 10, y: 10 }, W, H)).toEqual({ x: 10, y: 10 });
  });
});

describe("regionRectFrom", () => {
  it("makes a press with no movement a single pixel", () => {
    // Not an empty rectangle: clicking with erase-rect erases one pixel.
    expect(rect([10, 12], [10, 12])).toEqual({ x: 10, y: 12, width: 1, height: 1 });
  });

  it("is inclusive of both endpoints", () => {
    expect(rect([4, 4], [7, 6])).toEqual({ x: 4, y: 4, width: 4, height: 3 });
  });

  it("normalises a drag in any direction", () => {
    const expected = { x: 4, y: 4, width: 4, height: 3 };
    expect(rect([7, 6], [4, 4])).toEqual(expected);
    expect(rect([4, 6], [7, 4])).toEqual(expected);
    expect(rect([7, 4], [4, 6])).toEqual(expected);
  });

  it("floors before deriving, so a sub-pixel drag still covers a pixel", () => {
    expect(rect([10.9, 12.9], [10.1, 12.1])).toEqual({
      x: 10,
      y: 12,
      width: 1,
      height: 1,
    });
  });

  it("trims the size to the canvas rather than the origin", () => {
    // Dragging past the right edge: clipToCanvas gives W, then the width is
    // pulled back so the rectangle ends on the last pixel.
    const r = rect([W - 3, 2], [W, 5]);
    expect(r).not.toBeNull();
    expect(r!.x + r!.width).toBe(W);
    expect(r!.y + r!.height).toBe(6);
  });

  it("covers the whole canvas for a corner-to-corner drag", () => {
    expect(rect([0, 0], [W, H])).toEqual({ x: 0, y: 0, width: W, height: H });
  });

  it("returns null when the rectangle collapses at the far edge", () => {
    // Both ends clamped onto the edge column, which holds no pixels
    expect(rect([W, 4], [W, 6])).toBeNull();
    expect(rect([4, H], [6, H])).toBeNull();
  });

  it("keeps upstream's asymmetry: the origin is clamped, the far edge is not pulled back", () => {
    // A drag from off-canvas. NEO moves x to 0 and leaves the width alone, so
    // the rectangle reaches one pixel further than the pointer did. Recorded
    // regions have to mean the same thing here as in a NEO replay.
    const r = regionRectFrom({ x: -4, y: 0 }, { x: 6, y: 3 }, W, H);
    expect(r).toEqual({ x: 0, y: 0, width: 11, height: 4 });
  });
});

describe("RegionDrag", () => {
  it("tracks a drag and commits the rectangle it previewed", () => {
    const drag = new RegionDrag(W, H);
    expect(drag.active).toBe(false);
    expect(drag.current()).toBeNull();

    drag.begin({ x: 5, y: 5 });
    expect(drag.active).toBe(true);
    expect(drag.current()).toEqual({ x: 5, y: 5, width: 1, height: 1 });

    drag.move({ x: 15, y: 11 });
    const previewed = drag.current();
    expect(previewed).toEqual({ x: 5, y: 5, width: 11, height: 7 });

    // The preview and the commit must be the same rectangle, or the shape you
    // dragged is not the shape you get.
    expect(drag.commit()).toEqual(previewed);
    expect(drag.active).toBe(false);
  });

  it("takes a final point on commit", () => {
    const drag = new RegionDrag(W, H);
    drag.begin({ x: 2, y: 2 });
    expect(drag.commit({ x: 4, y: 3 })).toEqual({
      x: 2,
      y: 2,
      width: 3,
      height: 2,
    });
  });

  it("ignores movement before a drag starts", () => {
    const drag = new RegionDrag(W, H);
    drag.move({ x: 10, y: 10 });
    expect(drag.current()).toBeNull();
    expect(drag.active).toBe(false);
  });

  it("clips pointer positions as they arrive", () => {
    const drag = new RegionDrag(W, H);
    drag.begin({ x: -50, y: -50 });
    drag.move({ x: 500, y: 500 });
    expect(drag.current()).toEqual({ x: 0, y: 0, width: W, height: H });
  });

  it("cancels without committing", () => {
    const drag = new RegionDrag(W, H);
    drag.begin({ x: 5, y: 5 });
    drag.move({ x: 20, y: 20 });
    drag.cancel();
    expect(drag.active).toBe(false);
    expect(drag.current()).toBeNull();
    expect(drag.commit()).toBeNull();
  });
});
