import { useCallback, useMemo, useRef } from "react";

// Geometry lives in neo.css; only the fill arithmetic is here.

interface NeoColorSlidersProps {
  /** "#rrggbb" */
  color: string;
  /** 0-255 */
  alpha: number;
  onChange: (color: string, alpha: number) => void;
}

/** NEO's ColorSlider.update: the fill is the value scaled onto 49px. */
function widthFor(value: number): number {
  return Math.max(Math.min(48, (value * 49.0) / 255.0), 1);
}

const CHANNELS = [
  { key: "r", prefix: "R" },
  { key: "g", prefix: "G" },
  { key: "b", prefix: "B" },
  { key: "a", prefix: "A" },
] as const;

/**
 * NEO's four channel sliders, which is how it picks a colour -- there is no
 * colour picker in its toolbox, just these and the fourteen swatches.
 *
 * Each is a bar you drag horizontally, labelled with its channel and value.
 */
export function NeoColorSliders({ color, alpha, onChange }: NeoColorSlidersProps) {
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragging = useRef<string | null>(null);

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
    (key: string, value: number) => {
      const v = Math.max(0, Math.min(255, Math.round(value)));
      const next = { ...channels, [key]: v };
      const hex = (n: number) => n.toString(16).padStart(2, "0");
      onChange(`#${hex(next.r)}${hex(next.g)}${hex(next.b)}`, next.a);
    },
    [channels, onChange]
  );

  const slide = (key: string, clientX: number) => {
    const rect = refs.current[key]?.getBoundingClientRect();
    if (!rect) return;
    // Inverting NEO's width formula: value = x * 255 / 49
    setChannel(key, ((clientX - rect.left) * 255.0) / 49.0);
  };

  return (
    <div>
      {CHANNELS.map(({ key, prefix }) => {
        const value = channels[key];
        return (
          // NEO's .colorSlider; only the fill width is set from script, as
          // NEO sets it
          <div
            key={key}
            ref={(el) => {
              refs.current[key] = el;
            }}
            className="colorSlider"
            role="slider"
            aria-label={prefix}
            aria-valuemin={0}
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
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
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
          >
            <div
              className="slider"
              style={{ width: `${widthFor(value).toFixed(2)}px` }}
            />
            <div className="label">
              {prefix}
              {value.toFixed(0)}
            </div>
          </div>
        );
      })}
      {/* NEO's reserveControl, which gives the last label's -3px somewhere
          to hang */}
      <div className="reserveControl" />
    </div>
  );
}
