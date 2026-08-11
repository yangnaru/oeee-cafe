/**
 * The slice of a canvas context NEO's rasterisation actually uses.
 *
 * Every kernel reads a padded sub-rectangle, edits it, and writes it back, so
 * a surface only has to offer those two operations. `CanvasRenderingContext2D`
 * satisfies this structurally, which lets the same verified code render either
 * onto a canvas (the replay viewer) or straight into a layer buffer (the
 * painter) without a second implementation to keep in step.
 */
export interface PixelSurface {
  getImageData(x: number, y: number, width: number, height: number): ImageData;
  putImageData(data: ImageData, x: number, y: number): void;
}

/**
 * The colour a canvas gives back after storing `value` at `alpha`.
 *
 * A canvas keeps pixels premultiplied, so writing a partial-alpha colour and
 * reading it straight back does not return what you wrote -- at alpha 239,
 * 40 comes back as 39. NEO's kernels read-modify-write through getImageData
 * and putImageData on every stamp, so a canvas-backed painter accumulates that
 * loss and a buffer-backed one does not. Left alone, a drawing made here would
 * not match its own replay in a canvas viewer.
 *
 * The rounding is implementation-defined -- the HTML spec says the round trip
 * is lossy without saying how -- and measurement showed the obvious closed
 * forms (round/round, Skia's +127/255) all disagree with Chromium on about 1%
 * of inputs. So the table is measured from the canvas this code is actually
 * running on, once, which is exact by construction and stays exact on an
 * engine that rounds differently.
 */
let roundTripTable: Uint8Array | null = null;

function premultiplyTable(): Uint8Array {
  if (roundTripTable) return roundTripTable;

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable");

  // Row = alpha, column = the value written
  const probe = ctx.createImageData(256, 256);
  for (let a = 0; a < 256; a++) {
    for (let c = 0; c < 256; c++) {
      const i = (a * 256 + c) * 4;
      probe.data[i] = c;
      probe.data[i + 1] = c;
      probe.data[i + 2] = c;
      probe.data[i + 3] = a;
    }
  }
  ctx.putImageData(probe, 0, 0);

  const back = ctx.getImageData(0, 0, 256, 256).data;
  const table = new Uint8Array(256 * 256);
  for (let a = 0; a < 256; a++) {
    for (let c = 0; c < 256; c++) {
      table[a * 256 + c] = back[(a * 256 + c) * 4];
    }
  }
  roundTripTable = table;
  return table;
}

/** Exposed for the tests that check this against a real canvas. */
export function canvasRoundTrip(value: number, alpha: number): number {
  return premultiplyTable()[alpha * 256 + value];
}

/**
 * A PixelSurface over a plain RGBA buffer.
 *
 * Reproduces the canvas semantics the kernels lean on: reading outside the
 * bounds yields transparent pixels rather than throwing or wrapping, and
 * writing outside them is clipped. The returned sub-rectangle keeps the width
 * it was asked for, which matters -- blur walks its neighbours with
 * `index ± width * 4`, so a surface that quietly returned a narrower row would
 * blur against the wrong pixels.
 */
export class BufferSurface implements PixelSurface {
  private readonly buffer: Uint8ClampedArray;
  private readonly width: number;
  private readonly height: number;

  constructor(buffer: Uint8ClampedArray, width: number, height: number) {
    this.buffer = buffer;
    this.width = width;
    this.height = height;
  }

  getImageData(x: number, y: number, width: number, height: number): ImageData {
    const out = new ImageData(Math.max(1, width), Math.max(1, height));

    const startX = Math.max(0, -x);
    const startY = Math.max(0, -y);
    const endX = Math.min(width, this.width - x);
    const endY = Math.min(height, this.height - y);

    // Row at a time: a per-pixel loop here costs more than the kernels do.
    const span = (endX - startX) * 4;
    if (span > 0) {
      for (let row = startY; row < endY; row++) {
        const src = ((y + row) * this.width + x + startX) * 4;
        const dst = (row * width + startX) * 4;
        out.data.set(this.buffer.subarray(src, src + span), dst);
      }
    }
    return out;
  }

  putImageData(data: ImageData, x: number, y: number): void {
    const table = premultiplyTable();
    const startX = Math.max(0, -x);
    const startY = Math.max(0, -y);
    const endX = Math.min(data.width, this.width - x);
    const endY = Math.min(data.height, this.height - y);

    const span = endX - startX;
    if (span <= 0) return;
    for (let row = startY; row < endY; row++) {
      let src = (row * data.width + startX) * 4;
      let dst = ((y + row) * this.width + x + startX) * 4;
      for (let col = 0; col < span; col++) {
        // Stored as a canvas would store and hand back, so the painter's
        // layers carry the same rounding a canvas-backed NEO would.
        const alpha = data.data[src + 3] * 256;
        this.buffer[dst + 0] = table[alpha + data.data[src + 0]];
        this.buffer[dst + 1] = table[alpha + data.data[src + 1]];
        this.buffer[dst + 2] = table[alpha + data.data[src + 2]];
        this.buffer[dst + 3] = data.data[src + 3];
        src += 4;
        dst += 4;
      }
    }
  }
}
