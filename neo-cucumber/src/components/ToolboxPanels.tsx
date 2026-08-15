import { useEffect, useState } from "react";
import { ToolboxPanel, type ToolboxPanelProps } from "./ToolboxPanel";
import { anchorTo, PANEL_PITCH, type PanelPositions } from "./toolboxAnchor";

/**
 * The painter's two floating control panels: NEO's column and our extra
 * controls. They deliberately have no shared resize behaviour. Once opened,
 * each is its own draggable window and clamps itself into the viewport.
 */
export interface ToolboxPanelsProps
  extends Omit<ToolboxPanelProps, "section" | "initialPosition"> {
  /** Overrides the opening positions entirely. */
  origin?: { x: number; y: number };
}

export function ToolboxPanels({ origin, ...shared }: ToolboxPanelsProps) {
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
    setPositions(anchorTo());
  }, [origin]);

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
