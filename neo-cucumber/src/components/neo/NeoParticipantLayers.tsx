import { useEffect, useRef } from "react";
import { Icon } from "@iconify/react";
import { useLingui } from "@lingui/react/macro";
import {
  NEO_BUTTON_ON,
  NEO_ICON_BUTTON,
  NEO_PANEL_BUTTON,
  NEO_WELL,
} from "./neoClasses";

/** One participant's row in the layer toolbox. */
export interface ParticipantLayer {
  /** The actor the layers belong to; a session id in a collaborative room. */
  actorId: string;
  /** What to call them. Falls back to the actor id when nobody knows. */
  name: string;
  /** A colour to tell them apart by, if the host has one. */
  color?: string;
}

/** How tall a row's thumbnail is; its width follows the canvas's shape. */
const THUMBNAIL_HEIGHT = 18;
/** How often the thumbnails catch up with the drawing. */
const THUMBNAIL_INTERVAL_MS = 400;

interface NeoParticipantLayersProps {
  /** Everyone with layers, bottom of the stack last -- as they composite. */
  participants: ParticipantLayer[];
  /** Which of them this viewer has hidden. */
  hidden: ReadonlySet<string>;
  /** Whose layers new marks land in. */
  target: string;
  /** Which actor is us, so the row can say so. */
  localActorId: string;
  onToggleVisible: (actorId: string) => void;
  onSelectTarget: (actorId: string) => void;
  /**
   * Paints a participant's layers into a thumbnail.
   *
   * The panel does not know how to reach anybody's pixels and should not: it
   * is handed something that composites them at whatever size the target is.
   */
  drawThumbnail?: (actorId: string, target: HTMLCanvasElement) => void;
  /** The drawing's shape, so the thumbnails have it too. */
  canvasAspect?: number;
}

/**
 * The participant layer toolbox.
 *
 * Every participant in a collaborative session has their own background and
 * foreground, stacked as a unit in join order, and this is the list of them.
 * A row does two things: the eye hides that participant's layers for this
 * viewer alone -- it is a way of looking at the drawing, so it never travels
 * and never reaches the saved image -- and the name selects whose layers your
 * next mark goes into.
 *
 * NEO has no such control, having no such concept: its layer button switches
 * between one person's two layers and is still the thing that does that. This
 * sits beside it wearing the same chrome.
 */
export function NeoParticipantLayers({
  participants,
  hidden,
  target,
  localActorId,
  onToggleVisible,
  onSelectTarget,
  drawThumbnail,
  canvasAspect = 1,
}: NeoParticipantLayersProps) {
  const { t } = useLingui();
  const thumbnails = useRef(new Map<string, HTMLCanvasElement>());

  /**
   * Repainted on a timer rather than on every stroke.
   *
   * A thumbnail is a glance, not a mirror: refreshing it as fast as the canvas
   * changes would redraw every participant's for every segment of everybody's
   * stroke, and nobody would see the difference.
   */
  useEffect(() => {
    if (!drawThumbnail) return;
    const paint = () => {
      for (const [actorId, canvas] of thumbnails.current) {
        drawThumbnail(actorId, canvas);
      }
    };
    paint();
    const timer = setInterval(paint, THUMBNAIL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [drawThumbnail, participants]);

  const thumbnailWidth = Math.max(1, Math.round(THUMBNAIL_HEIGHT * canvasAspect));
  return (
    // Sized to the longest name rather than to a number picked in advance: a
    // fixed width leaves a gap after every short name and truncates every long
    // one. Bounded at both ends so one participant does not make a sliver of a
    // window, and a pathological name does not make a wall of one -- past that
    // the name ellipsizes.
    <div
      className={`${NEO_WELL} flex w-max min-w-[128px] max-w-[260px] flex-col gap-[2px] p-[3px]`}
    >
      {participants.map((participant) => {
        const isHidden = hidden.has(participant.actorId);
        const isTarget = participant.actorId === target;
        const isSelf = participant.actorId === localActorId;
        return (
          <div key={participant.actorId} className="flex items-center gap-[2px]">
            {/*
              A fixed-width holder rather than a width on the button: the panel
              button class sets `w-full`, and two width utilities on one element
              are settled by stylesheet order rather than by the order they are
              written in -- which had the eye taking the whole row and the name
              collapsing to nothing.
            */}
            <span className="block w-[20px] shrink-0">
            <button
              type="button"
              className={NEO_PANEL_BUTTON}
              aria-pressed={!isHidden}
              aria-label={
                isHidden
                  ? t`Show ${participant.name}'s layers`
                  : t`Hide ${participant.name}'s layers`
              }
              title={isHidden ? t`Show these layers` : t`Hide these layers`}
              onClick={() => onToggleVisible(participant.actorId)}
            >
              <Icon
                icon={
                  isHidden
                    ? "material-symbols:visibility-off"
                    : "material-symbols:visibility"
                }
                width={14}
                height={14}
              />
            </button>
            </span>
            {drawThumbnail && (
              <canvas
                aria-hidden="true"
                className="shrink-0 bg-(--neo-bk2)"
                width={thumbnailWidth}
                height={THUMBNAIL_HEIGHT}
                style={{ width: thumbnailWidth, height: THUMBNAIL_HEIGHT }}
                ref={(node) => {
                  if (node) thumbnails.current.set(participant.actorId, node);
                  else thumbnails.current.delete(participant.actorId);
                }}
              />
            )}
            <button
              type="button"
              // Built from the icon button rather than the panel button: that
              // one centres its contents and zeroes its padding, and a second
              // utility for either is settled by stylesheet order rather than
              // by the order it is written in -- which left the name floating
              // in the middle of the row. NEO_BUTTON_ON is the pressed face
              // and bevel only, so it sits on top rather than in place.
              className={`${NEO_ICON_BUTTON} ${isTarget ? NEO_BUTTON_ON : ""} flex min-w-0 flex-1 items-center gap-[4px] overflow-hidden px-[5px] text-left`}
              aria-pressed={isTarget}
              aria-label={t`Draw on ${participant.name}'s layers`}
              title={t`Draw on these layers`}
              onClick={() => onSelectTarget(participant.actorId)}
            >
              {participant.color && (
                <span
                  aria-hidden="true"
                  className="h-[8px] w-[8px] shrink-0"
                  style={{ backgroundColor: participant.color }}
                />
              )}
              <span className="truncate text-[11px]">
                {participant.name}
                {isSelf ? t` (you)` : ""}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
