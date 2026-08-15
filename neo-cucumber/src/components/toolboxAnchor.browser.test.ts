import { describe, expect, it } from "vitest";
import {
  anchorTo,
  NARROW_WORKSPACE,
  PANEL_WIDTH,
  TOOLBOX_LANE,
} from "./toolboxAnchor";

/**
 * Where the two floating panels open.
 *
 * The painter fits the canvas into what they leave, using `TOOLBOX_LANE` to
 * say how much that is -- so the thing worth pinning is not the coordinates
 * but the agreement: every panel has to land inside the lane the canvas was
 * kept out of. Get that wrong and the drawing opens underneath a toolbox,
 * which is what this is here to stop happening again.
 */

/** An iPhone in portrait, which is where the panels used to open on top of the drawing. */
const PHONE = new DOMRect(0, 0, 390, 664);
const DESKTOP = new DOMRect(0, 0, 1440, 900);

describe("anchoring the toolbox panels", () => {
  it("keeps both panels inside the lanes the canvas is fitted around", () => {
    const { neo, extras } = anchorTo(PHONE);

    expect(extras.x + PANEL_WIDTH).toBeLessThanOrEqual(TOOLBOX_LANE);
    expect(neo.x).toBeGreaterThanOrEqual(PHONE.width - TOOLBOX_LANE);
  });

  it("leaves the middle of a phone to the canvas", () => {
    const { neo, extras } = anchorTo(PHONE);

    // What the painter reserves, and so the widest the canvas can open.
    const canvasWidth = PHONE.width - TOOLBOX_LANE * 2;
    const canvasLeft = (PHONE.width - canvasWidth) / 2;

    expect(extras.x + PANEL_WIDTH).toBeLessThanOrEqual(canvasLeft);
    expect(neo.x).toBeGreaterThanOrEqual(canvasLeft + canvasWidth);
  });

  it("still clusters them against one edge on a desktop", () => {
    const { neo, extras } = anchorTo(DESKTOP);

    expect(neo).toEqual({ x: 1296, y: 12 });
    expect(extras).toEqual({ x: 1372, y: 12 });
  });

  it("opens at the top of a workspace that has nothing above it", () => {
    // The offline page moves its Save button into the toolbox, so there is no
    // chrome to clear and none is reserved.
    expect(anchorTo(PHONE).neo.y).toBe(12);
  });

  it("switches layout at the narrow threshold and not before", () => {
    const wide = anchorTo(new DOMRect(0, 0, NARROW_WORKSPACE, 800));
    const narrow = anchorTo(new DOMRect(0, 0, NARROW_WORKSPACE - 1, 800));

    // Clustered: the two sit a panel pitch apart.
    expect(wide.extras.x - wide.neo.x).toBe(76);
    // Split: one at each edge.
    expect(narrow.extras.x).toBe(12);
    expect(narrow.neo.x).toBeGreaterThan(narrow.extras.x);
  });

  it("opens below the chrome the host puts above the workspace", () => {
    const { neo, extras } = anchorTo(new DOMRect(0, 120, 390, 544));

    expect(neo.y).toBe(132);
    expect(extras.y).toBe(132);
  });
});
