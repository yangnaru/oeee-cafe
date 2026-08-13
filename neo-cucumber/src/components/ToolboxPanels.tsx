import React, { useEffect, useState } from "react";
import { ToolboxPanel, type ToolboxPanelProps } from "./ToolboxPanel";

/**
 * The painter's two panels: NEO's column, and everything NEO keeps outside it.
 *
 * They are split rather than merged because the column is a reproduction --
 * anything sharing its frame reads as part of it, which is how fill and pan
 * ended up looking like NEO's own buttons. Separate windows make the boundary
 * a physical one.
 *
 * Every mode that is not two-tone mounts this, so the pair cannot drift apart
 * between offline and collaborative: the twenty-odd props they share are
 * written once here rather than twice in each app.
 */
export interface ToolboxPanelsProps
  extends Omit<ToolboxPanelProps, "section" | "initialPosition"> {
  /**
   * The painter area the panels open against, so they land inside it rather
   * than over whatever chrome the page has above it. Without one they fall
   * back to the viewport, which is only right when the painter fills it.
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Overrides the anchor entirely. */
  origin?: { x: number; y: number };
}

/** A panel is 56px wide; the pitch leaves a gap between the two. */
const PANEL_WIDTH = 56;
const PANEL_PITCH = 76;
/** How far the pair sits from the edges of the area it opens in. */
const MARGIN = 12;
/** The application navigation occupies the top 58px of the viewport. */
const MINIMUM_TOP = 70;

interface Point {
  x: number;
  y: number;
}

/**
 * Both panels against the right edge of `area`, the NEO column innermost so
 * it is the one beside the canvas -- the side NEO docks its own tools to
 * (`Neo.setToolSide(false)` puts `#toolsWrapper` at `right: -3px`).
 */
function anchorTo(area: DOMRect | null): Point {
  const right = area ? area.right : window.innerWidth;
  const top = area ? area.top : 0;
  return {
    x: Math.max(0, right - MARGIN - PANEL_WIDTH - PANEL_PITCH),
    // The painter can be mounted inside the fixed application shell, whose
    // DOM rect begins at zero even though the visible drawing area starts
    // below the navigation. Keep the panels clear of that chrome either way.
    y: Math.max(MINIMUM_TOP, top + MARGIN),
  };
}

export function ToolboxPanels({
  anchorRef,
  origin,
  ...shared
}: ToolboxPanelsProps) {
  /*
   * Measured, not guessed.
   *
   * The panels are `fixed`, so their coordinates are the viewport's, and a
   * hardcoded top was landing them under the page's nav bar on any layout
   * whose header was not the height that constant assumed.
   *
   * This is a passive effect rather than a layout one: React attaches refs
   * child-first, so an ancestor's ref is still null while a child's layout
   * effect runs, and measuring there silently fell back to the viewport. The
   * first pass renders nothing, so there is no frame in the wrong place --
   * only one without the panels. They are draggable afterwards, so this
   * decides where they open and nothing more.
   */
  const [start, setStart] = useState<Point | null>(origin ?? null);

  useEffect(() => {
    if (origin) return;
    setStart(anchorTo(anchorRef?.current?.getBoundingClientRect() ?? null));
  }, [origin, anchorRef]);

  if (!start) return null;

  return (
    <>
      <ToolboxPanel {...shared} section="neo" initialPosition={start} />
      <ToolboxPanel
        {...shared}
        section="extras"
        initialPosition={{ x: start.x + PANEL_PITCH, y: start.y }}
      />
    </>
  );
}
