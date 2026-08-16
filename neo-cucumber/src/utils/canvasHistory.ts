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
import { NO_MASK, type Mask } from "../neo/mask";
import type {
  HistoryActorId,
  HistoryOperation,
  HistorySnapshot,
  HistoryStroke,
} from "../synchronization/historyOperations";
import {
  fromHistoryOperation,
  toHistoryOperation,
} from "../synchronization/historyOperations";
import type {
  CanonicalPainterOperation,
  LocalPainterOperation,
} from "../operations";
import { pngDataToLayer } from "./canvasSnapshot";
import { extentFor, fontSizeForBrush, TEXT_FONT_FAMILY } from "../neo/tools";
import type { WireBrushType } from "../types/drawing";

type LayerName = "foreground" | "background";
type StrokeState = [[number, number], [number, number]] | null;
/**
 * Per-actor state, keyed by `actorKey`. An actor arrives as a 1-byte session
 * id from the wire and as a string through the public envelope, and a Map
 * tells `1` and `"1"` apart -- so one person would hold two entries and their
 * next stroke would continue from the other one's endpoint, drawing a line
 * across the canvas. Every lookup goes through `actorKey` to prevent that.
 */
type ActorKey = string;
type StrokeStates = Map<ActorKey, StrokeState>;

const actorKey = (id: HistoryActorId): ActorKey => String(id);

type UndoState = "done" | "undone" | "gone";

interface Entry {
  seq?: number;
  msg: HistoryOperation;
  undo: UndoState;
}

/** One participant's two buffers, as stored in a savepoint. */
interface OwnerLayers {
  foreground: Uint8ClampedArray;
  background: Uint8ClampedArray;
}

interface Savepoint {
  index: number; // number of history entries applied in this state
  /**
   * Every participant's pair at this point in history.
   *
   * A participant whose layers have not changed since the previous savepoint
   * shares that savepoint's arrays rather than a copy of them: with eight
   * participants and eight savepoints, copying all of them every time would
   * cost a few hundred megabytes at the largest canvas size, and a savepoint
   * is only ever read, never drawn into, so sharing is safe.
   */
  layers: Map<ActorKey, OwnerLayers>;
  strokes: StrokeStates;
}

/** Where an operation's pixels live: one participant's pair, by author. */
type LayerSource = (owner: ActorKey) => OwnerLayers;

type Area =
  | {
      kind: "pixels";
      /** Whose layer pair the rectangle is in. */
      owner: ActorKey;
      layer: LayerName;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
  | { kind: "user" }
  | { kind: "everything" };

interface ForkEntry {
  id: string;
  msg: HistoryOperation;
  area: Area;
}

// A stroke being drawn locally: its segments are painted optimistically as
// they happen, then flushed into one STROKE message (a fork entry) at a time
interface OpenBatch {
  /** Whose pair the segments land in; the local participant's by default. */
  targetOwner: ActorKey;
  layer: LayerName;
  brushSize: number;
  brushType: WireBrushType;
  color: { r: number; g: number; b: number; a: number };
  mask: Mask;
  points: { x: number; y: number }[];
  area: {
    kind: "pixels";
    owner: ActorKey;
    layer: LayerName;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
}

const SAVEPOINT_INTERVAL = 64;
const MAX_SAVEPOINTS = 8;

function transportId(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
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

function affectedArea(msg: HistoryOperation): Area {
  // The rectangle is in the layers the operation *writes*, which is usually
  // its author's own pair but need not be: a participant may paint into
  // somebody else's. Naming the author here instead would call two people
  // drawing on one layer concurrent and let them diverge.
  const owner = "targetOwner" in msg ? actorKey(msg.targetOwner) : "";
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
        kind: "pixels", owner,
        layer: msg.layer,
        x0: x0 - pad,
        y0: y0 - pad,
        x1: x1 + pad,
        y1: y1 + pad,
      };
    }
    case "region": {
      // The tool table already knows what each op reads and writes -- turn
      // squares off the rectangle, blur reaches a pixel past it, merge takes
      // both layers. Deriving it here again would let the two drift.
      const extent = extentFor(msg.tool, msg.layer === "foreground" ? 1 : 0, msg.rect);
      if (extent.layers.length > 1) {
        // merge: both layers, and Area names only one
        return { kind: "everything" };
      }
      return {
        kind: "pixels", owner,
        // copy writes nothing, but it *reads* the rectangle, so it still has
        // to stay ordered against writes to it
        layer: msg.layer,
        x0: extent.x0,
        y0: extent.y0,
        x1: extent.x1,
        y1: extent.y1,
      };
    }
    case "line":
      return {
        kind: "pixels", owner,
        layer: msg.layer,
        x0: Math.min(msg.from.x, msg.to.x) - msg.brushSize,
        y0: Math.min(msg.from.y, msg.to.y) - msg.brushSize,
        x1: Math.max(msg.from.x, msg.to.x) + msg.brushSize,
        y1: Math.max(msg.from.y, msg.to.y) + msg.brushSize,
      };
    case "bezier": {
      // The control polygon bounds the curve, so its box padded by the brush
      // is a superset of what the curve can touch.
      const xs = msg.points.filter((_, i) => i % 2 === 0);
      const ys = msg.points.filter((_, i) => i % 2 === 1);
      return {
        kind: "pixels", owner,
        layer: msg.layer,
        x0: Math.min(...xs) - msg.brushSize,
        y0: Math.min(...ys) - msg.brushSize,
        x1: Math.max(...xs) + msg.brushSize,
        y1: Math.max(...ys) + msg.brushSize,
      };
    }
    case "text":
      // Glyph metrics are the font's business, not ours, and guessing a box
      // too small would let a concurrent op reorder through it. Take the
      // layer.
      return { kind: "pixels", owner, layer: msg.layer, x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
    case "eraseAll":
    case "fill":
    case "snapshot":
      // Fills depend on (and snapshots replace) the whole layer
      return { kind: "pixels", owner, layer: msg.layer, x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
    case "undoPoint":
      return { kind: "user" };
    default:
      return { kind: "everything" };
  }
}

function areasConcurrent(a: Area, b: Area): boolean {
  if (a.kind === "user" || b.kind === "user") return true;
  if (a.kind === "everything" || b.kind === "everything") return false;
  // Different layer pairs cannot contend, however many people are drawing:
  // the usual case, where each participant paints into their own. Two
  // operations aimed at the *same* pair still fall through to the rectangle
  // test below, so drawing on somebody else's layer is reconciled exactly as
  // drawing on your own always was.
  if (a.owner !== b.owner) return true;
  if (a.layer !== b.layer) return true;
  return a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0;
}

export class CanvasHistory {
  private engine: DrawingEngine;
  // Whoever the host says we are on the canonical stream -- the 1-byte
  // session id the server assigns, however it names it. -1 until told.
  private localUserId: HistoryActorId = -1;
  /** Whose pair local marks land in; our own unless the host redirects it. */
  private localTargetOwner: ActorKey = actorKey(-1);
  private onChange?: (canUndo: boolean, canRedo: boolean) => void;

  private entries: Entry[] = [];
  private savepoints: Savepoint[] = [];
  /** Who has drawn since the last savepoint, so the rest can share its arrays. */
  private readonly dirtyOwners = new Set<ActorKey>();
  private releaseRenames?: () => void;
  private fork: ForkEntry[] = [];
  private canonicalLog: CanonicalPainterOperation[] = [];
  private openBatch: OpenBatch | null = null;
  // Per-user stroke continuation state of the currently rendered canvas
  private liveStrokes: StrokeStates = new Map();
  /** One clipboard per user, so a paste replays the sender's copy. */
  private readonly clipboards = new Map<ActorKey, ImageData | null>();
  private snapshotCache = new WeakMap<HistorySnapshot, Uint8ClampedArray>();

  constructor(
    engine: DrawingEngine,
    onChange?: (canUndo: boolean, canRedo: boolean) => void
  ) {
    this.engine = engine;
    this.onChange = onChange;
    // Savepoints hold a participant's layers under their name, and that name
    // changes when the server names them. Following the rename is what stops a
    // restore from conjuring the old name back into existence as a
    // participant of its own, holding whatever those layers held at the time.
    this.releaseRenames = engine.onOwnerRenamed((from, to) => {
      for (const savepoint of this.savepoints) {
        const held = savepoint.layers.get(from);
        if (held === undefined) continue;
        savepoint.layers.delete(from);
        savepoint.layers.set(to, held);
      }
      if (this.dirtyOwners.delete(from)) this.dirtyOwners.add(to);
    });
    this.reset();
  }

  /** Stops following the engine's renames. */
  dispose(): void {
    this.releaseRenames?.();
    this.releaseRenames = undefined;
  }

  setLocalUserId(id: HistoryActorId): void {
    const wasOwn = this.localTargetOwner === actorKey(this.localUserId);
    this.localUserId = id;
    // Aiming at our own layers is the default, and stays true through the
    // rename a collaborative client does when the server names it.
    if (wasOwn) this.localTargetOwner = actorKey(id);
  }

  /**
   * Point new local marks at a participant's layers.
   *
   * Anyone may draw into anyone's pair, so this is what the toolbox sets when
   * a participant picks whose layers to work on. It only affects marks made
   * from here on; a stroke already open keeps the pair it was started in.
   */
  setLocalTargetOwner(owner: HistoryActorId): void {
    this.localTargetOwner = actorKey(owner);
  }

  /** Whose layers new local marks land in. */
  getLocalTargetOwner(): ActorKey {
    return this.localTargetOwner;
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
    for (const owner of this.engine.ownerIds()) {
      const layers = this.engine.layersFor(owner);
      layers.foreground.fill(0);
      layers.background.fill(0);
    }
    this.reset();
    this.queueUpdates();
  }

  /** Clears everything and takes a base savepoint of the current layers. */
  reset(): void {
    this.entries = [];
    this.fork = [];
    this.canonicalLog = [];
    this.openBatch = null;
    this.liveStrokes = new Map();
    // Cleared before capturing, not after: `captureLayers` shares the last
    // savepoint's arrays for anyone who has not drawn since it, and with the
    // dirty set just emptied that is everyone. Leaving the old savepoints in
    // place here would base the new one on the pixels of the old one rather
    // than on the canvas actually in front of us.
    this.savepoints = [];
    this.dirtyOwners.clear();
    this.savepoints = [
      { index: 0, layers: this.captureLayers(), strokes: new Map() },
    ];
    this.notify();
  }

  /** Where a live operation's pixels go: its author's own pair. */
  private readonly liveSource: LayerSource = (owner) => {
    this.dirtyOwners.add(owner);
    return this.engine.layersFor(owner);
  };

  /**
   * Copies every participant's current layers for a savepoint, sharing the
   * previous savepoint's arrays for anyone who has not drawn since it.
   */
  private captureLayers(): Map<ActorKey, OwnerLayers> {
    const previous = this.savepoints[this.savepoints.length - 1]?.layers;
    const captured = new Map<ActorKey, OwnerLayers>();
    for (const owner of this.engine.ownerIds()) {
      const shared = this.dirtyOwners.has(owner) ? undefined : previous?.get(owner);
      if (shared) {
        captured.set(owner, shared);
        continue;
      }
      const live = this.engine.layersFor(owner);
      captured.set(owner, {
        foreground: new Uint8ClampedArray(live.foreground),
        background: new Uint8ClampedArray(live.background),
      });
    }
    this.dirtyOwners.clear();
    return captured;
  }

  /**
   * Puts every participant's layers back to a savepoint.
   *
   * Anyone who has no entry in it joined after it was taken, so their pair is
   * blanked rather than left showing work the replay is about to redraw.
   */
  private restoreLayers(sp: Savepoint): void {
    // Anyone the savepoint knows about must exist before the sweep below, or
    // a participant who left and whose pair was released never comes back.
    for (const owner of sp.layers.keys()) this.engine.layersFor(owner);
    for (const owner of this.engine.ownerIds()) {
      const live = this.engine.layersFor(owner);
      const saved = sp.layers.get(owner);
      if (saved) {
        live.foreground.set(saved.foreground);
        live.background.set(saved.background);
      } else {
        live.foreground.fill(0);
        live.background.fill(0);
      }
    }
    this.dirtyOwners.clear();
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
      if (
        e.msg.type === "undoPoint" &&
        actorKey(e.msg.userId) === actorKey(this.localUserId)
      ) {
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
  handleLocal(bytes: ArrayBuffer, msg: HistoryOperation): void {
    if (msg.type === "snapshot") {
      throw new Error("Snapshots cannot be optimistic local operations");
    }
    this.handleLocalOperation({
      id: transportId(new Uint8Array(bytes)),
      actorId: String(msg.userId),
      operation: fromHistoryOperation(msg),
    });
  }

  /** Applies an optimistic operation emitted through the public API. */
  handleLocalOperation(entry: LocalPainterOperation): void {
    const msg = toHistoryOperation(entry.actorId, entry.operation);
    this.fork.push({
      id: entry.id,
      msg,
      area: affectedArea(msg),
    });
    if (msg.type === "undoPoint") {
      // Reset the local stroke continuation so a new stroke doesn't dedup
      // against the previous one's endpoint
      this.liveStrokes.set(actorKey(msg.userId), null);
    } else if (msg.type !== "undo") {
      this.applyDrawSync(msg, this.liveSource, this.liveStrokes);
    }
    // Update undo/redo button state immediately (projected over the fork)
    this.notify();
  }

  /**
   * Registers an operation the interactive canvas has already painted.
   * Controlled mounts use this path because pointer latency stays local while
   * canonical ordering remains owned by this history.
   */
  registerOptimisticOperation(entry: LocalPainterOperation): void {
    const msg = toHistoryOperation(entry.actorId, entry.operation);
    this.fork.push({ id: entry.id, msg, area: affectedArea(msg) });
    if (msg.type === "undoPoint") {
      this.liveStrokes.set(actorKey(entry.actorId), null);
    }
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
    brushType: WireBrushType,
    color: { r: number; g: number; b: number; a: number },
    x: number,
    y: number,
    mask: Mask = NO_MASK
  ): number {
    if (this.localUserId === -1) return 0;
    if (!this.openBatch) {
      this.openBatch = {
        targetOwner: this.localTargetOwner,
        layer,
        brushSize,
        brushType,
        color,
        mask,
        points: [],
        area: {
          kind: "pixels",
          owner: this.localTargetOwner,
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
      this.liveSource(this.localTargetOwner),
      this.liveStrokes
    );
    return batch.points.length;
  }

  /**
   * Closes the open batch and returns its semantic stroke. The transport
   * encodes it, then calls `commitLocalStroke` with the opaque bytes it sent.
   */
  flushLocalStroke(): HistoryStroke | null {
    const batch = this.openBatch;
    this.openBatch = null;
    if (!batch || batch.points.length === 0) return null;
    return {
      type: "stroke",
      userId: this.localUserId,
      targetOwner: batch.targetOwner,
      layer: batch.layer,
      brushSize: batch.brushSize,
      brushType: batch.brushType,
      color: batch.color,
      points: batch.points,
      mask: batch.mask,
    };
  }

  /** Registers the transport token used to recognize this stroke's echo. */
  commitLocalStroke(bytes: ArrayBuffer, msg: HistoryStroke): void {
    this.fork.push({
      id: transportId(new Uint8Array(bytes)),
      msg,
      area: affectedArea(msg),
    });
  }

  /**
   * Handles a message from the canonical server stream (a remote user's
   * message or the echo of a local one).
   */
  async handleRemote(
    raw: Uint8Array,
    msg: HistoryOperation,
    seq?: number
  ): Promise<void> {
    return this.handleCanonicalMessage(transportId(raw), msg, seq);
  }

  /** Applies a server-ordered operation and reconciles any optimistic fork. */
  async handleCanonicalOperation(
    entry: CanonicalPainterOperation,
    sequenceOverride?: number,
  ): Promise<void> {
    const msg = toHistoryOperation(entry.actorId, entry.operation);
    const seq = sequenceOverride ?? entry.sequence;
    await this.handleCanonicalMessage(entry.id, msg, seq);
    this.canonicalLog.push({ ...entry, sequence: seq });
  }

  /** Canonical transport-neutral log since the most recent reset/checkpoint. */
  getCanonicalOperations(): CanonicalPainterOperation[] {
    return this.canonicalLog.map((entry) => ({
      ...entry,
      operation: structuredClone(entry.operation),
    }));
  }

  private async handleCanonicalMessage(
    id: string,
    msg: HistoryOperation,
    seq?: number,
  ): Promise<void> {
    // Echo of our own fork head: already on the canvas (except undo/undoPoint
    // which take effect now)
    if (this.fork.length > 0 && this.fork[0].id === id) {
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
      actorKey(msg.userId) === actorKey(this.localUserId)
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
  async handleResetPoint(
    baseSeq: number
  ): Promise<Map<ActorKey, OwnerLayers> | null> {
    let cut = 0;
    while (
      cut < this.entries.length &&
      this.entries[cut].seq !== undefined &&
      (this.entries[cut].seq as number) <= baseSeq
    ) {
      cut++;
    }
    if (cut === 0) return null;

    // Compute the state at the cut into temporary buffers, one pair per
    // participant, allocated as the replay first mentions each of them.
    const sp = this.savepointFor(cut);
    const layers = new Map<ActorKey, OwnerLayers>();
    for (const [owner, saved] of sp.layers) {
      layers.set(owner, {
        foreground: new Uint8ClampedArray(saved.foreground),
        background: new Uint8ClampedArray(saved.background),
      });
    }
    const forkSource: LayerSource = (owner) => {
      let pair = layers.get(owner);
      if (!pair) {
        pair = {
          foreground: new Uint8ClampedArray(this.engine.imageWidth * this.engine.imageHeight * 4),
          background: new Uint8ClampedArray(this.engine.imageWidth * this.engine.imageHeight * 4),
        };
        layers.set(owner, pair);
      }
      return pair;
    };
    const strokes = cloneStrokes(sp.strokes);
    for (let i = sp.index; i < cut; i++) {
      const entry = this.entries[i];
      if (entry.undo === "done") {
        await this.applyMessage(entry.msg, forkSource, strokes);
      }
    }

    this.entries = this.entries.slice(cut);
    this.canonicalLog = this.canonicalLog.filter(
      (entry) => entry.sequence > baseSeq,
    );
    this.savepoints = [
      { index: 0, layers, strokes },
      ...this.savepoints
        .filter((s) => s.index >= cut)
        .map((s) => ({ ...s, index: s.index - cut })),
    ];
    this.notify();
    return new Map(
      [...layers].map(([owner, pair]) => [
        owner,
        {
          foreground: new Uint8ClampedArray(pair.foreground),
          background: new Uint8ClampedArray(pair.background),
        },
      ])
    );
  }

  private async applyCanonical(
    msg: HistoryOperation,
    seq: number | undefined,
    { replay }: { replay: boolean }
  ): Promise<void> {
    if (msg.type === "undo") {
      await this.processUndo(msg.userId, msg.redo);
    } else if (msg.type === "undoPoint") {
      this.appendUndoPoint(msg, seq);
      this.liveStrokes.set(actorKey(msg.userId), null);
      if (replay) {
        await this.replayFrom(this.latestSavepoint());
      }
    } else {
      this.entries.push({ seq, msg, undo: "done" });
      if (replay) {
        await this.replayFrom(this.latestSavepoint());
      } else {
        await this.applyMessage(msg, this.liveSource, this.liveStrokes);
        // A snapshot is assigned straight into the buffer, so the engine has
        // no region for it; everything else drew through the engine.
        if (msg.type === "snapshot") this.queueUpdates();
        else this.queueDrawnUpdates();
      }
    }
    this.maybeSavepoint();
    this.notify();
  }

  /** Appends an undo point; a new operation by a user kills their redo. */
  private appendUndoPoint(
    msg: Extract<HistoryOperation, { type: "undoPoint" }>,
    seq?: number
  ): void {
    for (const entry of this.entries) {
      if (
        "userId" in entry.msg &&
        actorKey(entry.msg.userId) === actorKey(msg.userId) &&
        entry.undo === "undone"
      ) {
        entry.undo = "gone";
      }
    }
    this.entries.push({ seq, msg, undo: "done" });
  }

  /** Marks entries and replays; no-op if there is nothing to undo/redo. */
  private async processUndo(userId: HistoryActorId, redo: boolean): Promise<void> {
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
  private markUndo(userId: HistoryActorId, redo: boolean): number {
    let first = -1;
    if (redo) {
      first = this.entries.findIndex(
        (e) =>
          e.msg.type === "undoPoint" &&
          actorKey(e.msg.userId) === actorKey(userId) &&
          e.undo === "undone"
      );
      if (first < 0) return -1;
      let next = this.entries.length;
      for (let i = first + 1; i < this.entries.length; i++) {
        const e = this.entries[i];
        if (
          e.msg.type === "undoPoint" &&
          actorKey(e.msg.userId) === actorKey(userId)
        ) {
          next = i;
          break;
        }
      }
      for (let i = first; i < next; i++) {
        const e = this.entries[i];
        if (
          "userId" in e.msg &&
          actorKey(e.msg.userId) === actorKey(userId) &&
          e.undo === "undone"
        ) {
          e.undo = "done";
        }
      }
    } else {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i];
        if (
          e.msg.type === "undoPoint" &&
          actorKey(e.msg.userId) === actorKey(userId) &&
          e.undo === "done"
        ) {
          first = i;
          break;
        }
      }
      if (first < 0) return -1;
      for (let i = first; i < this.entries.length; i++) {
        const e = this.entries[i];
        if (
          "userId" in e.msg &&
          actorKey(e.msg.userId) === actorKey(userId) &&
          e.undo === "done"
        ) {
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
    this.restoreLayers(sp);
    const strokes = cloneStrokes(sp.strokes);
    for (let i = sp.index; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.undo === "done") {
        await this.applyMessage(entry.msg, this.liveSource, strokes);
      }
    }
    for (const f of this.fork) {
      if (f.msg.type === "undoPoint") {
        // Keyed by the entry's own actor, exactly as the confirmed entries
        // above are, so a boundary always clears the state the strokes
        // beside it are drawn under.
        strokes.set(actorKey(f.msg.userId), null);
      } else if (f.msg.type !== "undo") {
        this.applyDrawSync(f.msg, this.liveSource, strokes);
      }
    }
    if (this.openBatch && this.openBatch.points.length > 0) {
      this.applyStrokePoints(
        this.localUserId,
        this.openBatch,
        this.openBatch.points,
        this.liveSource(this.openBatch.targetOwner),
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
      layers: this.captureLayers(),
      strokes: cloneStrokes(this.liveStrokes),
    });
    if (this.savepoints.length > MAX_SAVEPOINTS) {
      // Keep the base savepoint (needed to replay any entry) and the most
      // recent ones; drop the second-oldest
      this.savepoints.splice(1, 1);
    }
  }

  /** Applies a message to its author's layers (snapshot decode is async). */
  private async applyMessage(
    msg: HistoryOperation,
    source: LayerSource,
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
      source(actorKey(msg.targetOwner))[msg.layer].set(data);
      return;
    }
    if (msg.type === "undoPoint") {
      strokes.set(actorKey(msg.userId), null);
      return;
    }
    this.applyDrawSync(msg, source, strokes);
  }

  /** Points the engine at a mask, or at none. */
  private useMask(mask: Mask | undefined): void {
    this.engine.maskType = mask?.type ?? 0;
    if (mask && mask.type !== 0) {
      this.engine.maskColor = [mask.r, mask.g, mask.b];
    }
  }

  private applyDrawSync(
    msg: HistoryOperation,
    source: LayerSource,
    strokes: StrokeStates
  ): void {
    // Every drawing message carries the mask it was drawn through, so replay
    // uses the sender's mask rather than whatever this client last set.
    this.useMask("mask" in msg ? msg.mask : undefined);
    // The layers written are the target's. Everything else about the message
    // still follows its author: the pen's continuation state, the clipboard a
    // paste reads, and the undo stack it lands on. The two undo messages write
    // nothing and never reach here.
    const layers = source(
      actorKey("targetOwner" in msg ? msg.targetOwner : msg.userId)
    );
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
      case "region": {
        // The clipboard belongs to whoever copied. Every client keeps one per
        // user and swaps it in around the op, so a paste reproduces what the
        // sender copied rather than whatever the receiver last copied -- which
        // is usually nothing.
        const targets = layers;
        this.engine.setClipboard(this.clipboards.get(actorKey(msg.userId)) ?? null);
        this.engine.applyRegionTool(
          msg.tool, msg.layer, msg.rect, msg.color, msg.brushSize, targets
        );
        if (msg.tool === "copy") {
          this.clipboards.set(actorKey(msg.userId), this.engine.getClipboard());
        }
        break;
      }
      case "line":
        this.engine.drawLine(
          layers[msg.layer],
          // Drawn new -> previous, as NEO draws every segment
          msg.to.x, msg.to.y, msg.from.x, msg.from.y,
          msg.brushSize, msg.brushType,
          msg.color.r, msg.color.g, msg.color.b, msg.color.a
        );
        this.engine.setStrokeState(null);
        break;
      case "bezier":
        this.engine.drawBezier(
          msg.layer,
          msg.points as [number, number, number, number, number, number, number, number],
          msg.brushSize, msg.brushType, msg.color,
          layers[msg.layer]
        );
        break;
      case "eraseAll":
        this.engine.eraseAll(msg.layer, layers);
        break;
      case "text":
        this.engine.drawText(
          msg.layer, msg.x, msg.y,
          msg.color, msg.color.a / 255, msg.text,
          String(fontSizeForBrush(msg.brushSize)), TEXT_FONT_FAMILY,
          layers[msg.layer]
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
    userId: HistoryActorId,
    props: Pick<HistoryStroke, "layer" | "brushSize" | "brushType" | "color" | "mask">,
    points: { x: number; y: number }[],
    layers: OwnerLayers,
    strokes: StrokeStates
  ): void {
    // Reached directly by the local live path and by rebuilds, not only
    // through applyDrawSync, so it sets the mask itself.
    this.useMask(props.mask);
    this.engine.setStrokeState(strokes.get(actorKey(userId)) ?? null);
    for (const p of points) {
      const prev = this.engine.getStrokeState();
      // Segments run new -> previous, as NEO draws them. The engine records
      // prevLine as [first arg, second arg], so the most recent point of the
      // last segment is prev[0].
      const [fromX, fromY] = prev === null ? [p.x, p.y] : prev[0];
      this.engine.drawLine(
        layers[props.layer],
        p.x,
        p.y,
        fromX,
        fromY,
        props.brushSize,
        props.brushType,
        props.color.r,
        props.color.g,
        props.color.b,
        props.color.a
      );
    }
    strokes.set(actorKey(userId), this.engine.getStrokeState());
  }

  /**
   * Repaints both layers whole. For the paths that put pixels somewhere the
   * engine cannot have seen: a savepoint restored under a replay, a decoded
   * snapshot, a blanked canvas.
   */
  private queueUpdates(): void {
    // Every participant's, not just our own. A replay rewrites whoever's
    // layers the entries touch, and an undo of somebody else's fill rewrites
    // theirs: repainting only ours would leave their canvas showing pixels
    // the buffer behind it no longer has.
    for (const owner of this.engine.ownerIds()) {
      this.engine.queueLayerUpdate("foreground", owner);
      this.engine.queueLayerUpdate("background", owner);
    }
  }

  /**
   * Repaints only what the operation just drew.
   *
   * The live application path -- one message, one small mark. Every write it
   * makes goes through the engine's own surfaces, which is what makes the
   * region trustworthy; a remote stroke segment covers a few hundred pixels,
   * and uploading the whole canvas for it costs an order of magnitude more
   * than drawing it did.
   */
  private queueDrawnUpdates(): void {
    // No owner loop here: every write on this path went through the engine's
    // own surfaces, which resolve the participant from the buffer and have
    // already marked the right canvas dirty. Only the whole-layer path above,
    // which puts pixels somewhere the engine never saw, has to name them.
    this.engine.queueLayerRegionUpdate("foreground");
    this.engine.queueLayerRegionUpdate("background");
  }

  private notify(): void {
    this.onChange?.(this.canUndo(), this.canRedo());
  }
}
