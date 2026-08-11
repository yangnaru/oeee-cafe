import type { ToolId } from "../neo/tools";

/** Everything the engine can rasterise, plus the two non-drawing tools. */
export type BrushType =
  | "solid"
  | "brush"
  | "halftone"
  | "eraser"
  | "dodge"
  | "burn"
  | "blur"
  | "fill"
  | "pan";

/**
 * The drawing tools the collaborative wire format carries. Every brush type
 * the engine rasterises has a code; fill and pan are excluded because neither
 * travels as a stroke -- fill is its own message and pan draws nothing.
 */
export type WireBrushType =
  | "solid"
  | "halftone"
  | "eraser"
  | "brush"
  | "dodge"
  | "burn"
  | "blur";

export const WIRE_BRUSH_TYPES: readonly WireBrushType[] = [
  "solid",
  "halftone",
  "eraser",
  "brush",
  "dodge",
  "burn",
  "blur",
];

export function isWireBrushType(type: string): type is WireBrushType {
  return (WIRE_BRUSH_TYPES as readonly string[]).includes(type);
}
export type LayerType = "foreground" | "background";

export interface DrawingState {
  brushSize: number;
  opacity: number;
  color: string;
  brushType: ToolId;
  layerType: LayerType;
  zoomLevel: number;
  fgVisible: boolean;
  bgVisible: boolean;
  isFlippedHorizontal: boolean;
  pendingPanDeltaX?: number;
  pendingPanDeltaY?: number;
}

export interface CollaborationMeta {
  title: string;
  width: number;
  height: number;
  ownerId: string;
  savedPostId?: string;
  ownerLoginName: string;
  maxUsers: number;
  currentUserCount: number;
}

export interface Participant {
  userId: string;
  username: string;
  joinedAt: number;
}