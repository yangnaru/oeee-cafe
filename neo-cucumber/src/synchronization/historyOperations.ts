import type { Mask } from "../neo/mask";
import type { RegionTool } from "../neo/tools";
import type { WireBrushType } from "../types/drawing";
import type { PainterOperation, PainterBrush } from "../operations";

export type HistoryLayer = "foreground" | "background";
export type HistoryActorId = string | number;

interface ActorOperation {
  userId: HistoryActorId;
}

interface MaskedOperation extends ActorOperation {
  layer: HistoryLayer;
  mask: Mask;
}

export interface HistorySnapshot extends ActorOperation {
  type: "snapshot";
  layer: HistoryLayer;
  pngData: Uint8Array;
}

export interface HistoryStroke extends MaskedOperation {
  type: "stroke";
  brushSize: number;
  brushType: WireBrushType;
  color: { r: number; g: number; b: number; a: number };
  points: { x: number; y: number }[];
}

export interface HistoryFill extends MaskedOperation {
  type: "fill";
  x: number;
  y: number;
  color: { r: number; g: number; b: number; a: number };
}

export interface HistoryRegion extends MaskedOperation {
  type: "region";
  tool: RegionTool;
  rect: { x: number; y: number; width: number; height: number };
  color: { r: number; g: number; b: number; a: number };
  brushSize: number;
}

export interface HistoryLine extends MaskedOperation {
  type: "line";
  brushSize: number;
  brushType: WireBrushType;
  color: { r: number; g: number; b: number; a: number };
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface HistoryBezier extends MaskedOperation {
  type: "bezier";
  brushSize: number;
  brushType: WireBrushType;
  color: { r: number; g: number; b: number; a: number };
  points: number[];
}

export interface HistoryEraseAll extends ActorOperation {
  type: "eraseAll";
  layer: HistoryLayer;
}

export interface HistoryText extends MaskedOperation {
  type: "text";
  x: number;
  y: number;
  text: string;
  color: { r: number; g: number; b: number; a: number };
  brushSize: number;
}

export interface HistoryUndoBoundary extends ActorOperation {
  type: "undoPoint";
}

export interface HistoryUndo extends ActorOperation {
  type: "undo";
  redo: boolean;
}

export type HistoryOperation =
  | HistorySnapshot
  | HistoryStroke
  | HistoryFill
  | HistoryRegion
  | HistoryLine
  | HistoryBezier
  | HistoryEraseAll
  | HistoryText
  | HistoryUndoBoundary
  | HistoryUndo;

export function isHistoryOperation(value: { type: string }): value is HistoryOperation {
  return [
    "snapshot",
    "stroke",
    "fill",
    "region",
    "line",
    "bezier",
    "eraseAll",
    "text",
    "undoPoint",
    "undo",
  ].includes(value.type);
}

/** Convert the public transport-neutral operation into the raster history form. */
export function toHistoryOperation(
  userId: HistoryActorId,
  operation: PainterOperation,
): Exclude<HistoryOperation, HistorySnapshot> {
  switch (operation.kind) {
    case "stroke":
      return {
        type: "stroke", userId, layer: operation.layer,
        brushSize: operation.brushSize,
        brushType: operation.brush as WireBrushType,
        color: operation.color, points: operation.points, mask: operation.mask,
      };
    case "fill":
      return {
        type: "fill", userId, layer: operation.layer,
        x: operation.at.x, y: operation.at.y,
        color: operation.color, mask: operation.mask,
      };
    case "line":
      return {
        type: "line", userId, layer: operation.layer,
        brushSize: operation.brushSize,
        brushType: operation.brush as WireBrushType,
        color: operation.color, from: operation.from, to: operation.to,
        mask: operation.mask,
      };
    case "bezier":
      return {
        type: "bezier", userId, layer: operation.layer,
        brushSize: operation.brushSize,
        brushType: operation.brush as WireBrushType,
        color: operation.color, points: operation.points, mask: operation.mask,
      };
    case "region":
      return {
        type: "region", userId, layer: operation.layer, tool: operation.tool,
        rect: operation.rect, color: operation.color,
        brushSize: operation.brushSize, mask: operation.mask,
      };
    case "text":
      return {
        type: "text", userId, layer: operation.layer,
        x: operation.at.x, y: operation.at.y, text: operation.text,
        color: operation.color, brushSize: operation.brushSize,
        mask: operation.mask,
      };
    case "clear-layer":
      return { type: "eraseAll", userId, layer: operation.layer };
    case "undo-boundary":
      return { type: "undoPoint", userId };
    case "undo":
      return { type: "undo", userId, redo: operation.redo };
  }
}

/** Convert a raster history operation into the package's public vocabulary. */
export function fromHistoryOperation(
  operation: Exclude<HistoryOperation, HistorySnapshot>,
): PainterOperation {
  switch (operation.type) {
    case "stroke":
      return {
        kind: "stroke", layer: operation.layer, brushSize: operation.brushSize,
        brush: operation.brushType as PainterBrush, color: operation.color,
        points: operation.points, mask: operation.mask,
      };
    case "fill":
      return {
        kind: "fill", layer: operation.layer,
        at: { x: operation.x, y: operation.y }, color: operation.color,
        mask: operation.mask,
      };
    case "line":
      return {
        kind: "line", layer: operation.layer, brushSize: operation.brushSize,
        brush: operation.brushType as PainterBrush, color: operation.color,
        from: operation.from, to: operation.to, mask: operation.mask,
      };
    case "bezier":
      return {
        kind: "bezier", layer: operation.layer, brushSize: operation.brushSize,
        brush: operation.brushType as PainterBrush, color: operation.color,
        points: operation.points as [number, number, number, number, number, number, number, number],
        mask: operation.mask,
      };
    case "region":
      return {
        kind: "region", layer: operation.layer, tool: operation.tool,
        rect: operation.rect, color: operation.color,
        brushSize: operation.brushSize, mask: operation.mask,
      };
    case "text":
      return {
        kind: "text", layer: operation.layer,
        at: { x: operation.x, y: operation.y }, text: operation.text,
        color: operation.color, brushSize: operation.brushSize,
        mask: operation.mask,
      };
    case "eraseAll":
      return { kind: "clear-layer", layer: operation.layer };
    case "undoPoint":
      return { kind: "undo-boundary" };
    case "undo":
      return { kind: "undo", redo: operation.redo };
  }
}
