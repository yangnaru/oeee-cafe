import React from "react";

type BrushType = "solid" | "halftone" | "eraser" | "fill" | "pan";

interface ToolSelectorProps {
  brushType: BrushType;
  onUpdateBrushType: (type: BrushType) => void;
}

export const ToolSelector: React.FC<ToolSelectorProps> = ({
  brushType,
  onUpdateBrushType,
}) => {
  const getToolEmoji = (toolType: BrushType): string => {
    switch (toolType) {
      case "solid":
        return "🖌️";
      case "halftone":
        return "🖍️";
      case "eraser":
        return "🧹";
      case "fill":
        return "🪣";
      case "pan":
        return "🤚";
      default:
        return "🔧";
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
              {getToolEmoji(type)}
            </div>
          </label>
        )
      )}
    </div>
  );
};