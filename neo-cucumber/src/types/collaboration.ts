// The engine rasterises all seven of NEO's line types; this union is what the
// UI and the collaborative wire format currently carry. Widening it means
// assigning new protocol codes, which older clients would not understand, so
// it happens with the tool work rather than on its own.
export type BrushType = "solid" | "halftone" | "eraser" | "fill" | "pan";
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