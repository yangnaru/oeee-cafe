import React, { useState, useRef, useCallback, useEffect } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Icon } from "@iconify/react";
import { ToolSelector } from "./ToolSelector";
import { ColorPalette } from "./ColorPalette";
import { CustomSlider } from "./CustomSlider";

type BrushType = "solid" | "halftone" | "eraser" | "fill" | "pan";
type LayerType = "foreground" | "background";

interface DrawingState {
  brushSize: number;
  opacity: number;
  color: string;
  brushType: BrushType;
  layerType: LayerType;
  zoomLevel: number;
  fgVisible: boolean;
  bgVisible: boolean;
  pendingPanDeltaX?: number;
  pendingPanDeltaY?: number;
}

interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

interface ToolboxPanelProps {
  drawingState: DrawingState;
  historyState: HistoryState;
  paletteColors: string[];
  selectedPaletteIndex: number;
  currentZoom: number;
  isOwner: boolean;
  isSaving: boolean;
  sessionEnded: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onUpdateBrushType: (type: BrushType) => void;
  onUpdateDrawingState: React.Dispatch<React.SetStateAction<DrawingState>>;
  onUpdateColor: (color: string) => void;
  onColorPickerChange: (color: string) => void;
  onSetSelectedPaletteIndex: (index: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onSaveCollaborativeDrawing: () => void;
}

export const ToolboxPanel = ({
  drawingState,
  historyState,
  paletteColors,
  selectedPaletteIndex,
  currentZoom,
  isOwner,
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
}: ToolboxPanelProps) => {
  const { t } = useLingui();

  // Dragging state
  const [position, setPosition] = useState({
    x: 288 + 16, // Chat width (288px = w-72) + 16px padding to match chat's p-4
    y: 70, // Same distance from header as chat (80px to match top positioning)
  });
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

  return (
    <div
      ref={panelRef}
      className="fixed flex flex-col border border-main bg-main touch-auto select-auto shadow-lg"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
    >
      {/* Drag handle */}
      <div
        className="flex items-center justify-center p-2 bg-main border-b border-main cursor-grab active:cursor-grabbing hover:bg-gray-100 touch-none"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
      >
        <div className="w-1 h-1 bg-gray-400 rounded-full"></div>
        <div className="w-1 h-1 bg-gray-400 rounded-full ml-1"></div>
        <div className="w-1 h-1 bg-gray-400 rounded-full ml-1"></div>
      </div>

      <div className="p-2 flex flex-col gap-1">
        {/* Undo/Redo buttons */}
        <div className="flex flex-row gap-1">
          <button
            type="button"
            onClick={onUndo}
            disabled={!historyState.canUndo}
            className="px-3 py-1 border border-main bg-main text-main cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:not(:disabled):bg-highlight hover:not(:disabled):text-white"
          >
            <Icon icon="material-symbols:undo" width={16} height={16} />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!historyState.canRedo}
            className="px-3 py-1 border border-main bg-main text-main cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:not(:disabled):bg-highlight hover:not(:disabled):text-white"
          >
            <Icon icon="material-symbols:redo" width={16} height={16} />
          </button>
        </div>

        <div className="flex flex-row gap-2">
          {/* Color palette and picker */}
          <ColorPalette
            paletteColors={paletteColors}
            selectedPaletteIndex={selectedPaletteIndex}
            currentColor={drawingState.color}
            onSetSelectedPaletteIndex={onSetSelectedPaletteIndex}
            onUpdateColor={onUpdateColor}
            onColorPickerChange={onColorPickerChange}
          />

          {/* Tool selection */}
          <ToolSelector
            brushType={drawingState.brushType}
            onUpdateBrushType={onUpdateBrushType}
          />
        </div>

        <div className="flex flex-col gap-1">
          {/* Brush size gauge */}
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

          {/* Opacity gauge */}
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
        </div>

        {/* Layer selection */}
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
      </div>
    </div>
  );
};
