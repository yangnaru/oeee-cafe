import React, { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Icon } from "@iconify/react";
import { NeoToolColumn } from "./neo/NeoToolColumn";
import {
  NEO_BUTTON,
  NEO_BUTTON_ON,
  NEO_PANEL,
  NEO_TITLEBAR,
} from "./neo/neoClasses";

import type { ToolId } from "../neo/tools";
import type { DrawingState } from "../types/collaboration";

interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

interface ToolboxPanelProps {
  /**
   * Which half to show. NEO's toolbox holds tools, colour and layers and
   * nothing else, so our own controls -- undo, zoom, flip, save -- can be
   * split into a second panel rather than sitting in a column claiming to be
   * NEO's. "all" puts both in one panel.
   */
  section?: "all" | "neo" | "extras";
  drawingState: DrawingState;
  historyState: HistoryState;
  paletteColors: string[];
  selectedPaletteIndex: number;
  currentZoom: number;
  isOwner: boolean;
  /** Tools to offer; defaults to everything the painter has. */
  tools: readonly ToolId[];
  /**
   * Whether a stroke can carry a mask. Offline drawings record one into the
   * .pch, but the collaborative wire format has no field for it, so a shared
   * session would draw a mask locally that no peer could reproduce. The tip
   * is hidden rather than allowed to lie.
   */
  maskSupported?: boolean;
  isSaving: boolean;
  sessionEnded: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onUpdateBrushType: (type: ToolId) => void;
  onUpdateDrawingState: React.Dispatch<React.SetStateAction<DrawingState>>;
  onUpdateColor: (color: string) => void;
  onSetSelectedPaletteIndex: (index: number) => void;
  onSetPaletteColor: (index: number, color: string) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onSaveCollaborativeDrawing: () => void;
  initialPosition?: { x: number; y: number };
}

/**
 * The floating window NEO's tool column lives in.
 *
 * NEO itself docks its column to the canvas rather than floating it, but our
 * painter has to sit inside a page it does not own, so the column travels in a
 * draggable panel. Everything inside the panel is NEO's; the panel is ours.
 */
export const ToolboxPanel = ({
  drawingState,
  historyState,
  paletteColors,
  selectedPaletteIndex,
  currentZoom,
  isOwner,
  tools,
  maskSupported = true,
  isSaving,
  sessionEnded,
  onUndo,
  onRedo,
  onUpdateBrushType,
  onUpdateDrawingState,
  onUpdateColor,
  onSetSelectedPaletteIndex,
  onSetPaletteColor,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onSaveCollaborativeDrawing,
  section = "all",
  initialPosition,
}: ToolboxPanelProps) => {
  const { t } = useLingui();

  const [position, setPosition] = useState(
    initialPosition ?? { x: 304, y: 70 }
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);

  /**
   * One pointer gesture rather than a mouse pair and a touch pair. Pointer
   * capture keeps the panel following even when the cursor outruns it, which
   * is what the old document-level mousemove listener was working around.
   */
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const offset = dragOffset.current;
    if (!offset) return;
    setPosition({
      x: Math.max(0, Math.min(e.clientX - offset.x, window.innerWidth - 24)),
      y: Math.max(0, Math.min(e.clientY - offset.y, window.innerHeight - 24)),
    });
  }, []);

  const endDrag = useCallback(() => {
    dragOffset.current = null;
  }, []);

  // Keep the panel reachable when the window shrinks under it
  useEffect(() => {
    const onResize = () =>
      setPosition((prev) => ({
        x: Math.max(0, Math.min(prev.x, window.innerWidth - 24)),
        y: Math.max(0, Math.min(prev.y, window.innerHeight - 24)),
      }));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const showNeo = section !== "extras";
  const showExtras = section !== "neo";

  return (
    <div
      ref={panelRef}
      className={`${NEO_PANEL} fixed flex w-max flex-col shadow-lg`}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      <div
        className={`${NEO_TITLEBAR} flex touch-none items-center justify-center gap-[3px] cursor-grab active:cursor-grabbing`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="h-[3px] w-[3px] rounded-full bg-white/70" />
        <span className="h-[3px] w-[3px] rounded-full bg-white/70" />
        <span className="h-[3px] w-[3px] rounded-full bg-white/70" />
      </div>

      <div className="flex flex-col gap-[2px] p-[2px]">
        {showNeo && (
          <NeoToolColumn
            drawingState={drawingState}
            paletteColors={paletteColors}
            selectedPaletteIndex={selectedPaletteIndex}
            tools={tools}
            maskSupported={maskSupported}
            onUpdateDrawingState={onUpdateDrawingState}
            onUpdateBrushType={onUpdateBrushType}
            onUpdateColor={onUpdateColor}
            onSetSelectedPaletteIndex={onSetSelectedPaletteIndex}
            onSetPaletteColor={onSetPaletteColor}
          />
        )}

        {showExtras && (
          <div className="flex w-[52px] flex-col gap-[2px]">
            {/* Undo and redo. NEO puts these in the bar above the canvas. */}
            <div className="flex flex-row gap-[2px]">
              <button
                type="button"
                onClick={onUndo}
                disabled={!historyState.canUndo}
                title={t`Undo`}
                className={`${NEO_BUTTON} flex flex-1 items-center justify-center`}
              >
                <Icon icon="material-symbols:undo" width={14} height={14} />
              </button>
              <button
                type="button"
                onClick={onRedo}
                disabled={!historyState.canRedo}
                title={t`Redo`}
                className={`${NEO_BUTTON} flex flex-1 items-center justify-center`}
              >
                <Icon icon="material-symbols:redo" width={14} height={14} />
              </button>
            </div>

            {/* Zoom. NEO overlays + and - on the canvas corners instead. */}
            <div className="flex flex-row gap-[2px]">
              <button
                type="button"
                onClick={onZoomOut}
                title={t`Zoom out`}
                className={`${NEO_BUTTON} flex flex-1 items-center justify-center`}
              >
                <Icon icon="material-symbols:zoom-out" width={14} height={14} />
              </button>
              <button
                type="button"
                onClick={onZoomIn}
                title={t`Zoom in`}
                className={`${NEO_BUTTON} flex flex-1 items-center justify-center`}
              >
                <Icon icon="material-symbols:zoom-in" width={14} height={14} />
              </button>
            </div>
            <button
              type="button"
              onClick={onZoomReset}
              title={t`Reset zoom`}
              className={`${NEO_BUTTON} w-full text-center tabular-nums`}
            >
              {Math.round(currentZoom * 100)}%
            </button>

            {/* Flipping the view, which is a mirror rather than an edit */}
            <button
              type="button"
              onClick={() =>
                onUpdateDrawingState((prev) => ({
                  ...prev,
                  isFlippedHorizontal: !prev.isFlippedHorizontal,
                }))
              }
              title={t`Toggle horizontal flip`}
              className={`${NEO_BUTTON} ${
                drawingState.isFlippedHorizontal ? NEO_BUTTON_ON : ""
              } flex w-full items-center justify-center gap-1`}
            >
              <Icon icon="material-symbols:flip" width={14} height={14} />
            </button>

            {isOwner && (
              <button
                type="button"
                onClick={onSaveCollaborativeDrawing}
                disabled={isSaving || sessionEnded}
                title={t`Save drawing to gallery`}
                className={`${NEO_BUTTON} flex w-full items-center justify-center`}
              >
                {isSaving ? (
                  <Icon
                    icon="material-symbols:refresh"
                    width={14}
                    height={14}
                    className="animate-spin"
                  />
                ) : (
                  <span className="text-[11px]">
                    <Trans>Save</Trans>
                  </span>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
