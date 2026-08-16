import { describe, expect, it } from "vitest";
import { act } from "react";
import { DrawingEngine } from "./DrawingEngine";
import { mount } from "./public";
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

  it("picks on a right press, on ctrl-click, and leaves no browser menu behind", async () => {
    // Ctrl-click is how a right press is made on a Mac, and the browser
    // answers it with its own menu. NEO turns that menu off across its whole
    // container; without doing the same the colour is picked and then buried
    // under something nobody asked for, which is indistinguishable from the
    // picker not working.
    const element = document.createElement("div");
    document.body.appendChild(element);
    let painter!: ReturnType<typeof mount>;
    act(() => {
      painter = mount(element, {
        width: 64, height: 48,
        mode: { kind: "standard" },
        controls: { kind: "toolbox" },
        synchronization: { actorId: "1", onOperation: () => {} },
      });
    });
    await act(async () => painter.ready);
    act(() => painter.setLocalActorId("1"));

    await act(async () => {
      await painter.applyCanonicalOperation({
        id: "x:1", actorId: "1", sequence: 1, operation: { kind: "undo-boundary" },
      });
      await painter.applyCanonicalOperation({
        id: "x:2", actorId: "1", sequence: 2,
        operation: {
          kind: "fill", layer: "background", at: { x: 32, y: 24 },
          color: { r: 200, g: 100, b: 50, a: 255 },
          mask: { type: 0, r: 0, g: 0, b: 0 },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    const canvas = element.querySelector("#canvas") as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    const press = async (init: PointerEventInit) => {
      await act(async () => {
        canvas.dispatchEvent(
          new PointerEvent("pointerdown", {
            pointerId: 1, pointerType: "mouse", bubbles: true,
            clientX: box.left + box.width / 2,
            clientY: box.top + box.height / 2,
            ...init,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
    };
    const chosen = () =>
      (document.querySelector('input[type="color"]') as HTMLInputElement).value;

    await press({ button: 2, buttons: 2 });
    expect(chosen()).toBe("#c86432");

    // Put it back to something else, then prove ctrl-click gets there too.
    act(() => {
      const input = document.querySelector('input[type="color"]') as HTMLInputElement;
      input.value = "#000000";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press({ button: 0, buttons: 1, ctrlKey: true });
    expect(chosen()).toBe("#c86432");

    // And the browser's menu never gets to open over the drawing.
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);

    act(() => painter.unmount());
  });
});
