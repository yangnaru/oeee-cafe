import { describe, expect, it } from "vitest";
import {
  anchorTo,
  minimumTop,
  NARROW_WORKSPACE,
  PANEL_MARGIN,
  PANEL_WIDTH,
  TOOLBOX_LANE,
} from "./toolboxAnchor";

/**
 * Where the two floating panels open.
 *
 * Three things are worth pinning. The panels sit inside the painter's area,
 * not the window, so chrome a host draws above the painter is not covered. The
 * gap above one is the gap beside it. And the painter fits the canvas into what
 * they leave, using `TOOLBOX_LANE` to say how much that is, so a panel landing
 * outside its lane means the drawing opens underneath a toolbox.
 */

/** A phone-width painter sitting under a 64px session header. */
const UNDER_A_HEADER = new DOMRect(0, 64, 390, 600);
const DESKTOP = new DOMRect(0, 0, 1440, 900);

describe("anchoring the toolbox panels", () => {
  it("opens below the chrome above the painter", () => {
    const { neo, extras } = anchorTo(UNDER_A_HEADER);

    expect(neo.y).toBe(UNDER_A_HEADER.top + PANEL_MARGIN);
    expect(extras.y).toBe(UNDER_A_HEADER.top + PANEL_MARGIN);
  });

  it("holds off the painter's top by what it holds off its sides", () => {
    const { neo, extras } = anchorTo(UNDER_A_HEADER);

    expect(neo.y - UNDER_A_HEADER.top).toBe(PANEL_MARGIN);
    expect(extras.x - UNDER_A_HEADER.left).toBe(PANEL_MARGIN);
    expect(UNDER_A_HEADER.right - (neo.x + PANEL_WIDTH)).toBe(PANEL_MARGIN);
  });

  it("reports the painter's top as the ceiling a window may not pass", () => {
    expect(minimumTop(UNDER_A_HEADER)).toBe(64);
    // A painter with nothing above it reserves nothing.
    expect(minimumTop(DESKTOP)).toBe(0);
    expect(minimumTop(null)).toBe(0);
  });

  it("keeps both panels inside the lanes the canvas is fitted around", () => {
    const { neo, extras } = anchorTo(UNDER_A_HEADER);

    expect(UNDER_A_HEADER.width).toBeLessThan(NARROW_WORKSPACE);
    expect(extras.x + PANEL_WIDTH).toBeLessThanOrEqual(TOOLBOX_LANE);
    expect(neo.x).toBeGreaterThanOrEqual(UNDER_A_HEADER.width - TOOLBOX_LANE);
  });

  it("still clusters them against one edge on a desktop", () => {
    const { neo, extras } = anchorTo(DESKTOP);

    expect(neo).toEqual({ x: 1296, y: PANEL_MARGIN });
    expect(extras).toEqual({ x: 1372, y: PANEL_MARGIN });
  });
});
