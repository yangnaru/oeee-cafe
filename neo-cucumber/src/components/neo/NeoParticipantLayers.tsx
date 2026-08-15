import { Icon } from "@iconify/react";
import { useLingui } from "@lingui/react/macro";
import { NEO_BUTTON_ON, NEO_PANEL_BUTTON, NEO_WELL } from "./neoClasses";

/** One participant's row in the layer toolbox. */
export interface ParticipantLayer {
  /** The actor the layers belong to; a session id in a collaborative room. */
  actorId: string;
  /** What to call them. Falls back to the actor id when nobody knows. */
  name: string;
  /** A colour to tell them apart by, if the host has one. */
  color?: string;
}

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
}: NeoParticipantLayersProps) {
  const { t } = useLingui();
  return (
    <div className={`${NEO_WELL} flex w-[168px] flex-col gap-[2px] p-[3px]`}>
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
            <button
              type="button"
              // NEO_BUTTON_ON is the pressed face and bevel only; it carries no
              // text colour or padding of its own, so it goes on top of the
              // button rather than in place of it.
              className={`${NEO_PANEL_BUTTON} ${isTarget ? NEO_BUTTON_ON : ""} min-w-0 flex-1 justify-start truncate px-[4px] text-left`}
              aria-pressed={isTarget}
              aria-label={t`Draw on ${participant.name}'s layers`}
              title={t`Draw on these layers`}
              onClick={() => onSelectTarget(participant.actorId)}
            >
              <span
                aria-hidden="true"
                className="mr-[4px] inline-block h-[8px] w-[8px] align-middle"
                style={{ backgroundColor: participant.color ?? "transparent" }}
              />
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
