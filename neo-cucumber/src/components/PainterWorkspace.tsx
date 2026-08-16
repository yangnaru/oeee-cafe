import type React from "react";
import { PainterCanvas, type PainterCanvasProps } from "./PainterCanvas";

interface PainterWorkspaceProps {
  workspaceRef: React.RefObject<HTMLDivElement | null>;
  canvas: PainterCanvasProps | null;
  /** Mode-specific content that must precede the canvas in paint order. */
  beforeCanvas?: React.ReactNode;
  /** Toolboxes and controls positioned within the painter ground. */
  children?: React.ReactNode;
  /** Modals positioned over the workspace but outside the painter ground. */
  overlay?: React.ReactNode;
}

/**
 * Shared editor composition around PainterCanvas. Transport, persistence and
 * mode-specific controls stay in their parent; this component guarantees that
 * both modes use the same clipped viewport and NEO ground hierarchy.
 */
export function PainterWorkspace({
  workspaceRef,
  canvas,
  beforeCanvas,
  children,
  overlay,
}: PainterWorkspaceProps) {
  return (
    <div className="flex-1 relative overflow-hidden">
      <div
        ref={workspaceRef}
        className="neo-ground flex gap-4 flex-row w-full h-full justify-center items-center"
        // A right press is the eyedropper, and NEO turns the browser's own
        // menu off across its whole container so one can be made at all.
        // Without this the colour is picked and then buried under a menu
        // nobody asked for -- and on a Mac, where Ctrl-click is how a right
        // press is made, that is every attempt at it.
        onContextMenu={(event) => event.preventDefault()}
      >
        {beforeCanvas}
        {canvas && <PainterCanvas {...canvas} />}
        {children}
      </div>
      {overlay}
    </div>
  );
}
