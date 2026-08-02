/**
 * Client-side canonical canvas history for the shared-layer collaboration
 * model, ported from Drawpile's canvas_history.c.
 *
 * All clients receive the same server-sequenced message stream and fold it
 * into this history, so marking strokes undone and replaying from a savepoint
 * is deterministic across every participant:
 *
 * - Confirmed messages append to `entries`; periodic savepoints (layer copies
 *   plus per-user stroke state) bound the cost of replays.
 * - Local messages are applied optimistically and queued in the fork until
 *   the server echoes them back in canonical order. A remote message that
 *   doesn't touch any fork entry's affected area applies directly; one that
 *   overlaps triggers a replay of history with the fork re-applied on top.
 * - UNDO_POINT messages delimit strokes; UNDO/redo marks a user's entries and
 *   replays. Undo takes effect on server echo (like Drawpile), keeping every
 *   client's marking order identical.
 * - RESET_POINT (sent after a server session reset) squashes everything at or
 *   below the reset's base sequence into a new base savepoint.
 */

import { DrawingEngine } from "../DrawingEngine";
import { type DecodedMessage, type SnapshotMessage } from "./binaryProtocol";
import { pngDataToLayer } from "./canvasSnapshot";

type LayerName = "foreground" | "background";
type StrokeState = [[number, number], [number, number]] | null;
type StrokeStates = Map<string, StrokeState>;

type UndoState = "done" | "undone" | "gone";

interface Entry {
  seq?: number;
  msg: DecodedMessage;
  undo: UndoState;
}

interface Savepoint {
  index: number; // number of history entries applied in this state
  foreground: Uint8ClampedArray;
  background: Uint8ClampedArray;
  strokes: StrokeStates;
}

type Area =
  | { kind: "pixels"; layer: LayerName; x0: number; y0: number; x1: number; y1: number }
  | { kind: "user" }
  | { kind: "everything" };

interface ForkEntry {
  bytes: Uint8Array;
  msg: DecodedMessage;
  area: Area;
}

const SAVEPOINT_INTERVAL = 64;
const MAX_SAVEPOINTS = 8;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function cloneStrokes(strokes: StrokeStates): StrokeStates {
  const copy: StrokeStates = new Map();
  for (const [userId, state] of strokes) {
    copy.set(
      userId,
      state === null
        ? null
        : [
            [state[0][0], state[0][1]],
            [state[1][0], state[1][1]],
          ]
    );
  }
  return copy;
}

function affectedArea(msg: DecodedMessage): Area {
  switch (msg.type) {
    case "drawLine": {
      const pad = msg.brushSize;
      return {
        kind: "pixels",
        layer: msg.layer,
        x0: Math.min(msg.fromX, msg.toX) - pad,
        y0: Math.min(msg.fromY, msg.toY) - pad,
        x1: Math.max(msg.fromX, msg.toX) + pad,
        y1: Math.max(msg.fromY, msg.toY) + pad,
      };
    }
    case "drawPoint": {
      const pad = msg.brushSize;
      return {
        kind: "pixels",
        layer: msg.layer,
        x0: msg.x - pad,
        y0: msg.y - pad,
        x1: msg.x + pad,
        y1: msg.y + pad,
      };
    }
    case "fill":
    case "snapshot":
      // Fills depend on (and snapshots replace) the whole layer
      return { kind: "pixels", layer: msg.layer, x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
    case "undoPoint":
      return { kind: "user" };
    default:
      return { kind: "everything" };
  }
}

function areasConcurrent(a: Area, b: Area): boolean {
  if (a.kind === "user" || b.kind === "user") return true;
  if (a.kind === "everything" || b.kind === "everything") return false;
  if (a.layer !== b.layer) return true;
  return a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0;
}

function isHistoryMessage(msg: DecodedMessage): boolean {
  switch (msg.type) {
    case "drawLine":
    case "drawPoint":
    case "fill":
    case "snapshot":
    case "undoPoint":
    case "undo":
      return true;
    default:
      return false;
  }
}

export class CanvasHistory {
  private engine: DrawingEngine;
  private localUserId: string;
  private onChange?: (canUndo: boolean, canRedo: boolean) => void;

  private entries: Entry[] = [];
  private savepoints: Savepoint[] = [];
  private fork: ForkEntry[] = [];
  // Per-user stroke continuation state of the currently rendered canvas
  private liveStrokes: StrokeStates = new Map();
  private snapshotCache = new WeakMap<SnapshotMessage, Uint8ClampedArray>();

  constructor(
    engine: DrawingEngine,
    localUserId: string,
    onChange?: (canUndo: boolean, canRedo: boolean) => void
  ) {
    this.engine = engine;
    this.localUserId = localUserId;
    this.onChange = onChange;
    this.reset();
  }

  /** Clears everything and takes a base savepoint of the current layers. */
  reset(): void {
    this.entries = [];
    this.fork = [];
    this.liveStrokes = new Map();
    this.savepoints = [
      {
        index: 0,
        foreground: new Uint8ClampedArray(this.engine.layers.foreground),
        background: new Uint8ClampedArray(this.engine.layers.background),
        strokes: new Map(),
      },
    ];
    this.notify();
  }

  get forkSize(): number {
    return this.fork.length;
  }

  clearFork(): void {
    this.fork = [];
  }

  canUndo(): boolean {
    return this.entries.some(
      (e) =>
        e.msg.type === "undoPoint" &&
        e.msg.userId === this.localUserId &&
        e.undo === "done"
    );
  }

  canRedo(): boolean {
    return this.entries.some(
      (e) =>
        e.msg.type === "undoPoint" &&
        e.msg.userId === this.localUserId &&
        e.undo === "undone"
    );
  }

  /**
   * Handles a locally generated message: queues it in the fork (to be matched
   * against the server's echo) and applies drawing messages optimistically.
   * UNDO and UNDO_POINT only take effect when echoed, like in Drawpile.
   */
  handleLocal(bytes: ArrayBuffer, msg: DecodedMessage): void {
    if (!isHistoryMessage(msg)) return;
    this.fork.push({
      bytes: new Uint8Array(bytes),
      msg,
      area: affectedArea(msg),
    });
    if (msg.type === "undoPoint") {
      // Reset the local stroke continuation so a new stroke doesn't dedup
      // against the previous one's endpoint
      this.liveStrokes.set(this.localUserId, null);
    } else if (msg.type !== "undo") {
      this.applyDrawSync(msg, this.engine.layers, this.liveStrokes);
    }
  }

  /**
   * Handles a message from the canonical server stream (a remote user's
   * message or the echo of a local one).
   */
  async handleRemote(
    raw: Uint8Array,
    msg: DecodedMessage,
    seq?: number
  ): Promise<void> {
    if (!isHistoryMessage(msg)) return;

    // Echo of our own fork head: already on the canvas (except undo/undoPoint
    // which take effect now)
    if (this.fork.length > 0 && bytesEqual(this.fork[0].bytes, raw)) {
      this.fork.shift();
      if (msg.type === "undo") {
        await this.processUndo(msg.userId, msg.redo);
      } else if (msg.type === "undoPoint") {
        this.appendUndoPoint(msg, seq);
      } else {
        this.entries.push({ seq, msg, undo: "done" });
      }
      this.maybeSavepoint();
      this.notify();
      return;
    }

    // Same user from another connection: the server's order diverged from the
    // fork. Drop the fork (in-flight messages re-arrive as ordinary echoes)
    // and unconditionally rebuild from canonical history, since the canvas
    // still shows the dropped fork's optimistic pixels.
    if (
      this.fork.length > 0 &&
      "userId" in msg &&
      msg.userId === this.localUserId
    ) {
      console.warn(
        "Canvas history rollback: server order diverged from local fork"
      );
      this.fork = [];
      let first = -1;
      if (msg.type === "undo") {
        first = this.markUndo(msg.userId, msg.redo);
      } else if (msg.type === "undoPoint") {
        this.appendUndoPoint(msg, seq);
      } else {
        this.entries.push({ seq, msg, undo: "done" });
      }
      await this.replayFrom(
        first >= 0 ? this.savepointFor(first) : this.latestSavepoint()
      );
      this.maybeSavepoint();
      this.notify();
      return;
    }

    // Remote message while local strokes are unconfirmed: apply directly only
    // if it can't touch any fork entry's affected area (Drawpile's
    // concurrency check); otherwise rebuild and re-apply the fork on top.
    if (this.fork.length > 0) {
      const area = affectedArea(msg);
      const concurrent = this.fork.every((f) => areasConcurrent(f.area, area));
      await this.applyCanonical(msg, seq, { replay: !concurrent });
      return;
    }

    await this.applyCanonical(msg, seq, { replay: false });
  }

  /**
   * Squashes all entries at or below the session reset's base sequence into a
   * new base savepoint. Their undo state is frozen; memory is reclaimed.
   */
  async handleResetPoint(baseSeq: number): Promise<void> {
    let cut = 0;
    while (
      cut < this.entries.length &&
      this.entries[cut].seq !== undefined &&
      (this.entries[cut].seq as number) <= baseSeq
    ) {
      cut++;
    }
    if (cut === 0) return;

    // Compute the state at the cut into temporary buffers
    const sp = this.savepointFor(cut);
    const layers = {
      foreground: new Uint8ClampedArray(sp.foreground),
      background: new Uint8ClampedArray(sp.background),
    };
    const strokes = cloneStrokes(sp.strokes);
    for (let i = sp.index; i < cut; i++) {
      const entry = this.entries[i];
      if (entry.undo === "done") {
        await this.applyMessage(entry.msg, layers, strokes);
      }
    }

    this.entries = this.entries.slice(cut);
    this.savepoints = [
      { index: 0, foreground: layers.foreground, background: layers.background, strokes },
      ...this.savepoints
        .filter((s) => s.index >= cut)
        .map((s) => ({ ...s, index: s.index - cut })),
    ];
    this.notify();
  }

  private async applyCanonical(
    msg: DecodedMessage,
    seq: number | undefined,
    { replay }: { replay: boolean }
  ): Promise<void> {
    if (msg.type === "undo") {
      await this.processUndo(msg.userId, msg.redo);
    } else if (msg.type === "undoPoint") {
      this.appendUndoPoint(msg, seq);
      this.liveStrokes.set(msg.userId, null);
      if (replay) {
        await this.replayFrom(this.latestSavepoint());
      }
    } else {
      this.entries.push({ seq, msg, undo: "done" });
      if (replay) {
        await this.replayFrom(this.latestSavepoint());
      } else {
        await this.applyMessage(msg, this.engine.layers, this.liveStrokes);
        this.queueUpdates();
      }
    }
    this.maybeSavepoint();
    this.notify();
  }

  /** Appends an undo point; a new operation by a user kills their redo. */
  private appendUndoPoint(
    msg: DecodedMessage & { type: "undoPoint" },
    seq?: number
  ): void {
    for (const entry of this.entries) {
      if (
        "userId" in entry.msg &&
        entry.msg.userId === msg.userId &&
        entry.undo === "undone"
      ) {
        entry.undo = "gone";
      }
    }
    this.entries.push({ seq, msg, undo: "done" });
  }

  /** Marks entries and replays; no-op if there is nothing to undo/redo. */
  private async processUndo(userId: string, redo: boolean): Promise<void> {
    const first = this.markUndo(userId, redo);
    if (first < 0) return;
    await this.replayFrom(this.savepointFor(first));
  }

  /**
   * Marks entries for an undo or redo by `userId` and returns the first
   * affected history index (-1 if nothing to do).
   *
   * Undo: the user's entries from their most recent active undo point to the
   * end of history become undone. Redo: the user's entries from their
   * earliest undone undo point to their next undo point become done again.
   */
  private markUndo(userId: string, redo: boolean): number {
    let first = -1;
    if (redo) {
      first = this.entries.findIndex(
        (e) =>
          e.msg.type === "undoPoint" &&
          e.msg.userId === userId &&
          e.undo === "undone"
      );
      if (first < 0) return -1;
      let next = this.entries.length;
      for (let i = first + 1; i < this.entries.length; i++) {
        const e = this.entries[i];
        if (e.msg.type === "undoPoint" && e.msg.userId === userId) {
          next = i;
          break;
        }
      }
      for (let i = first; i < next; i++) {
        const e = this.entries[i];
        if ("userId" in e.msg && e.msg.userId === userId && e.undo === "undone") {
          e.undo = "done";
        }
      }
    } else {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i];
        if (
          e.msg.type === "undoPoint" &&
          e.msg.userId === userId &&
          e.undo === "done"
        ) {
          first = i;
          break;
        }
      }
      if (first < 0) return -1;
      for (let i = first; i < this.entries.length; i++) {
        const e = this.entries[i];
        if ("userId" in e.msg && e.msg.userId === userId && e.undo === "done") {
          e.undo = "undone";
        }
      }
    }

    // Savepoints past the modified region no longer describe replayable state
    this.savepoints = this.savepoints.filter((s) => s.index <= first);
    return first;
  }

  /**
   * Restores a savepoint, replays all done entries after it, then re-applies
   * the unconfirmed fork on top.
   */
  private async replayFrom(sp: Savepoint): Promise<void> {
    this.engine.layers.foreground.set(sp.foreground);
    this.engine.layers.background.set(sp.background);
    const strokes = cloneStrokes(sp.strokes);
    for (let i = sp.index; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.undo === "done") {
        await this.applyMessage(entry.msg, this.engine.layers, strokes);
      }
    }
    for (const f of this.fork) {
      if (f.msg.type === "undoPoint") {
        strokes.set(this.localUserId, null);
      } else if (f.msg.type !== "undo") {
        this.applyDrawSync(f.msg, this.engine.layers, strokes);
      }
    }
    this.liveStrokes = strokes;
    this.queueUpdates();
  }

  private savepointFor(index: number): Savepoint {
    let best = this.savepoints[0];
    for (const sp of this.savepoints) {
      if (sp.index <= index && sp.index >= best.index) {
        best = sp;
      }
    }
    return best;
  }

  private latestSavepoint(): Savepoint {
    return this.savepoints[this.savepoints.length - 1];
  }

  private maybeSavepoint(): void {
    if (this.fork.length > 0) return;
    const last = this.latestSavepoint();
    if (this.entries.length - last.index < SAVEPOINT_INTERVAL) return;
    this.savepoints.push({
      index: this.entries.length,
      foreground: new Uint8ClampedArray(this.engine.layers.foreground),
      background: new Uint8ClampedArray(this.engine.layers.background),
      strokes: cloneStrokes(this.liveStrokes),
    });
    if (this.savepoints.length > MAX_SAVEPOINTS) {
      // Keep the base savepoint (needed to replay any entry) and the most
      // recent ones; drop the second-oldest
      this.savepoints.splice(1, 1);
    }
  }

  /** Applies a message to the given layer buffers (snapshot decode is async). */
  private async applyMessage(
    msg: DecodedMessage,
    layers: Record<string, Uint8ClampedArray>,
    strokes: StrokeStates
  ): Promise<void> {
    if (msg.type === "snapshot") {
      let data = this.snapshotCache.get(msg);
      if (!data) {
        data = await pngDataToLayer(
          msg.pngData,
          this.engine.imageWidth,
          this.engine.imageHeight
        );
        this.snapshotCache.set(msg, data);
      }
      layers[msg.layer].set(data);
      return;
    }
    if (msg.type === "undoPoint") {
      strokes.set(msg.userId, null);
      return;
    }
    this.applyDrawSync(msg, layers, strokes);
  }

  private applyDrawSync(
    msg: DecodedMessage,
    layers: Record<string, Uint8ClampedArray>,
    strokes: StrokeStates
  ): void {
    switch (msg.type) {
      case "drawLine":
        this.engine.setStrokeState(strokes.get(msg.userId) ?? null);
        this.engine.drawLine(
          layers[msg.layer],
          msg.fromX,
          msg.fromY,
          msg.toX,
          msg.toY,
          msg.brushSize,
          msg.brushType,
          msg.color.r,
          msg.color.g,
          msg.color.b,
          msg.color.a
        );
        strokes.set(msg.userId, this.engine.getStrokeState());
        break;
      case "drawPoint":
        this.engine.setStrokeState(strokes.get(msg.userId) ?? null);
        this.engine.drawLine(
          layers[msg.layer],
          msg.x,
          msg.y,
          msg.x,
          msg.y,
          msg.brushSize,
          msg.brushType,
          msg.color.r,
          msg.color.g,
          msg.color.b,
          msg.color.a
        );
        strokes.set(msg.userId, this.engine.getStrokeState());
        break;
      case "fill":
        this.engine.doFloodFill(
          layers[msg.layer],
          msg.x,
          msg.y,
          msg.color.r,
          msg.color.g,
          msg.color.b,
          msg.color.a
        );
        break;
    }
  }

  private queueUpdates(): void {
    this.engine.queueLayerUpdate("foreground");
    this.engine.queueLayerUpdate("background");
  }

  private notify(): void {
    this.onChange?.(this.canUndo(), this.canRedo());
  }
}
