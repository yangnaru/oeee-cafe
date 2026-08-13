/**
 * NEO's XOR overlay primitives, transcribed from Neo.Painter.
 *
 * Every cursor and preview NEO draws is XORed over the composited artwork:
 * `drawXORLine`, `drawXORRect`, `drawXOREllipse`, all funnelling into
 * `xorPixel` (`buf32[i] ^= c`) with `c` defaulting to `0xffffff` -- a plain
 * inversion. That is what keeps a preview legible over any drawing, and it is
 * not the same as `difference` compositing on a transparent overlay, which
 * agrees with XOR only where the backdrop is black or white.
 *
 * Colours are raw uint32 in little-endian RGBA order, so the low byte is red.
 * `0xffff7f` is r=7f g=ff b=ff, pale cyan -- not HTML yellow.
 */

/** The composited artwork a preview inverts against. */
export interface Backdrop {
  width: number;
  height: number;
  /** RGBA, bottom layer first. Hidden layers are simply left out. */
  layers: Uint8ClampedArray[];
}

/** NEO's default: a full inversion. */
export const XOR_WHITE = 0xffffff;

/**
 * The colour showing at one pixel: the layers composited over white, which is
 * what the canvas element sits on.
 */
export function backdropAt(
  backdrop: Backdrop,
  x: number,
  y: number
): { r: number; g: number; b: number } {
  let r = 255;
  let g = 255;
  let b = 255;
  const i = (y * backdrop.width + x) * 4;
  for (const layer of backdrop.layers) {
    const a = layer[i + 3] / 255;
    if (!a) continue;
    r = layer[i] * a + r * (1 - a);
    g = layer[i + 1] * a + g * (1 - a);
    b = layer[i + 2] * a + b * (1 - a);
  }
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

/**
 * Collects the pixels a preview touches and writes them once.
 *
 * NEO XORs straight into the destination canvas because it owns it and
 * repairs the damage afterwards. Ours is a separate overlay, so the XOR is
 * computed against the artwork here and the result written opaque -- same
 * pixels, without needing to undraw anything.
 *
 * Pixels are accumulated by XOR parity rather than merely collected. That
 * preserves Neo's cancellation when separate handle primitives cross while
 * still allowing the result to be written to a transparent overlay at once.
 */
export class XorOverlay {
  private readonly touched = new Set<number>();
  private readonly width: number;
  private readonly height: number;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly backdrop: Backdrop;
  private readonly colour: number;

  constructor(
    ctx: CanvasRenderingContext2D,
    backdrop: Backdrop,
    colour: number = XOR_WHITE
  ) {
    this.ctx = ctx;
    this.backdrop = backdrop;
    this.colour = colour;
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
  }

  plot(x: number, y: number): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    if (px >= this.backdrop.width || py >= this.backdrop.height) return;
    const key = py * this.width + px;
    // XOR is parity, not membership. Neo mutates the destination on every
    // primitive call, so two primitives crossing at a pixel cancel there.
    if (this.touched.has(key)) this.touched.delete(key);
    else this.touched.add(key);
  }

  /** Neo.Painter.drawXORLine: Bresenham, one pixel wide. */
  line(x0: number, y0: number, x1: number, y1: number): void {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);

    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = (dx > dy ? dx : -dy) / 2;

    for (;;) {
      this.plot(ax, ay);
      if (ax === bx && ay === by) break;
      const e2 = err;
      if (e2 > -dx) {
        err -= dy;
        ax += sx;
      }
      if (e2 < dy) {
        err += dx;
        ay += sy;
      }
    }
  }

  /** Neo.Painter.drawXORRect, both the outline and the filled form. */
  rect(
    x: number,
    y: number,
    width: number,
    height: number,
    isFill = false
  ): void {
    const left = Math.round(x);
    const top = Math.round(y);
    const w = Math.round(width);
    const h = Math.round(height);
    if (w === 0 || h === 0) return;

    if (isFill) {
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) this.plot(left + i, top + j);
      }
      return;
    }

    for (let i = 0; i < w; i++) this.plot(left + i, top);
    if (h > 1) {
      for (let j = 1; j < h; j++) this.plot(left, top + j);
      if (w > 1) {
        for (let j = 1; j < h - 1; j++) this.plot(left + w - 1, top + j);
        for (let i = 1; i < w; i++) this.plot(left + i, top + h - 1);
      }
    }
  }

  /**
   * Neo.Painter.drawXOREllipse. The arithmetic is NEO's, including `b1` being
   * reused as a step increment partway through.
   */
  ellipse(
    x: number,
    y: number,
    width: number,
    height: number,
    isFill = false
  ): void {
    const left = Math.round(x);
    const top = Math.round(y);
    const w = Math.round(width);
    const h = Math.round(height);
    if (w === 0 || h === 0) return;

    let a = w - 1;
    const b = h - 1;
    let b1 = b & 1;
    let dx = 4 * (1 - a) * b * b;
    let dy = 4 * (b1 + 1) * a * a;
    let err = dx + dy + b1 * a * a;
    let e2;

    let x0 = left;
    let y0 = top;
    let x1 = x0 + a;
    let y1 = y0 + b;

    if (x0 > x1) {
      x0 = x1;
      x1 += a;
    }
    if (y0 > y1) y0 = y1;
    y0 += Math.floor((b + 1) / 2);
    y1 = y0 - b1;
    a *= 8 * a;
    b1 = 8 * b * b;

    let ymin = y0 - 1;
    do {
      if (isFill) {
        if (ymin < y0) {
          for (let i = x0; i < x1; i++) this.plot(i, y0);
          if (y0 !== y1) for (let i = x0; i < x1; i++) this.plot(i, y1);
          ymin = y0;
        }
      } else {
        this.plot(x1, y0);
        if (x0 !== x1) this.plot(x0, y0);
        if (y0 !== y1) {
          this.plot(x0, y1);
          if (x0 !== x1) this.plot(x1, y1);
        }
      }
      e2 = 2 * err;
      if (e2 <= dy) {
        y0++;
        y1--;
        err += dy += a;
      }
      if (e2 >= dx || 2 * err > dy) {
        x0++;
        x1--;
        err += dx += b1;
      }
    } while (x0 <= x1);
  }

  /** Writes the collected pixels, inverted against the artwork. */
  commit(): void {
    if (this.touched.size === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const key of this.touched) {
      const x = key % this.width;
      const y = (key - x) / this.width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const image = this.ctx.createImageData(w, h);
    const data = image.data;

    const cr = this.colour & 0xff;
    const cg = (this.colour >> 8) & 0xff;
    const cb = (this.colour >> 16) & 0xff;

    for (const key of this.touched) {
      const x = key % this.width;
      const y = (key - x) / this.width;
      const under = backdropAt(this.backdrop, x, y);
      const i = ((y - minY) * w + (x - minX)) * 4;
      data[i] = under.r ^ cr;
      data[i + 1] = under.g ^ cg;
      data[i + 2] = under.b ^ cb;
      data[i + 3] = 255;
    }
    this.ctx.putImageData(image, minX, minY);
  }
}
