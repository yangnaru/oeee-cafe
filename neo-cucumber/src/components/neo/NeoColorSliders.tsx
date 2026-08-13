import { useCallback, useMemo, useRef } from "react";
import {
  NEO_BAR_LABEL,
  NEO_COLOR_SLIDER,
  NEO_COLOR_SLIDER_FILL,
  NEO_COLOR_SLIDER_HIT,
} from "./neoClasses";
import { NEO_SLIDER_COLORS } from "../../neo/toolboxSpec";

interface NeoColorSlidersProps {
  /** "#rrggbb" */
  color: string;
  /** 0-255 */
  alpha: number;
  onChange: (color: string, alpha: number) => void;
}

/** ColorSlider.update: the fill is the value scaled onto 49px, clamped to 48. */
function widthFor(value: number): number {
  return Math.max(Math.min(48, (value * 49.0) / 255.0), 1);
}

/**
 * Each channel has its own bar colour, from ColorSlider.init. Alpha's grey is
 * what tells it apart from the three it sits under.
 */
const CHANNELS = [
  { key: "r", prefix: "R", fill: NEO_SLIDER_COLORS.r },
  { key: "g", prefix: "G", fill: NEO_SLIDER_COLORS.g },
  { key: "b", prefix: "B", fill: NEO_SLIDER_COLORS.b },
  { key: "a", prefix: "A", fill: NEO_SLIDER_COLORS.a },
] as const;

type ChannelKey = (typeof CHANNELS)[number]["key"];

/**
 * NEO's four channel sliders, which together with the swatches are how it
 * picks a colour -- its toolbox has no colour picker.
 *
 * Alpha's floor is 1, not 0: a fully transparent brush would be a brush that
 * does nothing, so NEO refuses it (`min` in ColorSlider.slide).
 */
export function NeoColorSliders({
  color,
  alpha,
  onChange,
}: NeoColorSlidersProps) {
  const hits = useRef<Record<string, HTMLDivElement | null>>({});
  const dragging = useRef<ChannelKey | null>(null);
  /** Where the drag last sat inside the bar, for the relative phase below. */
  const anchor = useRef<{ value0: number; x0: number }>({ value0: 0, x0: 0 });

  const channels = useMemo(
    () => ({
      r: parseInt(color.slice(1, 3), 16),
      g: parseInt(color.slice(3, 5), 16),
      b: parseInt(color.slice(5, 7), 16),
      a: alpha,
    }),
    [color, alpha]
  );

  const setChannel = useCallback(
    (key: ChannelKey, value: number) => {
      const floor = key === "a" ? 1 : 0;
      const v = Math.max(floor, Math.min(255, Math.round(value)));
      const next = { ...channels, [key]: v };
      const hex = (n: number) => n.toString(16).padStart(2, "0");
      onChange(`#${hex(next.r)}${hex(next.g)}${hex(next.b)}`, next.a);
    },
    [channels, onChange]
  );

  /**
   * ColorSlider.slide, both halves of it.
   *
   * Inside the 60px hit area the value is read straight off the pointer:
   * x-5 scaled by 5 and snapped to a multiple of 5, which is why dragging
   * lands on round numbers. Once the pointer leaves, it switches to a slower
   * relative drag -- one step per three pixels from where it left -- so you
   * can fine-tune past either end instead of pinning to it.
   */
  const slide = (key: ChannelKey, clientX: number) => {
    const rect = hits.current[key]?.getBoundingClientRect();
    if (!rect) return;
    const x = clientX - rect.left;

    let value: number;
    if (x >= 0 && x < 60) {
      value = Math.round(Math.floor((x - 5) * 5.0) / 5) * 5;
      anchor.current = { value0: value, x0: x };
    } else {
      value = anchor.current.value0 + (x - anchor.current.x0) / 3.0;
    }
    setChannel(key, value);
  };

  return (
    <div>
      {CHANNELS.map(({ key, prefix, fill }) => {
        const value = channels[key];
        return (
          <div key={key} className={NEO_COLOR_SLIDER}>
            <div
              className={NEO_COLOR_SLIDER_FILL}
              style={{
                width: `${widthFor(value).toFixed(2)}px`,
                backgroundColor: fill,
              }}
            />
            <div className={NEO_BAR_LABEL}>
              {prefix}
              {value.toFixed(0)}
            </div>
            <div
              ref={(el) => {
                hits.current[key] = el;
              }}
              className={NEO_COLOR_SLIDER_HIT}
              role="slider"
              aria-label={prefix}
              aria-valuemin={key === "a" ? 1 : 0}
              aria-valuemax={255}
              aria-valuenow={value}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") setChannel(key, value + 1);
                if (e.key === "ArrowLeft") setChannel(key, value - 1);
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                dragging.current = key;
                anchor.current = { value0: value, x0: 0 };
                e.currentTarget.setPointerCapture(e.pointerId);
                slide(key, e.clientX);
              }}
              onPointerMove={(e) => {
                if (dragging.current === key) slide(key, e.clientX);
              }}
              onPointerUp={() => {
                dragging.current = null;
              }}
              onPointerCancel={() => {
                dragging.current = null;
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
