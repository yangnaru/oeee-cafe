import { NeoReplay } from "../neo/NeoReplay";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = any[];

/** Delay per step, in milliseconds. NEO offers a comparable spread. */
export const SPEEDS = [
  { label: "×4", delay: 0 },
  { label: "×2", delay: 4 },
  { label: "×1", delay: 12 },
  { label: "×½", delay: 30 },
] as const;

export const DEFAULT_SPEED_INDEX = 2;

export interface PlayerState {
  position: number;
  total: number;
  playing: boolean;
  finished: boolean;
}

/**
 * Drives a NeoReplay forward one step at a time onto a visible canvas.
 *
 * Stepping backwards means replaying from the start, which is cheap -- a whole
 * archived drawing renders in a fraction of a second -- and avoids keeping
 * snapshots around.
 */
export class ReplayPlayer {
  readonly total: number;

  private readonly steps: { frame: number; step: number }[] = [];
  private replay: NeoReplay;
  private position = 0;
  private playing = false;
  private timer: number | null = null;
  private delay: number = SPEEDS[DEFAULT_SPEED_INDEX].delay;
  private disposed = false;

  private readonly items: Frame[];
  private readonly width: number;
  private readonly height: number;
  private readonly display: CanvasRenderingContext2D;
  private readonly onChange: (state: PlayerState) => void;

  constructor(
    items: Frame[],
    width: number,
    height: number,
    display: CanvasRenderingContext2D,
    onChange: (state: PlayerState) => void
  ) {
    this.width = width;
    this.height = height;
    this.display = display;
    this.onChange = onChange;

    // Restore frames hold the finished drawing as a PNG. Replaying the strokes
    // is the point here, so they are skipped rather than short-circuiting it.
    this.items = items.filter((item) => item[0] !== "restore");

    for (let f = 0; f < this.items.length; f++) {
      const count = NeoReplay.stepsFor(this.items[f]);
      for (let s = 0; s < count; s++) this.steps.push({ frame: f, step: s });
    }
    this.total = this.steps.length;

    this.replay = new NeoReplay(width, height);
    this.paint();
  }

  getState(): PlayerState {
    return {
      position: this.position,
      total: this.total,
      playing: this.playing,
      finished: this.position >= this.total,
    };
  }

  private notify(): void {
    if (!this.disposed) this.onChange(this.getState());
  }

  /** White ground, then background layer, then foreground, as NEO composites. */
  private paint(): void {
    const { width, height } = this;
    this.display.clearRect(0, 0, width, height);
    this.display.fillStyle = "#ffffff";
    this.display.fillRect(0, 0, width, height);
    this.display.drawImage(this.replay.painter.canvas[0], 0, 0);
    this.display.drawImage(this.replay.painter.canvas[1], 0, 0);
  }

  private async advance(): Promise<boolean> {
    if (this.position >= this.total) return false;
    const { frame, step } = this.steps[this.position];
    await this.replay.applyStep(this.items[frame], step);
    this.position++;
    return true;
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.tick(), this.delay);
  }

  private async tick(): Promise<void> {
    if (!this.playing || this.disposed) return;

    // At the fastest setting a single timer callback would crawl, so batch
    // until a frame's worth of time has gone by.
    const started = performance.now();
    let drew = false;
    do {
      if (!(await this.advance())) break;
      drew = true;
    } while (this.delay === 0 && performance.now() - started < 12);

    this.paint();

    if (!drew || this.position >= this.total) {
      this.playing = false;
      this.notify();
      return;
    }
    this.notify();
    this.schedule();
  }

  play(): void {
    if (this.disposed || this.playing) return;
    if (this.position >= this.total) {
      void this.seekTo(0).then(() => {
        this.playing = true;
        this.notify();
        this.schedule();
      });
      return;
    }
    this.playing = true;
    this.notify();
    this.schedule();
  }

  pause(): void {
    this.playing = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.notify();
  }

  setSpeed(delay: number): void {
    this.delay = delay;
    if (this.playing) this.schedule();
  }

  /** Jumps to a step, replaying from the start when moving backwards. */
  async seekTo(target: number): Promise<void> {
    const clamped = Math.max(0, Math.min(this.total, Math.round(target)));

    if (clamped < this.position) {
      this.replay = new NeoReplay(this.width, this.height);
      this.position = 0;
    }
    while (this.position < clamped) {
      if (!(await this.advance())) break;
    }
    this.paint();
    this.notify();
  }

  async rewind(): Promise<void> {
    this.pause();
    await this.seekTo(0);
  }

  /** Draws the whole thing immediately, skipping the animation. */
  async skipToEnd(): Promise<void> {
    this.pause();
    await this.seekTo(this.total);
  }

  dispose(): void {
    this.disposed = true;
    this.playing = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
  }
}
