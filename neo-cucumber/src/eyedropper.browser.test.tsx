import { describe, expect, it } from "vitest";
import { DrawingEngine } from "./DrawingEngine";
import { loadNeo } from "./test/neoHarness";

/**
 * The eyedropper reads the screen, not the buffers.
 *
 * NEO's right press takes the colour under the pointer, composited over the
 * white the canvas sits on. Ours asks the mounted canvases the same question,
 * so whatever has been hidden -- a participant, or a whole tier -- is absent
 * from the answer for the same reason it is absent from the eye.
 */
describe("picking the colour under the pointer", () => {
  const mountPair = (engine: DrawingEngine, owner: string, z: number) => {
    const make = (zIndex: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      canvas.style.zIndex = String(zIndex);
      document.body.appendChild(canvas);
      return canvas;
    };
    const background = make(z);
    const foreground = make(z + 1);
    engine.attachDOMCanvases(background, foreground, owner);
    return { background, foreground };
  };

  // Cleared first, so each call sets the canvas to exactly this and not to
  // this composited over whatever it held before.
  const paint = (canvas: HTMLCanvasElement, style: string) => {
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 8, 8);
    ctx.fillStyle = style;
    ctx.fillRect(0, 0, 8, 8);
  };

  it("composites the visible stack over white, in stack order", () => {
    const engine = new DrawingEngine(8, 8);
    engine.setLocalOwner("1");
    const alice = mountPair(engine, "1", 10);
    const bob = mountPair(engine, "2", 20);

    // Nothing painted: the ground shows through.
    expect(engine.pickVisibleColor(4, 4)).toEqual({ r: 255, g: 255, b: 255 });

    paint(alice.background, "rgb(200, 100, 50)");
    expect(engine.pickVisibleColor(4, 4)).toEqual({ r: 200, g: 100, b: 50 });

    // Bob is above Alice, so his opaque paint is what you see.
    paint(bob.foreground, "rgb(10, 20, 30)");
    expect(engine.pickVisibleColor(4, 4)).toEqual({ r: 10, g: 20, b: 30 });

    // Hide Bob and Alice's colour is what is there again.
    bob.foreground.style.display = "none";
    expect(engine.pickVisibleColor(4, 4)).toEqual({ r: 200, g: 100, b: 50 });

    // Half-transparent paint mixes with what is under it.
    paint(bob.foreground, "rgba(0, 0, 0, 0.5)");
    bob.foreground.style.display = "";
    expect(engine.pickVisibleColor(4, 4)).toEqual({ r: 100, g: 50, b: 25 });
  });

  it("declines a point outside the drawing", () => {
    const engine = new DrawingEngine(8, 8);
    expect(engine.pickVisibleColor(-1, 4)).toBeNull();
    expect(engine.pickVisibleColor(4, 8)).toBeNull();
  });

  it("agrees with NEO's own pickColor", () => {
    // NEO's arithmetic reads as though it swaps red and blue -- the variable
    // it calls `r` holds the sampled blue -- and it does not: `getColorString`
    // renders the packed int high byte first, which puts red back. Asserting
    // against NEO itself rather than against a reading of it is the only way
    // that stays true, and a reading of it is exactly what got this wrong.
    const Neo = loadNeo();
    const painter = Object.create(Neo.Painter.prototype);
    painter.canvasWidth = 8;
    painter.canvasHeight = 8;
    painter.visible = [true, true];
    painter.current = 0;
    let theirs = "";
    painter.setColor = (c: number | string) => {
      theirs = typeof c === "string" ? c : painter.getColorString(c);
    };
    const layer = (fill: string | null) => {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      const ctx = canvas.getContext("2d")!;
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, 8, 8);
      }
      return ctx;
    };
    painter.canvasCtx = [layer("rgb(200, 100, 50)"), layer(null)];
    painter.pickColor(4, 4);

    const engine = new DrawingEngine(8, 8);
    engine.setLocalOwner("1");
    const alice = mountPair(engine, "1", 10);
    paint(alice.background, "rgb(200, 100, 50)");
    const ours = engine.pickVisibleColor(4, 4)!;
    const hex = (v: number) => v.toString(16).padStart(2, "0");

    expect(`#${hex(ours.r)}${hex(ours.g)}${hex(ours.b)}`).toBe(theirs);
  });
});
