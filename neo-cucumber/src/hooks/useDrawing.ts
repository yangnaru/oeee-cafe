import { useEffect, useRef, useCallback } from "react";
import { useBaseDrawing, type DrawingState } from "./useBaseDrawing";
import {
  decodeMessage,
  encodeDrawLine,
  encodeDrawPoint,
  encodeFill,
  encodePointerUp,
  encodeUndo,
  encodeUndoPoint,
} from "../utils/binaryProtocol";
import { type CanvasHistory } from "../utils/canvasHistory";

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
  canvasHistoryRef?: React.RefObject<CanvasHistory | null>
) => {
  // WebSocket-specific state
  const outboundMessageQueue = useRef<ArrayBuffer[]>([]);
  const isCatchingUpRef = useRef(isCatchingUp);
  const connectionStateRef = useRef(connectionState);
  // True while a stroke is open and its UNDO_POINT has been sent
  const strokeOpenRef = useRef(false);

  useEffect(() => {
    isCatchingUpRef.current = isCatchingUp;
  }, [isCatchingUp]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  // Message queue management
  const queueMessage = useCallback((message: ArrayBuffer) => {
    outboundMessageQueue.current.push(message);
  }, []);

  const flushOutboundQueue = useCallback(() => {
    if (!wsRef?.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    while (outboundMessageQueue.current.length > 0) {
      const message = outboundMessageQueue.current.shift();
      if (message) {
        try {
          wsRef.current.send(message);
        } catch (error) {
          console.error("Failed to send queued message:", error);
          outboundMessageQueue.current.unshift(message);
          break;
        }
      }
    }
  }, [wsRef]);

  useEffect(() => {
    if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN) {
      flushOutboundQueue();
    }
  }, [wsRef, connectionState, flushOutboundQueue]);

  const sendOrQueueMessage = useCallback(
    (message: ArrayBuffer) => {
      if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(message);
        } catch (error) {
          console.error("Failed to send message, queueing:", error);
          queueMessage(message);
        }
      } else {
        queueMessage(message);
      }
    },
    [wsRef, queueMessage]
  );

  // Registers a locally generated message with the canonical canvas history
  // (optimistic apply + fork tracking) and sends it to the server.
  const dispatchLocalMessage = useCallback(
    (message: ArrayBuffer) => {
      const decoded = decodeMessage(message);
      if (decoded) {
        canvasHistoryRef?.current?.handleLocal(message, decoded);
      }
      sendOrQueueMessage(message);
    },
    [canvasHistoryRef, sendOrQueueMessage]
  );

  // Sends the UNDO_POINT that delimits an undoable operation, once per stroke
  const openStroke = useCallback(() => {
    if (strokeOpenRef.current || !userIdRef?.current) return;
    strokeOpenRef.current = true;
    try {
      dispatchLocalMessage(encodeUndoPoint(userIdRef.current));
    } catch (error) {
      console.error("Failed to encode/send undo point:", error);
    }
  }, [userIdRef, dispatchLocalMessage]);

  // WebSocket callbacks for drawing events
  const callbacks = {
    onDrawLine: useCallback(
      (
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

            openStroke();
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
            dispatchLocalMessage(binaryMessage);
          } catch (error) {
            console.error("Failed to encode/send drawLine event:", error);
          }
        }
      },
      [userIdRef, drawingState.layerType, dispatchLocalMessage, openStroke]
    ),

    onDrawPoint: useCallback(
      (
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

            openStroke();
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
            dispatchLocalMessage(binaryMessage);
          } catch (error) {
            console.error("Failed to encode/send drawPoint event:", error);
          }
        }
      },
      [userIdRef, drawingState.layerType, dispatchLocalMessage, openStroke]
    ),

    onFill: useCallback(
      (
        x: number,
        y: number,
        r: number,
        g: number,
        b: number,
        opacity: number
      ) => {
        if (userIdRef?.current) {
          try {
            openStroke();
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
            dispatchLocalMessage(binaryMessage);
            // A fill is a complete operation on its own
            strokeOpenRef.current = false;
          } catch (error) {
            console.error("Failed to encode/send fill event:", error);
          }
        }
      },
      [userIdRef, drawingState.layerType, dispatchLocalMessage, openStroke]
    ),

    onPointerUp: useCallback(() => {
      strokeOpenRef.current = false;
      if (userIdRef?.current && wsRef?.current?.readyState === WebSocket.OPEN) {
        try {
          const binaryMessage = encodePointerUp(
            userIdRef.current,
            0,
            0,
            0,
            "mouse"
          );
          sendOrQueueMessage(binaryMessage);
        } catch (error) {
          console.error("Failed to encode/send pointerup event:", error);
        }
      }
    }, [userIdRef, wsRef, sendOrQueueMessage]),
  };

  // Drawing disabled when catching up or disconnected
  const isDrawingDisabled = isCatchingUp || connectionState !== "connected";

  // Use base drawing hook with WebSocket callbacks; the canvas history owns
  // applying strokes and undo state (remoteSync mode)
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
    callbacks,
    true
  );

  // Collaborative undo/redo: send an UNDO message; it takes effect when the
  // server echoes it back in canonical order (Drawpile-style)
  const handleUndo = useCallback(() => {
    const history = canvasHistoryRef?.current;
    if (!history || !history.canUndo() || !userIdRef?.current) return;
    try {
      dispatchLocalMessage(encodeUndo(userIdRef.current, false));
    } catch (error) {
      console.error("Failed to encode/send undo:", error);
    }
  }, [canvasHistoryRef, userIdRef, dispatchLocalMessage]);

  const handleRedo = useCallback(() => {
    const history = canvasHistoryRef?.current;
    if (!history || !history.canRedo() || !userIdRef?.current) return;
    try {
      dispatchLocalMessage(encodeUndo(userIdRef.current, true));
    } catch (error) {
      console.error("Failed to encode/send redo:", error);
    }
  }, [canvasHistoryRef, userIdRef, dispatchLocalMessage]);

  return {
    ...baseDrawing,
    undo: handleUndo,
    redo: handleRedo,
  };
};
