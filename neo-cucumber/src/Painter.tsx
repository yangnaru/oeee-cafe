import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCanvasView, useDeferredHandler } from "./hooks/useCanvasView";
import "./App.css";
import { useLingui } from "@lingui/react/macro";
import { ToolboxPanels } from "./components/ToolboxPanels";
import { NEO_BUTTON } from "./components/neo/neoClasses";
import { ALL_TOOLS } from "./constants/drawing";
import { SimplifiedToolbox } from "./components/SimplifiedToolbox";
import { useOfflineDrawing } from "./hooks/useOfflineDrawing";
import { useDrawingState } from "./hooks/useDrawingState";
import { useDrawingTimer } from "./hooks/useDrawingTimer";
import { useTwoToneShortcuts } from "./hooks/useTwoToneShortcuts";
import { usePainterShortcuts } from "./hooks/usePainterShortcuts";
import { ShortcutHelp } from "./components/ShortcutHelp";
import type { ShortcutAction } from "./constants/shortcuts";
import { MAX_BRUSH_SIZE, MIN_BRUSH_SIZE } from "./constants/drawing";
import { useZoomControls } from "./hooks/useZoomControls";
import { useOfflineCanvas } from "./hooks/useOfflineCanvas";
import { compositeLayersToCanvas } from "./utils/canvasExport";
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
import { previewBackdrop as backdropFromCanvasStack } from "./neo/previewBackdrop";
import { PainterWorkspace } from "./components/PainterWorkspace";
import type {
  CanonicalPainterOperation,
  ImageSource,
  PainterCheckpoint,
  PainterExport,
  PainterHandle,
  PainterOptions,
  PainterSessionArchive,
} from "./public";
import { CanvasHistory } from "./utils/canvasHistory";
import { layerToPngBlob, pngDataToLayer } from "./utils/canvasSnapshot";

interface PainterProps {
  config: PainterOptions;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to encode canvas as PNG"));
    }, "image/png");
  });
}

const Painter = forwardRef<PainterHandle, PainterProps>(function Painter(
  { config },
  ref,
) {
  const { t } = useLingui();

  // The reusable painter receives its complete configuration from its host.
  const {
    canvasWidth,
    canvasHeight,
    controls,
    twoToneConfig,
  } =
    useMemo(() => {
      const resolved = config;
      const width = resolved.width;
      const height = resolved.height;
      const twoToneConfig =
        resolved.mode.kind === "two-tone"
          ? {
              enabled: true,
              backgroundColor: resolved.mode.backgroundColor,
              foregroundColor: resolved.mode.foregroundColor,
            }
          : null;

      return {
        canvasWidth: width,
        canvasHeight: height,
        controls: resolved.controls,
        twoToneConfig,
      };
    }, [config]);

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
  const [interactionEnabled, setInteractionEnabled] = useState(true);
  const operationCounterRef = useRef(0);
  const synchronizationHistoryRef = useRef<CanvasHistory | null>(null);
  const appliedCheckpointRef = useRef<PainterCheckpoint | undefined>(undefined);
  const synchronization = config.synchronization;
  const emitLocalOperation = useCallback(
    (operation: import("./operations").PainterOperation) => {
      if (!synchronization) return;
      operationCounterRef.current += 1;
      const entry = {
        id: `${synchronization.actorId}:${operationCounterRef.current}`,
        actorId: synchronization.actorId,
        operation,
        timestamp: Date.now(),
      };
      synchronizationHistoryRef.current?.registerOptimisticOperation(entry);
      synchronization.onOperation(entry);
    },
    [synchronization],
  );

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
    return backdropFromCanvasStack(
      engine,
      canvasWidth,
      canvasHeight,
      drawingState.zoomLevel / 100,
      drawingState.bgVisible,
      drawingState.fgVisible
    );
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
  const handleSynchronizedHover = useCallback(
    (at: { x: number; y: number } | null) => {
      handleHoverMove(at);
      synchronization?.onPointerMove?.(at);
    },
    [handleHoverMove, synchronization],
  );

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
    getActionCount,
    getInitializationActionCount,
    addRestoreAction,
    initializeFromImage,
    initializeTwoToneCanvas,
    recordText,
    emitOperation,
    isDrawingRef,
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
    handleSynchronizedHover,
    !interactionEnabled,
    emitLocalOperation,
    synchronization?.onPointerUp,
  );
  previewEngineRef.current = drawingEngine ?? null;

  useEffect(() => {
    if (!drawingEngine || !synchronization) {
      synchronizationHistoryRef.current = null;
      return;
    }
    const history = new CanvasHistory(drawingEngine, handleHistoryChange);
    history.setLocalUserId(synchronization.actorId);
    synchronizationHistoryRef.current = history;
    return () => {
      if (synchronizationHistoryRef.current === history) {
        synchronizationHistoryRef.current = null;
      }
    };
  }, [drawingEngine, synchronization, handleHistoryChange]);

  const readinessRef = useRef<{
    promise: Promise<void>;
    resolve: () => void;
  } | null>(null);
  if (!readinessRef.current) {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    readinessRef.current = { promise, resolve };
  }
  useEffect(() => {
    if (drawingEngine) readinessRef.current?.resolve();
  }, [drawingEngine]);

  const actionCount = getActionCount();
  const onChange = config?.onChange;
  useEffect(() => {
    onChange?.({
      canUndo: historyState.canUndo,
      canRedo: historyState.canRedo,
      strokeCount: actionCount,
      dirty: actionCount > 0,
    });
  }, [onChange, historyState.canUndo, historyState.canRedo, actionCount]);

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
      emitOperation({
        kind: "text",
        layer: drawingState.layerType,
        at: textAt,
        text: value,
        color: { r, g, b, a: drawingState.opacity },
        brushSize: drawingState.brushSize,
        mask: {
          type: drawingState.maskType ?? 0,
          r: parseInt((drawingState.maskColor ?? "#000000").slice(1, 3), 16),
          g: parseInt((drawingState.maskColor ?? "#000000").slice(3, 5), 16),
          b: parseInt((drawingState.maskColor ?? "#000000").slice(5, 7), 16),
        },
      });
      domCanvasUpdateRef.current();
      setTextAt(null);
    },
    [textAt, drawingEngine, drawingState, recordText, emitOperation]
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
  const { canvasContainerRef } = useOfflineCanvas({
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

  const exportPng = useCallback(async (): Promise<Blob> => {
    if (!drawingEngine) throw new Error("Painter is not ready");
    const layers = [
      drawingEngine.getLayerCanvas("background"),
      drawingEngine.getLayerCanvas("foreground"),
    ].filter((canvas): canvas is HTMLCanvasElement => canvas !== null);
    const composited = compositeLayersToCanvas(canvasWidth, canvasHeight, layers);
    if (!composited) throw new Error("Failed to composite canvas layers");
    return canvasToPng(composited);
  }, [drawingEngine, canvasWidth, canvasHeight]);

  const exportReplay = useCallback(async (): Promise<Blob> => {
    if (!drawingEngine) throw new Error("Painter is not ready");
    addRestoreAction();
    return getReplayBlob();
  }, [drawingEngine, addRestoreAction, getReplayBlob]);

  const save = useCallback(async (): Promise<PainterExport> => {
    // Start both captures in the same JavaScript turn. exportPng snapshots the
    // composited pixels and exportReplay snapshots the action list before
    // either promise yields back to pointer input.
    const pngPromise = exportPng();
    const replayPromise = exportReplay();
    const [png, replay] = await Promise.all([pngPromise, replayPromise]);
    const nonStrokeActions = 1 + getInitializationActionCount();
    return {
      png,
      replay,
      width: canvasWidth,
      height: canvasHeight,
      strokeCount: Math.max(0, getActionCount() - nonStrokeActions),
    };
  }, [
    exportPng,
    exportReplay,
    canvasWidth,
    canvasHeight,
    getActionCount,
    getInitializationActionCount,
  ]);

  const loadImage = useCallback(
    async (source: ImageSource): Promise<void> => {
      let objectUrl: string | null = null;
      try {
        const url =
          source instanceof Blob
            ? (objectUrl = URL.createObjectURL(source))
            : source instanceof URL
              ? source.href
              : source;
        await initializeFromImage(url);
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    },
    [initializeFromImage],
  );

  const applyCanonicalOperation = useCallback(
    async (operation: CanonicalPainterOperation): Promise<void> => {
      const history = synchronizationHistoryRef.current;
      if (!history) throw new Error("Painter is not in controlled mode");
      await history.handleCanonicalOperation(operation);
      domCanvasUpdateRef.current();
    },
    [],
  );

  const exportCheckpoint = useCallback(
    async (sequence: number): Promise<PainterCheckpoint> => {
      if (!drawingEngine) throw new Error("Painter is not ready");
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error("Checkpoint sequence must be a non-negative safe integer");
      }
      const [background, foreground] = await Promise.all([
        layerToPngBlob(drawingEngine.layers.background, canvasWidth, canvasHeight),
        layerToPngBlob(drawingEngine.layers.foreground, canvasWidth, canvasHeight),
      ]);
      return { sequence, width: canvasWidth, height: canvasHeight, background, foreground };
    },
    [drawingEngine, canvasWidth, canvasHeight],
  );

  const applyCheckpoint = useCallback(
    async (checkpoint: PainterCheckpoint): Promise<void> => {
      if (!drawingEngine) throw new Error("Painter is not ready");
      if (checkpoint.width !== canvasWidth || checkpoint.height !== canvasHeight) {
        throw new Error(
          `Checkpoint is ${checkpoint.width}x${checkpoint.height}; painter is ${canvasWidth}x${canvasHeight}`,
        );
      }
      const [background, foreground] = await Promise.all([
        pngDataToLayer(new Uint8Array(await checkpoint.background.arrayBuffer()), canvasWidth, canvasHeight),
        pngDataToLayer(new Uint8Array(await checkpoint.foreground.arrayBuffer()), canvasWidth, canvasHeight),
      ]);
      drawingEngine.layers.background.set(background);
      drawingEngine.layers.foreground.set(foreground);
      synchronizationHistoryRef.current?.reset();
      appliedCheckpointRef.current = checkpoint;
      domCanvasUpdateRef.current();
    },
    [drawingEngine, canvasWidth, canvasHeight],
  );

  const exportSessionArchive = useCallback(async (): Promise<PainterSessionArchive> => {
    if (!drawingEngine) throw new Error("Painter is not ready");
    const history = synchronizationHistoryRef.current;
    if (!history) throw new Error("Painter is not in controlled mode");
    return {
      format: "neo-cucumber-session",
      version: 1,
      canvas: { width: canvasWidth, height: canvasHeight, mode: config.mode },
      checkpoint: appliedCheckpointRef.current,
      operations: history.getCanonicalOperations(),
    };
  }, [drawingEngine, canvasWidth, canvasHeight, config.mode]);

  const compactCanonicalHistory = useCallback(async (sequence: number): Promise<void> => {
    const history = synchronizationHistoryRef.current;
    if (!history) throw new Error("Painter is not in controlled mode");
    const base = await history.handleResetPoint(sequence);
    if (!base) return;
    const [background, foreground] = await Promise.all([
      layerToPngBlob(base.background, canvasWidth, canvasHeight),
      layerToPngBlob(base.foreground, canvasWidth, canvasHeight),
    ]);
    appliedCheckpointRef.current = {
      sequence,
      width: canvasWidth,
      height: canvasHeight,
      background,
      foreground,
    };
  }, [canvasWidth, canvasHeight]);

  const isSynchronizationSettled = useCallback((): boolean =>
    !isDrawingRef.current && !(synchronizationHistoryRef.current?.hasPendingLocal ?? false),
  [isDrawingRef]);

  useImperativeHandle(
    ref,
    () => ({
      ready: readinessRef.current!.promise,
      save,
      exportPng,
      exportReplay,
      loadImage,
      undo,
      redo,
      setInteractionEnabled,
      applyCanonicalOperation,
      exportCheckpoint,
      applyCheckpoint,
      exportSessionArchive,
      compactCanonicalHistory,
      isSynchronizationSettled,
      // The owning mount adapter replaces this with its React-root teardown.
      unmount: () => {},
    }),
    [save, exportPng, exportReplay, loadImage, undo, redo, applyCanonicalOperation, exportCheckpoint, applyCheckpoint, exportSessionArchive, compactCanonicalHistory, isSynchronizationSettled],
  );

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


  // Two-tone canvases open on their fixed background. Continuation images are
  // loaded explicitly by the host through PainterHandle.loadImage().
  useEffect(() => {
    if (drawingEngine && twoToneConfig) {
      initializeTwoToneCanvas(twoToneConfig.backgroundColor);
    }
  }, [
    drawingEngine,
    twoToneConfig,
    initializeTwoToneCanvas,
  ]);

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
      <div className="flex-1 flex overflow-hidden">
        <PainterWorkspace
          workspaceRef={appRef}
          canvas={{
            width: canvasWidth,
            height: canvasHeight,
            zoom: currentZoom,
            brushType: drawingState.brushType,
            brushSize: drawingState.brushSize,
            color: drawingState.color,
            containerRef: canvasContainerRef,
            interactionRef: tempLocalUserCanvasRef,
            cursorRef: cursorCanvasRef,
            previewRef: previewCanvasRef,
            textBoxRef,
            textAt,
            onTextKeyDown: handleTextKey,
            onDismissText: () => setTextAt(null),
          }}
        >
            {controls.kind === "toolbox" && <ShortcutHelp
              open={showShortcuts}
              onClose={() => setShowShortcuts(false)}
            />}
            {controls.kind === "toolbox" && twoToneConfig === null && (
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
            {controls.kind === "none" ? null : twoToneConfig ? (
              <SimplifiedToolbox
                brushSize={drawingState.brushSize}
                paletteColors={paletteColors}
                selectedPaletteIndex={selectedPaletteIndex}
                canUndo={historyState.canUndo}
                canRedo={historyState.canRedo}
                timerMinutes={timerMinutes}
                timerRemainingSeconds={timerRemainingSeconds}
                onBrushSizeChange={setPenSize}
                onSelectPen={selectPen}
                onTimerChange={handleTimerChange}
                onUndo={undo}
                onRedo={redo}
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
        </PainterWorkspace>
      </div>
    </div>
  );
});

export default Painter;
