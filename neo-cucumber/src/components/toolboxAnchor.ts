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

export const PANEL_WIDTH = 56;
export const PANEL_PITCH = 76;
const MARGIN = 12;
const MINIMUM_TOP = 70;

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
export const TOOLBOX_LANE = MARGIN + PANEL_WIDTH;

export interface Point {
  x: number;
  y: number;
}

export interface PanelPositions {
  neo: Point;
  extras: Point;
}

/** Opening positions for both panels, given the workspace they belong to. */
export function anchorTo(area: DOMRect | null): PanelPositions {
  const right = area ? area.right : window.innerWidth;
  const left = area ? area.left : 0;
  const width = area?.width ?? window.innerWidth;
  const top = area ? area.top : 0;
  const y = Math.max(MINIMUM_TOP, top + MARGIN);
  const rightEdge = Math.max(0, right - MARGIN - PANEL_WIDTH);

  // NEO's own column keeps the side NEO puts it on; the extras it never had
  // take the other one.
  if (width < NARROW_WORKSPACE) {
    return {
      neo: { x: rightEdge, y },
      extras: { x: Math.max(0, left + MARGIN), y },
    };
  }

  const neoX = Math.max(0, rightEdge - PANEL_PITCH);
  return {
    neo: { x: neoX, y },
    extras: { x: neoX + PANEL_PITCH, y },
  };
}
