import React from "react";
import { useLingui } from "@lingui/react/macro";

interface ColorPaletteProps {
  paletteColors: string[];
  selectedPaletteIndex: number;
  currentColor: string;
  onSetSelectedPaletteIndex: (index: number) => void;
  onUpdateColor: (color: string) => void;
  onColorPickerChange: (color: string) => void;
}

export const ColorPalette: React.FC<ColorPaletteProps> = ({
  paletteColors,
  selectedPaletteIndex,
  currentColor,
  onSetSelectedPaletteIndex,
  onUpdateColor,
  onColorPickerChange,
}) => {
  const { t } = useLingui();

  return (
    <div className="flex flex-col gap-1 p-1">
      <div className="grid grid-cols-2 grid-rows-7 grid-flow-col-dense">
        {paletteColors.map((paletteColor, index) => (
          <button
            key={index}
            className={`w-6 h-5 border border-main p-0 m-0.5 cursor-pointer transition-transform duration-100 hover:scale-105 hover:shadow-sm ${
              selectedPaletteIndex === index
                ? "shadow-black shadow-2xl scale-110 ring-2 ring-white ring-inset"
                : ""
            }`}
            style={{ backgroundColor: paletteColor }}
            onClick={() => {
              onSetSelectedPaletteIndex(index);
              onUpdateColor(paletteColor);
            }}
            title={
              selectedPaletteIndex === index
                ? t`Palette color ${
                    index + 1
                  } (selected - edit with color picker below)`
                : t`Palette color ${index + 1}`
            }
            data-color={paletteColor}
          />
        ))}
      </div>
      <input
        type="color"
        value={currentColor}
        onChange={(e) => onColorPickerChange(e.target.value)}
        aria-label={t`Custom color picker - edits selected palette color`}
        title={
          selectedPaletteIndex >= 0
            ? t`Edit palette color ${selectedPaletteIndex + 1}`
            : t`Custom color picker`
        }
        className="w-13 h-8 border-2 border-main cursor-pointer appearance-none bg-transparent [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-none [&::-moz-color-swatch]:border-none hover:border-highlight transition-colors mx-auto"
      />
    </div>
  );
};
