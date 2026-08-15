import { afterEach, describe, expect, it } from "vitest";
import { attachWindowDrag, type WindowPosition } from "./windowDrag";

/**
 * Dragging a floating window by its title bar.
 *
 * Synthetic PointerEvents are not in Chromium's active pointer table, so
 * `setPointerCapture` is stubbed out the way the slider tests do it; capture
 * itself is the browser's behaviour, not ours. What is checked here is the
 * arithmetic underneath it, which is this package's.
 */

interface Harness {
  handle: HTMLElement;
  positions: WindowPosition[];
  detach(): void;
}

let harness: Harness | null = null;

function mount(minimumY?: number, height = 200): Harness {
  const frame = document.createElement("div");
  frame.style.cssText = `position:fixed;left:0;top:0;width:200px;height:${height}px`;
  const handle = document.createElement("div");
  handle.style.cssText = "height:18px";
  frame.appendChild(handle);
  document.body.appendChild(frame);
  handle.setPointerCapture = () => {};

  const positions: WindowPosition[] = [];
  const detachDrag = attachWindowDrag(frame, handle, {
    minimumY,
    onPosition: (position) => positions.push(position),
  });

  harness = {
    handle,
    positions,
    detach: () => {
      detachDrag();
      frame.remove();
    },
  };
  return harness;
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    pointerId: 7,
    pointerType: "touch",
    button: type === "pointermove" ? -1 : 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
    bubbles: true,
  });
}

function drag(handle: HTMLElement, from: WindowPosition, to: WindowPosition) {
  handle.dispatchEvent(pointer("pointerdown", from.x, from.y));
  handle.dispatchEvent(pointer("pointermove", to.x, to.y));
  handle.dispatchEvent(pointer("pointerup", to.x, to.y));
}

afterEach(() => {
  harness?.detach();
  harness = null;
});

describe("dragging a floating window", () => {
  it("moves it by the distance the pointer travelled", () => {
    const { handle, positions } = mount();

    drag(handle, { x: 10, y: 10 }, { x: 60, y: 90 });

    expect(positions.at(-1)).toEqual({ x: 50, y: 80 });
  });

  it("keeps it on screen when dragged past the edge", () => {
    const { handle, positions } = mount();

    drag(handle, { x: 10, y: 10 }, { x: -400, y: -400 });

    expect(positions.at(-1)).toEqual({ x: 0, y: 0 });
  });

  it("keeps it below the chrome a host reserves", () => {
    const { handle, positions } = mount(70);

    drag(handle, { x: 10, y: 100 }, { x: 10, y: 20 });

    expect(positions.at(-1)?.y).toBe(70);
  });

  it("lets a window taller than the screen be dragged up past the top", () => {
    // NEO's tool column against a phone in landscape. Pinning it below the
    // chrome would put its bottom out of reach for good, so the range inverts
    // and the only limit left is that its bottom edge stays on screen.
    const tall = window.innerHeight + 200;
    const { handle, positions } = mount(70, tall);

    drag(handle, { x: 10, y: 100 }, { x: 10, y: -500 });

    expect(positions.at(-1)?.y).toBe(window.innerHeight - tall);
    expect(positions.at(-1)?.y).toBeLessThan(0);
  });
});
