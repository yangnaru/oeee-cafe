import { describe, expect, it } from "vitest";
import { clipToCanvas, regionRectFrom, type RegionRect } from "./regionDrag";
import { loadNeo } from "../test/neoHarness";

const W = 48;
const H = 32;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * Runs canonical NEO's EffectToolBase.upHandler and reports the rectangle it
 * hands to doEffect, or null when it declines to run.
 *
 * The handler only reads canvas dimensions and calls a few no-op hooks before
 * deriving the rectangle, so a stub painter is enough to exercise the real
 * arithmetic.
 */
function neoRegionRect(
  start: { x: number; y: number },
  end: { x: number; y: number }
): RegionRect | null {
  const Neo = loadNeo();
  const tool: Any = Object.create(Neo.EffectToolBase.prototype);

  let captured: RegionRect | null = null;
  tool.isUpMove = false;
  tool.startX = start.x;
  tool.startY = start.y;
  tool.endX = end.x;
  tool.endY = end.y;
  tool.doEffect = (_oe: Any, x: number, y: number, width: number, height: number) => {
    captured = { x, y, width, height };
  };

  const oe: Any = {
    canvasWidth: W,
    canvasHeight: H,
    canvasCtx: [null, null],
    current: 0,
    tool: { type: -1 },
    _pushUndo: () => {},
    prepareDrawing: () => {},
    updateDestCanvas: () => {},
  };

  tool.upHandler(oe);
  return captured;
}

describe("region drag geometry vs canonical NEO", () => {
  it("agrees on every drag across the canvas and past its edges", () => {
    const coords = [-7, -1, 0, 1, 5, 23, 31, 32, 47, 48, 60];
    let compared = 0;

    for (const sx of coords) {
      for (const sy of coords) {
        for (const ex of coords) {
          for (const ey of coords) {
            // NEO clips pointer positions on the way in, so feed both the
            // same clipped points its tools would have seen.
            const start = clipToCanvas({ x: sx, y: sy }, W, H);
            const end = clipToCanvas({ x: ex, y: ey }, W, H);

            const ours = regionRectFrom(start, end, W, H);
            const theirs = neoRegionRect(start, end);

            expect(
              ours,
              `drag (${sx}, ${sy}) -> (${ex}, ${ey}) clipped to ` +
                `(${start.x}, ${start.y}) -> (${end.x}, ${end.y})`
            ).toEqual(theirs);
            compared++;
          }
        }
      }
    }

    expect(compared).toBe(coords.length ** 4);
  });

  it("agrees on sub-pixel positions", () => {
    for (const start of [
      { x: 10.9, y: 12.9 },
      { x: 0.4, y: 0.6 },
      { x: 30.5, y: 15.25 },
    ]) {
      for (const end of [
        { x: 10.1, y: 12.1 },
        { x: 47.99, y: 31.99 },
        { x: 5.5, y: 5.5 },
      ]) {
        expect(
          regionRectFrom(start, end, W, H),
          `(${start.x}, ${start.y}) -> (${end.x}, ${end.y})`
        ).toEqual(neoRegionRect(start, end));
      }
    }
  });
});
