/**
 * PCH decoding and action dispatch, transcribed from neo/src/actions.js.
 *
 * The frame layouts here are the file format. `pushCurrent` writes colour,
 * mask, width and mask type into slots 2..10, which is why every verb that
 * calls it reads its own arguments from slot 11 onwards while the simpler
 * verbs read from slot 2.
 */
import { decompressFromUint8Array } from "lz-string";
import { NeoPainter } from "./NeoPainter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = any[];

export interface DecodedPCH {
  width: number;
  height: number;
  items: Frame[];
}

/** Neo.decodePCH: 12-byte header, then an LZString-compressed JSON array. */
export function decodePCH(raw: ArrayBuffer | Uint8Array): DecodedPCH | null {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const header = bytes.subarray(0, 12);

  if (
    header[0] !== "N".charCodeAt(0) ||
    header[1] !== "E".charCodeAt(0) ||
    header[2] !== "O".charCodeAt(0)
  ) {
    return null;
  }

  const data = decompressFromUint8Array(bytes.subarray(12));
  if (data === null) return null;

  return {
    width: header[4] + header[5] * 0x100,
    height: header[6] + header[7] * 0x100,
    items: fixPCH(JSON.parse(data)),
  };
}

/**
 * Neo.fixPCH: some files have an "eraseAll" spliced into the middle of another
 * frame. Upstream splits it back out into its own frame.
 */
export function fixPCH(items: Frame[]): Frame[] {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const index = item.indexOf("eraseAll");
    if (index > 0) {
      // Kept exactly as upstream, including inserting the tail *before* the
      // head so the erase happens first.
      const tail = item.slice(index);
      const head = item.slice(0, index);
      items[i] = head;
      items.splice(i, 0, tail);
    }
  }
  return items;
}

/**
 * Coordinates are numbers, or null which NEO's arithmetic treats as zero.
 * Anything else means the frame is damaged. Not a repair -- just enough of a
 * guard that a viewer degrades instead of throwing, which is what NEO does
 * when it hands a string to getImageData.
 */
function isCoordinate(v: unknown): boolean {
  return typeof v === "number" || v === null;
}

/** Loads a data: URL into an ImageBitmap-compatible image. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load restore image"));
    img.src = src;
  });
}

export class NeoReplay {
  readonly painter: NeoPainter;

  constructor(width: number, height: number) {
    this.painter = new NeoPainter(width, height);
  }

  /** Applies pushCurrent's slots: colour, mask, width, mask type. */
  private getCurrent(item: Frame): void {
    const p = this.painter;
    p._currentColor = [item[2], item[3], item[4], item[5]];
    p._currentMask = [item[6], item[7], item[8]];
    p._currentWidth = item[9];
    p._currentMaskType = item[10];
  }

  /**
   * Applies one frame. Returns false for frames NEO would route to its `dummy`
   * handler -- unknown verbs, and frames whose head is not a string at all,
   * which do occur in the archive.
   */
  async apply(item: Frame): Promise<boolean> {
    const p = this.painter;
    const verb = item[0];

    if (typeof verb !== "string") return false;

    switch (verb) {
      case "freeHand": {
        // freeHandFast: header holds the start point twice, then one x,y pair
        // per recorded move. Segments are drawn newest-to-previous.
        const layer = item[1];
        this.getCurrent(item);
        const lineType = item[11];
        let x0 = item[12];
        let y0 = item[13];
        for (let i = 14; i + 1 < item.length; i += 2) {
          const x1 = x0;
          const y1 = y0;
          x0 = item[i + 0];
          y0 = item[i + 1];
          // Stop at the first damaged coordinate rather than passing NaN into
          // getImageData, which is what NEO does and it throws. Drawing the
          // valid prefix cannot change any file whose coordinates are intact.
          if (!isCoordinate(x0) || !isCoordinate(y0)) break;
          p.drawLine(p.canvasCtx[layer], x0, y0, x1, y1, lineType);
        }
        p.prevLine = null;
        return true;
      }

      case "line": {
        const layer = item[1];
        this.getCurrent(item);
        const lineType = item[11];
        const x0 = item[12];
        const y0 = item[13];
        const x1 = item[14] === null ? x0 : item[14];
        const y1 = item[15] === null ? y0 : item[15];
        p.drawLine(p.canvasCtx[layer], x0, y0, x1, y1, lineType);
        return true;
      }

      case "bezier": {
        const layer = item[1];
        this.getCurrent(item);
        p.drawBezier(
          p.canvasCtx[layer],
          item[12], item[13], item[14], item[15],
          item[16], item[17], item[18], item[19],
          item[11]
        );
        return true;
      }

      case "floodFill":
        p.doFloodFill(p.canvasCtx[item[1]], item[2], item[3], item[4]);
        return true;

      case "fill": {
        const layer = item[1];
        this.getCurrent(item);
        p.doFill(layer, item[11], item[12], item[13], item[14], item[15]);
        return true;
      }

      case "eraseAll":
        p.eraseAll(item[1]);
        return true;

      case "clearCanvas":
        p.clearCanvas();
        return true;

      case "eraseRect":
        p.eraseRect(item[1], item[2], item[3], item[4], item[5]);
        return true;

      case "eraseRect2": {
        // Same operation as eraseRect but records pushCurrent first, so its
        // geometry starts at slot 11 rather than 2.
        const layer = item[1];
        this.getCurrent(item);
        p.eraseRect(layer, item[11], item[12], item[13], item[14]);
        return true;
      }

      case "blurRect":
        p.blurRect(item[1], item[2], item[3], item[4], item[5]);
        return true;

      case "merge":
        p.merge(item[1], item[2], item[3], item[4], item[5]);
        return true;

      case "flipH":
        p.flipH(item[1], item[2], item[3], item[4], item[5]);
        return true;

      case "flipV":
        p.flipV(item[1], item[2], item[3], item[4], item[5]);
        return true;

      case "turn":
        p.turn(item[1], item[2], item[3], item[4], item[5]);
        return true;

      case "copy":
        p.copy(item[1], item[2], item[3], item[4], item[5]);
        return true;

      case "paste":
        p.paste(item[1], item[2], item[3], item[4], item[5], item[6], item[7]);
        return true;

      case "text":
        p.doText(
          item[1], item[2], item[3], item[4], item[5],
          item[6], item[7], item[8]
        );
        return true;

      case "restore": {
        // Final state of both layers as PNG data URLs
        const [img0, img1] = await Promise.all([
          loadImage(item[1]),
          loadImage(item[2]),
        ]);
        const w = p.canvasWidth;
        const h = p.canvasHeight;
        p.canvasCtx[0].clearRect(0, 0, w, h);
        p.canvasCtx[1].clearRect(0, 0, w, h);
        p.canvasCtx[0].drawImage(img0, 0, 0);
        p.canvasCtx[1].drawImage(img1, 0, 0);
        return true;
      }

      default:
        // Unknown verb: NEO's play() falls back to dummy and skips it
        return false;
    }
  }

  /**
   * How many steps a frame takes to draw. Strokes animate one segment at a
   * time; everything else lands in one step.
   */
  static stepsFor(item: Frame): number {
    if (!Array.isArray(item) || item[0] !== "freeHand") return 1;
    const pairs = Math.floor((item.length - 14) / 2);
    return Math.max(1, pairs);
  }

  /**
   * Draws one segment of a stroke, or the whole of any other frame.
   *
   * NEO animates strokes segment by segment too, but clears prevLine between
   * segments, so its animated playback double-plots shared endpoints and ends
   * up slightly darker than its own skip-to-end path. We keep the fast-path
   * semantics -- the ones the corpus sweep verifies -- so what you watch being
   * drawn matches what you are left with.
   */
  async applyStep(item: Frame, step: number): Promise<void> {
    if (!Array.isArray(item) || item[0] !== "freeHand") {
      if (step === 0) await this.apply(item);
      return;
    }

    const p = this.painter;
    const layer = item[1];
    this.getCurrent(item);
    const lineType = item[11];

    const i = 14 + step * 2;
    if (i + 1 >= item.length) return;

    const x1 = step === 0 ? item[12] : item[i - 2];
    const y1 = step === 0 ? item[13] : item[i - 1];
    const x0 = item[i + 0];
    const y0 = item[i + 1];

    if (!isCoordinate(x0) || !isCoordinate(y0)) return;
    if (!isCoordinate(x1) || !isCoordinate(y1)) return;

    p.drawLine(p.canvasCtx[layer], x0, y0, x1, y1, lineType);

    if (step === NeoReplay.stepsFor(item) - 1) p.prevLine = null;
  }

  /** Applies every frame in order. */
  async playAll(items: Frame[]): Promise<void> {
    for (const item of items) {
      await this.apply(item);
    }
  }

  /**
   * Applies frames up to the last `restore`, then that restore -- NEO's
   * animation-skip path, which jumps straight to the finished drawing.
   */
  async playToEnd(items: Frame[]): Promise<void> {
    let lastRestore = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i][0] === "restore") lastRestore = i;
    }
    if (lastRestore >= 0) {
      await this.apply(items[lastRestore]);
      return;
    }
    await this.playAll(items);
  }

  getLayerPixels(layer: number): Uint8ClampedArray {
    const { canvasWidth: w, canvasHeight: h } = this.painter;
    return new Uint8ClampedArray(
      this.painter.canvasCtx[layer].getImageData(0, 0, w, h).data
    );
  }
}
