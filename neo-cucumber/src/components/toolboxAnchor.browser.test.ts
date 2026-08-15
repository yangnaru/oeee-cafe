import { describe, expect, it } from "vitest";
import {
  anchorTo,
  NARROW_WORKSPACE,
  PANEL_MARGIN,
  PANEL_WIDTH,
  TOOLBOX_LANE,
} from "./toolboxAnchor";

/**
 * Where the two floating panels open.
 *
 * Two things are worth pinning here. The first is an agreement: the painter
 * fits the canvas into what the panels leave, using `TOOLBOX_LANE` to say how
 * much that is, so every panel has to land inside the lane the canvas was kept
 * out of. Get that wrong and the drawing opens underneath a toolbox.
 *
 * The second is that the gap at the top is the gap at the sides. These are
 * fixed-position windows in a window, and nothing about the page they are over
 * should push them further down than in.
 */

const width = () => document.documentElement.clientWidth;

describe("anchoring the toolbox panels", () => {
  it("holds off the top by exactly what it holds off the sides", () => {
    const { neo, extras } = anchorTo();

    const sideGap =
      width() < NARROW_WORKSPACE
        ? extras.x
        : width() - (extras.x + PANEL_WIDTH);
    expect(neo.y).toBe(PANEL_MARGIN);
    expect(extras.y).toBe(PANEL_MARGIN);
    expect(sideGap).toBe(PANEL_MARGIN);
  });

  it("keeps the far panel a margin from the right edge", () => {
    const { neo, extras } = anchorTo();
    const rightmost = Math.max(neo.x, extras.x);

    expect(width() - (rightmost + PANEL_WIDTH)).toBe(PANEL_MARGIN);
  });

  it("keeps both panels inside the lanes the canvas is fitted around", () => {
    const { neo, extras } = anchorTo();

    if (width() < NARROW_WORKSPACE) {
      expect(extras.x + PANEL_WIDTH).toBeLessThanOrEqual(TOOLBOX_LANE);
      expect(neo.x).toBeGreaterThanOrEqual(width() - TOOLBOX_LANE);
    } else {
      // Wide: both cluster against the right, so only that lane is claimed.
      expect(neo.x).toBeGreaterThan(width() / 2);
    }
  });

  it("clusters them a panel pitch apart when there is room", () => {
    if (width() < NARROW_WORKSPACE) return;
    const { neo, extras } = anchorTo();

    expect(extras.x - neo.x).toBe(76);
  });
});
