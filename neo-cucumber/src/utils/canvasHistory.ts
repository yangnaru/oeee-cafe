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
import {
  decodeMessage,
  encodeStroke,
  type DecodedMessage,
  type SnapshotMessage,
  type StrokeMessage,
} from "./binaryProtocol";
import { pngDataToLayer } from "./canvasSnapshot";

type LayerName = "foreground" | "background";
type StrokeState = [[number, number], [number, number]] | null;
// Keyed by 1-byte session user id
type StrokeStates = Map<number, StrokeState>;

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

// A stroke being drawn locally: its segments are painted optimistically as
// they happen, then flushed into one STROKE message (a fork entry) at a time
interface OpenBatch {
  layer: LayerName;
  brushSize: number;
  brushType: "solid" | "halftone" | "eraser";
  color: { r: number; g: number; b: number; a: number };
  points: { x: number; y: number }[];
  area: { kind: "pixels"; layer: LayerName; x0: number; y0: number; x1: number; y1: number };
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
    case "stroke": {
      const pad = msg.brushSize;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of msg.points) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      return {
        kind: "pixels",
        layer: msg.layer,
        x0: x0 - pad,
        y0: y0 - pad,
        x1: x1 + pad,
        y1: y1 + pad,
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
    case "stroke":
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
  // 1-byte session user id assigned by the server's WELCOME; -1 until known
  private localUserId = -1;
  private onChange?: (canUndo: boolean, canRedo: boolean) => void;

  private entries: Entry[] = [];
  private savepoints: Savepoint[] = [];
  private fork: ForkEntry[] = [];
  private openBatch: OpenBatch | null = null;
  // Per-user stroke continuation state of the currently rendered canvas
  private liveStrokes: StrokeStates = new Map();
  private snapshotCache = new WeakMap<SnapshotMessage, Uint8ClampedArray>();

  constructor(
    engine: DrawingEngine,
    onChange?: (canUndo: boolean, canRedo: boolean) => void
  ) {
    this.engine = engine;
    this.onChange = onChange;
    this.reset();
  }

  setLocalUserId(id: number): void {
    this.localUserId = id;
  }

  /**
   * Blanks the canvas, then resets history against it.
   *
   * Used when a reconnect is about to replay the whole canonical history:
   * `reset()` alone bases everything on whatever is currently on screen, so
   * replaying on top of the pre-disconnect pixels would apply every stroke a
   * second time — invisible for opaque brushes, not for translucent ones.
   */
  resetToBlankCanvas(): void {
    this.engine.layers.foreground.fill(0);
    this.engine.layers.background.fill(0);
    this.reset();
    this.queueUpdates();
  }

  /** Clears everything and takes a base savepoint of the current layers. */
  reset(): void {
    this.entries = [];
    this.fork = [];
    this.openBatch = null;
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

  /** True while any locally drawn state is not yet server-confirmed. */
  get hasPendingLocal(): boolean {
    return (
      this.fork.length > 0 ||
      (this.openBatch !== null && this.openBatch.points.length > 0)
    );
  }

  canUndo(): boolean {
    return this.projectedUndoCounts().done > 0;
  }

  canRedo(): boolean {
    return this.projectedUndoCounts().undone > 0;
  }

  /**
   * Counts the local user's undoable/redoable strokes, projecting the effect
   * of unconfirmed fork messages. Undo takes effect only on server echo, so
   * without this projection a quickly repeated undo click would send multiple
   * UNDO messages and revert more strokes than intended.
   */
  private projectedUndoCounts(): { done: number; undone: number } {
    let done = 0;
    let undone = 0;
    for (const e of this.entries) {
      if (e.msg.type === "undoPoint" && e.msg.userId === this.localUserId) {
        if (e.undo === "done") done++;
        else if (e.undo === "undone") undone++;
      }
    }
    for (const f of this.fork) {
      if (f.msg.type === "undoPoint") {
        // A new stroke will be undoable and kills the redo stack
        done++;
        undone = 0;
      } else if (f.msg.type === "undo") {
        if (f.msg.redo) {
          if (undone > 0) {
            undone--;
            done++;
          }
        } else if (done > 0) {
          done--;
          undone++;
        }
      }
    }
    return { done, undone };
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
    // Update undo/redo button state immediately (projected over the fork)
    this.notify();
  }

  /**
   * Appends one point to the open local stroke batch, painting it
   * immediately. The batch becomes a single STROKE fork entry on flush.
   * Returns the number of accumulated points (so the caller can force a
   * flush on large batches).
   */
  addLocalSegment(
    layer: LayerName,
    brushSize: number,
    brushType: "solid" | "halftone" | "eraser",
    color: { r: number; g: number; b: number; a: number },
    x: number,
    y: number
  ): number {
    if (this.localUserId < 0) return 0;
    if (!this.openBatch) {
      this.openBatch = {
        layer,
        brushSize,
        brushType,
        color,
        points: [],
        area: {
          kind: "pixels",
          layer,
          x0: x - brushSize,
          y0: y - brushSize,
          x1: x + brushSize,
          y1: y + brushSize,
        },
      };
    }
    const batch = this.openBatch;
    batch.points.push({ x, y });
    batch.area.x0 = Math.min(batch.area.x0, x - brushSize);
    batch.area.y0 = Math.min(batch.area.y0, y - brushSize);
    batch.area.x1 = Math.max(batch.area.x1, x + brushSize);
    batch.area.y1 = Math.max(batch.area.y1, y + brushSize);

    this.applyStrokePoints(
      this.localUserId,
      batch,
      [{ x, y }],
      this.engine.layers,
      this.liveStrokes
    );
    return batch.points.length;
  }

  /**
   * Encodes the open batch into a STROKE message, moves it into the fork,
   * and returns the exact bytes to send (null if there is nothing to flush).
   */
  flushLocalStroke(): ArrayBuffer | null {
    const batch = this.openBatch;
    this.openBatch = null;
    if (!batch || batch.points.length === 0) return null;

    const bytes = encodeStroke(
      this.localUserId,
      batch.layer,
      batch.brushSize,
      batch.brushType,
      batch.color.r,
      batch.color.g,
      batch.color.b,
      batch.color.a,
      batch.points
    );
    const msg = decodeMessage(bytes);
    if (!msg) return null;
    this.fork.push({ bytes: new Uint8Array(bytes), msg, area: batch.area });
    return bytes;
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
    // fork. Drop the pending local state (in-flight messages re-arrive as
    // ordinary echoes) and unconditionally rebuild from canonical history,
    // since the canvas still shows the dropped fork's optimistic pixels.
    if (
      this.hasPendingLocal &&
      "userId" in msg &&
      msg.userId === this.localUserId
    ) {
      console.warn(
        "Canvas history rollback: server order diverged from local fork"
      );
      this.fork = [];
      this.openBatch = null;
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
    // if it can't touch any pending area (Drawpile's concurrency check);
    // otherwise rebuild and re-apply the pending local state on top.
    if (this.hasPendingLocal) {
      const area = affectedArea(msg);
      const pendingAreas: Area[] = this.fork.map((f) => f.area);
      if (this.openBatch && this.openBatch.points.length > 0) {
        pendingAreas.push(this.openBatch.area);
      }
      const concurrent = pendingAreas.every((a) => areasConcurrent(a, area));
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
  private async processUndo(userId: number, redo: boolean): Promise<void> {
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
  private markUndo(userId: number, redo: boolean): number {
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
    if (this.openBatch && this.openBatch.points.length > 0) {
      this.applyStrokePoints(
        this.localUserId,
        this.openBatch,
        this.openBatch.points,
        this.engine.layers,
        strokes
      );
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
    // Savepoints must capture confirmed-only state
    if (this.hasPendingLocal) return;
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
      case "stroke":
        this.applyStrokePoints(msg.userId, msg, msg.points, layers, strokes);
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

  /**
   * Applies polyline points for one user. Each point continues from the
   * user's previous point (tracked in `strokes`); a null continuation state
   * (set by their UNDO_POINT) starts a new stroke with a dot.
   */
  private applyStrokePoints(
    userId: number,
    props: Pick<StrokeMessage, "layer" | "brushSize" | "brushType" | "color">,
    points: { x: number; y: number }[],
    layers: Record<string, Uint8ClampedArray>,
    strokes: StrokeStates
  ): void {
    this.engine.setStrokeState(strokes.get(userId) ?? null);
    for (const p of points) {
      const prev = this.engine.getStrokeState();
      const [fromX, fromY] = prev === null ? [p.x, p.y] : prev[1];
      this.engine.drawLine(
        layers[props.layer],
        fromX,
        fromY,
        p.x,
        p.y,
        props.brushSize,
        props.brushType,
        props.color.r,
        props.color.g,
        props.color.b,
        props.color.a
      );
    }
    strokes.set(userId, this.engine.getStrokeState());
  }

  private queueUpdates(): void {
    this.engine.queueLayerUpdate("foreground");
    this.engine.queueLayerUpdate("background");
  }

  private notify(): void {
    this.onChange?.(this.canUndo(), this.canRedo());
  }
}
