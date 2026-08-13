import { useCallback, useRef } from "react";
import { MAX_BRUSH_SIZE, MIN_BRUSH_SIZE } from "../../constants/drawing";
import {
  NEO_BAR_LABEL,
  NEO_SIZE_SLIDER,
  NEO_SIZE_SLIDER_FILL,
  NEO_SIZE_SLIDER_HIT,
} from "./neoClasses";

// The bar is 33px tall and its hit area starts 4px above it. Both numbers are
// in NEO's drag arithmetic, which is why they are here and not only in CSS.
const BAR = 33;
const OFFSET = 4;
const HIT_HEIGHT = 41;

/** SizeSlider.update: bar height is the value scaled onto 33px. */
function heightFor(value: number): number {
  return Math.max(Math.min(34, (value * BAR) / MAX_BRUSH_SIZE), 1);
}

/**
 * NEO's brush size slider.
 *
 * Dragging inside the box sets the size from the pointer's height directly;
 * dragging outside switches to a slower relative adjustment, one step per
 * seven pixels, so you can fine-tune past the ends without the value pinning
 * itself to the edge. Both formulas are SizeSlider.slide's.
 */
export function NeoSizeSlider({
  value,
  color,
  onChange,
}: {
  value: number;
  color: string;
  onChange: (value: number) => void;
}) {
  const hitRef = useRef<HTMLDivElement>(null);
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
        next = state.value0 + (y - state.y0) / 7.0;
      }
      onChange(clamp(next));
    },
    [onChange]
  );

  // Measured against the hit area, whose origin is 4px above the bar -- which
  // is where the "y - 4" in NEO's formula comes from.
  const yFrom = (clientY: number) =>
    clientY - (hitRef.current?.getBoundingClientRect().top ?? 0);

  const stop = () => {
    drag.current = null;
  };

  return (
    <div className={NEO_SIZE_SLIDER}>
      <div
        className={NEO_SIZE_SLIDER_FILL}
        style={{
          height: `${heightFor(value).toFixed(2)}px`,
          backgroundColor: color,
        }}
      />
      <div className={NEO_BAR_LABEL}>{value}px</div>
      <div
        ref={hitRef}
        className={NEO_SIZE_SLIDER_HIT}
        style={{ touchAction: "none" }}
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
        onPointerDown={(e) => {
          e.preventDefault();
          const y = yFrom(e.clientY);
          if (e.shiftKey) {
            // Shift nudges by one, as SizeSlider.shift does
            onChange(clamp(value + (y < OFFSET + BAR / 2 ? -1 : 1)));
            return;
          }
          drag.current = { value0: value, y0: y };
          e.currentTarget.setPointerCapture(e.pointerId);
          slide(y);
        }}
        onPointerMove={(e) => {
          if (drag.current) slide(yFrom(e.clientY));
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
      />
    </div>
  );
}
