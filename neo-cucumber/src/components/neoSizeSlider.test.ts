import { describe, expect, it } from "vitest";

/**
 * NEO's SizeSlider arithmetic, kept here so a change to the component has to
 * disagree with the reference in the open rather than quietly.
 *
 * From widgets.js: the bar's height is the value scaled onto 33px, and a drag
 * inside the box reads the value straight back off the pointer's height.
 */
const MAX = 30;
const BAR = 33;
const OFFSET = 4;

const heightFor = (value: number) =>
  Math.max(Math.min(34, (value * BAR) / MAX), 1);

const valueAt = (y: number) => Math.floor(((y - OFFSET) * MAX) / BAR);

describe("NEO's size slider arithmetic", () => {
  it("scales the bar onto 33 pixels, clamped as NEO clamps it", () => {
    expect(heightFor(30)).toBeCloseTo(33, 5);
    expect(heightFor(1)).toBeCloseTo(1.1, 5);
    // NEO's floor is 1px, so the smallest brush still shows a bar
    expect(heightFor(0)).toBe(1);
    // and its ceiling is 34, one past a full bar
    expect(heightFor(100)).toBe(34);
  });

  it("reads the value back off the pointer, inverting the bar height", () => {
    // The 4px offset is why the top of the bar is size 0 rather than the top
    // of the hit area
    expect(valueAt(OFFSET)).toBe(0);
    expect(valueAt(OFFSET + BAR)).toBe(30);
    // Round-trips within a step across the range
    for (let v = 1; v <= MAX; v++) {
      const y = OFFSET + heightFor(v);
      expect(Math.abs(valueAt(y) - v)).toBeLessThanOrEqual(1);
    }
  });

  it("moves a step per seven pixels once the drag leaves the box", () => {
    // NEO: value = value0 + (y - y0) / 7
    const relative = (value0: number, dy: number) => value0 + dy / 7.0;
    expect(relative(10, 7)).toBe(11);
    expect(relative(10, -7)).toBe(9);
    // Slower than dragging inside, which is the point of it
    expect(Math.abs(relative(10, 33) - 10)).toBeLessThan(MAX);
  });
});
