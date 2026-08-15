import React, { useLayoutEffect, useState } from "react";
import { ToolboxPanel, type ToolboxPanelProps } from "./ToolboxPanel";
import { NeoLayersPanel } from "./NeoLayersPanel";
import {
  anchorTo,
  minimumTop,
  PANEL_MARGIN,
  PANEL_PITCH,
  PANEL_WIDTH,
  type PanelPositions,
} from "./toolboxAnchor";

/**
 * The painter's two floating control panels: NEO's column and our extra
 * controls. They deliberately have no shared resize behaviour. Once opened,
 * each is its own draggable window and clamps itself into the viewport.
 */
export interface ToolboxPanelsProps
  extends Omit<ToolboxPanelProps, "section" | "initialPosition" | "minimumY"> {
  /** The painter's area: what the panels are kept inside. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** The drawing itself, which is what they open beside. */
  canvasRef?: React.RefObject<HTMLElement | null>;
  /** Overrides the opening positions entirely. */
  origin?: { x: number; y: number };
}

export function ToolboxPanels({
  anchorRef,
  canvasRef,
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
  /**
   * Where the layers window opens: under the extras column.
   *
   * Measured rather than guessed, because the extras column is as tall as the
   * tools it was given and a constant would leave a gap under a short one and
   * cover a tall one.
   */
  const [layersTop, setLayersTop] = useState<number | null>(null);

  // Laid out rather than deferred: the panels have to be in the DOM by the end
  // of this commit, because that is when the painter reports itself ready and a
  // host may go looking for them.
  useLayoutEffect(() => {
    const area = anchorRef?.current?.getBoundingClientRect() ?? null;
    setCeiling(minimumTop(area));
    if (origin) return;
    setPositions(anchorTo(area, canvasRef?.current?.getBoundingClientRect()));
  }, [anchorRef, canvasRef, origin]);

  const [layersLeft, setLayersLeft] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!positions) return;
    const extras = document.querySelector(".toolbox-extras");
    const height = extras?.getBoundingClientRect().height ?? 0;
    setLayersTop(positions.extras.y + height + PANEL_MARGIN);

    // The window is far wider than the column it hangs under, so left-aligning
    // it would push it out over the drawing whenever the columns sit to the
    // drawing's left. Grow away from the canvas instead: rightwards when the
    // columns are to its right, leftwards when they are to its left.
    const layers = document.querySelector(".toolbox-layers");
    const width = layers?.getBoundingClientRect().width ?? 0;
    const area = anchorRef?.current?.getBoundingClientRect() ?? null;
    const canvas = canvasRef?.current?.getBoundingClientRect() ?? null;
    const columnsLeftOfCanvas = canvas ? positions.extras.x < canvas.left : false;
    const left = columnsLeftOfCanvas
      ? positions.extras.x + PANEL_WIDTH - width
      : positions.extras.x;
    const floor = (area?.left ?? 0) + PANEL_MARGIN;
    setLayersLeft(Math.max(floor, left));
  }, [positions, anchorRef, canvasRef, shared.participantLayers]);

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
      {shared.participantLayers &&
        shared.participantLayers.length > 0 &&
        layersTop !== null &&
        layersLeft !== null && (
          <NeoLayersPanel
            participants={shared.participantLayers}
            hidden={shared.hiddenOwners ?? new Set()}
            target={shared.targetOwner ?? ""}
            localActorId={shared.localActorId ?? ""}
            onToggleVisible={shared.onToggleOwnerVisible ?? (() => {})}
            onSelectTarget={shared.onSelectTargetOwner ?? (() => {})}
            initialPosition={{ x: layersLeft, y: layersTop }}
            minimumY={ceiling}
          />
        )}
    </>
  );
}
