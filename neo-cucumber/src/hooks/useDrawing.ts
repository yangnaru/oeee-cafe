import { useEffect, useRef, useCallback } from "react";
import { useBaseDrawing, type DrawingState } from "./useBaseDrawing";
import { layerToPngBlob } from "../utils/canvasSnapshot";
import {
  encodeSnapshot,
  encodeDrawLine,
  encodeDrawPoint,
  encodeFill,
  encodePointerUp,
} from "../utils/binaryProtocol";
import { type LocalFork } from "../utils/localFork";
import { type DrawingEngine } from "../DrawingEngine";

export const useDrawing = (
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  appRef: React.RefObject<HTMLDivElement | null>,
  drawingState: DrawingState,
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void,
  zoomLevel?: number,
  canvasWidth?: number,
  canvasHeight?: number,
  wsRef?: React.RefObject<WebSocket | null>,
  userIdRef?: React.RefObject<string>,
  onDrawingChange?: () => void,
  isCatchingUp: boolean = false,
  connectionState: "connecting" | "connected" | "disconnected" = "connected",
  containerRef?: React.RefObject<HTMLDivElement | null>,
  localForkRef?: React.RefObject<LocalFork | null>
) => {
  // WebSocket-specific state
  const outboundMessageQueue = useRef<ArrayBuffer[]>([]);
  const isCatchingUpRef = useRef(isCatchingUp);
  const connectionStateRef = useRef(connectionState);

  useEffect(() => {
    isCatchingUpRef.current = isCatchingUp;
  }, [isCatchingUp]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  // Message queue management
  const queueMessage = useCallback((message: ArrayBuffer) => {
    console.log("Queueing message, queue length before:", outboundMessageQueue.current.length);
    outboundMessageQueue.current.push(message);
    console.log("Queueing message, queue length after:", outboundMessageQueue.current.length);
  }, []);

  const flushOutboundQueue = useCallback(() => {
    console.log("flushOutboundQueue called:", {
      hasWsRef: !!wsRef?.current,
      wsReadyState: wsRef?.current?.readyState,
      queueLength: outboundMessageQueue.current.length,
    });

    if (!wsRef?.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.log("Cannot flush queue - WebSocket not ready");
      return;
    }

    console.log("Flushing", outboundMessageQueue.current.length, "queued messages");
    while (outboundMessageQueue.current.length > 0) {
      const message = outboundMessageQueue.current.shift();
      if (message) {
        try {
          wsRef.current.send(message);
          console.log("Sent queued message successfully");
        } catch (error) {
          console.error("Failed to send queued message:", error);
          outboundMessageQueue.current.unshift(message);
          break;
        }
      }
    }
    console.log("Queue flush completed, remaining messages:", outboundMessageQueue.current.length);
  }, [wsRef]);

  useEffect(() => {
    if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log("WebSocket became ready, flushing outbound queue");
      flushOutboundQueue();
    }
  }, [wsRef, connectionState, flushOutboundQueue]);

  const sendOrQueueMessage = useCallback((message: ArrayBuffer) => {
    console.log("sendOrQueueMessage called:", {
      hasWsRef: !!wsRef?.current,
      wsReadyState: wsRef?.current?.readyState,
      queueLength: outboundMessageQueue.current.length,
    });

    if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log("Sending message immediately via WebSocket");
      try {
        wsRef.current.send(message);
        console.log("Message sent successfully");
      } catch (error) {
        console.error("Failed to send message, queueing:", error);
        queueMessage(message);
      }
    } else {
      console.log("Queuing message - WebSocket not available");
      queueMessage(message);
    }
  }, [wsRef, queueMessage]);

  // Engine ref for fork savepoint capture (populated after useBaseDrawing runs)
  const forkEngineRef = useRef<DrawingEngine | null>(null);

  // Queues a sent message in the local fork so it can be matched against the
  // server's echo. Must be called BEFORE the message is applied to the local
  // layers so the savepoint captures the pre-mutation state.
  const pushToFork = useCallback(
    (message: ArrayBuffer) => {
      const fork = localForkRef?.current;
      const engine = forkEngineRef.current;
      if (!fork || !engine) return;
      fork.beginLocalChange(() => ({
        foreground: new Uint8ClampedArray(engine.layers.foreground),
        background: new Uint8ClampedArray(engine.layers.background),
      }));
      fork.push(message);
    },
    [localForkRef]
  );

  // WebSocket callbacks for drawing events
  const callbacks = {
    onDrawLine: useCallback((
      fromX: number,
      fromY: number,
      toX: number,
      toY: number,
      brushSize: number,
      brushType: "solid" | "halftone" | "eraser" | "fill" | "pan",
      r: number,
      g: number,
      b: number,
      opacity: number
    ) => {
      if (userIdRef?.current) {
        try {
          // Filter out "fill" and "pan" which are not valid for line drawing protocol
          const validBrushType: "solid" | "halftone" | "eraser" =
            brushType === "fill" || brushType === "pan" ? "solid" : brushType;

          const binaryMessage = encodeDrawLine(
            userIdRef.current,
            drawingState.layerType,
            fromX,
            fromY,
            toX,
            toY,
            brushSize,
            validBrushType,
            r,
            g,
            b,
            opacity,
            "mouse"
          );
          pushToFork(binaryMessage);
          sendOrQueueMessage(binaryMessage);
        } catch (error) {
          console.error("Failed to encode/send drawLine event:", error);
        }
      }
    }, [userIdRef, drawingState.layerType, sendOrQueueMessage, pushToFork]),

    onDrawPoint: useCallback((
      x: number,
      y: number,
      brushSize: number,
      brushType: "solid" | "halftone" | "eraser" | "fill" | "pan",
      r: number,
      g: number,
      b: number,
      opacity: number
    ) => {
      if (userIdRef?.current) {
        try {
          // Filter out "fill" and "pan" which are not valid for point drawing protocol
          const validBrushType: "solid" | "halftone" | "eraser" =
            brushType === "fill" || brushType === "pan" ? "solid" : brushType;

          const binaryMessage = encodeDrawPoint(
            userIdRef.current,
            drawingState.layerType,
            x,
            y,
            brushSize,
            validBrushType,
            r,
            g,
            b,
            opacity,
            "mouse"
          );
          pushToFork(binaryMessage);
          sendOrQueueMessage(binaryMessage);
        } catch (error) {
          console.error("Failed to encode/send drawPoint event:", error);
        }
      }
    }, [userIdRef, drawingState.layerType, sendOrQueueMessage, pushToFork]),

    onFill: useCallback((
      x: number,
      y: number,
      r: number,
      g: number,
      b: number,
      opacity: number
    ) => {
      if (userIdRef?.current) {
        try {
          const binaryMessage = encodeFill(
            userIdRef.current,
            drawingState.layerType,
            x,
            y,
            r,
            g,
            b,
            opacity
          );
          pushToFork(binaryMessage);
          sendOrQueueMessage(binaryMessage);
        } catch (error) {
          console.error("Failed to encode/send fill event:", error);
        }
      }
    }, [userIdRef, drawingState.layerType, sendOrQueueMessage, pushToFork]),

    onPointerUp: useCallback(() => {
      if (userIdRef?.current && wsRef?.current?.readyState === WebSocket.OPEN) {
        try {
          const binaryMessage = encodePointerUp(userIdRef.current, 0, 0, 0, "mouse");
          sendOrQueueMessage(binaryMessage);
        } catch (error) {
          console.error("Failed to encode/send pointerup event:", error);
        }
      }
    }, [userIdRef, wsRef, sendOrQueueMessage]),
  };

  // Drawing disabled when catching up or disconnected
  const isDrawingDisabled = isCatchingUp || connectionState !== "connected";

  // Use base drawing hook with WebSocket callbacks
  const baseDrawing = useBaseDrawing(
    canvasRef,
    appRef,
    drawingState,
    onHistoryChange,
    zoomLevel,
    canvasWidth,
    canvasHeight,
    onDrawingChange,
    containerRef,
    isDrawingDisabled,
    callbacks
  );

  // Keep the fork's engine reference in sync
  useEffect(() => {
    forkEngineRef.current = baseDrawing.drawingEngine;
  }, [baseDrawing.drawingEngine]);

  // Applies a history state to the layers and syncs it as snapshot messages.
  // Snapshots are encoded first so that the savepoint capture, layer mutation,
  // fork push, and send happen in one synchronous block with no message
  // processing interleaved between them.
  const applyHistoryState = useCallback(
    async (state: { foreground: Uint8ClampedArray; background: Uint8ClampedArray }) => {
      if (!baseDrawing.drawingEngine) return;

      const canSync =
        wsRef?.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        userIdRef?.current &&
        canvasWidth &&
        canvasHeight;

      let fgMessage: ArrayBuffer | null = null;
      let bgMessage: ArrayBuffer | null = null;
      if (canSync) {
        try {
          const fgBlob = await layerToPngBlob(state.foreground, canvasWidth, canvasHeight);
          const bgBlob = await layerToPngBlob(state.background, canvasWidth, canvasHeight);

          fgMessage = await encodeSnapshot(userIdRef.current!, "foreground", fgBlob);
          bgMessage = await encodeSnapshot(userIdRef.current!, "background", bgBlob);
        } catch (error) {
          console.error("Failed to encode undo/redo snapshots:", error);
          fgMessage = null;
          bgMessage = null;
        }
      }

      if (fgMessage && bgMessage) {
        pushToFork(fgMessage);
        pushToFork(bgMessage);
      }

      baseDrawing.drawingEngine.layers.foreground.set(state.foreground);
      baseDrawing.drawingEngine.layers.background.set(state.background);

      baseDrawing.drawingEngine.queueLayerUpdate("foreground");
      baseDrawing.drawingEngine.queueLayerUpdate("background");

      onDrawingChange?.();
      onHistoryChange?.(baseDrawing.history.canUndo(), baseDrawing.history.canRedo());

      if (fgMessage && bgMessage) {
        sendOrQueueMessage(fgMessage);
        sendOrQueueMessage(bgMessage);
      }
    },
    [baseDrawing, canvasWidth, canvasHeight, wsRef, userIdRef, onDrawingChange, onHistoryChange, sendOrQueueMessage, pushToFork]
  );

  // Enhanced undo with WebSocket sync
  const handleUndo = useCallback(async () => {
    const previousState = baseDrawing.history.undo();
    if (previousState) {
      await applyHistoryState(previousState);
    }
  }, [baseDrawing.history, applyHistoryState]);

  // Enhanced redo with WebSocket sync
  const handleRedo = useCallback(async () => {
    const nextState = baseDrawing.history.redo();
    if (nextState) {
      await applyHistoryState(nextState);
    }
  }, [baseDrawing.history, applyHistoryState]);

  // Function to add snapshot to history (for WebSocket snapshots)
  const addSnapshotToHistory = useCallback(
    (layerName: "foreground" | "background", layerData: Uint8ClampedArray) => {
      if (baseDrawing.drawingEngine?.layers.foreground && baseDrawing.drawingEngine?.layers.background) {
        console.log(`Received remote ${layerName} snapshot - updating canvas only`);
        baseDrawing.drawingEngine.layers[layerName].set(layerData);
        baseDrawing.drawingEngine.queueLayerUpdate(layerName);
      }
    },
    [baseDrawing.drawingEngine]
  );

  const markDrawingComplete = useCallback(() => {
    if (baseDrawing.isDrawingRef) {
      baseDrawing.isDrawingRef.current = false;
    }
  }, [baseDrawing.isDrawingRef]);

  return {
    ...baseDrawing,
    undo: handleUndo,
    redo: handleRedo,
    addSnapshotToHistory,
    markDrawingComplete,
  };
};
