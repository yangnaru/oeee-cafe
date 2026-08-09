/**
 * A TypeScript transcription of PaintBBS NEO's rasterisation, from
 * neo/src/painter.js.
 *
 * This is deliberately a transcription and not a reimplementation. Archived
 * .pch replays were produced by that code, so reproducing them means
 * reproducing its arithmetic exactly -- including behaviour that looks like a
 * mistake. Places where upstream does something surprising are marked "NEO
 * quirk" and must not be tidied up: every one of them is load-bearing for some
 * file in the archive. The differential tests in DrawingEngine.browser.test.ts
 * and neoReplay.browser.test.ts check this against the real thing.
 */

export const LINETYPE = {
  NONE: 0,
  PEN: 1,
  ERASER: 2,
  BRUSH: 3,
  TONE: 4,
  DODGE: 5,
  BURN: 6,
  BLUR: 7,
} as const;

export const MASKTYPE = {
  NONE: 0,
  NORMAL: 1,
  REVERSE: 2,
  ADD: 3,
  SUB: 4,
} as const;

export const ALPHATYPE = {
  PEN: 0,
  FILL: 1,
  BRUSH: 2,
} as const;

export type Point = [number, number];

export class NeoPainter {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly canvasCtx: CanvasRenderingContext2D[];
  readonly canvas: HTMLCanvasElement[];

  current = 0;

  _currentColor: [number, number, number, number] = [0, 0, 0, 255];
  _currentMask: [number, number, number] = [0, 0, 0];
  _currentWidth = 1;
  _currentMaskType: number = MASKTYPE.NONE;

  aerr = 0;
  prevLine: [Point, Point] | null = null;

  private readonly roundData: Uint8Array[] = [];
  private readonly toneData: Uint8Array[] = [];

  /** Clipboard for copy/paste. */
  private clipboard: ImageData | null = null;

  constructor(width: number, height: number) {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.canvas = [];
    this.canvasCtx = [];

    for (let i = 0; i < 2; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("2d context unavailable");
      this.canvas.push(canvas);
      this.canvasCtx.push(ctx);
    }

    this.initRoundData();
    this.initToneData();
  }

  // ---------------------------------------------------------------- shapes

  private initRoundData(): void {
    for (let r = 1; r <= 30; r++) {
      this.roundData[r] = new Uint8Array(r * r);
      const mask = this.roundData[r];
      let index = 0;
      for (let x = 0; x < r; x++) {
        for (let y = 0; y < r; y++) {
          const xx = x + 0.5 - r / 2.0;
          const yy = y + 0.5 - r / 2.0;
          mask[index++] = xx * xx + yy * yy <= (r * r) / 4 ? 1 : 0;
        }
      }
    }
    this.roundData[3][0] = 0;
    this.roundData[3][2] = 0;
    this.roundData[3][6] = 0;
    this.roundData[3][8] = 0;

    this.roundData[5][1] = 0;
    this.roundData[5][3] = 0;
    this.roundData[5][5] = 0;
    this.roundData[5][9] = 0;
    this.roundData[5][15] = 0;
    this.roundData[5][19] = 0;
    this.roundData[5][21] = 0;
    this.roundData[5][23] = 0;
  }

  private initToneData(): void {
    const pattern = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let i = 0; i < 16; i++) {
      this.toneData[i] = new Uint8Array(16);
      for (let j = 0; j < 16; j++) {
        this.toneData[i][j] = i >= pattern[j] ? 1 : 0;
      }
    }
  }

  private getToneData(alpha: number): Uint8Array {
    const alphaTable = [
      23, 47, 69, 92, 114, 114, 114, 138, 161, 184, 184, 207, 230, 230, 253,
    ];
    for (let i = 0; i < alphaTable.length; i++) {
      if (alpha < alphaTable[i]) return this.toneData[i];
    }
    return this.toneData[alphaTable.length];
  }

  // ---------------------------------------------------------------- colour

  getAlpha(type: number): number {
    let a1 = this._currentColor[3] / 255.0;

    switch (type) {
      case ALPHATYPE.PEN:
        if (a1 > 0.5) {
          a1 = 1.0 / 16 + ((a1 - 0.5) * 30.0) / 16;
        } else {
          a1 = Math.sqrt(2 * a1) / 16.0;
        }
        a1 = Math.min(1, Math.max(0, a1));
        break;

      case ALPHATYPE.FILL:
        a1 = -0.00056 * a1 + 0.0042 / (1.0 - a1) - 0.0042;
        a1 = Math.min(1.0, Math.max(0, a1 * 10));
        break;

      case ALPHATYPE.BRUSH:
        a1 = -0.00056 * a1 + 0.0042 / (1.0 - a1) - 0.0042;
        a1 = Math.min(1.0, Math.max(0, a1));
        break;
    }

    // Thin alphas are dithered by dropping points to match apparent density
    if (a1 < 1.0 / 255) {
      this.aerr += a1;
      a1 = 0;
      while (this.aerr > 1.0 / 255) {
        a1 = 1.0 / 255;
        this.aerr -= 1.0 / 255;
      }
    }
    return a1;
  }

  sortColor(r0: number, g0: number, b0: number): [number, number, number] {
    const min = r0 < g0 ? (r0 < b0 ? 0 : 2) : g0 < b0 ? 1 : 2;
    const max = r0 > g0 ? (r0 > b0 ? 0 : 2) : g0 > b0 ? 1 : 2;
    const mid = min + max === 1 ? 2 : min + max === 2 ? 1 : 0;
    return [min, mid, max];
  }

  isMasked(buf8: Uint8ClampedArray, index: number): boolean {
    const r = this._currentMask[0];
    const g = this._currentMask[1];
    const b = this._currentMask[2];

    let r0 = buf8[index + 0];
    let g0 = buf8[index + 1];
    let b0 = buf8[index + 2];
    const a0 = buf8[index + 3];

    if (a0 === 0) {
      r0 = 0xff;
      g0 = 0xff;
      b0 = 0xff;
    }

    let type = this._currentMaskType;

    // NEO quirk: add/sub masking is not reproducible at partial alpha upstream,
    // so it is simply ignored there. Keep ignoring it the same way.
    if (type === MASKTYPE.ADD || type === MASKTYPE.SUB) {
      if (this._currentColor[3] < 250) {
        type = MASKTYPE.NONE;
      }
    }

    switch (type) {
      case MASKTYPE.NONE:
        return false;

      case MASKTYPE.NORMAL:
        return r0 === r && g0 === g && b0 === b;

      case MASKTYPE.REVERSE:
        return r0 !== r || g0 !== g || b0 !== b;

      case MASKTYPE.ADD:
        if (a0 > 0) {
          const sort = this.sortColor(r0, g0, b0);
          for (let i = 0; i < 3; i++) {
            const c = sort[i];
            if (buf8[index + c] < this._currentColor[c]) return true;
          }
          return false;
        }
        return false;

      case MASKTYPE.SUB:
        if (a0 > 0) {
          const sort = this.sortColor(r0, g0, b0);
          for (let i = 0; i < 3; i++) {
            const c = sort[i];
            if (buf8[index + c] > this._currentColor[c]) return true;
          }
          return false;
        }
        return true;
    }
    return false;
  }

  // -------------------------------------------------------------- geometry

  getBound(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r: number
  ): [number, number, number, number] {
    let left = Math.floor(x0 < x1 ? x0 : x1);
    let top = Math.floor(y0 < y1 ? y0 : y1);
    let width = Math.ceil(Math.abs(x0 - x1));
    let height = Math.ceil(Math.abs(y0 - y1));
    r = Math.ceil(r + 1);

    if (!r) {
      width += 1;
      height += 1;
    } else {
      left -= r;
      top -= r;
      width += r * 2;
      height += r * 2;
    }
    return [left, top, width, height];
  }

  /**
   * Reads the affected sub-rectangle, hands it to the callback, writes it
   * back. NEO works on a padded window rather than the whole layer, and the
   * padding is what keeps brush stamps near the edges from wrapping.
   */
  private draw(
    ctx: CanvasRenderingContext2D,
    points: Point[],
    callback: (
      left: number,
      top: number,
      width: number,
      height: number,
      buf8: Uint8ClampedArray,
      imageData: ImageData
    ) => void
  ): void {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const point of points) {
      xs.push(Math.round(point[0]));
      ys.push(Math.round(point[1]));
    }
    const xmin = Math.min(...xs);
    const xmax = Math.max(...xs);
    const ymin = Math.min(...ys);
    const ymax = Math.max(...ys);

    const r = Math.ceil(this._currentWidth / 2);
    const left = xmin - r;
    const top = ymin - r;
    const width = xmax - xmin;
    const height = ymax - ymin;

    const imageData = ctx.getImageData(
      left,
      top,
      width + r * 2,
      height + r * 2
    );
    const buf8 = new Uint8ClampedArray(imageData.data.buffer);

    callback(left, top, width, height, buf8, imageData);

    imageData.data.set(buf8);
    ctx.putImageData(imageData, left, top);
  }

  private bresenham(points: [Point, Point], callback: (x: number, y: number) => void): void {
    let x0 = points[0][0];
    let y0 = points[0][1];
    const x1 = points[1][0];
    const y1 = points[1][1];

    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = (dx > dy ? dx : -dy) / 2;

    for (;;) {
      // A stroke's segments share endpoints; plotting them twice would double
      // up the alpha, so the previous segment's ends are skipped.
      if (
        this.prevLine === null ||
        !(
          (this.prevLine[0][0] === x0 && this.prevLine[0][1] === y0) ||
          (this.prevLine[1][0] === x0 && this.prevLine[1][1] === y0)
        )
      ) {
        callback(x0, y0);
      }

      if (x0 === x1 && y0 === y1) break;
      const e2 = err;
      if (e2 > -dx) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dy) {
        err += dx;
        y0 += sy;
      }
    }
    this.prevLine = points;
  }

  // --------------------------------------------------------------- kernels

  private setPoint(
    buf8: Uint8ClampedArray,
    bufWidth: number,
    x0: number,
    y0: number,
    left: number,
    top: number,
    type: number
  ): void {
    const x = x0 - left;
    const y = y0 - top;

    switch (type) {
      case LINETYPE.PEN:
        this.setPenPoint(buf8, bufWidth, x, y);
        break;
      case LINETYPE.BRUSH:
        this.setBrushPoint(buf8, bufWidth, x, y);
        break;
      case LINETYPE.TONE:
        this.setTonePoint(buf8, bufWidth, x, y, x0, y0);
        break;
      case LINETYPE.ERASER:
        this.setEraserPoint(buf8, bufWidth, x, y);
        break;
      case LINETYPE.BLUR:
        this.setBlurPoint(buf8, bufWidth, x, y, x0, y0);
        break;
      case LINETYPE.DODGE:
        this.setDodgePoint(buf8, bufWidth, x, y);
        break;
      case LINETYPE.BURN:
        this.setBurnPoint(buf8, bufWidth, x, y);
        break;
      default:
        break;
    }
  }

  private setPenPoint(buf8: Uint8ClampedArray, width: number, x: number, y: number): void {
    const d = this._currentWidth;
    const r0i = Math.floor(d / 2);
    x -= r0i;
    y -= r0i;

    let index = (y * width + x) * 4;
    const shape = this.roundData[d];
    let shapeIndex = 0;

    const r1 = this._currentColor[0];
    const g1 = this._currentColor[1];
    const b1 = this._currentColor[2];
    const a1 = this.getAlpha(ALPHATYPE.PEN);
    if (a1 === 0) return;

    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        if (shape[shapeIndex++] && !this.isMasked(buf8, index)) {
          const r0 = buf8[index + 0];
          const g0 = buf8[index + 1];
          const b0 = buf8[index + 2];
          const a0 = buf8[index + 3] / 255.0;

          let a = a0 + a1 - a0 * a1;
          let r = r0;
          let g = g0;
          let b = b0;
          if (a > 0) {
            const a1x = Math.max(a1, 1.0 / 255);
            r = (r1 * a1x + r0 * a0 * (1 - a1x)) / a;
            g = (g1 * a1x + g0 * a0 * (1 - a1x)) / a;
            b = (b1 * a1x + b0 * a0 * (1 - a1x)) / a;

            r = r1 > r0 ? Math.ceil(r) : Math.floor(r);
            g = g1 > g0 ? Math.ceil(g) : Math.floor(g);
            b = b1 > b0 ? Math.ceil(b) : Math.floor(b);
          }
          a = Math.ceil(a * 255);

          buf8[index + 0] = r;
          buf8[index + 1] = g;
          buf8[index + 2] = b;
          buf8[index + 3] = a;
        }
        index += 4;
      }
      index += (width - d) * 4;
    }
  }

  private setBrushPoint(buf8: Uint8ClampedArray, width: number, x: number, y: number): void {
    const d = this._currentWidth;
    const r0i = Math.floor(d / 2);
    x -= r0i;
    y -= r0i;

    let index = (y * width + x) * 4;
    const shape = this.roundData[d];
    let shapeIndex = 0;

    const r1 = this._currentColor[0];
    const g1 = this._currentColor[1];
    const b1 = this._currentColor[2];
    const a1 = this.getAlpha(ALPHATYPE.BRUSH);
    if (a1 === 0) return;

    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        if (shape[shapeIndex++] && !this.isMasked(buf8, index)) {
          const r0 = buf8[index + 0];
          const g0 = buf8[index + 1];
          const b0 = buf8[index + 2];
          const a0 = buf8[index + 3] / 255.0;

          let a = a0 + a1 - a0 * a1;
          let r = r0;
          let g = g0;
          let b = b0;
          if (a > 0) {
            const a1x = Math.max(a1, 1.0 / 255);
            // NEO quirk: the brush divides by (a0 + a1x), not by the composite
            // alpha the pen uses, and omits the (1 - a1x) weighting.
            r = (r1 * a1x + r0 * a0) / (a0 + a1x);
            g = (g1 * a1x + g0 * a0) / (a0 + a1x);
            b = (b1 * a1x + b0 * a0) / (a0 + a1x);

            r = r1 > r0 ? Math.ceil(r) : Math.floor(r);
            g = g1 > g0 ? Math.ceil(g) : Math.floor(g);
            b = b1 > b0 ? Math.ceil(b) : Math.floor(b);
          }
          a = Math.ceil(a * 255);

          buf8[index + 0] = r;
          buf8[index + 1] = g;
          buf8[index + 2] = b;
          buf8[index + 3] = a;
        }
        index += 4;
      }
      index += (width - d) * 4;
    }
  }

  private setTonePoint(
    buf8: Uint8ClampedArray,
    width: number,
    x: number,
    y: number,
    x0: number,
    y0: number
  ): void {
    const d = this._currentWidth;
    const r0i = Math.floor(d / 2);

    x -= r0i;
    y -= r0i;
    x0 -= r0i;
    y0 -= r0i;

    const shape = this.roundData[d];
    let shapeIndex = 0;
    let index = (y * width + x) * 4;

    const r = this._currentColor[0];
    const g = this._currentColor[1];
    const b = this._currentColor[2];
    const a = this._currentColor[3];

    const toneData = this.getToneData(a);

    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        if (shape[shapeIndex++] && !this.isMasked(buf8, index)) {
          if (toneData[((y0 + i) % 4) + ((x0 + j) % 4) * 4]) {
            buf8[index + 0] = r;
            buf8[index + 1] = g;
            buf8[index + 2] = b;
            buf8[index + 3] = 255;
          }
        }
        index += 4;
      }
      index += (width - d) * 4;
    }
  }

  private setEraserPoint(buf8: Uint8ClampedArray, width: number, x: number, y: number): void {
    const d = this._currentWidth;
    const r0i = Math.floor(d / 2);
    x -= r0i;
    y -= r0i;

    const shape = this.roundData[d];
    let shapeIndex = 0;
    let index = (y * width + x) * 4;
    const a = Math.floor(this._currentColor[3]);

    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        if (shape[shapeIndex++] && !this.isMasked(buf8, index)) {
          // NEO quirk: erase strength is divided by the brush diameter, so a
          // fat eraser removes less alpha per pixel than a thin one.
          buf8[index + 3] -= a / ((d * (255.0 - a)) / 255.0);
        }
        index += 4;
      }
      index += (width - d) * 4;
    }
  }

  private setBlurPoint(
    buf8: Uint8ClampedArray,
    width: number,
    x: number,
    y: number,
    x0: number,
    y0: number
  ): void {
    const d = this._currentWidth;
    const r0i = Math.floor(d / 2);
    x -= r0i;
    y -= r0i;

    const shape = this.roundData[d];
    let shapeIndex = 0;

    const a1 = this._currentColor[3] / 255.0 / 12;
    if (a1 === 0) return;
    const blur = a1;

    const tmp = new Uint8ClampedArray(buf8.length);
    for (let i = 0; i < buf8.length; i++) tmp[i] = buf8[i];

    const left = x0 - x - r0i;
    const top = y0 - y - r0i;

    let xstart = 0;
    let xend = d;
    let ystart = 0;
    let yend = d;
    if (xstart > left) xstart = -left;
    if (ystart > top) ystart = -top;
    if (xend > this.canvasWidth - left) xend = this.canvasWidth - left;
    if (yend > this.canvasHeight - top) yend = this.canvasHeight - top;

    for (let j = ystart; j < yend; j++) {
      let index = (j * width + xstart) * 4;
      for (let i = xstart; i < xend; i++) {
        // NEO quirk: shapeIndex advances once per visited pixel, but the loop
        // bounds are clamped at the canvas edge, so the brush mask desyncs
        // from the grid whenever a blur stamp is clipped.
        if (shape[shapeIndex++] && !this.isMasked(buf8, index)) {
          const rgba = [0, 0, 0, 0, 0];

          this.addBlur(tmp, index, 1.0 - blur * 4, rgba);
          if (i > xstart) this.addBlur(tmp, index - 4, blur, rgba);
          if (i < xend - 1) this.addBlur(tmp, index + 4, blur, rgba);
          if (j > ystart) this.addBlur(tmp, index - width * 4, blur, rgba);
          if (j < yend - 1) this.addBlur(tmp, index + width * 4, blur, rgba);

          buf8[index + 0] = Math.round(rgba[0]);
          buf8[index + 1] = Math.round(rgba[1]);
          buf8[index + 2] = Math.round(rgba[2]);
          buf8[index + 3] = Math.round((rgba[3] / rgba[4]) * 255.0);
        }
        index += 4;
      }
    }
  }

  private addBlur(
    buffer: Uint8ClampedArray,
    index: number,
    a: number,
    rgba: number[]
  ): void {
    const r0 = rgba[0];
    const g0 = rgba[1];
    const b0 = rgba[2];
    const a0 = rgba[3];
    const r1 = buffer[index + 0];
    const g1 = buffer[index + 1];
    const b1 = buffer[index + 2];
    const a1 = (buffer[index + 3] / 255.0) * a;
    rgba[4] += a;

    const sum = a0 + a1;
    if (sum > 0) {
      rgba[0] = (r1 * a1 + r0 * a0) / (a0 + a1);
      rgba[1] = (g1 * a1 + g0 * a0) / (a0 + a1);
      rgba[2] = (b1 * a1 + b0 * a0) / (a0 + a1);
      rgba[3] = sum;
    }
  }

  private setDodgePoint(buf8: Uint8ClampedArray, width: number, x: number, y: number): void {
    const d = this._currentWidth;
    const r0i = Math.floor(d / 2);
    x -= r0i;
    y -= r0i;

    let index = (y * width + x) * 4;
    const shape = this.roundData[d];
    let shapeIndex = 0;

    const a1 = this.getAlpha(ALPHATYPE.BRUSH);
    if (a1 === 0) return;

    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        if (shape[shapeIndex++] && !this.isMasked(buf8, index)) {
          const r0 = buf8[index + 0];
          const g0 = buf8[index + 1];
          const b0 = buf8[index + 2];
          const a0 = buf8[index + 3] / 255.0;

          // NEO quirk: a1 here is 0..1 from getAlpha but is compared against
          // and subtracted from 255, so the else branch is dead and the
          // brightening is very slight. Archived files depend on it.
          let r1: number, g1: number, b1: number;
          if (a1 !== 255.0) {
            r1 = (r0 * 255) / (255 - a1);
            g1 = (g0 * 255) / (255 - a1);
            b1 = (b0 * 255) / (255 - a1);
          } else {
            r1 = 255.0;
            g1 = 255.0;
            b1 = 255.0;
          }

          buf8[index + 0] = Math.ceil(r1);
          buf8[index + 1] = Math.ceil(g1);
          buf8[index + 2] = Math.ceil(b1);
          buf8[index + 3] = Math.ceil(a0 * 255);
        }
        index += 4;
      }
      index += (width - d) * 4;
    }
  }

  private setBurnPoint(buf8: Uint8ClampedArray, width: number, x: number, y: number): void {
    const d = this._currentWidth;
    const r0i = Math.floor(d / 2);
    x -= r0i;
    y -= r0i;

    let index = (y * width + x) * 4;
    const shape = this.roundData[d];
    let shapeIndex = 0;

    const a1 = this.getAlpha(ALPHATYPE.BRUSH);
    if (a1 === 0) return;

    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        if (shape[shapeIndex++] && !this.isMasked(buf8, index)) {
          const r0 = buf8[index + 0];
          const g0 = buf8[index + 1];
          const b0 = buf8[index + 2];
          const a0 = buf8[index + 3] / 255.0;

          // NEO quirk: mirrors setDodgePoint, same dead else branch.
          let r1: number, g1: number, b1: number;
          if (a1 !== 255.0) {
            r1 = 255 - ((255 - r0) * 255) / (255 - a1);
            g1 = 255 - ((255 - g0) * 255) / (255 - a1);
            b1 = 255 - ((255 - b0) * 255) / (255 - a1);
          } else {
            r1 = 0;
            g1 = 0;
            b1 = 0;
          }

          buf8[index + 0] = Math.floor(r1);
          buf8[index + 1] = Math.floor(g1);
          buf8[index + 2] = Math.floor(b1);
          buf8[index + 3] = Math.ceil(a0 * 255);
        }
        index += 4;
      }
      index += (width - d) * 4;
    }
  }

  // ------------------------------------------------------------ public ops

  drawLine(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    type: number
  ): void {
    const points: [Point, Point] = [
      [x0, y0],
      [x1, y1],
    ];
    this.aerr = 0;

    this.draw(ctx, points, (left, top, _width, _height, buf8, imageData) => {
      this.bresenham(points, (x, y) => {
        this.setPoint(buf8, imageData.width, x, y, left, top, type);
      });
    });
    this.prevLine = points;
  }

  drawPoint(ctx: CanvasRenderingContext2D, x: number, y: number, type: number): void {
    this.drawLine(ctx, x, y, x, y, type);
  }

  getClipboard(): ImageData | null {
    return this.clipboard;
  }

  setClipboard(data: ImageData | null): void {
    this.clipboard = data;
  }
}
