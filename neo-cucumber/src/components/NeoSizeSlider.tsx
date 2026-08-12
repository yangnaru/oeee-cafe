import { useCallback, useRef } from "react";
import { MAX_BRUSH_SIZE, MIN_BRUSH_SIZE } from "../constants/drawing";

interface NeoSizeSliderProps {
  value: number;
  color: string;
  onChange: (value: number) => void;
}

// NEO's geometry, from neo.css and SizeSlider in widgets.js: a 48x33 bar that
// fills downward from the top, sitting 4px below the top of its hit area.
const WIDTH = 48;
const BAR = 33;
const OFFSET = 4;
const HIT_HEIGHT = 41;

/** NEO's SizeSlider.update: bar height is the value scaled onto 33px. */
function heightFor(value: number): number {
  return Math.max(Math.min(34, (value * BAR) / MAX_BRUSH_SIZE), 1);
}

/**
 * NEO's brush size slider rather than a range input.
 *
 * Dragging inside the box sets the size from the pointer's height directly;
 * dragging outside it switches to a slower relative adjustment -- one step per
 * seven pixels -- so you can fine-tune past the ends without the value pinning
 * itself to the edge. Both formulas are NEO's own.
 */
export function NeoSizeSlider({ value, color, onChange }: NeoSizeSliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ value0: number; y0: number } | null>(null);

  const clamp = (v: number) =>
    Math.max(MIN_BRUSH_SIZE, Math.min(MAX_BRUSH_SIZE, Math.round(v)));

  const slide = useCallback(
    (y: number) => {
      const state = drag.current;
      if (!state) return;
      let next: number;
      if (y >= 0 && y < HIT_HEIGHT) {
        // Inside the box: the pointer's height *is* the value
        next = Math.floor(((y - OFFSET) * MAX_BRUSH_SIZE) / BAR);
        drag.current = { value0: next, y0: y };
      } else {
        // Outside: a slower relative drag, one step per seven pixels
        next = state.value0 + (y - state.y0) / 7.0;
      }
      onChange(clamp(next));
    },
    [onChange]
  );

  const yFrom = (clientY: number) => {
    const rect = ref.current?.getBoundingClientRect();
    return clientY - (rect?.top ?? 0);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const y = yFrom(e.clientY);
    if (e.shiftKey) {
      // Shift nudges by one, as NEO's shift() does
      onChange(clamp(value + (y < OFFSET + BAR / 2 ? -1 : 1)));
      return;
    }
    drag.current = { value0: value, y0: y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    slide(y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    slide(yFrom(e.clientY));
  };

  const stop = () => {
    drag.current = null;
  };

  return (
    <div
      ref={ref}
      className="relative select-none"
      style={{ width: `${WIDTH}px`, height: `${HIT_HEIGHT}px`, cursor: "ns-resize" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      role="slider"
      aria-label="Brush size"
      aria-valuemin={MIN_BRUSH_SIZE}
      aria-valuemax={MAX_BRUSH_SIZE}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") onChange(clamp(value + 1));
        if (e.key === "ArrowDown") onChange(clamp(value - 1));
      }}
    >
      <div
        style={{
          position: "absolute",
          top: `${OFFSET}px`,
          left: 0,
          width: "100%",
          height: `${BAR}px`,
          backgroundColor: "#ffffff",
          border: "1px solid #9397b2",
          boxSizing: "border-box",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: `${OFFSET}px`,
          left: 0,
          width: "100%",
          height: `${heightFor(value).toFixed(2)}px`,
          backgroundColor: color,
          boxShadow: "0 -1px 0 0px rgba(0, 0, 0, 0.3) inset",
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
          pointerEvents: "none",
        }}
      >
        {value}px
      </div>
    </div>
  );
}
