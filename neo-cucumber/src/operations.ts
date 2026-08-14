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
      kind: "text";
      at: PainterPoint;
      text: string;
      color: PainterColor;
      brushSize: number;
    })
  | { kind: "clear-layer"; layer: PainterLayer }
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
export interface PainterCheckpoint {
  sequence: number;
  width: number;
  height: number;
  background: Blob;
  foreground: Blob;
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
