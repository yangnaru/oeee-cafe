import { describe, expect, it } from "vitest";
import {
  DEFAULT_SMOOTHING,
  MAX_SMOOTHING,
  StrokeSmoother,
  strokeSmootherSizeFor,
} from "./strokeSmoother";

const near = (value: number, expected: number, tolerance = 1e-9) =>
  expect(Math.abs(value - expected)).toBeLessThanOrEqual(tolerance);

describe("the stroke smoother", () => {
  /**
   * Drawpile pads the window with the first sample rather than starting from
   * an empty average, so the line begins exactly under the pen. Starting from
   * zero would fling the first segment out of the corner of the canvas.
   */
  it("starts exactly at the first sample", () => {
    const smoother = new StrokeSmoother(4);
    expect(smoother.push(10, 20)).toEqual({ x: 10, y: 20 });
  });

  it("blends away from the start as real samples arrive", () => {
    const smoother = new StrokeSmoother(4);
    smoother.push(0, 0);
    // Window fills with 10s a slot at a time: 2.5, 5, 7.5, 10 -- rounded,
    // because a canvas coordinate is a whole pixel.
    expect(smoother.push(10, 0).x).toBe(3);
    expect(smoother.push(10, 0).x).toBe(5);
    expect(smoother.push(10, 0).x).toBe(8);
    expect(smoother.push(10, 0).x).toBe(10);
  });

  /**
   * NEO's Bresenham walk steps by exactly one pixel and stops on `x0 === x1`.
   * Hand it a fractional endpoint and it never stops -- it took the browser
   * down with it. The recorder rounds what it writes into a frame too, so a
   * fractional point here would also draw one line and replay another.
   */
  it("only ever emits whole pixels", () => {
    const smoother = new StrokeSmoother(3);
    const seen = [smoother.push(0.4, 0.6)];
    for (const [x, y] of [
      [1.5, 2.25],
      [4.75, 9.125],
      [7.3, 11.9],
      [12.05, 13.4],
    ]) {
      seen.push(smoother.push(x, y));
    }
    seen.push(...smoother.drain());
    for (const point of seen) {
      expect(Number.isInteger(point.x)).toBe(true);
      expect(Number.isInteger(point.y)).toBe(true);
    }

    // Including when it is switched off and simply passing samples through.
    const off = new StrokeSmoother(0);
    expect(off.push(3.7, 4.2)).toEqual({ x: 4, y: 4 });
  });

  it("averages a moving pointer over its window", () => {
    const smoother = new StrokeSmoother(3);
    smoother.push(0, 0);
    smoother.push(3, 0);
    smoother.push(6, 0);
    // Window holds 6, 3, 0.
    expect(smoother.push(9, 0).x).toBe(6);
  });

  /**
   * The average trails the pen by half the window. Draining walks it the rest
   * of the way, so a stroke ends where the pen was lifted instead of short of
   * it -- which would clip the end off every stroke by a few pixels.
   */
  it("catches up to the last real sample when drained", () => {
    const smoother = new StrokeSmoother(4);
    for (const x of [0, 10, 20, 30, 40]) smoother.push(x, 0);
    const tail = smoother.drain();
    expect(tail.length).toBeGreaterThan(0);
    near(tail[tail.length - 1].x, 40);
  });

  it("drains monotonically towards the end of the stroke", () => {
    const smoother = new StrokeSmoother(5);
    for (let x = 0; x <= 100; x += 10) smoother.push(x, 0);
    const tail = smoother.drain();
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i].x).toBeGreaterThanOrEqual(tail[i - 1].x);
    }
    near(tail[tail.length - 1].x, 100);
  });

  it("has nothing to drain after a single tap", () => {
    const smoother = new StrokeSmoother(4);
    smoother.push(7, 7);
    expect(smoother.drain()).toEqual([]);
  });

  it("smooths a jittery line towards its true path", () => {
    const smoother = new StrokeSmoother(5);
    let worstSmoothed = 0;
    let worstRaw = 0;
    for (let i = 0; i < 60; i++) {
      // A straight horizontal line with a one-pixel tremor on it.
      const jitter = i % 2 === 0 ? 1 : -1;
      const point = smoother.push(i, jitter);
      worstRaw = Math.max(worstRaw, Math.abs(jitter));
      if (i > 10) worstSmoothed = Math.max(worstSmoothed, Math.abs(point.y));
    }
    expect(worstSmoothed).toBeLessThan(worstRaw);
  });

  it("passes samples through untouched when disabled", () => {
    const smoother = new StrokeSmoother(0);
    expect(smoother.disabled).toBe(true);
    expect(smoother.push(3, 4)).toEqual({ x: 3, y: 4 });
    expect(smoother.drain()).toEqual([]);
  });

  it("forgets the previous stroke on reset", () => {
    const smoother = new StrokeSmoother(4);
    for (const x of [0, 10, 20, 30]) smoother.push(x, 0);
    smoother.reset();
    expect(smoother.push(100, 100)).toEqual({ x: 100, y: 100 });
  });

  it("clamps the window to what Drawpile allows", () => {
    expect(new StrokeSmoother(-5).disabled).toBe(true);
    const huge = new StrokeSmoother(1000);
    huge.push(0, 0);
    // Would throw or read undefined slots if the size were not clamped.
    expect(huge.push(10, 0).x).toBeGreaterThan(0);
    expect(MAX_SMOOTHING).toBeGreaterThan(DEFAULT_SMOOTHING);
  });

  /** Touch digitisers already smooth; averaging again only adds lag. */
  it("leaves touch input alone and smooths pen and mouse", () => {
    expect(strokeSmootherSizeFor("touch")).toBe(0);
    expect(strokeSmootherSizeFor("pen")).toBe(DEFAULT_SMOOTHING);
    expect(strokeSmootherSizeFor("mouse")).toBe(DEFAULT_SMOOTHING);
  });
});
