import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { mount } from "../public";
import { PANEL_MARGIN } from "./toolboxAnchor";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Where the toolboxes open relative to the drawing and to the page around it.
 *
 * Beside the drawing. They are the tools you reach for while using it, and the
 * edge of a wide display can be an arm's reach from a small canvas centred in
 * the middle of it.
 *
 * Still below the host's chrome, though: on the collaborative page that bar
 * carries the title, the owner, the share button, the connection indicator and
 * the only link back to the lobby, and a panel on top of it hides all five. So
 * the drawing decides where they open and the painter's area decides how high
 * they may go, and they cannot be dragged above it either.
 */

const HEADER_HEIGHT = 64;

let host: HTMLElement | null = null;
let painter: ReturnType<typeof mount> | null = null;

function mountBelowAHeader() {
  const page = document.createElement("div");
  page.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column";
  const header = document.createElement("div");
  header.style.cssText = `flex:0 0 ${HEADER_HEIGHT}px;height:${HEADER_HEIGHT}px`;
  const area = document.createElement("div");
  area.style.cssText = "flex:1 1 auto;position:relative";
  page.append(header, area);
  document.body.appendChild(page);
  host = page;

  act(() => {
    painter = mount(area, {
      width: 100,
      height: 100,
      mode: { kind: "standard" },
      controls: { kind: "toolbox" },
    });
  });
  return area;
}

function panels(): DOMRect[] {
  return [...document.querySelectorAll<HTMLElement>("body div")]
    .filter(
      (el) =>
        getComputedStyle(el).position === "fixed" &&
        el.className.includes("shadow-lg"),
    )
    .map((el) => el.getBoundingClientRect());
}

afterEach(() => {
  if (painter) act(() => painter?.unmount());
  painter = null;
  host?.remove();
  host = null;
});

function canvasBox(): DOMRect {
  return document
    .querySelector<HTMLElement>(".canvas-container")!
    .getBoundingClientRect();
}

describe("toolbox placement", () => {
  it("opens the panels beside the drawing, not beside the screen", async () => {
    mountBelowAHeader();
    await act(async () => painter?.ready);

    const canvas = canvasBox();
    const nearest = panels().sort((a, b) => a.left - b.left)[0];

    // Hard against the canvas rather than out at the workspace edge, which on
    // a wide display is an arm's reach from the drawing.
    expect(Math.round(nearest.left - canvas.right)).toBe(PANEL_MARGIN);

    // Level with it, and never below: a panel that would run off the bottom is
    // pulled up, which is the only reason one may sit higher than the drawing.
    const shortest = panels().sort((a, b) => a.height - b.height)[0];
    expect(Math.round(shortest.top)).toBe(Math.round(canvas.top));
    for (const rect of panels()) {
      expect(Math.round(rect.top)).toBeLessThanOrEqual(Math.round(canvas.top));
    }
  });

  it("still opens below the chrome the host draws above the painter", async () => {
    const area = mountBelowAHeader();
    await act(async () => painter?.ready);

    for (const rect of panels()) {
      expect(Math.round(rect.top)).toBeGreaterThanOrEqual(
        Math.round(area.getBoundingClientRect().top),
      );
      expect(Math.round(rect.top)).toBeGreaterThanOrEqual(HEADER_HEIGHT);
    }
  });

  it("refuses to be dragged up onto the header", async () => {
    mountBelowAHeader();
    await act(async () => painter?.ready);

    const frame = [...document.querySelectorAll<HTMLElement>("body div")].find(
      (el) =>
        getComputedStyle(el).position === "fixed" &&
        el.className.includes("shadow-lg"),
    )!;
    const handle = frame.firstElementChild as HTMLElement;
    handle.setPointerCapture = () => {};

    const start = frame.getBoundingClientRect();
    for (const [type, y] of [
      ["pointerdown", start.top + 4],
      ["pointermove", -200],
      ["pointerup", -200],
    ] as const) {
      await act(async () => {
        handle.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 5,
            pointerType: "touch",
            button: type === "pointermove" ? -1 : 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: start.left + 10,
            clientY: y,
            bubbles: true,
          }),
        );
      });
    }

    expect(Math.round(frame.getBoundingClientRect().top)).toBe(HEADER_HEIGHT);
  });
});
