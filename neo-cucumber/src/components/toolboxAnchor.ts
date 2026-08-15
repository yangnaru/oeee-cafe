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
 * The top a panel opens at: level with the drawing.
 *
 * Beside means beside. On a tall display the canvas is centred well down the
 * workspace, and a panel pinned to the top of the painter ends up diagonally
 * across from the thing it belongs to rather than next to it. Never above the
 * painter's own top, and a panel too tall to fit from here is pulled back up
 * when it mounts and knows its height -- see NeoWindow.
 */
function besideCanvasY(area: DOMRect | null, canvas: DOMRect | null): number {
  const ceiling = minimumTop(area) + PANEL_MARGIN;
  if (!canvas) return ceiling;
  return Math.max(ceiling, Math.round(canvas.top));
}

/**
 * Where a panel's left edge goes if it is to sit just outside `edge`.
 *
 * Held inside the painter either way: a panel pushed off the workspace to stay
 * clear of the drawing is worse than one overlapping it.
 */
function beside(
  area: DOMRect,
  edge: number,
  side: "left" | "right",
): number | null {
  const x = side === "right" ? edge + PANEL_MARGIN : edge - PANEL_MARGIN - PANEL_WIDTH;
  if (x < area.left) return null;
  if (x + PANEL_WIDTH > area.right) return null;
  return x;
}

/**
 * Opening positions for both panels, given the painter's area and the drawing
 * inside it.
 *
 * Beside the canvas, not beside the window. They are the tools you reach for
 * while drawing, and on an ultrawide display the edge of the screen is a long
 * way from the edge of a 300px canvas sitting in the middle of it -- far enough
 * that the toolbox may as well be on another monitor. Where there is room they
 * both go to the right of the drawing, as they do on a desktop; where there is
 * not, they take a side each; and where the drawing fills the painter, they
 * fall back to its edges and overlap, because a panel outside the workspace is
 * no use at all.
 *
 * With no canvas to measure, the painter's own edges are the fallback.
 */
export function anchorTo(area: DOMRect | null, canvas?: DOMRect | null): PanelPositions {
  const width = area?.width ?? windowBounds().width;
  const left = area?.left ?? 0;
  const right = area?.right ?? width;
  const y = besideCanvasY(area, canvas ?? null);
  const edgeRight = Math.max(0, right - PANEL_MARGIN - PANEL_WIDTH);
  const edgeLeft = Math.max(0, left + PANEL_MARGIN);

  if (area && canvas) {
    // NEO's column keeps the side NEO puts it on, so it is placed first and
    // the extras take what is left.
    const neoX = beside(area, canvas.right, "right");
    if (neoX !== null) {
      const pairX = beside(area, canvas.right + PANEL_PITCH, "right");
      if (pairX !== null) return { neo: { x: neoX, y }, extras: { x: pairX, y } };

      const extrasX = beside(area, canvas.left, "left");
      if (extrasX !== null) return { neo: { x: neoX, y }, extras: { x: extrasX, y } };
    }
  }

  if (width < NARROW_WORKSPACE) {
    return { neo: { x: edgeRight, y }, extras: { x: edgeLeft, y } };
  }

  const neoX = Math.max(0, edgeRight - PANEL_PITCH);
  return { neo: { x: neoX, y }, extras: { x: neoX + PANEL_PITCH, y } };
}

/**
 * Where a single wide panel opens: just right of the drawing, or against the
 * painter's right edge when it does not fit there.
 */
export function anchorBesideCanvas(
  area: DOMRect | null,
  canvas: DOMRect | null,
  panelWidth: number,
): Point {
  const y = besideCanvasY(area, canvas);
  const right = area?.right ?? windowBounds().width;
  const left = area?.left ?? 0;
  const atEdge = Math.max(left, right - PANEL_MARGIN - panelWidth);
  if (!area || !canvas) return { x: atEdge, y };

  const x = canvas.right + PANEL_MARGIN;
  return { x: x + panelWidth <= area.right ? x : atEdge, y };
}
