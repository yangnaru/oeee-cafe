import { describe, expect, it } from "vitest";
import { BufferSurface } from "./PixelSurface";
import { LINETYPE, MASKTYPE, NeoPainter } from "./NeoPainter";
import { describeDifference, firstPixelDifference } from "../test/neoHarness";

/**
 * Canvas getImageData premultiplies, so a fully erased pixel reads back as
 * [0,0,0,0] where a raw buffer still holds its old colour under a zero alpha.
 * That difference is unobservable: every kernel that reads a neighbour
 * multiplies its colour by that neighbour's alpha (so it cancels), isMasked
 * rewrites zero-alpha pixels to white before comparing, and nothing draws an
 * invisible pixel. Normalise it away rather than pretend the buffer is lossy.
 */
function clearTransparent(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
    }
  }
  return out;
}

const W = 64;
const H = 64;

interface Stroke {
  color: [number, number, number, number];
  width: number;
  lineType: number;
  points: [number, number][];
  maskType?: number;
}

/**
 * The same strokes rendered onto a canvas and into a plain buffer must come
 * out identical, or the painter and the replay viewer would drift apart.
 */
function bothSurfaces(strokes: Stroke[]) {
  const viaCanvas = new NeoPainter(W, H);
  const viaBuffer = new NeoPainter(W, H);
  const buffer = new Uint8ClampedArray(W * H * 4);
  const surface = new BufferSurface(buffer, W, H);

  for (const painter of [viaCanvas, viaBuffer]) {
    const target =
      painter === viaCanvas ? painter.canvasCtx[0] : surface;

    for (const stroke of strokes) {
      painter._currentColor = [...stroke.color];
      painter._currentWidth = stroke.width;
      painter._currentMaskType = stroke.maskType ?? MASKTYPE.NONE;
      painter._currentMask = [120, 160, 200];

      const [x0, y0] = stroke.points[0];
      painter.drawLine(target, x0, y0, x0, y0, stroke.lineType);
      for (let i = 1; i < stroke.points.length; i++) {
        const [nx, ny] = stroke.points[i];
        const [px, py] = stroke.points[i - 1];
        painter.drawLine(target, nx, ny, px, py, stroke.lineType);
      }
      painter.prevLine = null;
    }
  }

  const canvasPixels = new Uint8ClampedArray(
    viaCanvas.canvasCtx[0].getImageData(0, 0, W, H).data
  );
  return {
    canvasPixels: clearTransparent(canvasPixels),
    bufferPixels: clearTransparent(buffer),
  };
}

const underlay: Stroke = {
  color: [120, 160, 200, 255],
  width: 22,
  lineType: LINETYPE.PEN,
  points: [
    [4, 32],
    [60, 32],
  ],
};

describe("BufferSurface matches a canvas context", () => {
  const cases: [string, number][] = [
    ["PEN", LINETYPE.PEN],
    ["ERASER", LINETYPE.ERASER],
    ["BRUSH", LINETYPE.BRUSH],
    ["TONE", LINETYPE.TONE],
    ["DODGE", LINETYPE.DODGE],
    ["BURN", LINETYPE.BURN],
    ["BLUR", LINETYPE.BLUR],
  ];

  for (const [name, lineType] of cases) {
    it(`renders ${name} identically on either surface`, () => {
      const { canvasPixels, bufferPixels } = bothSurfaces([
        underlay,
        {
          color: [20, 20, 20, 255],
          width: 9,
          lineType,
          points: [
            [10, 12],
            [30, 28],
            [52, 46],
          ],
        },
      ]);
      expect(
        firstPixelDifference(canvasPixels, bufferPixels),
        `${name}: ${describeDifference(canvasPixels, bufferPixels, W)}`
      ).toBe(-1);
    });
  }

  it("clips at the edges identically, where the buffer has no padding to lean on", () => {
    for (const points of [
      [
        [0, 0],
        [12, 5],
      ],
      [
        [W - 1, H - 1],
        [W - 10, H - 4],
      ],
      [[0, 32]],
      [[W - 1, 0]],
    ] as [number, number][][]) {
      for (const lineType of [LINETYPE.PEN, LINETYPE.BLUR, LINETYPE.ERASER]) {
        const { canvasPixels, bufferPixels } = bothSurfaces([
          underlay,
          { color: [0, 0, 0, 255], width: 14, lineType, points },
        ]);
        expect(
          firstPixelDifference(canvasPixels, bufferPixels),
          `${JSON.stringify(points)} type ${lineType}: ${describeDifference(
            canvasPixels,
            bufferPixels,
            W
          )}`
        ).toBe(-1);
      }
    }
  });

  it("applies masks identically on either surface", () => {
    for (const maskType of [
      MASKTYPE.NORMAL,
      MASKTYPE.REVERSE,
      MASKTYPE.ADD,
      MASKTYPE.SUB,
    ]) {
      const { canvasPixels, bufferPixels } = bothSurfaces([
        underlay,
        {
          color: [200, 80, 40, 255],
          width: 10,
          lineType: LINETYPE.PEN,
          points: [
            [12, 12],
            [50, 44],
          ],
          maskType,
        },
      ]);
      expect(
        firstPixelDifference(canvasPixels, bufferPixels),
        `mask ${maskType}: ${describeDifference(canvasPixels, bufferPixels, W)}`
      ).toBe(-1);
    }
  });

  it("matches across every brush size", () => {
    for (let width = 1; width <= 30; width++) {
      const { canvasPixels, bufferPixels } = bothSurfaces([
        underlay,
        {
          color: [0, 0, 0, 200],
          width,
          lineType: LINETYPE.PEN,
          points: [
            [14, 18],
            [48, 42],
          ],
        },
      ]);
      expect(
        firstPixelDifference(canvasPixels, bufferPixels),
        `width ${width}: ${describeDifference(canvasPixels, bufferPixels, W)}`
      ).toBe(-1);
    }
  });
});

describe("the one place a buffer deliberately differs from a canvas", () => {
  // A canvas stores premultiplied, so it loses a little of a translucent
  // colour on every read-modify-write. The painter keeps its precision
  // instead of reproducing that, which means these two genuinely disagree
  // while a result is translucent. Asserted rather than assumed, so the size
  // of the difference stays visible if anything changes.
  it("keeps translucent colour a canvas would round away", () => {
    const seen: number[] = [];
    for (const alpha of [47, 128, 220]) {
      const { canvasPixels, bufferPixels } = bothSurfaces([
        {
          color: [40, 90, 200, alpha],
          width: 12,
          lineType: LINETYPE.PEN,
          points: [
            [4, 40],
            [44, 6],
          ],
        },
      ]);
      let worst = 0;
      for (let i = 0; i < canvasPixels.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          worst = Math.max(worst, Math.abs(canvasPixels[i + c] - bufferPixels[i + c]));
        }
      }
      seen.push(worst);
    }
    // Small, bounded, and largest at low alpha -- a stroke has edge pixels at
    // every alpha, so even a high nominal alpha differs somewhere. Playback
    // settles onto the artwork via the restore frame, so none of this
    // survives to the end.
    expect(Math.max(...seen)).toBeLessThanOrEqual(12);
    expect(seen[0]).toBeGreaterThan(seen[2]);
  });

  it("agrees exactly once the result is opaque", () => {
    const { canvasPixels, bufferPixels } = bothSurfaces([
      underlay,
      {
        color: [10, 10, 10, 255],
        width: 9,
        lineType: LINETYPE.PEN,
        points: [
          [10, 12],
          [40, 36],
        ],
      },
    ]);
    expect(
      firstPixelDifference(canvasPixels, bufferPixels),
      describeDifference(canvasPixels, bufferPixels, W)
    ).toBe(-1);
  });
});
