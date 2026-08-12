import { useCallback, useMemo, useRef } from "react";

// NEO's .colorSlider: 48x13 with 3px above it, filling left to right.
const WIDTH = 48;
const HEIGHT = 13;
const GAP = 3;

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
          <div
            key={key}
            ref={(el) => {
              refs.current[key] = el;
            }}
            className="relative select-none"
            style={{
              width: `${WIDTH}px`,
              height: `${HEIGHT}px`,
              marginTop: `${GAP}px`,
              cursor: "ew-resize",
            }}
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
              style={{
                position: "absolute",
                inset: 0,
                backgroundColor: "var(--neo-tool-bar, #ddddff)",
                border: "1px solid var(--neo-shadow, #8f8fb3)",
                boxSizing: "border-box",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                height: "100%",
                width: `${widthFor(value).toFixed(2)}px`,
                backgroundColor: "#fa9696",
                boxShadow: "-1px 0 0 0px rgba(0, 0, 0, 0.3) inset",
                pointerEvents: "none",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: "2px",
                bottom: "-3px",
                fontSize: "12px",
                fontFamily: "Arial",
                letterSpacing: 0,
                color: "var(--neo-tool-text, #773333)",
                whiteSpace: "nowrap",
                pointerEvents: "none",
              }}
            >
              {prefix}
              {value.toFixed(0)}
            </div>
          </div>
        );
      })}
      {/* NEO's reserveControl sits after the sliders and gives the last
          label's -3px somewhere to hang */}
      <div style={{ height: "4px" }} />
    </div>
  );
}
