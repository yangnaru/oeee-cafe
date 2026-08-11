import { Icon } from "@iconify/react";

import type { ToolId } from "../neo/tools";
import { SHARED_TOOLS } from "../constants/drawing";

interface ToolSelectorProps {
  brushType: ToolId;
  onUpdateBrushType: (type: ToolId) => void;
  /**
   * Which tools to offer. A shared session is limited to what the wire format
   * can carry, so it passes a smaller set than an offline drawing does.
   */
  tools?: readonly ToolId[];
}

export const ToolSelector = ({
  brushType,
  onUpdateBrushType,
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

  return (
    <div className="flex flex-col gap-1">
      {tools.map(
        (type) => (
          <label key={type} className="relative cursor-pointer">
            <input
              type="radio"
              name="brushType"
              value={type}
              checked={brushType === type}
              onChange={() => onUpdateBrushType(type)}
              className="sr-only"
            />
            <div
              className={`w-8 h-8 flex items-center justify-center border transition-all duration-200 text-xl ${
                brushType === type
                  ? "border-highlight bg-highlight text-white shadow-md"
                  : "border-main bg-main text-main hover:border-highlight hover:bg-highlight hover:text-white"
              }`}
            >
              <Icon icon={getToolIcon(type)} width={20} height={20} />
            </div>
          </label>
        )
      )}
    </div>
  );
};
