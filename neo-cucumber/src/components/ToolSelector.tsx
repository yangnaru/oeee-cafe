import { Icon } from "@iconify/react";

type BrushType = "solid" | "halftone" | "eraser" | "fill" | "pan";

interface ToolSelectorProps {
  brushType: BrushType;
  onUpdateBrushType: (type: BrushType) => void;
}

export const ToolSelector = ({
  brushType,
  onUpdateBrushType,
}: ToolSelectorProps) => {
  const getToolIcon = (toolType: BrushType): string => {
    switch (toolType) {
      case "solid":
        return "material-symbols:brush";
      case "halftone":
        return "material-symbols:shower";
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
    <div className="flex flex-col gap-2">
      {(["solid", "halftone", "eraser", "fill", "pan"] as BrushType[]).map(
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
              className={`w-8 h-8 flex items-center justify-center border-2 transition-all duration-200 text-xl ${
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
