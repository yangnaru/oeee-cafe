import { NeoWindow } from "./neo/NeoWindow";
import {
  NeoParticipantLayers,
  type ParticipantLayer,
} from "./neo/NeoParticipantLayers";

export interface NeoLayersPanelProps {
  participants: ParticipantLayer[];
  hidden: ReadonlySet<string>;
  target: string;
  localActorId: string;
  onToggleVisible: (actorId: string) => void;
  onSelectTarget: (actorId: string) => void;
  initialPosition: { x: number; y: number };
  minimumY?: number;
}

/**
 * The participants' layers, in a window of their own.
 *
 * Not in NEO's column, which holds only NEO's own tools, and not in the extras
 * column either: that one is a fixed 56px so its buttons line up with NEO's,
 * and a list of names is far wider than that. Putting it there widened the
 * whole panel and broke the alignment the width exists for.
 */
export function NeoLayersPanel({
  participants,
  hidden,
  target,
  localActorId,
  onToggleVisible,
  onSelectTarget,
  initialPosition,
  minimumY = 0,
}: NeoLayersPanelProps) {
  return (
    <NeoWindow
      initialPosition={initialPosition}
      className="w-max overflow-hidden select-text toolbox-layers"
      minimumY={minimumY}
    >
      <div className="p-[2px]">
        <NeoParticipantLayers
          participants={participants}
          hidden={hidden}
          target={target}
          localActorId={localActorId}
          onToggleVisible={onToggleVisible}
          onSelectTarget={onSelectTarget}
        />
      </div>
    </NeoWindow>
  );
}
