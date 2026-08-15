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
 * This used to be a flat 70px everywhere, which was a guess at how much chrome
 * a host puts above the painter. It is not a guess -- the workspace knows where
 * it starts. A host with a session header gets the same reservation it always
 * had, and the offline page, which moves its Save button into the toolbox and
 * has nothing up there at all, stops holding back 70px of a phone in landscape
 * for nothing.
 */
export function minimumTop(area: DOMRect | null): number {
  return Math.max(0, area ? area.top : 0);
}

/** Opening positions for both panels, given the workspace they belong to. */
export function anchorTo(area: DOMRect | null): PanelPositions {
  const right = area ? area.right : window.innerWidth;
  const left = area ? area.left : 0;
  const width = area?.width ?? window.innerWidth;
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
