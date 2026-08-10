import { describe, expect, it } from "vitest";
import { LINETYPE, NeoPainter, TOOLTYPE } from "./NeoPainter";
import { BufferSurface } from "./PixelSurface";
import {
  blurRectExtent,
  clearCanvasExtent,
  eraseAllExtent,
  eraseRectExtent,
  extentContains,
  fillExtent,
  flipExtent,
  floodFillExtent,
  mergeExtent,
  pasteExtent,
  strokeExtent,
  turnExtent,
  type Extent,
} from "./extents";

const W = 48;
const H = 48;

/**
 * A painter whose layers are plain buffers, so a before/after diff shows
 * exactly which pixels an operation touched.
 */
function scratchPainter() {
  const painter = new NeoPainter(W, H);
  const layers = [
    new Uint8ClampedArray(W * H * 4),
    new Uint8ClampedArray(W * H * 4),
  ];
  painter.surfaces = [
    new BufferSurface(layers[0], W, H),
    new BufferSurface(layers[1], W, H),
  ];

  // Content on both layers, so every operation has something to change
  const seed = (layer: number, color: [number, number, number, number], size: number,
                points: [number, number][]) => {
    painter._currentColor = [...color];
    painter._currentWidth = size;
    painter._currentMaskType = 0;
    const [x0, y0] = points[0];
    painter.drawLine(painter.surfaces[layer], x0, y0, x0, y0, LINETYPE.PEN);
    for (let i = 1; i < points.length; i++) {
      const [nx, ny] = points[i];
      const [px, py] = points[i - 1];
      painter.drawLine(painter.surfaces[layer], nx, ny, px, py, LINETYPE.PEN);
    }
    painter.prevLine = null;
  };

  seed(0, [200, 60, 40, 255], 16, [[2, 8], [46, 40]]);
  // A contrasting stroke across the first: blur returns a uniform region
  // unchanged, so without an edge to work on it would have nothing to prove.
  seed(0, [20, 20, 20, 255], 5, [[8, 42], [42, 6]]);
  seed(1, [40, 90, 200, 220], 12, [[4, 40], [44, 6]]);

  return { painter, layers };
}

const snapshot = (layers: Uint8ClampedArray[]) =>
  layers.map((l) => new Uint8ClampedArray(l));

/**
 * Every pixel an operation changed must fall inside the extent it declared,
 * on a layer the extent names. Over-declaring is fine; under-declaring is what
 * makes collaborative clients diverge.
 */
function expectWithin(
  before: Uint8ClampedArray[],
  after: Uint8ClampedArray[],
  extent: Extent,
  label: string
) {
  let changed = 0;
  const outside: string[] = [];

  for (let layer = 0; layer < before.length; layer++) {
    for (let i = 0; i < before[layer].length; i += 4) {
      const differs =
        before[layer][i] !== after[layer][i] ||
        before[layer][i + 1] !== after[layer][i + 1] ||
        before[layer][i + 2] !== after[layer][i + 2] ||
        before[layer][i + 3] !== after[layer][i + 3];
      if (!differs) continue;

      changed++;
      const pixel = i / 4;
      const x = pixel % W;
      const y = Math.floor(pixel / W);

      if (!extent.layers.includes(layer) || !extentContains(extent, x, y)) {
        if (outside.length < 8) outside.push(`layer ${layer} (${x}, ${y})`);
      }
    }
  }

  expect(
    changed,
    `${label}: the operation changed nothing, so the test proves nothing`
  ).toBeGreaterThan(0);
  expect(
    outside,
    `${label}: changed pixels outside the declared extent ` +
      `[layers ${extent.layers}, x ${extent.x0}..${extent.x1}, y ${extent.y0}..${extent.y1}]`
  ).toEqual([]);
}

describe("declared extents cover what each operation actually changes", () => {
  it("freehand strokes of every line type", () => {
    const points = [
      { x: 10, y: 12 },
      { x: 26, y: 30 },
      { x: 38, y: 20 },
    ];
    for (const [name, lineType] of [
      ["PEN", LINETYPE.PEN],
      ["ERASER", LINETYPE.ERASER],
      ["BRUSH", LINETYPE.BRUSH],
      ["TONE", LINETYPE.TONE],
      ["DODGE", LINETYPE.DODGE],
      ["BURN", LINETYPE.BURN],
      ["BLUR", LINETYPE.BLUR],
    ] as [string, number][]) {
      // A one-pixel blur brush is an identity in NEO: it takes a single sample
      // and divides by that sample's own weight, so nothing moves. Excluded
      // rather than special-cased, so the vacuity guard stays strict.
      const sizes = lineType === LINETYPE.BLUR ? [7, 20] : [1, 7, 20];
      for (const size of sizes) {
        const { painter, layers } = scratchPainter();
        const before = snapshot(layers);

        painter._currentColor = [10, 10, 10, 255];
        painter._currentWidth = size;
        painter.drawLine(painter.surfaces[0], points[0].x, points[0].y, points[0].x, points[0].y, lineType);
        for (let i = 1; i < points.length; i++) {
          painter.drawLine(
            painter.surfaces[0], points[i].x, points[i].y,
            points[i - 1].x, points[i - 1].y, lineType
          );
        }
        painter.prevLine = null;

        expectWithin(before, layers, strokeExtent(0, points, size), `${name} size ${size}`);
      }
    }
  });

  it("eraseRect", () => {
    const { painter, layers } = scratchPainter();
    const before = snapshot(layers);
    painter._currentColor = [0, 0, 0, 255];
    painter.eraseRect(0, 6, 8, 24, 18);
    expectWithin(before, layers, eraseRectExtent(0, 6, 8, 24, 18), "eraseRect");
  });

  it("blurRect", () => {
    const { painter, layers } = scratchPainter();
    const before = snapshot(layers);
    painter._currentColor = [0, 0, 0, 255];
    painter.blurRect(0, 8, 8, 22, 20);
    expectWithin(before, layers, blurRectExtent(0, 8, 8, 22, 20), "blurRect");
  });

  it("flipH and flipV", () => {
    for (const axis of ["H", "V"] as const) {
      const { painter, layers } = scratchPainter();
      const before = snapshot(layers);
      if (axis === "H") painter.flipH(0, 4, 6, 30, 22);
      else painter.flipV(0, 4, 6, 30, 22);
      expectWithin(before, layers, flipExtent(0, 4, 6, 30, 22), `flip${axis}`);
    }
  });

  it("turn, which writes a rotated rectangle", () => {
    // Deliberately non-square: the source rect alone would understate it
    const { painter, layers } = scratchPainter();
    const before = snapshot(layers);
    painter.turn(0, 6, 6, 28, 12);
    expectWithin(before, layers, turnExtent(0, 6, 6, 28, 12), "turn 28x12");
  });

  it("merge, which touches both layers", () => {
    const { painter, layers } = scratchPainter();
    const before = snapshot(layers);
    painter.merge(0, 0, 0, W, H);
    expectWithin(before, layers, mergeExtent(0, 0, W, H), "merge");
  });

  it("paste, which writes at the offset position", () => {
    const { painter, layers } = scratchPainter();
    painter.copy(0, 4, 4, 16, 14);
    const before = snapshot(layers);
    painter.paste(0, 4, 4, 16, 14, 14, 18);
    expectWithin(before, layers, pasteExtent(0, 4, 4, 16, 14, 14, 18), "paste");
  });

  it("doFill for each shape mask", () => {
    for (const type of [
      TOOLTYPE.RECT,
      TOOLTYPE.RECTFILL,
      TOOLTYPE.ELLIPSE,
      TOOLTYPE.ELLIPSEFILL,
    ]) {
      const { painter, layers } = scratchPainter();
      const before = snapshot(layers);
      painter._currentColor = [30, 200, 90, 255];
      painter._currentWidth = 3;
      painter._currentMaskType = 0;
      painter.doFill(0, 8, 8, 26, 22, type);
      expectWithin(before, layers, fillExtent(0, 8, 8, 26, 22), `doFill ${type}`);
    }
  });

  it("doFloodFill", () => {
    const { painter, layers } = scratchPainter();
    const before = snapshot(layers);
    painter.doFloodFill(painter.surfaces[1], 1, 1, 0xff2266aa);
    expectWithin(before, layers, floodFillExtent(1, W, H), "doFloodFill");
  });

  it("eraseAll and clearCanvas", () => {
    {
      const { painter, layers } = scratchPainter();
      const before = snapshot(layers);
      painter.eraseAll(1);
      expectWithin(before, layers, eraseAllExtent(1, W, H), "eraseAll");
    }
    {
      const { painter, layers } = scratchPainter();
      const before = snapshot(layers);
      painter.clearCanvas();
      expectWithin(before, layers, clearCanvasExtent(W, H), "clearCanvas");
    }
  });
});

describe("extents that would be wrong if derived naively", () => {
  it("turn's source rectangle does not contain what turn writes", () => {
    // The guard rail for the guard rail: if this ever stops failing, turn has
    // changed and turnExtent's square is no longer needed.
    const { painter, layers } = scratchPainter();
    const before = snapshot(layers);
    painter.turn(0, 6, 6, 28, 12);

    const naive = { layers: [0], x0: 6, y0: 6, x1: 6 + 28 - 1, y1: 6 + 12 - 1 };
    let escaped = 0;
    for (let i = 0; i < before[0].length; i += 4) {
      const differs =
        before[0][i] !== layers[0][i] ||
        before[0][i + 1] !== layers[0][i + 1] ||
        before[0][i + 2] !== layers[0][i + 2] ||
        before[0][i + 3] !== layers[0][i + 3];
      if (!differs) continue;
      const pixel = i / 4;
      if (!extentContains(naive, pixel % W, Math.floor(pixel / W))) escaped++;
    }
    expect(escaped).toBeGreaterThan(0);
  });

  it("merge changes the layer a single-layer extent would omit", () => {
    const { painter, layers } = scratchPainter();
    const before = snapshot(layers);
    painter.merge(0, 0, 0, W, H);

    let changedOnSource = 0;
    for (let i = 0; i < before[1].length; i += 4) {
      if (before[1][i + 3] !== layers[1][i + 3]) changedOnSource++;
    }
    expect(changedOnSource).toBeGreaterThan(0);
  });
});
