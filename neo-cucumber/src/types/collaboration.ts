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
 * The subset the collaborative wire format can carry: brushType is one byte
 * with three defined values. Until that is versioned, a shared session can
 * only offer these, so the boundary is a type rather than a convention.
 */
export type WireBrushType = "solid" | "halftone" | "eraser";

export const WIRE_BRUSH_TYPES: readonly WireBrushType[] = [
  "solid",
  "halftone",
  "eraser",
];

export function isWireBrushType(type: string): type is WireBrushType {
  return (WIRE_BRUSH_TYPES as readonly string[]).includes(type);
}
export type LayerType = "foreground" | "background";

export interface DrawingState {
  brushSize: number;
  opacity: number;
  color: string;
  brushType: BrushType;
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