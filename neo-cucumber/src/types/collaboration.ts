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