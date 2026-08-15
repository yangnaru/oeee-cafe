import { beforeEach, describe, expect, it } from "vitest";
import { attachWindowDrag, type WindowPosition } from "./windowDrag";

/**
 * Dragging a floating window, and in particular the rule that decides whether
 * a press on the panel is a drag or a press on what the panel holds.
 *
 * That rule only runs on a touch screen, where a five-pixel title bar is no
 * target at all -- so every test here asks for `"always"`, because the browser
 * these run in reports a mouse. What is being checked is the filtering, not the
 * media query.
 *
 * Synthetic PointerEvents are not in Chromium's active pointer table, so
 * `setPointerCapture` is stubbed out the way the slider tests do it; capture
 * itself is the browser's behaviour, not ours.
 */

interface Harness {
  frame: HTMLElement;
  handle: HTMLElement;
  background: HTMLElement;
  button: HTMLButtonElement;
  ignored: HTMLElement;
  positions: WindowPosition[];
  detach(): void;
}

let harnesses: Harness[] = [];

function mount(
  dragFromBody: "coarse-pointer" | "always" | "never" = "always",
): Harness {
  const frame = document.createElement("div");
  frame.style.cssText = "position:fixed;left:0;top:0;width:200px;height:200px";
  const handle = document.createElement("div");
  handle.style.cssText = "height:28px";
  const background = document.createElement("div");
  background.style.cssText = "height:100px";
  const button = document.createElement("button");
  button.textContent = "tool";
  const ignored = document.createElement("div");
  ignored.setAttribute("data-no-window-drag", "");
  ignored.textContent = "log";

  background.append(button, ignored);
  frame.append(handle, background);
  document.body.appendChild(frame);
  for (const element of [frame, handle, background, button, ignored]) {
    element.setPointerCapture = () => {};
  }

  const positions: WindowPosition[] = [];
  const detach = attachWindowDrag(frame, handle, {
    dragFromBody,
    onPosition: (position) => positions.push(position),
  });

  const harness = { frame, handle, background, button, ignored, positions, detach };
  harnesses.push(harness);
  return harness;
}

function press(target: HTMLElement, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 7,
      pointerType: "touch",
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
      bubbles: true,
    }),
  );
}

function move(target: HTMLElement, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent("pointermove", {
      pointerId: 7,
      pointerType: "touch",
      buttons: 1,
      clientX: x,
      clientY: y,
      bubbles: true,
    }),
  );
}

function release(target: HTMLElement, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent("pointerup", {
      pointerId: 7,
      pointerType: "touch",
      button: 0,
      clientX: x,
      clientY: y,
      bubbles: true,
    }),
  );
}

beforeEach(() => {
  for (const harness of harnesses) {
    harness.detach();
    harness.frame.remove();
  }
  harnesses = [];
});

describe("dragging a floating window", () => {
  it("still moves from the title bar", () => {
    const { handle, positions } = mount();

    press(handle, 10, 10);
    move(handle, 60, 90);
    release(handle, 60, 90);

    expect(positions.at(-1)).toEqual({ x: 50, y: 80 });
  });

  it("moves from the panel's own background", () => {
    const { background, positions } = mount();

    press(background, 20, 40);
    move(background, 70, 120);
    release(background, 70, 120);

    expect(positions.at(-1)).toEqual({ x: 50, y: 80 });
  });

  it("leaves a press on a control alone", () => {
    const { button, positions } = mount();

    press(button, 20, 40);
    move(button, 70, 120);
    release(button, 70, 120);

    expect(positions).toEqual([]);
  });

  it("leaves a press on a region that opted out alone", () => {
    const { ignored, positions } = mount();

    press(ignored, 20, 40);
    move(ignored, 70, 120);
    release(ignored, 70, 120);

    expect(positions).toEqual([]);
  });

  it("does not move the window on a mis-tap between two buttons", () => {
    const { background, positions } = mount();

    // A fingertip never lands and lifts on exactly one pixel.
    press(background, 20, 40);
    move(background, 22, 41);
    release(background, 22, 41);

    expect(positions).toEqual([]);
  });

  it("keeps the background to itself when the panel scrolls", () => {
    const { background, positions } = mount("never");

    press(background, 20, 40);
    move(background, 70, 120);
    release(background, 70, 120);

    expect(positions).toEqual([]);
  });

  it("does not start a second drag from the frame when the handle has one", () => {
    const { frame, handle, positions } = mount();

    press(handle, 10, 10);
    move(frame, 60, 90);
    release(frame, 60, 90);

    // One press, one reported position: the frame's own listener saw the
    // handle's press bubble through and left it alone.
    expect(positions).toEqual([{ x: 50, y: 80 }]);
  });
});
