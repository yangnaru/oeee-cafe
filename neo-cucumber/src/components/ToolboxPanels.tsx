import React, { useEffect, useState } from "react";
import { ToolboxPanel, type ToolboxPanelProps } from "./ToolboxPanel";
import {
  anchorTo,
  minimumTop,
  PANEL_PITCH,
  type PanelPositions,
} from "./toolboxAnchor";

/**
 * The painter's two floating control panels: NEO's column and our extra
 * controls. They deliberately have no shared resize behaviour. Once opened,
 * each is its own draggable window and clamps itself into the viewport.
 */
export interface ToolboxPanelsProps
  extends Omit<ToolboxPanelProps, "section" | "initialPosition" | "minimumY"> {
  /** The painter's area: what the panels are inset from and kept inside. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Overrides the opening positions entirely. */
  origin?: { x: number; y: number };
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

  /** As high as either panel may be dragged; see `minimumTop`. */
  const [ceiling, setCeiling] = useState(0);

  useEffect(() => {
    const area = anchorRef?.current?.getBoundingClientRect() ?? null;
    setCeiling(minimumTop(area));
    if (origin) return;
    setPositions(anchorTo(area));
  }, [anchorRef, origin]);

  if (!positions) return null;

  return (
    <>
      <ToolboxPanel
        {...shared}
        section="neo"
        initialPosition={positions.neo}
        minimumY={ceiling}
      />
      <ToolboxPanel
        {...shared}
        section="extras"
        initialPosition={positions.extras}
        minimumY={ceiling}
      />
    </>
  );
}
