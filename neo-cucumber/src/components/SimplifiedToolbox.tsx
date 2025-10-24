import { Trans } from "@lingui/react/macro";
import { CustomSlider } from "./CustomSlider";

interface SimplifiedToolboxProps {
  brushSize: number;
  paletteColors: string[]; // Should be [backgroundColor, foregroundColor]
  selectedPaletteIndex: number;
  canUndo: boolean;
  canRedo: boolean;
  isSaving: boolean;
  onBrushSizeChange: (size: number) => void;
  onColorSelect: (color: string) => void;
  onSetSelectedPaletteIndex: (index: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
}

export const SimplifiedToolbox = ({
  brushSize,
  paletteColors,
  selectedPaletteIndex,
  canUndo,
  canRedo,
  isSaving,
  onBrushSizeChange,
  onColorSelect,
  onSetSelectedPaletteIndex,
  onUndo,
  onRedo,
  onSave,
}: SimplifiedToolboxProps) => {
  const backgroundColor = paletteColors[0] || "#ffffff";
  const foregroundColor = paletteColors[1] || "#000000";

  const handleColorClick = (index: number) => {
    onSetSelectedPaletteIndex(index);
    onColorSelect(paletteColors[index]);
  };

  return (
    <div
      className="fixed right-4 top-20 bg-main border border-main p-4 flex flex-col gap-4"
      style={{
        width: "200px",
        zIndex: 1000,
      }}
    >
      {/* Pen Size Slider */}
      <div className="flex flex-col gap-2">
        <CustomSlider
          label={`Size: ${brushSize}`}
          min={1}
          max={30}
          value={brushSize}
          onChange={onBrushSizeChange}
        />
      </div>

      {/* Color Picker */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-semibold text-main">
          <Trans>Color</Trans>
        </label>
        <div className="flex gap-2">
          {/* Background Color */}
          <div
            className="flex flex-col items-center gap-1 cursor-pointer"
            onClick={() => handleColorClick(0)}
          >
            <div
              className="w-10 h-10 border border-main"
              style={{ backgroundColor }}
            />
            <input
              type="radio"
              name="color-picker"
              checked={selectedPaletteIndex === 0}
              onChange={() => handleColorClick(0)}
              className="cursor-pointer"
            />
          </div>

          {/* Foreground Color */}
          <div
            className="flex flex-col items-center gap-1 cursor-pointer"
            onClick={() => handleColorClick(1)}
          >
            <div
              className="w-10 h-10 border border-main"
              style={{ backgroundColor: foregroundColor }}
            />
            <input
              type="radio"
              name="color-picker"
              checked={selectedPaletteIndex === 1}
              onChange={() => handleColorClick(1)}
              className="cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Undo/Redo Buttons */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className="flex-1 px-4 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trans>Undo</Trans>
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          className="flex-1 px-4 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trans>Redo</Trans>
        </button>
      </div>

      {/* Save Button */}
      <button
        type="button"
        onClick={onSave}
        disabled={isSaving}
        className="px-4 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSaving ? <Trans>Saving...</Trans> : <Trans>Save Drawing</Trans>}
      </button>
    </div>
  );
};
