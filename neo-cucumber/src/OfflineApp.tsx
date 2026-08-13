import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { useCanvasView, useDeferredHandler } from "./hooks/useCanvasView";
import "./App.css";
import { Trans, useLingui } from "@lingui/react/macro";
import { ToolboxPanels } from "./components/ToolboxPanels";
import { NEO_BUTTON } from "./components/neo/neoClasses";
import { ALL_TOOLS } from "./constants/drawing";
import { SimplifiedToolbox } from "./components/SimplifiedToolbox";
import { useOfflineDrawing } from "./hooks/useOfflineDrawing";
import { useDrawingState } from "./hooks/useDrawingState";
import { useDrawingTimer } from "./hooks/useDrawingTimer";
import { useTwoToneShortcuts } from "./hooks/useTwoToneShortcuts";
import { usePainterShortcuts } from "./hooks/usePainterShortcuts";
import { isSandbox, sandboxBridge } from "./sandbox/bridge";
import { ShortcutHelp } from "./components/ShortcutHelp";
import type { ShortcutAction } from "./constants/shortcuts";
import { MAX_BRUSH_SIZE, MIN_BRUSH_SIZE } from "./constants/drawing";
import { useZoomControls } from "./hooks/useZoomControls";
import { useOfflineCanvas } from "./hooks/useOfflineCanvas";
import { compositeLayersToCanvas } from "./utils/canvasExport";
import { NativeBridge } from "./utils/nativeBridge";
import {
  type Backdrop,
  type BezierPreviewStyle,
  drawBezierPreview,
  drawLinePreview,
  drawRegionPreview,
} from "./neo/regionPreview";
import type { DrawingEngine } from "./DrawingEngine";
import type { RegionRect } from "./neo/regionDrag";
import { TEXT_FONT_FAMILY, fontSizeForBrush } from "./neo/tools";

// Validation constants
const MIN_DIMENSION = 100;
const MAX_WIDTH = 1000;
const MAX_HEIGHT = 800;
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 300;

function OfflineApp() {
  const { t } = useLingui();
  const isDevelopment = import.meta.env.DEV;

  // Extract and validate dimensions and context from URL parameters
  const { canvasWidth, canvasHeight, communityId, parentPostId, twoToneConfig } =
    useMemo(() => {
      const params = new URLSearchParams(window.location.search);
      const widthParam = params.get("width");
      const heightParam = params.get("height");

      // Parse and validate width
      let width = widthParam ? parseInt(widthParam, 10) : DEFAULT_WIDTH;
      if (isNaN(width) || width < MIN_DIMENSION || width > MAX_WIDTH) {
        width = DEFAULT_WIDTH;
      }

      // Parse and validate height
      let height = heightParam ? parseInt(heightParam, 10) : DEFAULT_HEIGHT;
      if (isNaN(height) || height < MIN_DIMENSION || height > MAX_HEIGHT) {
        height = DEFAULT_HEIGHT;
      }

      // Extract community_id and parent_post_id
      const communityId = params.get("community_id") || null;
      const parentPostId = params.get("parent_post_id") || null;

      // Parse two-tone mode parameters
      const twoTone = params.get("twoTone") === "true";
      const twoToneConfig = twoTone ? {
        enabled: true,
        backgroundColor: params.get("backgroundColor") || "#ffffff",
        foregroundColor: params.get("foregroundColor") || "#000000"
      } : null;

      // Debug logging
      if (twoToneConfig) {
        console.log("Two-tone config parsed:", twoToneConfig);
      }

      return {
        canvasWidth: width,
        canvasHeight: height,
        communityId,
        parentPostId,
        twoToneConfig,
      };
    }, []);

  const {
    drawingState,
    selectedPaletteIndex,
    paletteColors,
    setDrawingState,
    setSelectedPaletteIndex,
    updateBrushType,
    updateColor,
    setPaletteColor,
    initializeForTwoTone,
    selectPen,
    swapPen,
    setPenSize,
    adjustPenSize,
  } = useDrawingState();

  // Initialize two-tone palette immediately if in two-tone mode
  // Use useLayoutEffect to ensure synchronous execution before first paint
  useLayoutEffect(() => {
    if (twoToneConfig) {
      console.log("Calling initializeForTwoTone with:", {
        bg: twoToneConfig.backgroundColor,
        fg: twoToneConfig.foregroundColor
      });
      initializeForTwoTone(
        twoToneConfig.backgroundColor,
        twoToneConfig.foregroundColor
      );
    }
  }, [twoToneConfig, initializeForTwoTone]);

  const [historyState, setHistoryState] = useState({
    canUndo: false,
    canRedo: false,
  });

  // Debug: Log palette colors whenever they change
  useEffect(() => {
    console.log("Current paletteColors:", paletteColors);
  }, [paletteColors]);

  // Store community and parent post context from URL parameters
  const [drawingContext] = useState({
    communityId,
    parentPostId,
  });

  // Save state
  const [isSaving, setIsSaving] = useState(false);

  const appRef = useRef<HTMLDivElement>(null);
  /**
   * The rubber band a region tool is being dragged out over. Its own canvas
   * above the layers: it is a cursor, not part of the drawing, so it must not
   * touch the pixels or be recorded.
   */
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewEngineRef = useRef<DrawingEngine | null>(null);
  const previewBackdrop = useCallback((): Backdrop | null => {
    const engine = previewEngineRef.current;
    if (!engine) return null;
    return {
      width: canvasWidth,
      height: canvasHeight,
      scale: drawingState.zoomLevel / 100,
      layers: [
        drawingState.bgVisible ? engine.layers.background : null,
        drawingState.fgVisible ? engine.layers.foreground : null,
      ].filter((layer): layer is Uint8ClampedArray => layer !== null),
    };
  }, [canvasWidth, canvasHeight, drawingState.zoomLevel, drawingState.bgVisible, drawingState.fgVisible]);
  const handleRegionPreview = useCallback((rect: RegionRect | null) => {
    const ctx = previewCanvasRef.current?.getContext("2d");
    if (ctx) drawRegionPreview(ctx, rect, previewBackdrop(), drawingState.brushType);
  }, [previewBackdrop, drawingState.brushType]);
  /**
   * Where the text tool was clicked, if an editor is open there. NEO puts an
   * editable box straight on the canvas rather than in a dialog: you type in
   * place, Enter commits and Escape abandons. There are no font controls
   * because the pen size is the font size and the family is fixed.
   */
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null);
  const textBoxRef = useRef<HTMLDivElement>(null);
  const handleTextPlace = useCallback((x: number, y: number) => {
    setTextAt({ x, y });
  }, []);

  const handleLinePreview = useCallback(
    (
      from: { x: number; y: number } | null,
      to: { x: number; y: number } | null
    ) => {
      const ctx = previewCanvasRef.current?.getContext("2d");
      if (ctx) drawLinePreview(ctx, from, to, previewBackdrop());
    },
    [previewBackdrop]
  );
  const handleBezierPreview = useCallback(
    (points: number[] | null, step: number, style: BezierPreviewStyle) => {
      const ctx = previewCanvasRef.current?.getContext("2d");
      if (ctx) drawBezierPreview(ctx, points, previewBackdrop(), step, style);
    },
    [previewBackdrop]
  );

  /*
   * The cursor is painted by useCanvasView, which needs the engine that the
   * drawing hook below creates -- so the hook is given a forwarder now and
   * pointed at the real painter once both exist.
   */
  const [handleHoverMove, setHoverHandler] = useDeferredHandler<
    { x: number; y: number } | null
  >();

  const tempCanvasContainerRef = useRef<HTMLDivElement>(null);
  const tempLocalUserCanvasRef = useRef<HTMLCanvasElement>(null);

  // History change callback
  const handleHistoryChange = useCallback(
    (canUndo: boolean, canRedo: boolean) => {
      setHistoryState({ canUndo, canRedo });
    },
    []
  );

  // Create a ref to hold the DOM canvas update function
  const domCanvasUpdateRef = useRef<() => void>(() => {});

  // Callback to trigger canvas update when local drawing changes
  const handleLocalDrawingChange = useCallback(() => {
    domCanvasUpdateRef.current();
  }, []);

  // Use the offline drawing hook
  const {
    undo,
    redo,
    drawingEngine,
    getReplayBlob,
    getStartTime,
    getActionCount,
    addRestoreAction,
    initializeTwoToneCanvas,
    recordText,
  } = useOfflineDrawing(
    tempLocalUserCanvasRef,
    appRef,
    drawingState,
    handleHistoryChange,
    drawingState.zoomLevel,
    canvasWidth,
    canvasHeight,
    handleLocalDrawingChange,
    tempCanvasContainerRef,
    handleRegionPreview,
    handleLinePreview,
    handleTextPlace,
    handleBezierPreview,
    handleHoverMove
  );
  previewEngineRef.current = drawingEngine ?? null;

  // Focus the box as soon as it appears, so typing just works
  useEffect(() => {
    if (textAt && textBoxRef.current) {
      textBoxRef.current.textContent = "";
      textBoxRef.current.focus();
    }
  }, [textAt]);

  /** Enter commits the text, Escape abandons it -- NEO's keys. */
  const handleTextKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setTextAt(null);
        return;
      }
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();

      const value = textBoxRef.current?.textContent ?? "";
      if (!textAt || !drawingEngine || !value) {
        setTextAt(null);
        return;
      }

      const r = parseInt(drawingState.color.slice(1, 3), 16);
      const g = parseInt(drawingState.color.slice(3, 5), 16);
      const b = parseInt(drawingState.color.slice(5, 7), 16);
      const size = `${fontSizeForBrush(drawingState.brushSize)}px`;

      drawingEngine.drawText(
        drawingState.layerType,
        textAt.x,
        textAt.y,
        { r, g, b },
        drawingState.opacity / 255,
        value,
        size,
        TEXT_FONT_FAMILY
      );
      // NEO packs the colour with red in the low byte
      recordText(
        drawingState.layerType,
        textAt.x,
        textAt.y,
        r | (g << 8) | (b << 16),
        drawingState.opacity / 255,
        value,
        size,
        TEXT_FONT_FAMILY
      );
      domCanvasUpdateRef.current();
      setTextAt(null);
    },
    [textAt, drawingEngine, drawingState, recordText]
  );

  // Zoom controls
  const { currentZoom, handleZoomIn, handleZoomOut, handleZoomReset, handleZoomFit } =
    useZoomControls({
      canvasContainerRef: tempCanvasContainerRef,
      appRef,
      drawingEngine,
      setDrawingState,
    });

  // Canvas management
  const { canvasContainerRef, downloadCanvasAsPNG } = useOfflineCanvas({
    canvasWidth,
    canvasHeight,
    drawingEngine,
    currentZoom,
  });

  const { cursorCanvasRef, paintCursor } = useCanvasView({
    drawingEngine,
    drawingState,
    setDrawingState,
    canvasContainerRef,
    currentZoom,
    canvasWidth,
    canvasHeight,
  });
  setHoverHandler(paintCursor);

  // Save drawing handler
  const handleSaveDrawing = useCallback(async () => {
    if (!drawingEngine || isSaving) return;

    setIsSaving(true);
    try {
      // Get composited canvas as PNG
      const bgLayer = drawingEngine.getLayerCanvas("background");
      const fgLayer = drawingEngine.getLayerCanvas("foreground");
      const layers = [bgLayer, fgLayer].filter(
        (canvas): canvas is HTMLCanvasElement => canvas !== null
      );
      const composited = compositeLayersToCanvas(
        canvasWidth,
        canvasHeight,
        layers
      );

      if (!composited) {
        throw new Error("Failed to composite canvas layers");
      }

      const imageDataURL = composited.toDataURL("image/png");

      // Add restore action with final layer states (enables animation skip in Neo)
      addRestoreAction();

      // Get replay blob
      const replayBlob = getReplayBlob();

      // Create form data
      const formData = new FormData();
      formData.append("image", imageDataURL);
      formData.append("animation", replayBlob);
      formData.append("width", canvasWidth.toString());
      formData.append("height", canvasHeight.toString());
      // Use "cucumber" tool name for two-tone mode, otherwise "neo-cucumber-offline"
      formData.append("tool", twoToneConfig ? "cucumber" : "neo-cucumber-offline");
      formData.append("security_timer", getStartTime().toString());
      // Recorded actions minus the ones that aren't user strokes: the restore
      // frame just added, plus two-tone's initial background fill.
      const nonStrokeActions = twoToneConfig ? 2 : 1;
      const strokeCount = Math.max(0, getActionCount() - nonStrokeActions);
      formData.append("security_count", strokeCount.toString());

      if (drawingContext.communityId) {
        formData.append("community_id", drawingContext.communityId);
      }
      if (drawingContext.parentPostId) {
        formData.append("parent_post_id", drawingContext.parentPostId);
      }

      // POST to server
      const response = await fetch("/draw/finish", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (data?.error) {
        alert(data.error);
      } else {
        // Check if running in native mobile app
        if (NativeBridge.isNativeEnvironment()) {
          // Notify native app of completion
          NativeBridge.postMessage({
            type: 'drawing_complete',
            postId: data.post_id,
            communityId: data.community_id,
            imageUrl: data.image_url
          });
        } else {
          // Web environment: redirect to publish page
          window.location.href = `/posts/${data.post_id}/publish`;
        }
      }
    } catch (error) {
      alert(t`Failed to save drawing. Please try again.`);
      console.error(error);
    } finally {
      setIsSaving(false);
    }
  }, [
    drawingEngine,
    canvasWidth,
    canvasHeight,
    getReplayBlob,
    getStartTime,
    getActionCount,
    addRestoreAction,
    drawingContext,
    isSaving,
    twoToneConfig,
    t,
  ]);

  // Download replay handler for debugging
  const handleDownloadReplay = useCallback(() => {
    if (!drawingEngine) return;

    try {
      // Add restore action before downloading
      addRestoreAction();

      const replayBlob = getReplayBlob();
      const url = URL.createObjectURL(replayBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `offline-drawing-${Date.now()}.pch`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      alert(t`Failed to download replay file.`);
      console.error(error);
    }
  }, [drawingEngine, getReplayBlob, addRestoreAction, t]);

  // Keep drawingEngine ref in sync
  const drawingEngineRef = useRef(drawingEngine);
  useEffect(() => {
    drawingEngineRef.current = drawingEngine;
  }, [drawingEngine]);

  // Synchronize temp container ref with real container ref
  useEffect(() => {
    if (canvasContainerRef.current) {
      tempCanvasContainerRef.current = canvasContainerRef.current;
    }
  }, [canvasContainerRef]);

  // Ensure drawing engine DOM canvases are updated when engine becomes available
  useEffect(() => {
    if (drawingEngine) {
      // Update the DOM canvas update function
      domCanvasUpdateRef.current = () => {
        drawingEngine.updateAllDOMCanvasesImmediate();
      };

      // Force an immediate update of all DOM canvases
      setTimeout(() => {
        drawingEngine.updateAllDOMCanvasesImmediate();
      }, 0);
    }
  }, [drawingEngine]);


  // Initialize two-tone canvas fill when drawing engine is ready
  useEffect(() => {
    if (drawingEngine && twoToneConfig) {
      initializeTwoToneCanvas(twoToneConfig.backgroundColor);
    }
  }, [drawingEngine, twoToneConfig, initializeTwoToneCanvas]);

  // Drawing alarm, offered in two-tone mode
  const handleTimerExpire = useCallback(() => {
    alert(t`Time's up.`);
  }, [t]);

  const {
    durationMinutes: timerMinutes,
    remainingSeconds: timerRemainingSeconds,
    startTimer,
    stopTimer,
  } = useDrawingTimer({ onExpire: handleTimerExpire });

  const handleTimerChange = useCallback(
    (minutes: number) => {
      if (minutes === 0) {
        stopTimer();
      } else {
        startTimer(minutes);
      }
    },
    [startTimer, stopTimer]
  );

  const [showShortcuts, setShowShortcuts] = useState(false);

  // The local test page reaches the recorder through here. Production never
  // sets the flag, so this stays inert.
  useEffect(() => {
    if (!isSandbox()) return;
    sandboxBridge.getReplayBlob = getReplayBlob;
    sandboxBridge.addRestoreAction = async () => {
      await addRestoreAction();
    };
    sandboxBridge.width = canvasWidth;
    sandboxBridge.height = canvasHeight;
  }, [getReplayBlob, addRestoreAction, canvasWidth, canvasHeight]);

  /**
   * The full painter's shortcuts. Two-tone mode keeps Tegaki's pen semantics
   * instead, so the two are mutually exclusive rather than layered.
   */
  const handleShortcut = useCallback(
    (action: ShortcutAction) => {
      switch (action.kind) {
        case "tool":
          updateBrushType(action.tool);
          break;
        case "drawType":
          setDrawingState((prev) => ({ ...prev, drawType: action.drawType }));
          break;
        case "size":
          setDrawingState((prev) => ({
            ...prev,
            brushSize: Math.min(
              MAX_BRUSH_SIZE,
              Math.max(MIN_BRUSH_SIZE, prev.brushSize + action.delta)
            ),
          }));
          break;
        case "zoom":
          if (action.delta > 0) handleZoomIn();
          else handleZoomOut();
          break;
        case "toggleLayer":
          setDrawingState((prev) => ({
            ...prev,
            layerType:
              prev.layerType === "foreground" ? "background" : "foreground",
          }));
          break;
        case "undo":
          if (historyState.canUndo) undo();
          break;
        case "redo":
          if (historyState.canRedo) redo();
          break;
        case "help":
          setShowShortcuts((open) => !open);
          break;
      }
    },
    [
      updateBrushType, setDrawingState, handleZoomIn, handleZoomOut,
      historyState.canUndo, historyState.canRedo, undo, redo,
    ]
  );

  usePainterShortcuts({
    enabled: twoToneConfig === null,
    onAction: handleShortcut,
  });

  // Tegaki-style pen shortcuts, two-tone mode only
  useTwoToneShortcuts({
    enabled: twoToneConfig !== null,
    onSelectPen: selectPen,
    onSwapPen: swapPen,
    onAdjustPenSize: adjustPenSize,
  });

  // Add keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key === "z" && !e.shiftKey) {
          e.preventDefault();
          if (historyState.canUndo) {
            undo();
          }
        } else if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
          e.preventDefault();
          if (historyState.canRedo) {
            redo();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo, historyState.canUndo, historyState.canRedo]);

  return (
    <div className="w-full app-container flex flex-col">
      {/* Simple header */}
      <div className="w-full bg-main border-b border-main p-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">
              <Trans>Offline Drawing ({canvasWidth} × {canvasHeight})</Trans>
            </h1>
            {(drawingContext.communityId || drawingContext.parentPostId) && (
              <div className="text-sm text-gray-600 mt-1">
                {drawingContext.communityId && (
                  <span>
                    <Trans>Community: {drawingContext.communityId}</Trans>
                  </span>
                )}
                {drawingContext.communityId && drawingContext.parentPostId && (
                  <span className="mx-2">•</span>
                )}
                {drawingContext.parentPostId && (
                  <span>
                    <Trans>Parent Post: {drawingContext.parentPostId}</Trans>
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSaveDrawing}
              disabled={isSaving || !drawingContext.communityId}
              className="px-4 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? <Trans>Saving...</Trans> : <Trans>Save Drawing</Trans>}
            </button>
            {isDevelopment && (
              <>
                <button
                  type="button"
                  onClick={downloadCanvasAsPNG}
                  className="px-4 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white"
                >
                  <Trans>Download PNG</Trans>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadReplay}
                  className="px-4 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white"
                >
                  <Trans>Download Replay</Trans>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content Area */}
        <div className="flex-1 relative overflow-hidden">
          <div
            className="neo-ground flex gap-4 flex-row w-full h-full justify-center items-center"
            ref={appRef}
          >
            <div
              ref={canvasContainerRef}
              className={`relative mx-auto border border-main bg-white touch-none select-none canvas-container ${
                drawingState.brushType === "pan"
                  ? "cursor-grab active:cursor-grabbing"
                  : "cursor-crosshair"
              }`}
              style={{
                width: `${canvasWidth}px`,
                height: `${canvasHeight}px`,
                minWidth: `${canvasWidth}px`,
                minHeight: `${canvasHeight}px`,
                maxWidth: `${canvasWidth}px`,
                maxHeight: `${canvasHeight}px`,
                flexShrink: 0,
              }}
            >
              <div className="canvas-content absolute inset-0">
                {/* Local user interaction canvas for drawing events */}
                <canvas
                id="canvas"
                ref={tempLocalUserCanvasRef}
                width={Math.max(1, Math.round(canvasWidth * currentZoom))}
                height={Math.max(1, Math.round(canvasHeight * currentZoom))}
                className="absolute top-0 left-0 pointer-events-auto canvas-bg"
                style={{
                  width: `${canvasWidth * currentZoom}px`,
                  height: `${canvasHeight * currentZoom}px`,
                  transform: `scale(${1 / currentZoom})`,
                  transformOrigin: "top left",
                }}
                />
              {/* Layer canvases will be dynamically created here */}
              {textAt && (
                <div
                  ref={textBoxRef}
                  contentEditable
                  suppressContentEditableWarning
                  onKeyDown={handleTextKey}
                  onBlur={() => setTextAt(null)}
                  className="absolute whitespace-pre outline outline-1 outline-dashed outline-(--neo-tool-frame) outline-offset-[1px]"
                  style={{
                    left: `${textAt.x}px`,
                    // fillText draws from the baseline, so lift the box to sit
                    // where the glyphs will land
                    top: `${textAt.y - fontSizeForBrush(drawingState.brushSize)}px`,
                    fontFamily: TEXT_FONT_FAMILY,
                    fontSize: `${fontSizeForBrush(drawingState.brushSize)}px`,
                    lineHeight: `${fontSizeForBrush(drawingState.brushSize)}px`,
                    color: drawingState.color,
                    zIndex: 20,
                    minWidth: "1em",
                  }}
                />
              )}
              <canvas
                ref={cursorCanvasRef}
                width={Math.max(1, Math.round(canvasWidth * currentZoom))}
                height={Math.max(1, Math.round(canvasHeight * currentZoom))}
                className="absolute top-0 left-0 pointer-events-none"
                style={{
                  width: `${canvasWidth * currentZoom}px`,
                  height: `${canvasHeight * currentZoom}px`,
                  transform: `scale(${1 / currentZoom})`,
                  transformOrigin: "top left",
                  zIndex: 11,
                }}
              />
              <canvas
                ref={previewCanvasRef}
                width={Math.max(1, Math.round(canvasWidth * currentZoom))}
                height={Math.max(1, Math.round(canvasHeight * currentZoom))}
                className="absolute top-0 left-0 pointer-events-none"
                style={{
                  width: `${canvasWidth * currentZoom}px`,
                  height: `${canvasHeight * currentZoom}px`,
                  transform: `scale(${1 / currentZoom})`,
                  transformOrigin: "top left",
                  zIndex: 10,
                }}
              />
              </div>
            </div>
            <ShortcutHelp
              open={showShortcuts}
              onClose={() => setShowShortcuts(false)}
            />
            {twoToneConfig === null && (
              // A shortcut nobody can find is a shortcut nobody uses, so the
              // key that opens the list is also a button.
              <button
                type="button"
                onClick={() => setShowShortcuts(true)}
                title="Keyboard shortcuts (?)"
                aria-label="Keyboard shortcuts"
                className={`${NEO_BUTTON} fixed bottom-3 right-3 z-40 h-7 w-7 text-sm`}
              >
                ?
              </button>
            )}
            {twoToneConfig ? (
              <SimplifiedToolbox
                brushSize={drawingState.brushSize}
                paletteColors={paletteColors}
                selectedPaletteIndex={selectedPaletteIndex}
                canUndo={historyState.canUndo}
                canRedo={historyState.canRedo}
                isSaving={isSaving}
                timerMinutes={timerMinutes}
                timerRemainingSeconds={timerRemainingSeconds}
                onBrushSizeChange={setPenSize}
                onSelectPen={selectPen}
                onTimerChange={handleTimerChange}
                onUndo={undo}
                onRedo={redo}
                onSave={handleSaveDrawing}
              />
            ) : (
              <ToolboxPanels
                // Opens inside the painter area, below whatever the page
                // puts above it
                anchorRef={appRef}
                // An offline drawing records lineType straight into the .pch,
                // which already has codes for every one of these.
                tools={ALL_TOOLS}
                drawingState={drawingState}
                historyState={historyState}
                paletteColors={paletteColors}
                selectedPaletteIndex={selectedPaletteIndex}
                currentZoom={currentZoom}
                isOwner={false}
                isSaving={false}
                sessionEnded={false}
                onUndo={undo}
                onRedo={redo}
                onUpdateBrushType={updateBrushType}
                onUpdateDrawingState={setDrawingState}
                onUpdateColor={updateColor}
                onSetSelectedPaletteIndex={setSelectedPaletteIndex}
                onSetPaletteColor={setPaletteColor}
                onZoomIn={() => handleZoomIn()}
                onZoomOut={() => handleZoomOut()}
                onZoomReset={handleZoomReset}
                onZoomFit={handleZoomFit}
                onSaveCollaborativeDrawing={() => {}}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default OfflineApp;
