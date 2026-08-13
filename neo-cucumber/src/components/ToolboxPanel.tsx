import React from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Icon } from "@iconify/react";
import { NeoToolColumn } from "./neo/NeoToolColumn";
import {
  NEO_BUTTON_ON,
  NEO_COLOR_INPUT,
  NEO_ICON_BUTTON,
} from "./neo/neoClasses";
import { NeoWindow } from "./neo/NeoWindow";
import { useTheme } from "../hooks/useTheme";

import { NON_NEO_TOOLS } from "../constants/drawing";
import { NEO_TOOL_LABELS } from "../neo/toolboxSpec";
import type { ToolId } from "../neo/tools";

/**
 * Icons for the three tools NEO has no artwork for, since they have no button
 * in its toolbox to carry one.
 */
const NON_NEO_TOOL_ICONS: Record<string, string> = {
  fill: "material-symbols:format-color-fill",
  paste: "material-symbols:content-paste",
  pan: "material-symbols:pan-tool",
};
import type { DrawingState } from "../types/collaboration";

interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

export interface ToolboxPanelProps {
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
  const { theme, toggle: toggleTheme } = useTheme();

  const showNeo = section !== "extras";
  const showExtras = section !== "neo";

  return (
    <NeoWindow
      initialPosition={initialPosition ?? { x: 304, y: 70 }}
      className="w-max"
      constrainToViewport
      minimumY={70}
    >
      <div className="flex flex-col gap-[2px] p-[2px]">
        {showNeo && (
          <NeoToolColumn
            drawingState={drawingState}
            paletteColors={paletteColors}
            selectedPaletteIndex={selectedPaletteIndex}
            tools={tools}
            onUpdateDrawingState={onUpdateDrawingState}
            onUpdateBrushType={onUpdateBrushType}
            onUpdateColor={onUpdateColor}
            onSetSelectedPaletteIndex={onSetSelectedPaletteIndex}
            onSetPaletteColor={onSetPaletteColor}
          />
        )}

        {showExtras && (
          <div className="flex w-[50px] flex-col gap-[2px]">
            {/*
              Everything NEO keeps outside its toolbox, in the same width the
              NEO column paints in so the two panels line up. Every row is the
              same two-column grid so the buttons line up too: a flex row will
              not shrink a button below its icon, and two of those overflowed
              the column and widened the whole panel.
            */}

            {/*
              Tools NEO's column has no button for: fill is a button above
              NEO's canvas, paste is what finishing a copy switches to, and
              pan is ours outright. They are still tools -- selecting one
              deselects whatever the NEO column held.
            */}
            <div className="grid grid-cols-2 gap-[2px]">
              {NON_NEO_TOOLS.filter((tool) => tools.includes(tool)).map(
                (tool) => (
                  <button
                    key={tool}
                    type="button"
                    onClick={() => onUpdateBrushType(tool)}
                    aria-pressed={drawingState.brushType === tool}
                    title={NEO_TOOL_LABELS[tool] ?? tool}
                    className={`${NEO_ICON_BUTTON} ${
                      drawingState.brushType === tool ? NEO_BUTTON_ON : ""
                    } flex items-center justify-center`}
                  >
                    <Icon
                      icon={NON_NEO_TOOL_ICONS[tool]}
                      width={14}
                      height={14}
                    />
                  </button>
                )
              )}
            </div>

            {/*
              A colour picker, which NEO does not have -- its swatches and
              RGBA sliders are how it mixes a colour. This sets the drawing
              colour only; right-clicking a swatch is still what stores it.
            */}
            <input
              type="color"
              value={drawingState.color}
              onChange={(e) => onUpdateColor(e.target.value)}
              title={t`Pick a colour`}
              aria-label={t`Pick a colour`}
              className={NEO_COLOR_INPUT}
            />

            {/* Undo and redo. NEO puts these in the bar above the canvas. */}
            <div className="grid grid-cols-2 gap-[2px]">
              <button
                type="button"
                onClick={onUndo}
                disabled={!historyState.canUndo}
                title={t`Undo`}
                className={`${NEO_ICON_BUTTON} flex items-center justify-center`}
              >
                <Icon icon="material-symbols:undo" width={14} height={14} />
              </button>
              <button
                type="button"
                onClick={onRedo}
                disabled={!historyState.canRedo}
                title={t`Redo`}
                className={`${NEO_ICON_BUTTON} flex items-center justify-center`}
              >
                <Icon icon="material-symbols:redo" width={14} height={14} />
              </button>
            </div>

            {/* Zoom. NEO overlays + and - on the canvas corners instead. */}
            <div className="grid grid-cols-2 gap-[2px]">
              <button
                type="button"
                onClick={onZoomOut}
                title={t`Zoom out`}
                className={`${NEO_ICON_BUTTON} flex items-center justify-center`}
              >
                <Icon icon="material-symbols:zoom-out" width={14} height={14} />
              </button>
              <button
                type="button"
                onClick={onZoomIn}
                title={t`Zoom in`}
                className={`${NEO_ICON_BUTTON} flex items-center justify-center`}
              >
                <Icon icon="material-symbols:zoom-in" width={14} height={14} />
              </button>
            </div>
            <button
              type="button"
              onClick={onZoomReset}
              title={t`Reset zoom`}
              className={`${NEO_ICON_BUTTON} w-full text-center text-[11px] tabular-nums`}
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
              className={`${NEO_ICON_BUTTON} ${
                drawingState.isFlippedHorizontal ? NEO_BUTTON_ON : ""
              } flex w-full items-center justify-center`}
            >
              <Icon icon="material-symbols:flip" width={14} height={14} />
            </button>

            {/*
              Light and dark. The palette follows the OS on its own, so this
              is for wanting the painter dark on a light desktop or the other
              way round -- and it is in this panel because NEO has no such
              thing to reproduce.
            */}
            <button
              type="button"
              onClick={toggleTheme}
              title={theme === "dark" ? t`Switch to light` : t`Switch to dark`}
              className={`${NEO_ICON_BUTTON} flex w-full items-center justify-center gap-[3px]`}
            >
              <Icon
                icon={
                  theme === "dark"
                    ? "material-symbols:light-mode"
                    : "material-symbols:dark-mode"
                }
                width={12}
                height={12}
              />
              {/* Labelled, not just an icon: as the ninth glyph in a stack of
                  identical buttons it was effectively invisible. */}
              <span className="text-[10px] leading-none">
                {theme === "dark" ? <Trans>Light</Trans> : <Trans>Dark</Trans>}
              </span>
            </button>

            {isOwner && (
              <button
                type="button"
                onClick={onSaveCollaborativeDrawing}
                disabled={isSaving || sessionEnded}
                title={t`Save drawing to gallery`}
                className={`${NEO_ICON_BUTTON} flex w-full items-center justify-center`}
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
    </NeoWindow>
  );
};
