import { describe, expect, it } from "vitest";
import { DrawingEngine } from "./DrawingEngine";

/**
 * A line has to end.
 *
 * NEO's Bresenham steps by one from one endpoint towards the other and stops
 * when it arrives exactly: `x0 === x1 && y0 === y1`. Hand it an endpoint with a
 * fraction and it steps past without ever arriving, so the loop runs until the
 * tab is killed -- which is what happens if any caller ever forgets to round.
 * Every caller does round today; this is what keeps that from being a fact
 * nobody is checking.
 */
describe("drawLine endpoints", () => {
  it("terminates on fractional coordinates", () => {
    const engine = new DrawingEngine(64, 48);
    const pair = engine.layersFor("1");
    const started = performance.now();
    engine.drawLine(pair.foreground, 4.3, 5.7, 40.1, 30.9, 3, "solid", 255, 0, 0, 255);
    // Generous: the point is that it finishes at all, not how fast.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("draws a fractional line where the rounded one goes", () => {
    const rounded = new DrawingEngine(64, 48);
    const fractional = new DrawingEngine(64, 48);
    rounded.drawLine(rounded.layersFor("1").foreground, 4, 6, 40, 31, 3, "solid", 255, 0, 0, 255);
    fractional.drawLine(
      fractional.layersFor("1").foreground, 4.3, 5.7, 40.1, 30.9, 3, "solid", 255, 0, 0, 255,
    );
    expect([...fractional.layersFor("1").foreground])
      .toEqual([...rounded.layersFor("1").foreground]);
  });
});
