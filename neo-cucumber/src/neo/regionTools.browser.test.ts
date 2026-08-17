import { describe, expect, it } from "vitest";
import { DrawingEngine } from "../DrawingEngine";
import { ActionRecorder } from "../utils/ActionRecorder";
import {
  brushTypeFor,
  extentFor,
  fillToolTypeFor,
  fontSizeForBrush,
  frameShapeFor,
  isRegionTool,
  TEXT_FONT_FAMILY,
  type RegionTool,
} from "./tools";
import { extentContains } from "./extents";
import { NeoPainter } from "./NeoPainter";
import { BufferSurface } from "./PixelSurface";
import { NeoReplay, decodePCH as decodeReplay } from "./NeoReplay";
import {
  createCanonicalPainter,
  describeDifference,
  firstPixelDifference,
  readPixels,
  replayWithNeo,
} from "../test/neoHarness";
import { CanvasHistory } from "../utils/canvasHistory";
import { decodeMessage, encodeRegion } from "../../../frontend/collaborate/binaryProtocol";
import { isHistoryOperation } from "../synchronization/historyOperations";

const W = 48;
const H = 48;

const COLOR = { r: 30, g: 200, b: 90, a: 255 };
const SIZE = 3;

/**
 * An engine and a reference painter carrying the same starting picture.
 *
 * The reference is buffer-backed rather than canvas-backed on purpose. A
 * canvas loses a little translucent colour on every write and the painter
 * deliberately does not, so comparing against one here would measure storage
 * precision rather than whether the tool was mapped to the right kernel.
 * NeoRegions.browser.test.ts holds the kernels themselves to canonical NEO,
 * canvas against canvas, where that difference does not arise.
 */
function seeded() {
  const engine = new DrawingEngine(W, H);
  const refLayers = [
    new Uint8ClampedArray(W * H * 4),
    new Uint8ClampedArray(W * H * 4),
  ];
  const reference = new NeoPainter(W, H);
  reference.surfaces = [
    new BufferSurface(refLayers[0], W, H),
    new BufferSurface(refLayers[1], W, H),
  ];
  const cp = { painter: reference, contexts: reference.surfaces, layers: refLayers };

  const strokes: [number, [number, number, number, number], number, [number, number][]][] = [
    [0, [200, 60, 40, 255], 16, [[2, 8], [46, 40]]],
    [0, [20, 20, 20, 255], 5, [[8, 42], [42, 6]]],
    [1, [40, 90, 200, 220], 12, [[4, 40], [44, 6]]],
  ];

  for (const [layer, color, size, points] of strokes) {
    const buffer = layer === 0 ? engine.layers.background : engine.layers.foreground;
    const [r, g, b, a] = color;
    const [x0, y0] = points[0];
    engine.drawLine(buffer, x0, y0, x0, y0, size, "solid", r, g, b, a);
    for (let i = 1; i < points.length; i++) {
      const [nx, ny] = points[i];
      const [px, py] = points[i - 1];
      engine.drawLine(buffer, nx, ny, px, py, size, "solid", r, g, b, a);
    }
    engine.setStrokeState(null);

    cp.painter._currentColor = [...color];
    cp.painter._currentWidth = size;
    cp.painter.drawLine(cp.contexts[layer], x0, y0, x0, y0, 1);
    for (let i = 1; i < points.length; i++) {
      const [nx, ny] = points[i];
      const [px, py] = points[i - 1];
      cp.painter.drawLine(cp.contexts[layer], nx, ny, px, py, 1);
    }
    cp.painter.prevLine = null;
  }

  return { engine, cp };
}

const zeroTransparent = (px: Uint8ClampedArray) => {
  const out = new Uint8ClampedArray(px);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) {
      out[i] = out[i + 1] = out[i + 2] = 0;
    }
  }
  return out;
};

const RECT = { x: 6, y: 8, width: 28, height: 18 };

describe("the tool model", () => {
  it("tells region tools apart from brushes", () => {
    for (const tool of ["eraseRect", "turn", "merge", "ellipseFill"] as RegionTool[]) {
      expect(isRegionTool(tool)).toBe(true);
    }
    for (const tool of ["solid", "brush", "blur", "eraser", "fill", "pan"] as const) {
      expect(isRegionTool(tool)).toBe(false);
    }
  });

  it("gives every brush tool its own brush type and region tools none", () => {
    expect(brushTypeFor("blur")).toBe("blur");
    expect(brushTypeFor("halftone")).toBe("halftone");
    // A region tool has no brush type; asking gets the harmless default rather
    // than a claim that some particular brush is in use.
    expect(brushTypeFor("blurRect")).toBe("solid");
  });

  it("answers the extent question for every region tool", () => {
    for (const tool of [
      "eraseRect", "blurRect", "merge", "flipH", "flipV", "turn",
      "rect", "rectFill", "ellipse", "ellipseFill",
    ] as RegionTool[]) {
      const extent = extentFor(tool, 0, RECT);
      expect(extent.layers.length, tool).toBeGreaterThan(0);
      expect(extent.x1, tool).toBeGreaterThanOrEqual(extent.x0);
      expect(frameShapeFor(tool), tool).not.toBeNull();
    }
    // merge is the one that names both layers
    expect(extentFor("merge", 0, RECT).layers).toEqual([0, 1]);
    // and turn's is the square containing both orientations
    const turned = extentFor("turn", 0, RECT);
    expect(turned.x1 - turned.x0).toBe(turned.y1 - turned.y0);
  });

  it("maps only the shape tools to a fill mask", () => {
    expect(fillToolTypeFor("rectFill")).not.toBeNull();
    expect(fillToolTypeFor("ellipse")).not.toBeNull();
    expect(fillToolTypeFor("eraseRect")).toBeNull();
    expect(fillToolTypeFor("turn")).toBeNull();
  });
});

describe("region tools through the engine map to the right kernel", () => {
  const cases: [RegionTool, (cp: ReturnType<typeof seeded>["cp"]) => void][] = [
    ["eraseRect", ({ painter }) => painter.eraseRect(0, RECT.x, RECT.y, RECT.width, RECT.height)],
    ["blurRect", ({ painter }) => painter.blurRect(0, RECT.x, RECT.y, RECT.width, RECT.height)],
    ["flipH", ({ painter }) => painter.flipH(0, RECT.x, RECT.y, RECT.width, RECT.height)],
    ["flipV", ({ painter }) => painter.flipV(0, RECT.x, RECT.y, RECT.width, RECT.height)],
    ["turn", ({ painter }) => painter.turn(0, RECT.x, RECT.y, RECT.width, RECT.height)],
    ["merge", ({ painter }) => painter.merge(0, RECT.x, RECT.y, RECT.width, RECT.height)],
    ["rectFill", ({ painter }) => painter.doFill(0, RECT.x, RECT.y, RECT.width, RECT.height, fillToolTypeFor("rectFill")!)],
    ["ellipse", ({ painter }) => painter.doFill(0, RECT.x, RECT.y, RECT.width, RECT.height, fillToolTypeFor("ellipse")!)],
  ];

  for (const [tool, applyToNeo] of cases) {
    it(`${tool} matches the kernel it should call`, () => {
      const { engine, cp } = seeded();

      cp.painter._currentColor = [COLOR.r, COLOR.g, COLOR.b, COLOR.a];
      cp.painter._currentWidth = SIZE;
      cp.painter._currentMaskType = 0;
      applyToNeo(cp);

      engine.applyRegionTool(tool, "background", RECT, COLOR, SIZE);

      for (const layer of [0, 1]) {
        const ours = zeroTransparent(
          new Uint8ClampedArray(layer === 0 ? engine.layers.background : engine.layers.foreground)
        );
        const neo = zeroTransparent(new Uint8ClampedArray(cp.layers[layer]));
        expect(
          firstPixelDifference(ours, neo),
          `${tool} layer ${layer}: ${describeDifference(ours, neo, W)}`
        ).toBe(-1);
      }
    });

    it(`${tool} stays inside the extent it declares`, () => {
      const { engine } = seeded();
      const before = [
        new Uint8ClampedArray(engine.layers.background),
        new Uint8ClampedArray(engine.layers.foreground),
      ];
      engine.applyRegionTool(tool, "background", RECT, COLOR, SIZE);
      const after = [engine.layers.background, engine.layers.foreground];

      const extent = extentFor(tool, 0, RECT);
      const outside: string[] = [];
      for (let layer = 0; layer < 2; layer++) {
        for (let i = 0; i < before[layer].length; i += 4) {
          const differs =
            before[layer][i] !== after[layer][i] ||
            before[layer][i + 3] !== after[layer][i + 3];
          if (!differs) continue;
          const pixel = i / 4;
          const x = pixel % W;
          const y = Math.floor(pixel / W);
          if (!extent.layers.includes(layer) || !extentContains(extent, x, y)) {
            if (outside.length < 5) outside.push(`layer ${layer} (${x}, ${y})`);
          }
        }
      }
      expect(outside, `${tool} escaped its declared extent`).toEqual([]);
    });
  }
});

describe("eraseRect end to end", () => {
  it("applies and confirms WhiteRegion through collaborative history", async () => {
    const engine = new DrawingEngine(W, H);
    const layer = engine.layers.background;
    for (let i = 0; i < layer.length; i += 4) {
      layer[i] = 40;
      layer[i + 1] = 90;
      layer[i + 2] = 180;
      layer[i + 3] = 255;
    }

    const history = new CanvasHistory(engine);
    history.setLocalUserId(7);
    // The engine keys its pairs by actor, and this one belongs to user 7 --
    // the same rename the painter does when the server names it. Without it
    // the operation would land in a second pair and leave `layer` untouched.
    engine.setLocalOwner("7");
    const bytes = encodeRegion(7, 7,
      "background",
      "eraseRect",
      RECT,
      { r: 0, g: 0, b: 0, a: 255 },
      SIZE
    );
    const message = decodeMessage(bytes)!;
    if (!isHistoryOperation(message)) throw new Error("expected history operation");

    history.handleLocal(bytes, message);
    const inside = ((RECT.y + 2) * W + RECT.x + 2) * 4 + 3;
    const outside = 2 * 4 + 3;
    expect(layer[inside]).toBe(0);
    expect(layer[outside]).toBe(255);
    expect(history.hasPendingLocal).toBe(true);

    await history.handleRemote(new Uint8Array(bytes), message, 12);
    expect(history.hasPendingLocal).toBe(false);
    expect(layer[inside]).toBe(0);
    expect(layer[outside]).toBe(255);
  });

  it("records a frame that replays back to the same pixels", async () => {
    const { engine } = seeded();
    const recorder = new ActionRecorder();

    // Rebuild the same starting picture in the recording, so the replay has
    // something to erase from.
    const strokes: [number, [number, number, number, number], number, [number, number][]][] = [
      [0, [200, 60, 40, 255], 16, [[2, 8], [46, 40]]],
      [0, [20, 20, 20, 255], 5, [[8, 42], [42, 6]]],
      [1, [40, 90, 200, 220], 12, [[4, 40], [44, 6]]],
    ];
    for (const [layer, color, size, points] of strokes) {
      const [r, g, b, a] = color;
      const [x0, y0] = points[0];
      recorder.step();
      recorder.push("freeHand", layer, r, g, b, a, 0, 0, 0, size, 0, 1, x0, y0, x0, y0);
      for (let i = 1; i < points.length; i++) {
        recorder.push(points[i][0], points[i][1]);
      }
    }

    const shape = frameShapeFor("eraseRect")!;
    expect(shape.verb).toBe("eraseRect2");
    expect(shape.carriesDrawingState).toBe(true);

    engine.applyRegionTool("eraseRect", "background", RECT, COLOR, SIZE);
    recorder.pushRegion(shape.verb, shape.carriesDrawingState, 0, RECT, COLOR, SIZE);

    const decoded = decodeReplay(
      new Uint8Array(await recorder.getReplayBlob(W, H).arrayBuffer())
    )!;
    const frame = decoded.items[decoded.items.length - 1];
    expect(frame[0]).toBe("eraseRect2");
    // pushCurrent occupies 2..10, so the rectangle starts at 11
    expect(frame.slice(11, 15)).toEqual([RECT.x, RECT.y, RECT.width, RECT.height]);

    // Replay, and compare against doing the same operations directly -- both
    // canvas-backed, so this measures whether the recorded frame reproduces
    // the operation, not how the painter stores pixels.
    const replay = new NeoReplay(W, H);
    await replay.playAll(decoded.items);

    const direct = new NeoReplay(W, H);
    await direct.playAll(decoded.items.slice(0, -1));
    direct.painter._currentColor = [COLOR.r, COLOR.g, COLOR.b, COLOR.a];
    direct.painter._currentWidth = SIZE;
    direct.painter._currentMaskType = 0;
    direct.painter.eraseRect(0, RECT.x, RECT.y, RECT.width, RECT.height);

    const ours = zeroTransparent(direct.getLayerPixels(0));
    const neo = zeroTransparent(replay.getLayerPixels(0));
    expect(
      firstPixelDifference(ours, neo),
      describeDifference(ours, neo, W)
    ).toBe(-1);
  });
});

/**
 * Every region tool and the text tool, recorded and then read back by
 * canonical NEO.
 *
 * `frameShapeFor` decides the verb each tool is written as and whether its
 * geometry sits at slot 2 or slot 11 -- the difference being the nine slots
 * `pushCurrent` writes before it. Get that boundary wrong and every field
 * after it shifts, producing a file that replays into something else
 * entirely, quietly, for as long as the file exists. Only eraseRect was
 * pinned; the rest were covered for rasterisation but not for the shape of
 * what gets written down.
 *
 * Both sides here are canvas-backed -- canonical NEO against our own reader --
 * so what is being compared is whether a frame we wrote means the same thing
 * to NEO as it does to us, rather than how the painter stores pixels.
 */
describe("every recorded tool, replayed by canonical NEO", () => {
  /** The seed strokes, as frames, so a replay starts from the same picture. */
  function seedFrames(recorder: ActionRecorder) {
    const strokes: [number, [number, number, number, number], number, [number, number][]][] = [
      [0, [200, 60, 40, 255], 16, [[2, 8], [46, 40]]],
      [0, [20, 20, 20, 255], 5, [[8, 42], [42, 6]]],
      [1, [40, 90, 200, 220], 12, [[4, 40], [44, 6]]],
    ];
    for (const [layer, color, size, points] of strokes) {
      const [r, g, b, a] = color;
      const [x0, y0] = points[0];
      recorder.step();
      recorder.push("freeHand", layer, r, g, b, a, 0, 0, 0, size, 0, 1, x0, y0, x0, y0);
      for (let i = 1; i < points.length; i++) {
        recorder.push(points[i][0], points[i][1]);
      }
    }
  }

  /** Replays a recording through canonical NEO and through our own reader. */
  async function bothReaders(recorder: ActionRecorder) {
    const decoded = decodeReplay(
      new Uint8Array(await recorder.getReplayBlob(W, H).arrayBuffer())
    )!;

    const cp = createCanonicalPainter(W, H);
    replayWithNeo(cp, decoded.items);

    const ours = new NeoReplay(W, H);
    await ours.playAll(decoded.items);

    return { decoded, cp, ours };
  }

  function expectSameLayers(
    cp: ReturnType<typeof createCanonicalPainter>,
    ours: NeoReplay,
    tool: string
  ) {
    for (const layer of [0, 1]) {
      const neo = zeroTransparent(readPixels(cp.contexts[layer], W, H));
      const mine = zeroTransparent(ours.getLayerPixels(layer));
      expect(
        firstPixelDifference(mine, neo),
        `${tool} layer ${layer}: ${describeDifference(mine, neo, W)}`
      ).toBe(-1);
    }
  }

  /**
   * What each tool's frame has to look like, transcribed from NEO's
   * `actions.js` rather than derived from our own tool table.
   *
   * Asking `frameShapeFor` where the geometry is and then checking it is there
   * proves nothing -- and neither does comparing two readers, since both read
   * the slot the writer used. The number has to come from outside.
   */
  const EXPECTED: Record<string, { verb: string; geometryAt: number }> = {
    // pushes pushCurrent's nine slots first, so geometry starts at 11
    eraseRect: { verb: "eraseRect2", geometryAt: 11 },
    blurRect: { verb: "blurRect", geometryAt: 2 },
    merge: { verb: "merge", geometryAt: 2 },
    flipH: { verb: "flipH", geometryAt: 2 },
    flipV: { verb: "flipV", geometryAt: 2 },
    turn: { verb: "turn", geometryAt: 2 },
    // the shape tools are all NEO's `fill`, told apart by a trailing TOOLTYPE
    rect: { verb: "fill", geometryAt: 11 },
    rectFill: { verb: "fill", geometryAt: 11 },
    ellipse: { verb: "fill", geometryAt: 11 },
    ellipseFill: { verb: "fill", geometryAt: 11 },
  };

  for (const tool of Object.keys(EXPECTED) as RegionTool[]) {
    it(`writes ${tool} in a shape NEO reads back the same way`, async () => {
      const recorder = new ActionRecorder();
      seedFrames(recorder);

      const shape = frameShapeFor(tool)!;
      const toolType = fillToolTypeFor(tool);
      recorder.pushRegion(
        shape.verb,
        shape.carriesDrawingState,
        0,
        RECT,
        COLOR,
        SIZE,
        toolType === null ? [] : [toolType]
      );

      const { decoded, cp, ours } = await bothReaders(recorder);
      const frame = decoded.items[decoded.items.length - 1];
      const expected = EXPECTED[tool];
      expect(frame[0]).toBe(expected.verb);
      expect(frame.slice(expected.geometryAt, expected.geometryAt + 4)).toEqual([
        RECT.x, RECT.y, RECT.width, RECT.height,
      ]);
      if (toolType !== null) {
        expect(frame[expected.geometryAt + 4]).toBe(toolType);
      }

      expectSameLayers(cp, ours, tool);
    });
  }

  /**
   * copy fills a clipboard and writes nothing; paste writes what copy took,
   * offset by the two trailing fields at the end of its frame. They only mean
   * anything as a pair, so they are recorded and replayed as one.
   */
  it("writes copy and paste in a shape NEO reads back the same way", async () => {
    const recorder = new ActionRecorder();
    seedFrames(recorder);

    const copy = frameShapeFor("copy")!;
    recorder.pushRegion(copy.verb, copy.carriesDrawingState, 0, RECT, COLOR, SIZE);
    const paste = frameShapeFor("paste")!;
    const target = { x: RECT.x + 4, y: RECT.y + 6, width: RECT.width, height: RECT.height };
    recorder.pushRegion(paste.verb, paste.carriesDrawingState, 0, target, COLOR, SIZE, [0, 0]);

    const { decoded, cp, ours } = await bothReaders(recorder);
    const pasteFrame = decoded.items[decoded.items.length - 1];
    expect(pasteFrame[0]).toBe("paste");
    expect(pasteFrame.slice(2, 8)).toEqual([
      target.x, target.y, target.width, target.height, 0, 0,
    ]);
    expect(decoded.items[decoded.items.length - 2][0]).toBe("copy");

    expectSameLayers(cp, ours, "copy+paste");
  });

  it("writes eraseAll in a shape NEO reads back the same way", async () => {
    const recorder = new ActionRecorder();
    seedFrames(recorder);
    recorder.step();
    recorder.push("eraseAll", 1);

    const { cp, ours } = await bothReaders(recorder);
    expectSameLayers(cp, ours, "eraseAll");
  });

  /**
   * Text is the one frame whose alpha is 0..1 rather than 0..255, and whose
   * colour is packed with red in the low byte. Both are easy to write the
   * other way round and impossible to notice without reading it back.
   */
  it("writes text in a shape NEO reads back the same way", async () => {
    const recorder = new ActionRecorder();
    seedFrames(recorder);
    recorder.step();
    recorder.push(
      "text", 0, 8, 30,
      COLOR.r | (COLOR.g << 8) | (COLOR.b << 16),
      COLOR.a / 255,
      "Ag",
      `${fontSizeForBrush(SIZE)}px`,
      TEXT_FONT_FAMILY
    );

    const { decoded, cp, ours } = await bothReaders(recorder);
    const frame = decoded.items[decoded.items.length - 1];
    expect(frame[0]).toBe("text");
    expect(frame[6]).toBe("Ag");
    expectSameLayers(cp, ours, "text");
  });
});
