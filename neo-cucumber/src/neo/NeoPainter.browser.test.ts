import { describe, expect, it } from "vitest";
import { LINETYPE, MASKTYPE, NeoPainter } from "./NeoPainter";
import {
  createCanonicalPainter,
  describeDifference,
  firstPixelDifference,
  readPixels,
} from "../test/neoHarness";

const W = 64;
const H = 64;

interface Stroke {
  color: [number, number, number, number];
  width: number;
  lineType: number;
  points: [number, number][];
  maskType?: number;
  maskColor?: [number, number, number];
}

/** Drives both implementations through NEO's live stroke shape. */
function runBoth(strokes: Stroke[], layer = 0) {
  const ours = new NeoPainter(W, H);
  const cp = createCanonicalPainter(W, H);

  const play = (
    setColor: (s: Stroke) => void,
    line: (x0: number, y0: number, x1: number, y1: number, t: number) => void,
    clearPrev: () => void
  ) => {
    for (const s of strokes) {
      setColor(s);
      const [x0, y0] = s.points[0];
      line(x0, y0, x0, y0, s.lineType);
      for (let i = 1; i < s.points.length; i++) {
        const [nx, ny] = s.points[i];
        const [px, py] = s.points[i - 1];
        line(nx, ny, px, py, s.lineType);
      }
      clearPrev();
    }
  };

  play(
    (s) => {
      ours._currentColor = [...s.color];
      ours._currentWidth = s.width;
      ours._currentMaskType = s.maskType ?? MASKTYPE.NONE;
      ours._currentMask = s.maskColor ?? [0, 0, 0];
    },
    (x0, y0, x1, y1, t) => ours.drawLine(ours.canvasCtx[layer], x0, y0, x1, y1, t),
    () => {
      ours.prevLine = null;
    }
  );

  play(
    (s) => {
      cp.painter._currentColor = [...s.color];
      cp.painter._currentWidth = s.width;
      cp.painter._currentMaskType = s.maskType ?? MASKTYPE.NONE;
      cp.painter._currentMask = s.maskColor ?? [0, 0, 0];
    },
    (x0, y0, x1, y1, t) =>
      cp.painter.drawLine(cp.contexts[layer], x0, y0, x1, y1, t),
    () => {
      cp.painter.prevLine = null;
    }
  );

  return {
    ours: readPixels(ours.canvasCtx[layer], W, H),
    neo: readPixels(cp.contexts[layer], W, H),
  };
}

function expectIdentical(strokes: Stroke[], label = "") {
  const { ours, neo } = runBoth(strokes);
  expect(
    firstPixelDifference(ours, neo),
    `${label}${label ? ": " : ""}${describeDifference(ours, neo, W)}`
  ).toBe(-1);
}

const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const RED: [number, number, number, number] = [180, 30, 30, 255];

const diagonal: [number, number][] = [
  [12, 12],
  [30, 26],
  [50, 44],
];

const LINE_TYPES: [string, number][] = [
  ["PEN", LINETYPE.PEN],
  ["ERASER", LINETYPE.ERASER],
  ["BRUSH", LINETYPE.BRUSH],
  ["TONE", LINETYPE.TONE],
  ["DODGE", LINETYPE.DODGE],
  ["BURN", LINETYPE.BURN],
  ["BLUR", LINETYPE.BLUR],
];

describe("NeoPainter kernels vs canonical NEO", () => {
  // Dodge, burn, blur and eraser only show against existing pixels
  const underlay: Stroke = {
    color: [120, 160, 200, 255],
    width: 24,
    lineType: LINETYPE.PEN,
    points: [
      [6, 32],
      [58, 32],
    ],
  };

  for (const [name, lineType] of LINE_TYPES) {
    it(`renders ${name} identically`, () => {
      expectIdentical([underlay, { color: BLACK, width: 8, lineType, points: diagonal }], name);
    });

    it(`renders ${name} at every brush size identically`, () => {
      for (let width = 1; width <= 30; width++) {
        const { ours, neo } = runBoth([
          underlay,
          {
            color: BLACK,
            width,
            lineType,
            points: [
              [16, 20],
              [46, 40],
            ],
          },
        ]);
        expect(
          firstPixelDifference(ours, neo),
          `${name} width ${width}: ${describeDifference(ours, neo, W)}`
        ).toBe(-1);
      }
    });

    it(`renders ${name} at every opacity identically`, () => {
      for (let alpha = 1; alpha <= 255; alpha += 2) {
        const { ours, neo } = runBoth([
          underlay,
          {
            color: [0, 0, 0, alpha],
            width: 6,
            lineType,
            points: [
              [16, 20],
              [46, 40],
            ],
          },
        ]);
        expect(
          firstPixelDifference(ours, neo),
          `${name} alpha ${alpha}: ${describeDifference(ours, neo, W)}`
        ).toBe(-1);
      }
    });
  }

  it("renders every angle identically for each line type", () => {
    for (const [name, lineType] of LINE_TYPES) {
      for (let deg = 0; deg < 360; deg += 15) {
        const rad = (deg * Math.PI) / 180;
        const end: [number, number] = [
          Math.round(32 + 22 * Math.cos(rad)),
          Math.round(32 + 22 * Math.sin(rad)),
        ];
        const { ours, neo } = runBoth([
          underlay,
          { color: RED, width: 5, lineType, points: [[32, 32], end] },
        ]);
        expect(
          firstPixelDifference(ours, neo),
          `${name} angle ${deg}: ${describeDifference(ours, neo, W)}`
        ).toBe(-1);
      }
    }
  });

  it("clips at canvas edges identically for each line type", () => {
    for (const [name, lineType] of LINE_TYPES) {
      for (const points of [
        [
          [0, 0],
          [14, 6],
        ],
        [
          [W - 1, H - 1],
          [W - 14, H - 8],
        ],
        [
          [2, H - 2],
          [W - 2, 2],
        ],
        [[0, 32]],
        [[W - 1, 32]],
      ] as [number, number][][]) {
        const { ours, neo } = runBoth([
          underlay,
          { color: BLACK, width: 12, lineType, points },
        ]);
        expect(
          firstPixelDifference(ours, neo),
          `${name} at ${JSON.stringify(points)}: ${describeDifference(ours, neo, W)}`
        ).toBe(-1);
      }
    }
  });

  it("applies every mask type identically", () => {
    const maskColor: [number, number, number] = [120, 160, 200];
    for (const maskType of [
      MASKTYPE.NORMAL,
      MASKTYPE.REVERSE,
      MASKTYPE.ADD,
      MASKTYPE.SUB,
    ]) {
      for (const alpha of [255, 200, 100]) {
        const { ours, neo } = runBoth([
          underlay,
          {
            color: [200, 80, 40, alpha],
            width: 10,
            lineType: LINETYPE.PEN,
            points: diagonal,
            maskType,
            maskColor,
          },
        ]);
        expect(
          firstPixelDifference(ours, neo),
          `maskType ${maskType} alpha ${alpha}: ${describeDifference(ours, neo, W)}`
        ).toBe(-1);
      }
    }
  });

  it("keeps the alpha dithering accumulator in step across a long stroke", () => {
    const points: [number, number][] = [];
    for (let i = 0; i < 50; i++) {
      points.push([4 + i, Math.round(32 + 20 * Math.sin(i / 5))]);
    }
    expectIdentical([
      underlay,
      { color: [0, 0, 0, 3], width: 4, lineType: LINETYPE.BRUSH, points },
    ]);
  });
});
