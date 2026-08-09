import { describe, expect, it } from "vitest";
import { DrawingEngine } from "./DrawingEngine";
import {
  LAYER,
  LINETYPE,
  createCanonicalPainter,
  describeDifference,
  firstPixelDifference,
  neoDrawStroke,
  readPixels,
  type StrokeSpec,
} from "./test/neoHarness";

const W = 64;
const H = 64;

/**
 * Draws a stroke through our engine the way useBaseDrawing does: a dot on
 * pointer down, then a segment from the previous point to the new one, then
 * the end-of-stroke prevLine reset.
 */
function ourDrawStroke(engine: DrawingEngine, stroke: StrokeSpec) {
  const layer =
    stroke.layer === LAYER.FOREGROUND
      ? engine.layers.foreground
      : engine.layers.background;
  const [r, g, b, a] = stroke.color;
  const brushType =
    stroke.lineType === LINETYPE.ERASER
      ? "eraser"
      : stroke.lineType === LINETYPE.TONE
        ? "halftone"
        : "solid";

  const [x0, y0] = stroke.points[0];
  engine.drawLine(layer, x0, y0, x0, y0, stroke.width, brushType, r, g, b, a);

  for (let i = 1; i < stroke.points.length; i++) {
    const [px, py] = stroke.points[i - 1];
    const [nx, ny] = stroke.points[i];
    engine.drawLine(layer, nx, ny, px, py, stroke.width, brushType, r, g, b, a);
  }

  engine.setStrokeState(null);
}

function runBoth(strokes: StrokeSpec[]) {
  const engine = new DrawingEngine(W, H);
  const cp = createCanonicalPainter(W, H);

  for (const stroke of strokes) {
    ourDrawStroke(engine, stroke);
    neoDrawStroke(cp, stroke);
  }

  const ours = new Uint8ClampedArray(
    strokes[0].layer === LAYER.FOREGROUND
      ? engine.layers.foreground
      : engine.layers.background
  );
  const neo = readPixels(cp.contexts[strokes[0].layer], W, H);
  return { ours, neo };
}

function expectIdentical(strokes: StrokeSpec[]) {
  const { ours, neo } = runBoth(strokes);
  expect(
    firstPixelDifference(ours, neo),
    describeDifference(ours, neo, W)
  ).toBe(-1);
}

const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const RED: [number, number, number, number] = [128, 0, 0, 255];

const pen = (
  points: [number, number][],
  width = 2,
  color = BLACK,
  layer: number = LAYER.BACKGROUND
): StrokeSpec => ({
  layer,
  color,
  width,
  lineType: LINETYPE.PEN,
  points,
});

describe("DrawingEngine vs canonical NEO", () => {
  it("renders a single dot identically", () => {
    expectIdentical([pen([[32, 32]])]);
  });

  it("renders every brush size identically", () => {
    for (let width = 1; width <= 30; width++) {
      const { ours, neo } = runBoth([
        pen(
          [
            [20, 20],
            [40, 34],
          ],
          width
        ),
      ]);
      expect(
        firstPixelDifference(ours, neo),
        `width ${width}: ${describeDifference(ours, neo, W)}`
      ).toBe(-1);
    }
  });

  it("renders lines at every angle identically", () => {
    const cx = 32;
    const cy = 32;
    const radius = 20;
    for (let deg = 0; deg < 360; deg += 5) {
      const rad = (deg * Math.PI) / 180;
      const end: [number, number] = [
        Math.round(cx + radius * Math.cos(rad)),
        Math.round(cy + radius * Math.sin(rad)),
      ];
      const { ours, neo } = runBoth([pen([[cx, cy], end], 3)]);
      expect(
        firstPixelDifference(ours, neo),
        `angle ${deg}: ${describeDifference(ours, neo, W)}`
      ).toBe(-1);
    }
  });

  it("renders a multi-segment stroke identically", () => {
    expectIdentical([
      pen(
        [
          [5, 5],
          [12, 9],
          [20, 26],
          [21, 27],
          [33, 30],
          [44, 51],
          [58, 58],
        ],
        4
      ),
    ]);
  });

  it("renders consecutive strokes sharing an endpoint identically", () => {
    // The case the prevLine reset governs: a stroke starting exactly where
    // the previous one ended.
    expectIdentical([
      pen([
        [10, 10],
        [30, 30],
      ]),
      pen([
        [30, 30],
        [50, 12],
      ]),
    ]);
  });

  it("renders repeated taps on one pixel identically", () => {
    expectIdentical([pen([[32, 32]]), pen([[32, 32]]), pen([[32, 32]])]);
  });

  it("renders overlapping strokes identically", () => {
    expectIdentical([
      pen(
        [
          [8, 32],
          [56, 32],
        ],
        6,
        BLACK
      ),
      pen(
        [
          [32, 8],
          [32, 56],
        ],
        6,
        RED
      ),
    ]);
  });

  it("clips strokes at the canvas edges identically", () => {
    expectIdentical([
      pen(
        [
          [0, 0],
          [10, 4],
        ],
        8
      ),
    ]);
    expectIdentical([
      pen(
        [
          [W - 1, H - 1],
          [W - 12, H - 5],
        ],
        8
      ),
    ]);
    expectIdentical([
      pen(
        [
          [2, H - 2],
          [W - 2, 2],
        ],
        10
      ),
    ]);
  });

  it("renders a one-pixel step identically", () => {
    expectIdentical([
      pen(
        [
          [20, 20],
          [21, 20],
          [21, 21],
          [22, 21],
        ],
        1
      ),
    ]);
  });

  it("renders every opacity identically", () => {
    // NEO recomputes getAlpha per plotted pixel (its aerr dithering
    // accumulator is stateful); we compute it once per segment. These must
    // agree for every alpha we can actually record.
    for (let opacity = 1; opacity <= 255; opacity++) {
      const { ours, neo } = runBoth([
        pen(
          [
            [12, 12],
            [50, 40],
          ],
          4,
          [0, 0, 0, opacity]
        ),
      ]);
      expect(
        firstPixelDifference(ours, neo),
        `opacity ${opacity}: ${describeDifference(ours, neo, W)}`
      ).toBe(-1);
    }
  });

  it("renders the eraser identically", () => {
    const engine = new DrawingEngine(W, H);
    const cp = createCanonicalPainter(W, H);

    const base = pen(
      [
        [4, 30],
        [60, 30],
      ],
      20,
      BLACK
    );
    const erase: StrokeSpec = {
      layer: LAYER.BACKGROUND,
      color: BLACK,
      width: 8,
      lineType: LINETYPE.ERASER,
      points: [
        [16, 24],
        [44, 36],
      ],
    };

    for (const stroke of [base, erase]) {
      ourDrawStroke(engine, stroke);
      neoDrawStroke(cp, stroke);
    }

    const ours = new Uint8ClampedArray(engine.layers.background);
    const neo = readPixels(cp.contexts[LAYER.BACKGROUND], W, H);
    expect(
      firstPixelDifference(ours, neo),
      describeDifference(ours, neo, W)
    ).toBe(-1);
  });

  it("renders halftone identically", () => {
    const stroke: StrokeSpec = {
      layer: LAYER.BACKGROUND,
      color: BLACK,
      width: 10,
      lineType: LINETYPE.TONE,
      points: [
        [10, 10],
        [50, 45],
      ],
    };
    const { ours, neo } = runBoth([stroke]);
    expect(
      firstPixelDifference(ours, neo),
      describeDifference(ours, neo, W)
    ).toBe(-1);
  });

  it("flood fills identically", () => {
    const engine = new DrawingEngine(W, H);
    const cp = createCanonicalPainter(W, H);

    // r=200, g=100, b=50, a=255 -> ABGR packed as NEO stores it
    const [r, g, b, a] = [200, 100, 50, 255];
    engine.doFloodFill(engine.layers.background, 0, 0, r, g, b, a);

    const packed = (a << 24) | (b << 16) | (g << 8) | r;
    cp.painter.doFloodFill(LAYER.BACKGROUND, 0, 0, packed);

    const ours = new Uint8ClampedArray(engine.layers.background);
    const neo = readPixels(cp.contexts[LAYER.BACKGROUND], W, H);
    expect(
      firstPixelDifference(ours, neo),
      describeDifference(ours, neo, W)
    ).toBe(-1);
  });
});
