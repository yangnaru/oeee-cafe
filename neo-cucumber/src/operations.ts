/** Transport-neutral drawing vocabulary for controlled and collaborative hosts. */

export type PainterLayer = "foreground" | "background";
export type PainterBrush =
  | "solid"
  | "halftone"
  | "eraser"
  | "brush"
  | "dodge"
  | "burn"
  | "blur";
export type PainterRegionTool =
  | "eraseRect"
  | "blurRect"
  | "merge"
  | "flipH"
  | "flipV"
  | "turn"
  | "rect"
  | "rectFill"
  | "ellipse"
  | "ellipseFill"
  | "copy"
  | "paste";

export interface PainterPoint {
  x: number;
  y: number;
}

export interface PainterColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PainterMask {
  /** NEO mask mode: 0 none, 1 mask, 2 reverse, 3 add, 4 subtract. */
  type: number;
  r: number;
  g: number;
  b: number;
}

interface PainterMark {
  layer: PainterLayer;
  mask: PainterMask;
  /**
   * Whose layer pair the mark lands in, when that is not the author's own.
   *
   * A collaborative session gives every participant their own background and
   * foreground, and a participant may paint into somebody else's. Leave it
   * unset to mean "my own layers", which is every offline mark.
   */
  targetActorId?: string;
}

export type PainterOperation =
  | (PainterMark & {
      kind: "stroke";
      brushSize: number;
      brush: PainterBrush;
      color: PainterColor;
      points: PainterPoint[];
    })
  | (PainterMark & {
      kind: "fill";
      at: PainterPoint;
      color: PainterColor;
    })
  | (PainterMark & {
      kind: "line";
      brushSize: number;
      brush: PainterBrush;
      color: PainterColor;
      from: PainterPoint;
      to: PainterPoint;
    })
  | (PainterMark & {
      kind: "bezier";
      brushSize: number;
      brush: PainterBrush;
      color: PainterColor;
      points: [number, number, number, number, number, number, number, number];
    })
  | (PainterMark & {
      kind: "region";
      tool: PainterRegionTool;
      rect: { x: number; y: number; width: number; height: number };
      color: PainterColor;
      brushSize: number;
    })
  | (PainterMark & {
      /**
       * A rectangle of pixels replacing what is under it.
       *
       * A flood fill travels this way rather than as the point that seeded it:
       * replaying a seed re-runs the flood against whatever the layer holds at
       * the time, so a fill could spread differently when something under it
       * was undone. The pixels are the pixels.
       */
      kind: "raster";
      at: PainterPoint;
      width: number;
      height: number;
      /**
       * The rectangle's RGBA, DEFLATE-compressed. Measured against PNG on the
       * rasters a fill actually makes, this is several times smaller.
       */
      pixels: Uint8Array;
    })
  | (PainterMark & {
      kind: "text";
      at: PainterPoint;
      text: string;
      color: PainterColor;
      brushSize: number;
    })
  | { kind: "clear-layer"; layer: PainterLayer; targetActorId?: string }
  | { kind: "undo-boundary" }
  | { kind: "undo"; redo: boolean };

/** A host-assigned identity around an operation emitted by a painter. */
export interface LocalPainterOperation {
  id: string;
  actorId: string;
  operation: PainterOperation;
  timestamp?: number;
}

/** The canonical ordering delivered by a collaborative host. */
export interface CanonicalPainterOperation extends LocalPainterOperation {
  sequence: number;
}

/** A compaction boundary from which canonical operations can continue. */
/** One participant's two layers, as a checkpoint carries them. */
export interface PainterCheckpointLayers {
  /** The participant these layers belong to, as `actorId` names them. */
  actorId: string;
  background: Blob;
  foreground: Blob;
}

export interface PainterCheckpoint {
  sequence: number;
  width: number;
  height: number;
  /**
   * Every participant's pair, bottom of the stack first.
   *
   * A collaborative session composites one pair per participant, so a
   * checkpoint that carried a single pair could not describe it. Offline and
   * replay mounts have exactly one entry here and never notice.
   */
  layers: PainterCheckpointLayers[];
}

/** Rich archival form; `.pch` is a flattened export derived from this log. */
export interface PainterSessionArchive {
  format: "neo-cucumber-session";
  version: 1;
  canvas: {
    width: number;
    height: number;
    mode:
      | { kind: "standard" }
      | {
          kind: "two-tone";
          backgroundColor: string;
          foregroundColor: string;
        };
  };
  checkpoint?: PainterCheckpoint;
  operations: CanonicalPainterOperation[];
}
