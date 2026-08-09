/**
 * Loads the canonical NEO implementation (neo/src/painter.js) into the test
 * page so our drawing engine and replay files can be checked against it
 * directly, rather than against a paraphrase of it.
 *
 * painter.js is a plain script of prototype assignments over a free `Neo`
 * variable, with no top-level DOM or jQuery use, so it can be evaluated with a
 * stub and its primitives driven against real canvases.
 */
import painterSource from "../../../neo/src/painter.js?raw";
import { decompressFromUint8Array } from "lz-string";

export const LINETYPE = {
  NONE: 0,
  PEN: 1,
  ERASER: 2,
  BRUSH: 3,
  TONE: 4,
} as const;

export const LAYER = { BACKGROUND: 0, FOREGROUND: 1 } as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let cachedNeo: Any = null;

export function loadNeo(): Any {
  if (cachedNeo) return cachedNeo;
  const Neo: Any = { config: {}, isMobile: () => false };
  new Function("Neo", painterSource)(Neo);
  cachedNeo = Neo;
  return Neo;
}

export interface CanonicalPainter {
  painter: Any;
  canvases: HTMLCanvasElement[];
  contexts: CanvasRenderingContext2D[];
  width: number;
  height: number;
}

/**
 * A Neo.Painter with just the state its drawing primitives touch. The real
 * constructor wires up undo managers, tools and DOM, none of which the
 * rasterisation path reads.
 */
export function createCanonicalPainter(
  width: number,
  height: number
): CanonicalPainter {
  const Neo = loadNeo();

  const canvases: HTMLCanvasElement[] = [];
  const contexts: CanvasRenderingContext2D[] = [];
  for (let i = 0; i < 2; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    canvases.push(canvas);
    contexts.push(ctx);
  }

  const painter = Object.create(Neo.Painter.prototype);
  // _roundData/_toneData live on the prototype upstream; give each painter its
  // own so tests cannot bleed into one another.
  painter._roundData = [];
  painter._toneData = [];
  painter.canvas = canvases;
  painter.canvasCtx = contexts;
  painter.canvasWidth = width;
  painter.canvasHeight = height;
  painter.current = LAYER.BACKGROUND;
  painter.aerr = 0;
  painter.prevLine = null;
  painter._currentColor = [0, 0, 0, 255];
  painter._currentMask = [0, 0, 0];
  painter._currentMaskType = 0;
  painter._currentWidth = 1;
  painter._initRoundData();
  if (typeof painter._initToneData === "function") painter._initToneData();
  // Display refresh only; the pixel state we compare lives in canvasCtx.
  painter.updateDestCanvas = () => {};

  return { painter, canvases, contexts, width, height };
}

export function readPixels(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): Uint8ClampedArray {
  return new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data);
}

export interface StrokeSpec {
  layer: number;
  color: [number, number, number, number]; // r, g, b, a(0-255)
  width: number;
  lineType: number;
  points: [number, number][];
}

/**
 * Draws a stroke the way NEO's live handlers do: freeHandDownHandler emits a
 * dot at the press point, then each freeHandMoveHandler draws from the NEW
 * position back to the PREVIOUS one, and freeHandUpHandler clears prevLine.
 */
export function neoDrawStroke(cp: CanonicalPainter, stroke: StrokeSpec): void {
  const p = cp.painter;
  const ctx = cp.contexts[stroke.layer];

  p._currentColor = [...stroke.color];
  p._currentWidth = stroke.width;
  p._currentMask = [0, 0, 0];
  p._currentMaskType = 0;

  const [x0, y0] = stroke.points[0];
  p.drawLine(ctx, x0, y0, x0, y0, stroke.lineType);

  for (let i = 1; i < stroke.points.length; i++) {
    const [nx, ny] = stroke.points[i];
    const [px, py] = stroke.points[i - 1];
    p.drawLine(ctx, nx, ny, px, py, stroke.lineType);
  }

  p.prevLine = null; // freeHandUpHandler
}

/** Decode a PCH blob exactly as Neo.decodePCH does. */
export async function decodePCH(blob: Blob): Promise<{
  magic: string;
  width: number;
  height: number;
  items: Any[][];
}> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const header = bytes.subarray(0, 12);
  const data = decompressFromUint8Array(bytes.subarray(12));
  return {
    magic: String.fromCharCode(...Array.from(header.subarray(0, 4))),
    width: header[4] + header[5] * 0x100,
    height: header[6] + header[7] * 0x100,
    items: JSON.parse(data as string),
  };
}

/**
 * Replays decoded PCH items through canonical NEO, following the index layout
 * of Neo.ActionManager.freeHandFast and .floodFill.
 */
export function replayWithNeo(cp: CanonicalPainter, items: Any[][]): void {
  const p = cp.painter;

  for (const item of items) {
    switch (item[0]) {
      case "freeHand": {
        const layer = item[1];
        const ctx = cp.contexts[layer];

        // getCurrent(): color, mask, width, maskType
        p._currentColor = [item[2], item[3], item[4], item[5]];
        p._currentMask = [item[6], item[7], item[8]];
        p._currentWidth = item[9];
        p._currentMaskType = item[10];

        const lineType = item[11];
        let x0 = item[12];
        let y0 = item[13];

        for (let i = 14; i + 1 < item.length; i += 2) {
          const x1 = x0;
          const y1 = y0;
          x0 = item[i + 0];
          y0 = item[i + 1];
          p.drawLine(ctx, x0, y0, x1, y1, lineType);
        }
        p.prevLine = null;
        break;
      }

      case "floodFill": {
        p.doFloodFill(item[1], item[2], item[3], item[4]);
        break;
      }

      case "restore":
        // Final-state images; the strokes preceding it are what we verify.
        break;

      default:
        throw new Error(`unhandled replay action: ${String(item[0])}`);
    }
  }
}

/** First differing pixel index, or -1. Compared as whole RGBA quads. */
export function firstPixelDifference(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray
): number {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      a[i] !== b[i] ||
      a[i + 1] !== b[i + 1] ||
      a[i + 2] !== b[i + 2] ||
      a[i + 3] !== b[i + 3]
    ) {
      return i;
    }
  }
  return -1;
}

export function describeDifference(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number
): string {
  const i = firstPixelDifference(a, b);
  if (i === -1) return "identical";
  const px = (i / 4) % width;
  const py = Math.floor(i / 4 / width);
  let differing = 0;
  for (let k = 0; k < a.length; k += 4) {
    if (
      a[k] !== b[k] ||
      a[k + 1] !== b[k + 1] ||
      a[k + 2] !== b[k + 2] ||
      a[k + 3] !== b[k + 3]
    ) {
      differing++;
    }
  }
  return (
    `${differing} pixel(s) differ; first at (${px}, ${py}): ` +
    `ours [${a[i]}, ${a[i + 1]}, ${a[i + 2]}, ${a[i + 3]}] vs ` +
    `neo [${b[i]}, ${b[i + 1]}, ${b[i + 2]}, ${b[i + 3]}]`
  );
}
