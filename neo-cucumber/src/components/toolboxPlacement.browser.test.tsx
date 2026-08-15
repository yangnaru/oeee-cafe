import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { mount } from "../public";
import { PANEL_MARGIN } from "./toolboxAnchor";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Where the toolboxes open relative to the page around them.
 *
 * Below it. A host may draw a session header above the painter -- on the
 * collaborative page that bar carries the title, the owner, the share button,
 * the connection indicator and the only link back to the lobby -- and a panel
 * opening on top of it hides all five. So the panels are inset from the
 * painter's area, by the same margin at the top as at the sides, and cannot be
 * dragged above it either.
 *
 * This only works because the painter's root fills the element it was mounted
 * into. While it pinned itself to the viewport, everything measured inside it
 * reported the whole screen and the panels anchored to the top of that.
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

describe("toolbox placement", () => {
  it("opens the panels below the chrome the host draws above the painter", async () => {
    const area = mountBelowAHeader();
    await act(async () => painter?.ready);

    const tops = panels().map((rect) => Math.round(rect.top));
    expect(tops.length).toBe(2);
    expect(tops).toEqual([
      HEADER_HEIGHT + PANEL_MARGIN,
      HEADER_HEIGHT + PANEL_MARGIN,
    ]);
    for (const top of tops) {
      expect(top).toBeGreaterThanOrEqual(
        Math.round(area.getBoundingClientRect().top),
      );
    }
  });

  it("insets them from the painter by the same margin top and side", async () => {
    const area = mountBelowAHeader();
    await act(async () => painter?.ready);

    const painterBox = area.getBoundingClientRect();
    const rightmost = panels().sort((a, b) => b.right - a.right)[0];

    expect(Math.round(rightmost.top - painterBox.top)).toBe(PANEL_MARGIN);
    expect(Math.round(painterBox.right - rightmost.right)).toBe(PANEL_MARGIN);
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
