import { describe, expect, it } from "vitest";
import { PinchGesture } from "./pinchGesture";
import { nearestZoomIndex } from "../hooks/useZoomControls";

const at = (x: number, y: number) => ({ x, y });

describe("PinchGesture", () => {
  it("says nothing until a second finger lands", () => {
    const gesture = new PinchGesture();
    expect(gesture.down(1, at(0, 0))).toBe("none");
    expect(gesture.active).toBe(false);
    expect(gesture.move(1, at(50, 0))).toBeNull();

    expect(gesture.down(2, at(100, 0))).toBe("seeded");
    expect(gesture.active).toBe(true);
  });

  it("reports scale against the separation it was seeded with", () => {
    const gesture = new PinchGesture();
    gesture.down(1, at(0, 0));
    gesture.down(2, at(100, 0));

    expect(gesture.move(2, at(200, 0))?.scale).toBeCloseTo(2);
    // Measured from the seed rather than from the sample before it, so a
    // pinch out and back lands on the zoom it started from.
    expect(gesture.move(2, at(100, 0))?.scale).toBeCloseTo(1);
    expect(gesture.move(2, at(50, 0))?.scale).toBeCloseTo(0.5);
  });

  it("reports the midpoint and how far it has travelled", () => {
    const gesture = new PinchGesture();
    gesture.down(1, at(0, 0));
    gesture.down(2, at(100, 0));

    const sample = gesture.move(1, at(20, 40));
    expect(sample?.center).toEqual({ x: 60, y: 20 });
    expect(sample?.panX).toBe(10);
    expect(sample?.panY).toBe(20);
    // A second sample is relative to the first, not to the seed.
    expect(gesture.move(1, at(20, 60))?.panY).toBe(10);
  });

  it("holds still when both fingers move together", () => {
    const gesture = new PinchGesture();
    gesture.down(1, at(0, 0));
    gesture.down(2, at(100, 0));

    gesture.move(1, at(10, 0));
    const sample = gesture.move(2, at(110, 0));
    expect(sample?.scale).toBeCloseTo(1);
    expect(sample?.center).toEqual({ x: 60, y: 0 });
  });

  it("ignores a third finger while the first two are still down", () => {
    const gesture = new PinchGesture();
    gesture.down(1, at(0, 0));
    gesture.down(2, at(100, 0));
    expect(gesture.down(3, at(500, 500))).toBe("none");

    expect(gesture.move(3, at(900, 900))).toBeNull();
    expect(gesture.move(2, at(200, 0))?.scale).toBeCloseTo(2);
  });

  it("re-seeds on the survivors rather than jumping when one of the pair lifts", () => {
    const gesture = new PinchGesture();
    gesture.down(1, at(0, 0));
    gesture.down(2, at(100, 0));
    gesture.down(3, at(300, 0));

    // 1 and 3 are 300 apart where 1 and 2 were 100; a gesture that kept the
    // old origin would snap to 3x the instant the finger came off.
    expect(gesture.up(2)).toBe("seeded");
    expect(gesture.move(3, at(300, 0))?.scale).toBeCloseTo(1);
    expect(gesture.move(3, at(600, 0))?.scale).toBeCloseTo(2);
  });

  it("ends when only one finger is left, and counts the rest of the hand", () => {
    const gesture = new PinchGesture();
    gesture.down(1, at(0, 0));
    gesture.down(2, at(100, 0));

    expect(gesture.up(1)).toBe("ended");
    expect(gesture.active).toBe(false);
    // The survivor is still down: the caller keeps the painter suspended on
    // this count, so the tail of a pinch cannot become a stroke.
    expect(gesture.pointerCount).toBe(1);
    expect(gesture.up(2)).toBe("none");
    expect(gesture.pointerCount).toBe(0);
  });

  it("has no opinion about scale when both fingers land on one point", () => {
    const gesture = new PinchGesture();
    gesture.down(1, at(40, 40));
    gesture.down(2, at(40, 40));
    expect(gesture.move(2, at(40, 40))?.scale).toBe(1);
  });
});

describe("nearestZoomIndex", () => {
  const levels = [0.5, 1, 2, 4];

  it("picks the rung a scale actually sits on", () => {
    expect(nearestZoomIndex(levels, 1)).toBe(1);
    expect(nearestZoomIndex(levels, 4)).toBe(3);
  });

  it("splits the difference by ratio, not by distance", () => {
    // Halfway between 1 and 2 multiplicatively is sqrt(2), not 1.5: by
    // subtraction 1.4 would round down to 1 and make a pinch out lag a pinch
    // in by a whole step.
    expect(nearestZoomIndex(levels, 1.3)).toBe(1);
    expect(nearestZoomIndex(levels, 1.5)).toBe(2);
  });

  it("stays on the ladder past either end", () => {
    expect(nearestZoomIndex(levels, 0.01)).toBe(0);
    expect(nearestZoomIndex(levels, 100)).toBe(3);
  });
});
