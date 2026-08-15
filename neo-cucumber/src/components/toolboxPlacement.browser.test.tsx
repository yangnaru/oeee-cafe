import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { mount } from "../public";
import { PANEL_MARGIN } from "./toolboxAnchor";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Where the toolboxes open relative to the page around them.
 *
 * They do not clear it. A host may draw a session header above the painter,
 * and the panels still open a margin from the top of the window, because they
 * are fixed-position windows and the window is the space they are in -- and
 * because a panel over a header can be dragged off it, while a band the panels
 * refuse to enter is one you find out about by being stopped at it.
 *
 * Anchoring to the painter's own area instead made the gap at the top the
 * height of the header plus the margin, against a margin at the sides.
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
  it("opens a margin from the top of the window, header or no header", async () => {
    mountBelowAHeader();
    await act(async () => painter?.ready);

    const tops = panels().map((rect) => Math.round(rect.top));
    expect(tops.length).toBe(2);
    expect(tops).toEqual([PANEL_MARGIN, PANEL_MARGIN]);
  });

  it("leaves the same gap at the top as at the side", async () => {
    mountBelowAHeader();
    await act(async () => painter?.ready);

    const rightmost = panels().sort((a, b) => b.right - a.right)[0];
    const sideGap = Math.round(
      document.documentElement.clientWidth - rightmost.right,
    );

    expect(Math.round(rightmost.top)).toBe(sideGap);
  });
});
