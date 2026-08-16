import {
  NEO_LAYER_BG,
  NEO_LAYER_CONTROL,
  NEO_LAYER_LABEL,
  NEO_LAYER_LINE,
} from "./neoClasses";
import { usePainterLabels } from "../../hooks/usePainterLabels";

interface NeoLayerControlProps {
  /** Which layer is being drawn on. */
  current: "foreground" | "background";
  fgVisible: boolean;
  bgVisible: boolean;
  onSwitch: () => void;
  /** NEO's right-click: hide or show the layer you are on. */
  onToggleVisible: () => void;
}

/**
 * NEO's layer button.
 *
 * One button, not two: it names the layer you are on, clicking swaps, and
 * right-clicking hides that layer. A hidden layer is struck through with a red
 * diagonal across its half of the button -- the top half is the foreground,
 * the bottom the background -- so both layers' states are visible even though
 * only one is named.
 */
export function NeoLayerControl({
  current,
  fgVisible,
  bgVisible,
  onSwitch,
  onToggleVisible,
}: NeoLayerControlProps) {
  const labels = usePainterLabels();

  return (
    <button
      type="button"
      className={NEO_LAYER_CONTROL}
      title="Switch layer — right-click to hide it"
      onPointerDown={(e) => {
        if (e.button === 2) return;
        onSwitch();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onToggleVisible();
      }}
    >
      <div className={NEO_LAYER_BG} />
      <span className={NEO_LAYER_LABEL} style={{ top: -4 }}>
        {current === "foreground" ? labels.layers[1] : ""}
      </span>
      <span className={NEO_LAYER_LABEL} style={{ top: 6 }}>
        {current === "background" ? labels.layers[0] : ""}
      </span>
      {!fgVisible && <div className={NEO_LAYER_LINE} style={{ top: 0 }} />}
      {!bgVisible && <div className={NEO_LAYER_LINE} style={{ top: 10 }} />}
    </button>
  );
}
