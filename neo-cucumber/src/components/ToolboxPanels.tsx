import React, { useEffect, useState } from "react";
import { ToolboxPanel, type ToolboxPanelProps } from "./ToolboxPanel";

/**
 * The painter's two floating control panels: NEO's column and our extra
 * controls. They deliberately have no shared resize behaviour. Once opened,
 * each is its own draggable window and clamps itself into the viewport.
 */
export interface ToolboxPanelsProps
  extends Omit<ToolboxPanelProps, "section" | "initialPosition"> {
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Overrides the anchor entirely. */
  origin?: { x: number; y: number };
}

const PANEL_WIDTH = 56;
const PANEL_PITCH = 76;
const MARGIN = 12;
const MINIMUM_TOP = 70;
const STACK_PITCH = 224;

interface Point {
  x: number;
  y: number;
}

interface PanelPositions {
  neo: Point;
  extras: Point;
}

function anchorTo(area: DOMRect | null): PanelPositions {
  const right = area ? area.right : window.innerWidth;
  const top = area ? area.top : 0;
  const y = Math.max(MINIMUM_TOP, top + MARGIN);

  if (
    (area?.width ?? window.innerWidth) >=
    PANEL_PITCH + PANEL_WIDTH + MARGIN * 2
  ) {
    const neoX = Math.max(0, right - MARGIN - PANEL_WIDTH - PANEL_PITCH);
    return {
      neo: { x: neoX, y },
      extras: { x: neoX + PANEL_PITCH, y },
    };
  }

  const x = Math.max(0, right - MARGIN - PANEL_WIDTH);
  return {
    extras: { x, y },
    neo: { x, y: y + STACK_PITCH },
  };
}

export function ToolboxPanels({
  anchorRef,
  origin,
  ...shared
}: ToolboxPanelsProps) {
  const [positions, setPositions] = useState<PanelPositions | null>(
    origin
      ? {
          neo: origin,
          extras: { x: origin.x + PANEL_PITCH, y: origin.y },
        }
      : null
  );

  useEffect(() => {
    if (origin) return;
    setPositions(anchorTo(anchorRef?.current?.getBoundingClientRect() ?? null));
  }, [anchorRef, origin]);

  if (!positions) return null;

  return (
    <>
      <ToolboxPanel {...shared} section="neo" initialPosition={positions.neo} />
      <ToolboxPanel
        {...shared}
        section="extras"
        initialPosition={positions.extras}
      />
    </>
  );
}
