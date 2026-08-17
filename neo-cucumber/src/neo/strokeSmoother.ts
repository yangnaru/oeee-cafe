/**
 * A sliding-average smoother for pointer input, transcribed from Drawpile's
 * `smoother_get` / `smoother_stroke_to` / `smoother_drain`
 * (`drawdance/libengine/dpengine/brush_engine.c`).
 *
 * Why this rather than the throttle it replaces. Pointer input arrives fast
 * and jittery -- a pen reports at up to a few hundred hertz and every sample
 * carries a little tremor. Dropping samples on a timer, which is what this
 * painter used to do, throws away the fast ones: it is during a quick flick
 * that the samples matter most, and that is exactly when a 12ms gate discards
 * two thirds of them and leaves a polygon behind. Averaging keeps every sample
 * and spends them on a steadier line instead.
 *
 * This is free with respect to the replay format. A `.pch` frame stores the
 * points of a stroke and NEO draws segments between whichever points are
 * there; smoothing changes which points we record, not how they are read back.
 *
 * The average is kept in floating point but every point handed out is rounded,
 * because a canvas coordinate is a whole pixel everywhere else in this
 * codebase. The recorder rounds what it writes into the frame, so emitting
 * anything else here would draw one line and replay a different one -- and
 * NEO's own Bresenham walk, which steps by exactly one pixel and stops on
 * `x0 === x1`, does not terminate at all if it is handed a fraction.
 */

export interface SmoothPoint {
  x: number;
  y: number;
}

/**
 * How many samples the average spans by default.
 *
 * Drawpile's `DEFAULT_SMOOTHING`. It uses 3 on desktop and 0 on Android,
 * because touch digitisers already deliver a smoothed stream and averaging a
 * second time only adds lag -- `strokeSmootherSizeFor` applies the same rule.
 */
export const DEFAULT_SMOOTHING = 3;

/** Drawpile's `MAX_SMOOTHING`; past this a stroke lags visibly behind the pen. */
export const MAX_SMOOTHING = 20;

/** How much smoothing a pointer of this kind wants. */
export function strokeSmootherSizeFor(pointerType: string): number {
  return pointerType === "touch" ? 0 : DEFAULT_SMOOTHING;
}

/**
 * Averages the last `size` samples of one stroke.
 *
 * Feed every sample to `push` and draw what it returns. At the end call
 * `drain` and draw those too: the average trails the pen by half the window,
 * and draining walks it the rest of the way so the stroke ends where the pen
 * did rather than short of it.
 */
export class StrokeSmoother {
  private readonly size: number;
  private readonly points: SmoothPoint[];
  /** How many real samples have arrived, capped at `size`. */
  private fill = 0;
  /** Where the newest sample sits; the ring runs backwards from here. */
  private offset = 0;

  constructor(size: number = DEFAULT_SMOOTHING) {
    this.size = Math.max(0, Math.min(MAX_SMOOTHING, Math.floor(size)));
    this.points = new Array(this.size);
  }

  /** True when this smoother does nothing, so callers can skip the work. */
  get disabled(): boolean {
    return this.size === 0;
  }

  /** Forgets the stroke so far. Call at every pointer-down. */
  reset(): void {
    this.fill = 0;
    this.offset = 0;
  }

  /** Takes a sample and returns the whole-pixel point to draw for it. */
  push(x: number, y: number): SmoothPoint {
    if (this.size === 0) return { x: Math.round(x), y: Math.round(y) };

    if (this.fill === 0) {
      // Pad the window with the first sample so the average starts exactly
      // under the pen and blends away from it as real samples arrive. Only one
      // of these counts as real, so `drain` knows how much it has to work off.
      for (let i = 0; i < this.size; i++) this.points[i] = { x, y };
    } else {
      this.offset = this.offset === 0 ? this.size - 1 : this.offset - 1;
      this.points[this.offset] = { x, y };
    }
    if (this.fill < this.size) this.fill++;

    return this.average();
  }

  /**
   * The points still owed at the end of a stroke.
   *
   * The window is drained by overwriting its oldest sample with its newest,
   * one at a time, which walks the average up to the last real sample --
   * mirroring how `push` pads it at the start.
   */
  drain(): SmoothPoint[] {
    const out: SmoothPoint[] = [];
    if (this.size === 0 || this.fill <= 1) return out;

    let fill = this.fill;
    this.overwriteOldest(fill);
    fill--;
    while (fill > 0) {
      out.push(this.average());
      this.overwriteOldest(fill);
      fill--;
    }
    return out;
  }

  private overwriteOldest(fill: number): void {
    this.points[(this.offset + fill - 1) % this.size] = this.points[this.offset];
  }

  /**
   * The mean of the window, snapped to a whole pixel.
   *
   * The window itself holds the raw samples -- rounding those first would
   * quantise away the sub-pixel motion that makes the average smooth.
   */
  private average(): SmoothPoint {
    let x = 0;
    let y = 0;
    for (let i = 0; i < this.size; i++) {
      x += this.points[i].x;
      y += this.points[i].y;
    }
    return { x: Math.round(x / this.size), y: Math.round(y / this.size) };
  }
}
