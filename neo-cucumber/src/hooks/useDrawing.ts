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
  containerRef?: React.RefObject<HTMLDivElement | null>
) => {
  // WebSocket-specific state
  const outboundMessageQueue = useRef<ArrayBuffer[]>([]);
  const isSnapshotInProgress = useRef(false);
  const pendingSnapshotRequestRef = useRef(false);
  const sendSnapshotRef = useRef<(() => Promise<void>) | undefined>(undefined);
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
      isSnapshotInProgress: isSnapshotInProgress.current,
      hasWsRef: !!wsRef?.current,
      wsReadyState: wsRef?.current?.readyState,
      queueLength: outboundMessageQueue.current.length,
    });

    if (isSnapshotInProgress.current) {
      console.log("Queuing message - snapshot in progress");
      queueMessage(message);
    } else if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN) {
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
          sendOrQueueMessage(binaryMessage);
        } catch (error) {
          console.error("Failed to encode/send drawLine event:", error);
        }
      }
    }, [userIdRef, drawingState.layerType, sendOrQueueMessage]),

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
          sendOrQueueMessage(binaryMessage);
        } catch (error) {
          console.error("Failed to encode/send drawPoint event:", error);
        }
      }
    }, [userIdRef, drawingState.layerType, sendOrQueueMessage]),

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
          sendOrQueueMessage(binaryMessage);
        } catch (error) {
          console.error("Failed to encode/send fill event:", error);
        }
      }
    }, [userIdRef, drawingState.layerType, sendOrQueueMessage]),

    onPointerUp: useCallback(() => {
      if (userIdRef?.current && wsRef?.current?.readyState === WebSocket.OPEN) {
        try {
          const binaryMessage = encodePointerUp(userIdRef.current, 0, 0, 0, "mouse");
          sendOrQueueMessage(binaryMessage);
        } catch (error) {
          console.error("Failed to encode/send pointerup event:", error);
        }
      }

      // Check for pending snapshot request
      if (pendingSnapshotRequestRef.current && sendSnapshotRef.current) {
        sendSnapshotRef.current();
        pendingSnapshotRequestRef.current = false;
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

  // Enhanced undo with WebSocket sync
  const handleUndo = useCallback(async () => {
    const previousState = baseDrawing.history.undo();
    if (previousState && baseDrawing.drawingEngine) {
      baseDrawing.drawingEngine.layers.foreground.set(previousState.foreground);
      baseDrawing.drawingEngine.layers.background.set(previousState.background);

      baseDrawing.drawingEngine.queueLayerUpdate("foreground");
      baseDrawing.drawingEngine.queueLayerUpdate("background");

      onDrawingChange?.();
      onHistoryChange?.(baseDrawing.history.canUndo(), baseDrawing.history.canRedo());

      // Send snapshots over WebSocket
      if (
        wsRef?.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        userIdRef?.current &&
        canvasWidth &&
        canvasHeight
      ) {
        try {
          const fgBlob = await layerToPngBlob(previousState.foreground, canvasWidth, canvasHeight);
          const bgBlob = await layerToPngBlob(previousState.background, canvasWidth, canvasHeight);

          const fgMessage = await encodeSnapshot(userIdRef.current, "foreground", fgBlob);
          const bgMessage = await encodeSnapshot(userIdRef.current, "background", bgBlob);

          sendOrQueueMessage(fgMessage);
          sendOrQueueMessage(bgMessage);
        } catch (error) {
          console.error("Failed to send undo snapshots:", error);
        }
      }
    }
  }, [baseDrawing, canvasWidth, canvasHeight, wsRef, userIdRef, onDrawingChange, onHistoryChange, sendOrQueueMessage]);

  // Enhanced redo with WebSocket sync
  const handleRedo = useCallback(async () => {
    const nextState = baseDrawing.history.redo();
    if (nextState && baseDrawing.drawingEngine) {
      baseDrawing.drawingEngine.layers.foreground.set(nextState.foreground);
      baseDrawing.drawingEngine.layers.background.set(nextState.background);

      baseDrawing.drawingEngine.queueLayerUpdate("foreground");
      baseDrawing.drawingEngine.queueLayerUpdate("background");

      onDrawingChange?.();
      onHistoryChange?.(baseDrawing.history.canUndo(), baseDrawing.history.canRedo());

      // Send snapshots over WebSocket
      if (
        wsRef?.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        userIdRef?.current &&
        canvasWidth &&
        canvasHeight
      ) {
        try {
          const fgBlob = await layerToPngBlob(nextState.foreground, canvasWidth, canvasHeight);
          const bgBlob = await layerToPngBlob(nextState.background, canvasWidth, canvasHeight);

          const fgMessage = await encodeSnapshot(userIdRef.current, "foreground", fgBlob);
          const bgMessage = await encodeSnapshot(userIdRef.current, "background", bgBlob);

          sendOrQueueMessage(fgMessage);
          sendOrQueueMessage(bgMessage);
        } catch (error) {
          console.error("Failed to send redo snapshots:", error);
        }
      }
    }
  }, [baseDrawing, canvasWidth, canvasHeight, wsRef, userIdRef, onDrawingChange, onHistoryChange, sendOrQueueMessage]);

  // Send snapshot functionality
  const sendSnapshot = useCallback(async () => {
    const engine = baseDrawing.drawingEngine;
    const ws = wsRef?.current;
    const userId = userIdRef?.current;

    if (!engine || !ws || ws.readyState !== WebSocket.OPEN || !userId || !canvasWidth || !canvasHeight) {
      return;
    }

    try {
      isSnapshotInProgress.current = true;

      const fgPngBlob = await layerToPngBlob(engine.layers.foreground, canvasWidth, canvasHeight);
      const fgSnapshot = await encodeSnapshot(userId, "foreground", fgPngBlob);
      ws.send(fgSnapshot);

      const bgPngBlob = await layerToPngBlob(engine.layers.background, canvasWidth, canvasHeight);
      const bgSnapshot = await encodeSnapshot(userId, "background", bgPngBlob);
      ws.send(bgSnapshot);

      console.log("Sent both snapshots, now flushing queued messages");
    } catch (error) {
      console.error("Failed to send snapshots:", error);
    } finally {
      isSnapshotInProgress.current = false;
      flushOutboundQueue();
    }
  }, [baseDrawing.drawingEngine, canvasWidth, canvasHeight, wsRef, userIdRef, flushOutboundQueue]);

  useEffect(() => {
    sendSnapshotRef.current = sendSnapshot;
  }, [sendSnapshot]);

  const handleSnapshotRequest = useCallback(() => {
    if (baseDrawing.isDrawingRef.current) {
      pendingSnapshotRequestRef.current = true;
    } else {
      sendSnapshot();
    }
  }, [baseDrawing.isDrawingRef, sendSnapshot]);

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
    handleSnapshotRequest,
  };
};
