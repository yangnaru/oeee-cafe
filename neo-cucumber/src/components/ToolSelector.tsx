import { Icon } from "@iconify/react";

import type { ToolId } from "../neo/tools";
import { SHARED_TOOLS, TOOL_GROUPS } from "../constants/drawing";
import { neoIconFor, NEO_TOOL_LABELS } from "../neo/toolIcons";
import { useRef } from "react";

interface ToolSelectorProps {
  brushType: ToolId;
  onUpdateBrushType: (type: ToolId) => void;
  /**
   * The draw type sits in the same grid as the tools, because in NEO it is
   * one of the tool buttons -- `Neo.toolButtons` includes drawTip.
   */
  drawType?: "freehand" | "line" | "bezier";
  onCycleDrawType?: (backwards: boolean) => void;
  /**
   * Which tools to offer. A shared session is limited to what the wire format
   * can carry, so it passes a smaller set than an offline drawing does.
   */
  tools?: readonly ToolId[];
}

export const ToolSelector = ({
  brushType,
  onUpdateBrushType,
  drawType,
  onCycleDrawType,
  tools = SHARED_TOOLS,
}: ToolSelectorProps) => {
  const getToolIcon = (toolType: ToolId): string => {
    switch (toolType) {
      case "solid":
        return "material-symbols:brush";
      case "brush":
        return "material-symbols:water-drop";
      case "halftone":
        return "material-symbols:shower";
      case "dodge":
        return "material-symbols:light-mode";
      case "burn":
        return "material-symbols:dark-mode";
      case "blur":
        return "material-symbols:blur-on";
      case "rect":
        return "material-symbols:rectangle-outline";
      case "rectFill":
        return "material-symbols:rectangle";
      case "ellipse":
        return "material-symbols:circle-outline";
      case "ellipseFill":
        return "material-symbols:circle";
      case "eraseRect":
        return "material-symbols:select-all";
      case "blurRect":
        return "material-symbols:deblur";
      case "flipH":
        return "material-symbols:flip";
      case "flipV":
        return "material-symbols:flip-camera-android";
      case "turn":
        return "material-symbols:rotate-90-degrees-cw";
      case "merge":
        return "material-symbols:layers";
      case "eraseAll":
        return "material-symbols:delete-sweep";
      case "copy":
        return "material-symbols:content-copy";
      case "paste":
        return "material-symbols:content-paste";
      case "text":
        return "material-symbols:title";
      case "eraser":
        return "material-symbols:ink-eraser";
      case "fill":
        return "material-symbols:format-color-fill";
      case "pan":
        return "material-symbols:pan-tool";
      default:
        return "material-symbols:settings";
    }
  };

  /**
   * Where each group was left. NEO keeps this on the button itself, so
   * coming back to a group returns to the tool you last used in it rather
   * than resetting to the first.
   */
  const modes = useRef<Record<string, number>>({});

  const groups = TOOL_GROUPS.map((group) => ({
    ...group,
    tools: group.tools.filter((tool) => tools.includes(tool)),
  })).filter((group) => group.tools.length > 0);

  /**
   * NEO's ToolTip handler: a click on an unselected group selects it, a click
   * on the selected group advances within it, and the right button goes back.
   */
  const activate = (
    group: { name: string; tools: readonly ToolId[] },
    backwards: boolean
  ) => {
    const held = group.tools.indexOf(brushType);
    const length = group.tools.length;
    let next: number;
    if (held === -1) {
      next = modes.current[group.name] ?? 0;
      if (next >= length) next = 0;
    } else {
      next = backwards
        ? (held - 1 + length) % length
        : (held + 1) % length;
    }
    modes.current[group.name] = next;
    onUpdateBrushType(group.tools[next]);
  };

  return (
    // Two across, like NEO's 52px tool column, rather than a wide grid
    // NEO's own #toolSet, so neo.css and the generated skin apply to it
    <div id="toolSet">
      {groups.map((group) => {
        const held = group.tools.indexOf(brushType);
        // Show the held tool when this group owns the selection, otherwise
        // the one it would return to
        const shown =
          group.tools[held === -1 ? modes.current[group.name] ?? 0 : held] ??
          group.tools[0];
        const selected = held !== -1;
        return (
          <button
            key={group.name}
            type="button"
            aria-pressed={selected}
            title={
              group.tools.length > 1
                ? `${shown} — click again to cycle (${group.tools.join(", ")})`
                : shown
            }
            className={selected ? "toolTipOn" : "toolTipOff"}
            onClick={() => activate(group, false)}
            onContextMenu={(e) => {
              e.preventDefault();
              activate(group, true);
            }}
          >
            {neoIconFor(shown) ? (
              <img src={neoIconFor(shown)!} alt="" />
            ) : (
              <Icon icon={getToolIcon(shown)} width={16} height={16} />
            )}
            <div className="label">{NEO_TOOL_LABELS[shown] ?? shown}</div>
          </button>
        );
      })}

      {drawType && onCycleDrawType && (
        <button
          type="button"
          title={`${drawType} — click to cycle (freehand, line, bezier)`}
          className="toolTipFixed"
          onClick={() => onCycleDrawType(false)}
          onContextMenu={(e) => {
            e.preventDefault();
            onCycleDrawType(true);
          }}
        >
          <img src={neoIconFor(drawType)!} alt="" />
          <div className="label">{NEO_TOOL_LABELS[drawType] ?? drawType}</div>
        </button>
      )}
    </div>
  );
};
