/**
 * What a tool *is*, as distinct from how it rasterises.
 *
 * Until now the painter carried a single `brushType`, which worked while every
 * tool was a brush. Region tools break that: erase-rect, turn and merge have no
 * line type at all, and encoding them as brush types would push a dozen values
 * into the collaborative protocol that never travel as strokes.
 *
 * NEO keeps the two apart -- a tool, and the line type a drawing tool
 * rasterises with -- and so does this. A ToolId is a superset of BrushType, so
 * the existing stroke tools keep their names and the code that reads them is
 * unchanged; what is new is that the type can now also say "this is not a
 * brush at all".
 */
import type { BrushType } from "../types/collaboration";
import { TOOLTYPE } from "./NeoPainter";
import {
  blurRectExtent,
  eraseRectExtent,
  fillExtent,
  flipExtent,
  mergeExtent,
  turnExtent,
  type Extent,
} from "./extents";

/** Tools driven by dragging out a rectangle, then applied on release. */
export type RegionTool =
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

/**
 * Tools that act the moment you click, with neither a stroke nor a rectangle.
 * NEO's EraseAllTool is the only one.
 */
export type ImmediateTool = "eraseAll";

/**
 * How a drawing tool lays its marks down. NEO's DRAWTYPE_FREEHAND, _LINE and
 * _BEZIER: an axis across every brush rather than more tools, so any of the
 * seven can be stroked freehand, drawn as a straight line, or curved.
 */
export type DrawType = "freehand" | "line" | "bezier";

export type ToolId = BrushType | RegionTool | ImmediateTool;

export function isImmediateTool(tool: ToolId): tool is ImmediateTool {
  return tool === "eraseAll";
}

const REGION_TOOLS: readonly RegionTool[] = [
  "eraseRect",
  "blurRect",
  "merge",
  "flipH",
  "flipV",
  "turn",
  "rect",
  "rectFill",
  "ellipse",
  "ellipseFill",
  "copy",
  "paste",
];

export function isRegionTool(tool: ToolId): tool is RegionTool {
  return (REGION_TOOLS as readonly string[]).includes(tool);
}

/**
 * The brush type a tool rasterises with. Region and immediate tools have none;
 * callers asking for one are asking the wrong question, so they get the
 * harmless default rather than a lie about which brush is in use.
 */
export function brushTypeFor(tool: ToolId): BrushType {
  return isRegionTool(tool) || isImmediateTool(tool) ? "solid" : tool;
}

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The region a tool would touch if applied to `rect` on `layer`.
 *
 * Kept beside the tool table so adding a tool means answering this question,
 * rather than discovering later that the collaborative history was reasoning
 * about the wrong pixels.
 */
export function extentFor(
  tool: RegionTool,
  layer: number,
  rect: RegionRect
): Extent {
  const { x, y, width: w, height: h } = rect;
  switch (tool) {
    case "eraseRect":
      return eraseRectExtent(layer, x, y, w, h);
    case "blurRect":
      return blurRectExtent(layer, x, y, w, h);
    case "merge":
      return mergeExtent(x, y, w, h);
    case "flipH":
    case "flipV":
      return flipExtent(layer, x, y, w, h);
    case "turn":
      return turnExtent(layer, x, y, w, h);
    case "rect":
    case "rectFill":
    case "ellipse":
    case "ellipseFill":
      return fillExtent(layer, x, y, w, h);
    case "copy":
      // Reads pixels into the clipboard and writes none
      return { layers: [], x0: x, y0: y, x1: x + w - 1, y1: y + h - 1 };
    case "paste":
      return fillExtent(layer, x, y, w, h);
  }
}

/** The shape mask a fill-style region tool draws with. */
export function fillToolTypeFor(tool: RegionTool): number | null {
  switch (tool) {
    case "rect":
      return TOOLTYPE.RECT;
    case "rectFill":
      return TOOLTYPE.RECTFILL;
    case "ellipse":
      return TOOLTYPE.ELLIPSE;
    case "ellipseFill":
      return TOOLTYPE.ELLIPSEFILL;
    default:
      return null;
  }
}

/**
 * The verb each region tool records into a .pch frame, and whether that verb
 * carries the drawing state (colour, width, mask) before its geometry.
 *
 * eraseRect is recorded as `eraseRect2`, which is the same operation written
 * the other way round: it pushes the current drawing state first, so its
 * rectangle starts at slot 11 instead of slot 2. NEO writes the newer form,
 * and reads both.
 */
export interface RegionFrameShape {
  verb: string;
  /** True when the frame carries pushCurrent's nine slots before its geometry. */
  carriesDrawingState: boolean;
}

export function frameShapeFor(tool: RegionTool): RegionFrameShape | null {
  switch (tool) {
    case "eraseRect":
      return { verb: "eraseRect2", carriesDrawingState: true };
    case "blurRect":
      return { verb: "blurRect", carriesDrawingState: false };
    case "merge":
      return { verb: "merge", carriesDrawingState: false };
    case "flipH":
      return { verb: "flipH", carriesDrawingState: false };
    case "flipV":
      return { verb: "flipV", carriesDrawingState: false };
    case "turn":
      return { verb: "turn", carriesDrawingState: false };
    case "rect":
    case "rectFill":
    case "ellipse":
    case "ellipseFill":
      return { verb: "fill", carriesDrawingState: true };
    case "copy":
      return { verb: "copy", carriesDrawingState: false };
    case "paste":
      return { verb: "paste", carriesDrawingState: false };
  }
}
