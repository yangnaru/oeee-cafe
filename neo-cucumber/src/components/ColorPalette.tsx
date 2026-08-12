import { useLingui } from "@lingui/react/macro";

interface ColorPaletteProps {
  /**
   * NEO's swatch block: 22x18 tips in a 48x144 grid, filled row by row, with
   * no backing panel and no picker -- its RGBA sliders are the picker.
   */
  retro?: boolean;
  paletteColors: string[];
  selectedPaletteIndex: number;
  currentColor: string;
  onSetSelectedPaletteIndex: (index: number) => void;
  onUpdateColor: (color: string) => void;
  onColorPickerChange: (color: string) => void;
}

export const ColorPalette = ({
  paletteColors,
  selectedPaletteIndex,
  currentColor,
  onSetSelectedPaletteIndex,
  onUpdateColor,
  onColorPickerChange,
  retro = false,
}: ColorPaletteProps) => {
  const { t } = useLingui();

  return (
    <div className={retro ? "" : "flex flex-col gap-1"}>
      <div className={retro ? "" : "border border-main bg-main p-1"}
           style={retro ? { width: "48px", marginTop: "4px" } : undefined}>
        <div
          className={
            retro
              ? "grid grid-cols-2"
              : "grid grid-cols-2 grid-rows-7 grid-flow-col-dense gap-0.5"
          }
          style={retro ? { gap: "1px" } : undefined}
        >
          {paletteColors.map((paletteColor, index) => (
            <button
              key={index}
              className={
                retro
                  ? `cursor-pointer ${
                      selectedPaletteIndex === index ? "neo-swatch-on" : ""
                    }`
                  : `w-6 h-5 border border-main cursor-pointer hover:bg-highlight transition-colors ${
                      selectedPaletteIndex === index
                        ? "ring-2 ring-inset ring-highlight"
                        : ""
                    }`
              }
              style={
                retro
                  ? {
                      backgroundColor: paletteColor,
                      width: "22px",
                      height: "18px",
                    }
                  : { backgroundColor: paletteColor }
              }
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
      </div>
      {/* NEO has no picker: its RGBA sliders are how you mix a colour */}
      {!retro && (
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
        className="w-full h-8 border border-main bg-main cursor-pointer appearance-none [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-none [&::-moz-color-swatch]:border-none hover:bg-highlight transition-colors"
      />
      )}
    </div>
  );
};
