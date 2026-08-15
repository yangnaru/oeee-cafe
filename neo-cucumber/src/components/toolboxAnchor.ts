/**
 * Where the painter's two floating panels open.
 *
 * This is arithmetic rather than layout: the panels are fixed-position windows,
 * so nothing in the document flow puts them anywhere, and nothing in the
 * document flow keeps the canvas out from under them either. The painter fits
 * the canvas into the room this file says the panels will take, which is why
 * the numbers live apart from the component that renders them -- two files
 * needing the same constant is exactly how the canvas came to open underneath
 * a toolbox in the first place.
 */

import { windowBounds } from "../utils/windowDrag";

export const PANEL_WIDTH = 56;
export const PANEL_PITCH = 76;

/**
 * How far a floating panel sits from the edge it is anchored to.
 *
 * Exported because a host's own windows stand beside the painter's, and a
 * window that is nearly flush with them reads as misaligned rather than as
 * placed differently.
 */
export const PANEL_MARGIN = 12;


/**
 * Below this the panels take an edge each instead of sharing the right one.
 *
 * Two 56px windows clustered against one edge is a desktop shape: it keeps the
 * controls together and there is canvas to spare beside them. On a phone there
 * is not. The canvas is centred in the workspace, so a cluster on the right
 * opens directly on top of the drawing -- 390px of viewport, a 300px canvas
 * centred across the middle of it, and both panels landing inside that. An
 * edge each leaves the middle to the canvas.
 */
export const NARROW_WORKSPACE = 640;

/**
 * The horizontal room one panel needs at an edge, its margin included.
 *
 * Exported because the painter reserves this much on each side before fitting
 * the canvas, and the two numbers have to be the same number.
 */
export const TOOLBOX_LANE = PANEL_MARGIN + PANEL_WIDTH;

export interface Point {
  x: number;
  y: number;
}

export interface PanelPositions {
  neo: Point;
  extras: Point;
}

/**
 * How high a panel may go: the top of the painter's own area.
 *
 * Not the top of the window. A host may draw chrome above the painter -- the
 * collaborative page draws the session header there, which carries the title,
 * the share button, the connection indicator and the only link back to the
 * lobby -- and a panel parked on it hides all four. The painter's area is where
 * the painter begins, so it is also where its windows do.
 */
export function minimumTop(area: DOMRect | null): number {
  return Math.max(0, area ? area.top : 0);
}

/**
 * Opening positions for both panels, given the painter's area.
 *
 * The gap above a panel is the gap beside it, both measured from that area:
 * the panels sit in the painter, so the painter is what they are inset from.
 */
export function anchorTo(area: DOMRect | null): PanelPositions {
  const width = area?.width ?? windowBounds().width;
  const left = area?.left ?? 0;
  const right = area?.right ?? width;
  const y = minimumTop(area) + PANEL_MARGIN;
  const rightEdge = Math.max(0, right - PANEL_MARGIN - PANEL_WIDTH);

  // NEO's own column keeps the side NEO puts it on; the extras it never had
  // take the other one.
  if (width < NARROW_WORKSPACE) {
    return {
      neo: { x: rightEdge, y },
      extras: { x: Math.max(0, left + PANEL_MARGIN), y },
    };
  }

  const neoX = Math.max(0, rightEdge - PANEL_PITCH);
  return {
    neo: { x: neoX, y },
    extras: { x: neoX + PANEL_PITCH, y },
  };
}
