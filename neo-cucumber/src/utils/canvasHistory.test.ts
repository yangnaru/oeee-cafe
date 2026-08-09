import { describe, expect, it, vi } from "vitest";
import { CanvasHistory } from "./canvasHistory";
import {
  decodeMessage,
  encodeFill,
  encodeStroke,
  encodeUndo,
  encodeUndoPoint,
} from "./binaryProtocol";
import { type DrawingEngine } from "../DrawingEngine";

vi.mock("./canvasSnapshot", () => ({
  pngDataToLayer: vi.fn(async () => new Uint8ClampedArray(SIZE * SIZE * 4).fill(7)),
}));

const SIZE = 16;
const LOCAL = 1;
const REMOTE = 2;

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
  const history = new CanvasHistory(engine as unknown as DrawingEngine);
  history.setLocalUserId(LOCAL);
  return { engine, history };
}

function red(engine: FakeEngine, x: number, y: number): number {
  return engine.layers.foreground[(y * SIZE + x) * 4];
}

function stroke(userId: number, x: number, y: number, r: number): ArrayBuffer {
  return encodeStroke(userId, "foreground", 1, "solid", r, 0, 0, 255, [
    { x, y },
  ]);
}

// Dispatches a locally generated non-stroke message (undo point, undo, fill)
function local(history: CanvasHistory, bytes: ArrayBuffer) {
  history.handleLocal(bytes, decodeMessage(bytes)!);
}

// Draws one local segment and flushes it into a STROKE fork entry
function localStroke(
  history: CanvasHistory,
  x: number,
  y: number,
  r: number
): ArrayBuffer {
  history.addLocalSegment(
    "foreground",
    1,
    "solid",
    { r, g: 0, b: 0, a: 255 },
    x,
    y
  );
  const bytes = history.flushLocalStroke();
  if (!bytes) throw new Error("expected a flushed stroke");
  return bytes;
}

// Delivers a message from the canonical server stream
async function remote(history: CanvasHistory, bytes: ArrayBuffer, seq?: number) {
  await history.handleRemote(new Uint8Array(bytes), decodeMessage(bytes)!, seq);
}

describe("canonical application", () => {
  it("applies remote strokes in server order, last writer wins", async () => {
    const { engine, history } = setup();
    await remote(history, stroke(REMOTE, 1, 1, 50), 1);
    await remote(history, stroke(REMOTE, 1, 1, 60), 2);
    expect(red(engine, 1, 1)).toBe(60);
    expect(engine.ops).toHaveLength(2);
  });

  it("chains a user's stroke points and resets on their undo point", async () => {
    const { engine, history } = setup();
    await remote(history, encodeUndoPoint(REMOTE), 1);
    await remote(
      history,
      encodeStroke(REMOTE, "foreground", 1, "solid", 50, 0, 0, 255, [
        { x: 1, y: 1 },
        { x: 3, y: 3 },
      ]),
      2
    );
    // Dot at first point, then a segment continuing from it. Segments run
    // new -> previous, as NEO draws them.
    expect(engine.ops).toEqual(["line:1,1-1,1:50", "line:3,3-1,1:50"]);

    await remote(history, encodeUndoPoint(REMOTE), 3);
    await remote(history, stroke(REMOTE, 5, 5, 60), 4);
    // New stroke starts with a dot, not a segment from (3,3)
    expect(engine.ops[2]).toBe("line:5,5-5,5:60");
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
  it("does not re-apply the echo of a local stroke", async () => {
    const { engine, history } = setup();
    const bytes = localStroke(history, 2, 2, 100);
    expect(red(engine, 2, 2)).toBe(100);
    expect(history.hasPendingLocal).toBe(true);

    await remote(history, bytes, 1);
    expect(history.hasPendingLocal).toBe(false);
    expect(engine.ops).toHaveLength(1); // applied exactly once
    expect(red(engine, 2, 2)).toBe(100);
  });

  it("applies a non-overlapping remote stroke without replaying the fork", async () => {
    const { engine, history } = setup();
    local(history, encodeUndoPoint(LOCAL));
    localStroke(history, 1, 1, 100);

    await remote(history, stroke(REMOTE, 10, 10, 200), 1);
    expect(red(engine, 1, 1)).toBe(100);
    expect(red(engine, 10, 10)).toBe(200);
    expect(engine.ops).toHaveLength(2); // no replay of the fork entry
  });

  it("replays the fork on top of an overlapping remote stroke", async () => {
    const { engine, history } = setup();
    local(history, encodeUndoPoint(LOCAL));
    const mine = localStroke(history, 5, 5, 100);

    // Same pixel: canonical order is remote first, so the unconfirmed local
    // stroke must end up on top
    await remote(history, stroke(REMOTE, 5, 5, 200), 1);
    expect(red(engine, 5, 5)).toBe(100);
    expect(engine.ops).toHaveLength(3); // local, remote (replay), local again

    // Echoes arrive; the canvas must not change
    await remote(history, encodeUndoPoint(LOCAL), 2);
    await remote(history, mine, 3);
    expect(red(engine, 5, 5)).toBe(100);
    expect(history.hasPendingLocal).toBe(false);
  });

  it("re-applies an unflushed open batch on top of a conflicting remote stroke", async () => {
    const { engine, history } = setup();
    local(history, encodeUndoPoint(LOCAL));
    history.addLocalSegment(
      "foreground",
      1,
      "solid",
      { r: 100, g: 0, b: 0, a: 255 },
      5,
      5
    );
    expect(history.hasPendingLocal).toBe(true);

    await remote(history, stroke(REMOTE, 5, 5, 200), 1);
    expect(red(engine, 5, 5)).toBe(100); // open batch replayed on top

    // Flush and echo everything; the canvas must not change
    const mine = history.flushLocalStroke();
    expect(mine).not.toBeNull();
    await remote(history, encodeUndoPoint(LOCAL), 2);
    await remote(history, mine!, 3);
    expect(red(engine, 5, 5)).toBe(100);
    expect(history.hasPendingLocal).toBe(false);
  });

  it("drops the fork and converges when the same user draws from another connection", async () => {
    const { engine, history } = setup();
    local(history, encodeUndoPoint(LOCAL));
    const mine = localStroke(history, 3, 3, 100);

    // A different message from the same user arrives first: server order
    // diverged, so the optimistic stroke is rolled back...
    await remote(history, stroke(LOCAL, 4, 4, 50), 1);
    expect(red(engine, 3, 3)).toBe(0);
    expect(red(engine, 4, 4)).toBe(50);
    expect(history.hasPendingLocal).toBe(false);

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
    userId: number,
    x: number,
    y: number,
    r: number,
    seq: number
  ) {
    await remote(history, encodeUndoPoint(userId), seq);
    await remote(history, stroke(userId, x, y, r), seq + 1);
  }

  it("undoes only the sender's stroke and redo restores it", async () => {
    const { engine, history } = setup();
    await confirmedStroke(history, LOCAL, 1, 1, 100, 1);
    await remote(history, stroke(REMOTE, 2, 2, 200), 3);
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
    await remote(history, stroke(LOCAL, 1, 1, 100), 2);
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
    await remote(history, stroke(LOCAL, 1, 1, 10), 2);
    await remote(history, encodeUndoPoint(LOCAL), 3);
    await remote(history, stroke(LOCAL, 2, 2, 20), 4);

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

describe("reconnect", () => {
  it("replays history onto a blank canvas instead of the stale drawing", async () => {
    const { engine, history } = setup();
    await remote(history, encodeUndoPoint(REMOTE), 1);
    await remote(history, stroke(REMOTE, 1, 1, 50), 2);
    await remote(history, encodeFill(REMOTE, "foreground", 4, 4, 30, 0, 0, 255), 3);
    expect(red(engine, 1, 1)).toBe(30);
    const opsBeforeDrop = [...engine.ops];

    // The connection drops and comes back: the canvas still shows everything
    // above, and the server is about to replay all of it from seq 1
    history.resetToBlankCanvas();
    expect(red(engine, 1, 1)).toBe(0);
    expect(red(engine, 4, 4)).toBe(0);

    engine.ops.length = 0;
    await remote(history, encodeUndoPoint(REMOTE), 1);
    await remote(history, stroke(REMOTE, 1, 1, 50), 2);
    await remote(history, encodeFill(REMOTE, "foreground", 4, 4, 30, 0, 0, 255), 3);

    // The replay reproduces the drawing exactly, doing the same work once
    expect(red(engine, 1, 1)).toBe(30);
    expect(engine.ops).toEqual(opsBeforeDrop);
  });

  it("keeps a reconnecting user's own strokes undoable under their new id", async () => {
    const { engine, history } = setup();
    await remote(history, encodeUndoPoint(LOCAL), 1);
    await remote(history, stroke(LOCAL, 2, 2, 40), 2);

    history.resetToBlankCanvas();
    // The server hands back the same session user id, since the id map
    // outlives the connection that owned it
    history.setLocalUserId(LOCAL);
    await remote(history, encodeUndoPoint(LOCAL), 1);
    await remote(history, stroke(LOCAL, 2, 2, 40), 2);

    expect(red(engine, 2, 2)).toBe(40);
    const undo = encodeUndo(LOCAL, false);
    local(history, undo);
    await remote(history, undo);
    expect(red(engine, 2, 2)).toBe(0);
  });
});
