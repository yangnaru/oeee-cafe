import { NEO_COLORTIP_SPRITE } from "../../neo/toolIcons";
import {
  NEO_COLORTIP,
  NEO_COLORTIPS,
  NEO_COLORTIP_SPRITE_IMG,
} from "./neoClasses";

interface NeoColorTipsProps {
  /** Fourteen colours in display order: left to right, top to bottom. */
  paletteColors: string[];
  selectedPaletteIndex: number;
  onSelect: (index: number, color: string) => void;
  /** NEO's right-click: overwrite the swatch with the drawing colour. */
  onOverwrite: (index: number) => void;
}

/**
 * NEO's fourteen colour swatches.
 *
 * They are placed rather than laid out, at the coordinates ColorTip.init
 * computes: odd indices at x=26 and even at x=0, 21px apart vertically. NEO
 * writes its markup in the order color2, color1, color4, color3 ... and then
 * positions the pair back into reading order, so the two cancel out and this
 * takes the palette in display order.
 *
 * There is no colour picker: the swatches and the RGBA sliders are the picker.
 */
export function NeoColorTips({
  paletteColors,
  selectedPaletteIndex,
  onSelect,
  onOverwrite,
}: NeoColorTipsProps) {
  return (
    <div className={NEO_COLORTIPS}>
      {paletteColors.map((paletteColor, index) => {
        const selected = selectedPaletteIndex === index;
        return (
          <button
            key={index}
            type="button"
            className={NEO_COLORTIP}
            style={{
              backgroundColor: paletteColor,
              left: index % 2 ? 26 : 0,
              top: Math.floor(index / 2) * 21,
            }}
            title={`Palette colour ${index + 1} — right-click to overwrite`}
            aria-pressed={selected}
            data-color={paletteColor}
            onPointerDown={(e) => {
              if (e.button === 2) return;
              onSelect(index, paletteColor);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onOverwrite(index);
            }}
          >
            {/*
              One sprite holds both states: the raised bevel at x=0 and the
              pressed one at x=-22. At half opacity the swatch colour shows
              through, so a single image works over black and white alike.
            */}
            <img
              src={NEO_COLORTIP_SPRITE}
              alt=""
              className={NEO_COLORTIP_SPRITE_IMG}
              style={{ left: selected ? -22 : 0 }}
            />
          </button>
        );
      })}
    </div>
  );
}
