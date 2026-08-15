import React, { useLayoutEffect, useState } from "react";
import { ToolboxPanel, type ToolboxPanelProps } from "./ToolboxPanel";
import { NeoLayersPanel } from "./NeoLayersPanel";
import {
  anchorTo,
  minimumTop,
  PANEL_MARGIN,
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
    const extrasHeight =
      document.querySelector(".toolbox-extras")?.getBoundingClientRect().height ?? 0;
    const width =
      document.querySelector(".toolbox-layers")?.getBoundingClientRect().width ?? 0;
    const area = anchorRef?.current?.getBoundingClientRect() ?? null;
    const canvas = canvasRef?.current?.getBoundingClientRect() ?? null;
    // Under the columns it hangs from, wherever those ended up.
    const stacked = positions.extras.y + extrasHeight + PANEL_MARGIN;

    if (!area || !canvas || width === 0) {
      setLayersTop(stacked);
      setLayersLeft(positions.extras.x);
      return;
    }

    // This window is three times the width of the columns, so the side they
    // are on may have no room for it. Take a side that does, preferring
    // theirs; if neither fits, go under the drawing rather than over it.
    const leftSlot = canvas.left - PANEL_MARGIN - width;
    const rightSlot = canvas.right + PANEL_MARGIN;
    const fitsLeft = leftSlot >= area.left + PANEL_MARGIN;
    const fitsRight = rightSlot + width <= area.right - PANEL_MARGIN;
    const columnsOnLeft = positions.extras.x < canvas.left;
    const preferred = columnsOnLeft
      ? (fitsLeft ? leftSlot : fitsRight ? rightSlot : null)
      : (fitsRight ? rightSlot : fitsLeft ? leftSlot : null);

    if (preferred === null) {
      setLayersLeft(area.left + PANEL_MARGIN);
      setLayersTop(canvas.bottom + PANEL_MARGIN);
      return;
    }
    setLayersLeft(preferred);
    setLayersTop(stacked);
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
