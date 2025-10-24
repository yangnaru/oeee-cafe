import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import "./App.css";
import { Trans, useLingui } from "@lingui/react/macro";
import { ToolboxPanel } from "./components/ToolboxPanel";
import { useOfflineDrawing } from "./hooks/useOfflineDrawing";
import { useDrawingState } from "./hooks/useDrawingState";
import { useZoomControls } from "./hooks/useZoomControls";
import { useOfflineCanvas } from "./hooks/useOfflineCanvas";
import { compositeLayersToCanvas } from "./utils/canvasExport";

// Validation constants
const MIN_DIMENSION = 100;
const MAX_WIDTH = 1000;
const MAX_HEIGHT = 800;
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 300;

function OfflineApp() {
  const { t } = useLingui();

  // Extract and validate dimensions and context from URL parameters
  const { canvasWidth, canvasHeight, communityId, parentPostId } =
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

      return {
        canvasWidth: width,
        canvasHeight: height,
        communityId,
        parentPostId,
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
    handleColorPickerChange,
  } = useDrawingState();

  const [historyState, setHistoryState] = useState({
    canUndo: false,
    canRedo: false,
  });

  // Store community and parent post context from URL parameters
  const [drawingContext] = useState({
    communityId,
    parentPostId,
  });

  // Save state
  const [isSaving, setIsSaving] = useState(false);

  const appRef = useRef<HTMLDivElement>(null);
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
    getStrokeCount,
    addRestoreAction,
  } = useOfflineDrawing(
    tempLocalUserCanvasRef,
    appRef,
    drawingState,
    handleHistoryChange,
    drawingState.zoomLevel,
    canvasWidth,
    canvasHeight,
    handleLocalDrawingChange,
    tempCanvasContainerRef
  );

  // Zoom controls
  const { currentZoom, handleZoomIn, handleZoomOut, handleZoomReset } =
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
      formData.append("tool", "neo-cucumber-offline");
      formData.append("security_timer", getStartTime().toString());
      formData.append("security_count", getStrokeCount().toString());

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
        window.location.href = `/posts/${data.post_id}/publish`;
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
    getStrokeCount,
    addRestoreAction,
    drawingContext,
    isSaving,
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

  // Apply pending pan adjustments after zoom level changes
  useEffect(() => {
    if (
      drawingState.pendingPanDeltaX !== undefined ||
      drawingState.pendingPanDeltaY !== undefined
    ) {
      requestAnimationFrame(() => {
        if (drawingEngine) {
          drawingEngine.adjustPanForZoom(
            drawingState.pendingPanDeltaX || 0,
            drawingState.pendingPanDeltaY || 0,
            canvasContainerRef.current || undefined,
            currentZoom
          );
        }

        setDrawingState((prev) => ({
          ...prev,
          pendingPanDeltaX: undefined,
          pendingPanDeltaY: undefined,
        }));
      });
    }
  }, [
    drawingState.pendingPanDeltaX,
    drawingState.pendingPanDeltaY,
    drawingState.zoomLevel,
    drawingEngine,
    currentZoom,
    setDrawingState,
    canvasContainerRef,
  ]);

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
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content Area */}
        <div className="flex-1 relative overflow-hidden">
          <div
            className="flex gap-4 flex-row w-full h-full bg-main justify-center items-center"
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
              {/* Local user interaction canvas for drawing events */}
              <canvas
                id="canvas"
                ref={tempLocalUserCanvasRef}
                width={canvasWidth}
                height={canvasHeight}
                className="absolute top-0 left-0 pointer-events-auto canvas-bg"
                style={{
                  width: `${canvasWidth}px`,
                  height: `${canvasHeight}px`,
                }}
              />
              {/* Layer canvases will be dynamically created here */}
            </div>
            <ToolboxPanel
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
              onColorPickerChange={handleColorPickerChange}
              onSetSelectedPaletteIndex={setSelectedPaletteIndex}
              onZoomIn={() => handleZoomIn()}
              onZoomOut={() => handleZoomOut()}
              onZoomReset={handleZoomReset}
              onSaveCollaborativeDrawing={() => {}}
              initialPosition={{ x: 16, y: 70 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default OfflineApp;
