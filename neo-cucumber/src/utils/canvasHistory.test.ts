import { describe, expect, it, vi } from "vitest";
import { CanvasHistory } from "./canvasHistory";
import {
  decodeMessage,
  encodeDrawLine,
  encodeFill,
  encodeUndo,
  encodeUndoPoint,
} from "./binaryProtocol";
import { type DrawingEngine } from "../DrawingEngine";

vi.mock("./canvasSnapshot", () => ({
  pngDataToLayer: vi.fn(async () => new Uint8ClampedArray(SIZE * SIZE * 4).fill(7)),
}));

const SIZE = 16;
const LOCAL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const REMOTE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

type StrokeState = [[number, number], [number, number]] | null;

// Deterministic, observable stand-in for DrawingEngine: drawLine writes the
// red value at both endpoints (last writer wins), fill floods the layer's red
// channel, and every operation is logged so tests can detect replays.
class FakeEngine {
  imageWidth = SIZE;
  imageHeight = SIZE;
  layers: Record<string, Uint8ClampedArray> = {
    foreground: new Uint8ClampedArray(SIZE * SIZE * 4),
    background: new Uint8ClampedArray(SIZE * SIZE * 4),
  };
  ops: string[] = [];
  private strokeState: StrokeState = null;

  drawLine(
    ctx: Uint8ClampedArray,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    _brushSize: number,
    _brushType: string,
    r: number
  ) {
    ctx[(y0 * SIZE + x0) * 4] = r;
    ctx[(y1 * SIZE + x1) * 4] = r;
    this.ops.push(`line:${x0},${y0}-${x1},${y1}:${r}`);
    this.strokeState = [
      [x0, y0],
      [x1, y1],
    ];
  }

  doFloodFill(ctx: Uint8ClampedArray, _x: number, _y: number, r: number) {
    for (let i = 0; i < ctx.length; i += 4) {
      ctx[i] = r;
    }
    this.ops.push(`fill:${r}`);
  }

  queueLayerUpdate() {}

  getStrokeState(): StrokeState {
    return this.strokeState;
  }

  setStrokeState(state: StrokeState) {
    this.strokeState = state;
  }
}

function setup() {
  const engine = new FakeEngine();
  const history = new CanvasHistory(
    engine as unknown as DrawingEngine,
    LOCAL
  );
  return { engine, history };
}

function red(engine: FakeEngine, x: number, y: number): number {
  return engine.layers.foreground[(y * SIZE + x) * 4];
}

function line(
  userId: string,
  x: number,
  y: number,
  r: number
): ArrayBuffer {
  return encodeDrawLine(userId, "foreground", x, y, x, y, 1, "solid", r, 0, 0, 255, "mouse");
}

// Dispatches a locally drawn message (optimistic apply + fork entry)
function local(history: CanvasHistory, bytes: ArrayBuffer) {
  history.handleLocal(bytes, decodeMessage(bytes)!);
}

// Delivers a message from the canonical server stream
async function remote(history: CanvasHistory, bytes: ArrayBuffer, seq?: number) {
  await history.handleRemote(new Uint8Array(bytes), decodeMessage(bytes)!, seq);
}

describe("canonical application", () => {
  it("applies remote draws in server order, last writer wins", async () => {
    const { engine, history } = setup();
    await remote(history, line(REMOTE, 1, 1, 50), 1);
    await remote(history, line(REMOTE, 1, 1, 60), 2);
    expect(red(engine, 1, 1)).toBe(60);
    expect(engine.ops).toHaveLength(2);
  });

  it("applies a remote snapshot's decoded pixels", async () => {
    const { engine, history } = setup();
    const msg = {
      type: "snapshot" as const,
      userId: REMOTE,
      layer: "foreground" as const,
      pngData: new Uint8Array(0),
    };
    await history.handleRemote(new Uint8Array([0x02, 9, 9]), msg, 1);
    expect(red(engine, 0, 0)).toBe(7);
  });
});

describe("local fork reconciliation", () => {
  it("does not re-apply the echo of a local message", async () => {
    const { engine, history } = setup();
    const bytes = line(LOCAL, 2, 2, 100);
    local(history, bytes);
    expect(red(engine, 2, 2)).toBe(100);
    expect(history.forkSize).toBe(1);

    await remote(history, bytes, 1);
    expect(history.forkSize).toBe(0);
    expect(engine.ops).toHaveLength(1); // applied exactly once
    expect(red(engine, 2, 2)).toBe(100);
  });

  it("applies a non-overlapping remote draw without replaying the fork", async () => {
    const { engine, history } = setup();
    local(history, encodeUndoPoint(LOCAL));
    local(history, line(LOCAL, 1, 1, 100));

    await remote(history, line(REMOTE, 10, 10, 200), 1);
    expect(red(engine, 1, 1)).toBe(100);
    expect(red(engine, 10, 10)).toBe(200);
    expect(engine.ops).toHaveLength(2); // no replay of the fork entry
  });

  it("replays the fork on top of an overlapping remote draw", async () => {
    const { engine, history } = setup();
    local(history, encodeUndoPoint(LOCAL));
    const mine = line(LOCAL, 5, 5, 100);
    local(history, mine);

    // Same pixel: canonical order is remote first, so the unconfirmed local
    // stroke must end up on top
    await remote(history, line(REMOTE, 5, 5, 200), 1);
    expect(red(engine, 5, 5)).toBe(100);
    expect(engine.ops).toHaveLength(3); // local, remote (replay), local again

    // Echoes arrive; the canvas must not change
    await remote(history, encodeUndoPoint(LOCAL), 2);
    await remote(history, mine, 3);
    expect(red(engine, 5, 5)).toBe(100);
    expect(history.forkSize).toBe(0);
  });

  it("drops the fork and converges when the same user draws from another connection", async () => {
    const { engine, history } = setup();
    local(history, encodeUndoPoint(LOCAL));
    const mine = line(LOCAL, 3, 3, 100);
    local(history, mine);

    // A different message from the same user arrives first: server order
    // diverged, so the optimistic stroke is rolled back...
    await remote(history, line(LOCAL, 4, 4, 50), 1);
    expect(red(engine, 3, 3)).toBe(0);
    expect(red(engine, 4, 4)).toBe(50);
    expect(history.forkSize).toBe(0);

    // ...and re-appears when its echo arrives in canonical order
    await remote(history, encodeUndoPoint(LOCAL), 2);
    await remote(history, mine, 3);
    expect(red(engine, 3, 3)).toBe(100);
    expect(red(engine, 4, 4)).toBe(50);
  });
});

describe("collaborative undo", () => {
  async function confirmedStroke(
    history: CanvasHistory,
    userId: string,
    x: number,
    y: number,
    r: number,
    seq: number
  ) {
    await remote(history, encodeUndoPoint(userId), seq);
    await remote(history, line(userId, x, y, r), seq + 1);
  }

  it("undoes only the sender's stroke and redo restores it", async () => {
    const { engine, history } = setup();
    await confirmedStroke(history, LOCAL, 1, 1, 100, 1);
    await remote(history, line(REMOTE, 2, 2, 200), 3);
    expect(history.canUndo()).toBe(true);

    const undo = encodeUndo(LOCAL, false);
    local(history, undo);
    await remote(history, undo);
    expect(red(engine, 1, 1)).toBe(0); // local stroke reverted
    expect(red(engine, 2, 2)).toBe(200); // remote stroke preserved
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);

    const redo = encodeUndo(LOCAL, true);
    local(history, redo);
    await remote(history, redo);
    expect(red(engine, 1, 1)).toBe(100);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
  });

  it("a new stroke kills the redo stack", async () => {
    const { history } = setup();
    await confirmedStroke(history, LOCAL, 1, 1, 100, 1);
    const undo = encodeUndo(LOCAL, false);
    local(history, undo);
    await remote(history, undo);
    expect(history.canRedo()).toBe(true);

    await confirmedStroke(history, LOCAL, 2, 2, 110, 3);
    expect(history.canRedo()).toBe(false);
    expect(history.canUndo()).toBe(true);
  });

  it("another user's undo does not affect local undo state", async () => {
    const { engine, history } = setup();
    await confirmedStroke(history, LOCAL, 1, 1, 100, 1);
    await confirmedStroke(history, REMOTE, 2, 2, 200, 3);

    await remote(history, encodeUndo(REMOTE, false));
    expect(red(engine, 2, 2)).toBe(0);
    expect(red(engine, 1, 1)).toBe(100);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
  });

  it("disables undo immediately while an undo is in flight", async () => {
    const { history } = setup();
    await remote(history, encodeUndoPoint(LOCAL), 1);
    await remote(history, line(LOCAL, 1, 1, 100), 2);
    expect(history.canUndo()).toBe(true);

    // Click undo: not yet echoed, but a second click must be refused
    local(history, encodeUndo(LOCAL, false));
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);

    await remote(history, encodeUndo(LOCAL, false));
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });

  it("undoes a fill", async () => {
    const { engine, history } = setup();
    await remote(history, encodeUndoPoint(LOCAL), 1);
    await remote(
      history,
      encodeFill(LOCAL, "foreground", 0, 0, 100, 0, 0, 255),
      2
    );
    expect(red(engine, 8, 8)).toBe(100);

    await remote(history, encodeUndo(LOCAL, false));
    expect(red(engine, 8, 8)).toBe(0);
  });
});

describe("reset point squashing", () => {
  it("freezes undo below the base seq but keeps newer strokes undoable", async () => {
    const { engine, history } = setup();
    await remote(history, encodeUndoPoint(LOCAL), 1);
    await remote(history, line(LOCAL, 1, 1, 10), 2);
    await remote(history, encodeUndoPoint(LOCAL), 3);
    await remote(history, line(LOCAL, 2, 2, 20), 4);

    await history.handleResetPoint(2);

    // The first stroke is squashed into the base savepoint: still visible,
    // no longer undoable
    expect(red(engine, 1, 1)).toBe(10);
    expect(history.canUndo()).toBe(true); // second stroke only

    const undo = encodeUndo(LOCAL, false);
    local(history, undo);
    await remote(history, undo);
    expect(red(engine, 2, 2)).toBe(0);
    expect(red(engine, 1, 1)).toBe(10); // squashed stroke untouched
    expect(history.canUndo()).toBe(false);
  });
});
