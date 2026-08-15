import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { mount } from "../public";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Where the toolboxes open relative to the page around them.
 *
 * The painter's own root is `position: fixed` with every inset at zero, so
 * anything measured inside it reports the viewport no matter where the host put
 * the painter. Anchoring the panels to that opened them at the top of the
 * screen -- over the session header a collaborative host draws above the
 * painter, and out of line with the host's own windows, which measure the
 * element they were mounted beside. So the panels anchor to the mount element,
 * and this is the test that says so.
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

function panelTops(): number[] {
  return [...document.querySelectorAll<HTMLElement>("body div")]
    .filter(
      (el) =>
        getComputedStyle(el).position === "fixed" &&
        el.className.includes("shadow-lg"),
    )
    .map((el) => Math.round(el.getBoundingClientRect().top));
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

    const tops = panelTops();
    expect(tops.length).toBe(2);
    for (const top of tops) {
      expect(top).toBeGreaterThanOrEqual(
        Math.round(area.getBoundingClientRect().top),
      );
    }
  });

  it("measures the host's element rather than its own fixed root", async () => {
    mountBelowAHeader();
    await act(async () => painter?.ready);

    // The painter's root covers the viewport, so a panel measured against it
    // would open at the very top of the screen. The margin is the only gap
    // there should be between the header and a panel.
    expect(panelTops()).toEqual([HEADER_HEIGHT + 12, HEADER_HEIGHT + 12]);
  });
});
