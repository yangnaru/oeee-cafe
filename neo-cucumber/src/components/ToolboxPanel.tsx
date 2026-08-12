import "../styles/neoChrome.css";
import React, { useState, useRef, useCallback, useEffect } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Icon } from "@iconify/react";
import { NeoSizeSlider } from "./NeoSizeSlider";
import { NeoColorSliders } from "./NeoColorSliders";
import { ToolSelector } from "./ToolSelector";
import { ColorPalette } from "./ColorPalette";
import { CustomSlider } from "./CustomSlider";

import type { ToolId } from "../neo/tools";
type LayerType = "foreground" | "background";

// The shared type rather than a local copy: the copy had already drifted,
// missing drawType, which is why the panel could not offer line or bezier.
import type { DrawingState } from "../types/collaboration";

interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

interface ToolboxPanelProps {
  /** NEO's beveled chrome instead of the flat panel. */
  retro?: boolean;
  /**
   * Which half to show. NEO's toolbox has tools, colour and layers and
   * nothing else, so our own controls -- undo, zoom, flip, save -- move to a
   * second panel rather than sitting in a column that claims to be NEO's.
   */
  section?: "all" | "neo" | "extras";
  drawingState: DrawingState;
  historyState: HistoryState;
  paletteColors: string[];
  selectedPaletteIndex: number;
  currentZoom: number;
  isOwner: boolean;
  /** Tools to offer; defaults to the shared-session subset. */
  tools?: readonly ToolId[];
  isSaving: boolean;
  sessionEnded: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onUpdateBrushType: (type: ToolId) => void;
  onUpdateDrawingState: React.Dispatch<React.SetStateAction<DrawingState>>;
  onUpdateColor: (color: string) => void;
  onColorPickerChange: (color: string) => void;
  onSetSelectedPaletteIndex: (index: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onSaveCollaborativeDrawing: () => void;
  initialPosition?: { x: number; y: number };
}

export const ToolboxPanel = ({
  drawingState,
  historyState,
  paletteColors,
  selectedPaletteIndex,
  currentZoom,
  isOwner,
  tools,
  isSaving,
  sessionEnded,
  onUndo,
  onRedo,
  onUpdateBrushType,
  onUpdateDrawingState,
  onUpdateColor,
  onColorPickerChange,
  onSetSelectedPaletteIndex,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onSaveCollaborativeDrawing,
  retro = false,
  section = "all",
  initialPosition,
}: ToolboxPanelProps) => {
  const { t } = useLingui();

  // Dragging state
  const [position, setPosition] = useState(
    initialPosition || {
      x: 288 + 16, // Chat width (288px = w-72) + 16px padding to match chat's p-4
      y: 70, // Same distance from header as chat (80px to match top positioning)
    }
  );
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!panelRef.current) return;

    const rect = panelRef.current.getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    setIsDragging(true);
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!panelRef.current) return;

    const touch = e.touches[0];
    const rect = panelRef.current.getBoundingClientRect();
    setDragOffset({
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top,
    });
    setIsDragging(true);
    e.preventDefault(); // Prevent scrolling
  }, []);

  const updatePosition = useCallback(
    (clientX: number, clientY: number) => {
      const newX = clientX - dragOffset.x;
      const newY = clientY - dragOffset.y;

      // Keep panel within viewport bounds
      const maxX = window.innerWidth;
      const maxY = window.innerHeight;

      setPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      });
    },
    [dragOffset]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;
      updatePosition(e.clientX, e.clientY);
    },
    [isDragging, updatePosition]
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!isDragging) return;
      const touch = e.touches[0];
      updatePosition(touch.clientX, touch.clientY);
      e.preventDefault(); // Prevent scrolling
    },
    [isDragging, updatePosition]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Handle window resize to keep panel in bounds
  const handleResize = useCallback(() => {
    setPosition((prevPosition) => {
      const panelWidth = 250; // Approximate panel width
      const panelHeight = 600; // Approximate panel height

      const maxX = window.innerWidth - panelWidth;
      const maxY = window.innerHeight - panelHeight;

      return {
        x: Math.max(0, Math.min(prevPosition.x, maxX)),
        y: Math.max(70, Math.min(prevPosition.y, maxY)), // Keep below header
      };
    });
  }, []);

  // Add window resize listener
  useEffect(() => {
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [handleResize]);

  // Add global mouse and touch event listeners
  useEffect(() => {
    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.addEventListener("touchmove", handleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", handleTouchEnd);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    } else {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [
    isDragging,
    handleMouseMove,
    handleMouseUp,
    handleTouchMove,
    handleTouchEnd,
  ]);

  const showNeo = section !== "extras";
  const showExtras = section !== "neo";

  return (
    <div
      ref={panelRef}
      className={`fixed flex flex-col touch-auto select-auto shadow-lg ${
        retro ? "neo-chrome neo-raised" : "border border-main bg-main"
      }`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
    >
      {/* Drag handle */}
      <div
        className={`flex items-center justify-center p-2 cursor-grab active:cursor-grabbing touch-none ${
          retro
            ? "neo-titlebar"
            : "bg-main border-b border-main hover:bg-gray-100"
        }`}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
      >
        <div className="w-1 h-1 bg-gray-400 rounded-full"></div>
        <div className="w-1 h-1 bg-gray-400 rounded-full ml-1"></div>
        <div className="w-1 h-1 bg-gray-400 rounded-full ml-1"></div>
      </div>

      <div className="p-2 flex flex-col gap-1">
{showExtras && (<>
        {/* Undo/Redo buttons */}
        <div className="flex flex-row">
          <button
            type="button"
            onClick={onUndo}
            disabled={!historyState.canUndo}
            className="flex items-center justify-center px-3 py-2 border-l border-t border-b border-r border-main bg-main text-main cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:not(:disabled):bg-highlight hover:not(:disabled):text-white flex-1"
          >
            <Icon icon="material-symbols:undo" width={16} height={16} />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!historyState.canRedo}
            className="flex items-center justify-center px-3 py-2 border-t border-b border-r border-main bg-main text-main cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:not(:disabled):bg-highlight hover:not(:disabled):text-white flex-1"
          >
            <Icon icon="material-symbols:redo" width={16} height={16} />
          </button>
        </div>

</>)}
{showNeo && (<>
        <div className="flex flex-row gap-2">
          {/* Tool selection */}
          <ToolSelector
            tools={tools}
            brushType={drawingState.brushType}
            onUpdateBrushType={onUpdateBrushType}
            drawType={drawingState.drawType ?? "freehand"}
            onCycleDrawType={(backwards) => {
              const types = ["freehand", "line", "bezier"] as const;
              onUpdateDrawingState((prev) => {
                const at = types.indexOf(prev.drawType ?? "freehand");
                const next =
                  (at + (backwards ? -1 : 1) + types.length) % types.length;
                return { ...prev, drawType: types[next] };
              });
            }}
          />
        </div>

        <div className="flex flex-col gap-1">
          {/* Color palette and picker */}
          <ColorPalette
            paletteColors={paletteColors}
            selectedPaletteIndex={selectedPaletteIndex}
            currentColor={drawingState.color}
            onSetSelectedPaletteIndex={onSetSelectedPaletteIndex}
            retro={retro}
            onUpdateColor={onUpdateColor}
            onColorPickerChange={onColorPickerChange}
          />

          {/* NEO picks colour with four channel sliders rather than a
              picker, and alpha is one of them -- so this replaces the
              opacity gauge rather than sitting beside it. */}
          {retro ? (
            <NeoColorSliders
              color={drawingState.color}
              alpha={drawingState.opacity}
              onChange={(color, alpha) => {
                onUpdateColor(color);
                onUpdateDrawingState((prev) => ({ ...prev, opacity: alpha }));
              }}
            />
          ) : (
            <CustomSlider
              value={drawingState.opacity}
              min={1}
              max={255}
              label={`Opacity: ${Math.max(
                1,
                Math.round((drawingState.opacity / 255) * 100)
              )}%`}
              onChange={(value) =>
                onUpdateDrawingState((prev) => ({
                  ...prev,
                  opacity: value,
                }))
              }
            />
          )}
        </div>

          {/* Brush size. NEO's own slider in the retro chrome; the generic
              one elsewhere, since the collaborative panel is not styled for it. */}
          {retro ? (
            <NeoSizeSlider
              value={drawingState.brushSize}
              color={drawingState.color}
              onChange={(value) =>
                onUpdateDrawingState((prev) => ({ ...prev, brushSize: value }))
              }
            />
          ) : (
            <CustomSlider
              value={drawingState.brushSize}
              min={1}
              max={30}
              label={`Size: ${drawingState.brushSize}`}
              onChange={(value) =>
                onUpdateDrawingState((prev) => ({
                  ...prev,
                  brushSize: value,
                }))
              }
            />
          )}

        {/* Layer selection. NEO shows one button naming the current layer --
            "LayerBG" -- rather than a pair; clicking swaps, right-clicking
            toggles that layer's visibility. */}
        {retro ? (
          <button
            type="button"
            className="neo-tool"
            style={{ width: "46px", height: "18px", position: "relative" }}
            title="Switch layer (right-click to hide)"
            onClick={() =>
              onUpdateDrawingState((prev) => ({
                ...prev,
                layerType:
                  prev.layerType === "foreground" ? "background" : "foreground",
              }))
            }
            onContextMenu={(e) => {
              e.preventDefault();
              onUpdateDrawingState((prev) =>
                prev.layerType === "foreground"
                  ? { ...prev, fgVisible: !prev.fgVisible }
                  : { ...prev, bgVisible: !prev.bgVisible }
              );
            }}
          >
            <span className="neo-tool-label" style={{ opacity:
              (drawingState.layerType === "foreground"
                ? drawingState.fgVisible
                : drawingState.bgVisible)
                ? 1
                : 0.4 }}>
              Layer{drawingState.layerType === "foreground" ? "FG" : "BG"}
            </span>
          </button>
        ) : (
        <div className="flex flex-row">
          {(["foreground", "background"] as LayerType[]).map((layer, index) => (
            <button
              key={layer}
              type="button"
              className={`flex items-center justify-center gap-2 px-3 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white flex-1 ${
                drawingState.layerType === layer ? 'bg-highlight text-white' : ''
              } ${
                index === 0 ? 'border-r-0' : 'border-l-0'
              }`}
              onClick={() =>
                onUpdateDrawingState((prev) => ({
                  ...prev,
                  layerType: layer,
                }))
              }
              onContextMenu={(e) => {
                e.preventDefault();
                if (layer === "foreground") {
                  onUpdateDrawingState((prev) => ({
                    ...prev,
                    fgVisible: !prev.fgVisible,
                  }));
                } else {
                  onUpdateDrawingState((prev) => ({
                    ...prev,
                    bgVisible: !prev.bgVisible,
                  }));
                }
              }}
              title={t`Left click to select layer, right click to toggle visibility`}
            >
              <span className="text-sm">
                {layer === "foreground" ? "FG" : "BG"}
              </span>
              <Icon
                icon={
                  layer === "foreground"
                    ? drawingState.fgVisible ? "material-symbols:visibility" : "material-symbols:visibility-off"
                    : drawingState.bgVisible ? "material-symbols:visibility" : "material-symbols:visibility-off"
                }
                width={16}
                height={16}
                className={`cursor-pointer ${
                  layer === "foreground"
                    ? drawingState.fgVisible ? "" : "opacity-50"
                    : drawingState.bgVisible ? "" : "opacity-50"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (layer === "foreground") {
                    onUpdateDrawingState((prev) => ({
                      ...prev,
                      fgVisible: !prev.fgVisible,
                    }));
                  } else {
                    onUpdateDrawingState((prev) => ({
                      ...prev,
                      bgVisible: !prev.bgVisible,
                    }));
                  }
                }}
              />
            </button>
          ))}
        </div>
        )}
</>)}

{showExtras && (<>
        {/* Zoom controls */}
        <div className="flex flex-row">
          <button
            type="button"
            onClick={onZoomOut}
            className="flex items-center justify-center px-2 py-2 border-l border-t border-b border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white flex-1"
          >
            <Icon icon="material-symbols:zoom-out" width={16} height={16} />
          </button>
          <button
            type="button"
            onClick={onZoomReset}
            className="flex items-center justify-center px-2 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white flex-1 tabular-nums text-center"
          >
            {Math.round(currentZoom * 100)}%
          </button>
          <button
            type="button"
            onClick={onZoomIn}
            className="flex items-center justify-center px-2 py-2 border-r border-t border-b border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white flex-1"
          >
            <Icon icon="material-symbols:zoom-in" width={16} height={16} />
          </button>
        </div>

        {/* Flip horizontal control */}
        <div className="flex flex-row">
          <button
            type="button"
            onClick={() =>
              onUpdateDrawingState((prev) => ({
                ...prev,
                isFlippedHorizontal: !prev.isFlippedHorizontal,
              }))
            }
            className={`flex items-center justify-center gap-2 px-3 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white flex-1 ${
              drawingState.isFlippedHorizontal ? 'bg-highlight text-white' : ''
            }`}
            title={t`Toggle horizontal flip`}
          >
            <Icon icon="material-symbols:flip" width={16} height={16} />
            <span className="text-sm">
              <Trans>Flip</Trans>
            </span>
          </button>
        </div>

        {/* Save button - only show for session owner */}
        {isOwner && (
          <div className="flex">
            <button
              type="button"
              onClick={onSaveCollaborativeDrawing}
              disabled={isSaving || sessionEnded}
              title={
                isSaving
                  ? t`Save drawing to gallery`
                  : t`Save drawing to gallery`
              }
              className="px-3 py-1 border border-main bg-main text-main cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:not(:disabled):bg-highlight hover:not(:disabled):text-white"
            >
              {isSaving ? (
                <span className="flex items-center gap-2">
                  <Icon
                    icon="material-symbols:refresh"
                    width={16}
                    height={16}
                    className="animate-spin"
                  />
                  <Trans>Saving...</Trans>
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Icon icon="material-symbols:save" width={16} height={16} />
                  <Trans>Save to Gallery</Trans>
                </span>
              )}
            </button>
          </div>
        )}
</>)}
      </div>
    </div>
  );
};
