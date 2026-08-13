import { useEffect, useRef, useCallback } from "react";
import { useBaseDrawing, type DrawingState } from "./useBaseDrawing";
import {
  decodeMessage,
  encodeFill,
  encodeRegion,
  encodeLine,
  encodeBezier,
  encodeEraseAll,
  encodeText,
  encodePointerUp,
  encodeUndo,
  encodeUndoPoint,
} from "../utils/binaryProtocol";
import type { RegionTool } from "../neo/tools";
import { maskFrom, NO_MASK, type Mask } from "../neo/mask";
import type { RegionRect } from "../neo/regionDrag";
import { type CanvasHistory } from "../utils/canvasHistory";
import {
  isWireBrushType,
  type BrushType,
  type WireBrushType,
} from "../types/collaboration";

// Stroke segments accumulate into one STROKE message and flush on this
// cadence (or on pointer-up / when the batch grows large); this trades a
// little remote-view latency for a large reduction in message count
const STROKE_FLUSH_MS = 60;
const STROKE_FLUSH_MAX_POINTS = 64;

export const useDrawing = (
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  appRef: React.RefObject<HTMLDivElement | null>,
  drawingState: DrawingState,
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void,
  zoomLevel?: number,
  canvasWidth?: number,
  canvasHeight?: number,
  wsRef?: React.RefObject<WebSocket | null>,
  localIdRef?: React.RefObject<number | null>,
  onDrawingChange?: () => void,
  isCatchingUp: boolean = false,
  connectionState: "connecting" | "connected" | "disconnected" = "connected",
  containerRef?: React.RefObject<HTMLDivElement | null>,
  canvasHistoryRef?: React.RefObject<CanvasHistory | null>,
  /** Called with the rubber-band rectangle while a region tool is dragged. */
  onRegionPreview?: (rect: RegionRect | null) => void,
  /** Called with the endpoints while a straight line is dragged out. */
  onLinePreview?: (
    from: { x: number; y: number } | null,
    to: { x: number; y: number } | null
  ) => void,
  /** Called with the curve so far while a bezier is being built. */
  onBezierPreview?: (points: number[] | null) => void,
  /** Called when the text tool is clicked, to open an editor there. */
  onTextPlace?: (x: number, y: number) => void,
  /** Called as the pointer moves over the canvas, or leaves it. */
  onHoverMove?: (at: { x: number; y: number } | null) => void
) => {
  // WebSocket-specific state
  const outboundMessageQueue = useRef<ArrayBuffer[]>([]);
  const isCatchingUpRef = useRef(isCatchingUp);
  const connectionStateRef = useRef(connectionState);
  // True while a stroke is open and its UNDO_POINT has been sent
  const strokeOpenRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);

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

  // Flushes the open stroke batch into a STROKE message and sends it
  const flushStroke = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const bytes = canvasHistoryRef?.current?.flushLocalStroke();
    if (bytes) {
      sendOrQueueMessage(bytes);
    }
  }, [canvasHistoryRef, sendOrQueueMessage]);

  const scheduleFlush = useCallback(
    (pendingPoints: number) => {
      if (pendingPoints >= STROKE_FLUSH_MAX_POINTS) {
        flushStroke();
        return;
      }
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          flushStroke();
        }, STROKE_FLUSH_MS);
      }
    },
    [flushStroke]
  );

  // Registers a locally generated (non-stroke) message with the canvas
  // history and sends it. Any open stroke batch is flushed first so the wire
  // order matches the fork order.
  const dispatchLocalMessage = useCallback(
    (message: ArrayBuffer) => {
      flushStroke();
      const decoded = decodeMessage(message);
      if (decoded) {
        canvasHistoryRef?.current?.handleLocal(message, decoded);
      }
      sendOrQueueMessage(message);
    },
    [canvasHistoryRef, sendOrQueueMessage, flushStroke]
  );

  /**
   * The mask the current operation opened with.
   *
   * An operation is drawn and sent with the settings it started with, the way
   * useBaseDrawing freezes the rest of them, so changing the mask tip mid-drag
   * applies to the next operation rather than retroactively to this one.
   */
  const liveMaskRef = useRef<Mask>(NO_MASK);
  liveMaskRef.current = maskFrom(drawingState);
  const strokeMaskRef = useRef<Mask>(NO_MASK);

  // Sends the UNDO_POINT that delimits an undoable operation, once per stroke
  const openStroke = useCallback(() => {
    if (strokeOpenRef.current || localIdRef?.current == null) return;
    strokeOpenRef.current = true;
    strokeMaskRef.current = liveMaskRef.current;
    try {
      dispatchLocalMessage(encodeUndoPoint(localIdRef.current));
    } catch (error) {
      console.error("Failed to encode/send undo point:", error);
    }
  }, [localIdRef, dispatchLocalMessage]);

  // Appends one stroke segment to the open batch (optimistically painted by
  // the canvas history) and schedules a flush
  const addSegment = useCallback(
    (
      x: number,
      y: number,
      brushSize: number,
      brushType: BrushType,
      r: number,
      g: number,
      b: number,
      opacity: number
    ) => {
      const history = canvasHistoryRef?.current;
      if (!history || localIdRef?.current == null) return;

      // Every drawing tool has a wire code now; fill and pan are the only
      // things that reach here without one, and neither travels as a stroke --
      // fill is its own message and pan draws nothing.
      const validBrushType: WireBrushType = isWireBrushType(brushType)
        ? brushType
        : "solid";

      openStroke();
      const pending = history.addLocalSegment(
        drawingState.layerType,
        brushSize,
        validBrushType,
        { r, g, b, a: opacity },
        Math.round(x),
        Math.round(y),
        strokeMaskRef.current
      );
      scheduleFlush(pending);
    },
    [canvasHistoryRef, localIdRef, drawingState.layerType, openStroke, scheduleFlush]
  );

  // WebSocket callbacks for drawing events
  const callbacks = {
    onDrawLine: useCallback(
      (
        _fromX: number,
        _fromY: number,
        toX: number,
        toY: number,
        brushSize: number,
        brushType: BrushType,
        r: number,
        g: number,
        b: number,
        opacity: number
      ) => {
        // The from-point is implied: each point continues the sender's stroke
        addSegment(toX, toY, brushSize, brushType, r, g, b, opacity);
      },
      [addSegment]
    ),

    onDrawPoint: useCallback(
      (
        x: number,
        y: number,
        brushSize: number,
        brushType: BrushType,
        r: number,
        g: number,
        b: number,
        opacity: number
      ) => {
        addSegment(x, y, brushSize, brushType, r, g, b, opacity);
      },
      [addSegment]
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
        if (localIdRef?.current == null) return;
        try {
          openStroke();
          const binaryMessage = encodeFill(
            localIdRef.current,
            drawingState.layerType,
            x,
            y,
            r,
            g,
            b,
            opacity,
            strokeMaskRef.current
          );
          dispatchLocalMessage(binaryMessage);
          // A fill is a complete operation on its own
          strokeOpenRef.current = false;
        } catch (error) {
          console.error("Failed to encode/send fill event:", error);
        }
      },
      [localIdRef, drawingState.layerType, dispatchLocalMessage, openStroke]
    ),

    /**
     * Region tools, straight lines, beziers, clears and text all travel as
     * one message describing the whole operation, rather than as the pixels
     * it produced. Each is complete on its own, so the stroke batch closes
     * immediately the way a fill does.
     */
    onRegionCommit: useCallback(
      (
        tool: RegionTool,
        layer: "foreground" | "background",
        rect: { x: number; y: number; width: number; height: number },
        color: { r: number; g: number; b: number; a: number },
        brushSize: number
      ) => {
        if (localIdRef?.current == null) return;
        try {
          openStroke();
          dispatchLocalMessage(
            encodeRegion(
              localIdRef.current, layer, tool, rect, color, brushSize,
              strokeMaskRef.current
            )
          );
          strokeOpenRef.current = false;
        } catch (error) {
          console.error("Failed to encode/send region event:", error);
        }
      },
      [localIdRef, dispatchLocalMessage, openStroke]
    ),

    onLine: useCallback(
      (
        from: { x: number; y: number },
        to: { x: number; y: number },
        brushSize: number,
        brushType: BrushType,
        color: { r: number; g: number; b: number; a: number },
        layer: "foreground" | "background"
      ) => {
        if (localIdRef?.current == null) return;
        try {
          openStroke();
          dispatchLocalMessage(
            encodeLine(
              localIdRef.current, layer, brushSize,
              brushType as WireBrushType, color, from, to,
              strokeMaskRef.current
            )
          );
          strokeOpenRef.current = false;
        } catch (error) {
          console.error("Failed to encode/send line event:", error);
        }
      },
      [localIdRef, dispatchLocalMessage, openStroke]
    ),

    onBezier: useCallback(
      (
        points: number[],
        brushSize: number,
        brushType: BrushType,
        color: { r: number; g: number; b: number; a: number },
        layer: "foreground" | "background"
      ) => {
        if (localIdRef?.current == null) return;
        try {
          openStroke();
          dispatchLocalMessage(
            encodeBezier(
              localIdRef.current, layer, brushSize,
              brushType as WireBrushType, color, points,
              strokeMaskRef.current
            )
          );
          strokeOpenRef.current = false;
        } catch (error) {
          console.error("Failed to encode/send bezier event:", error);
        }
      },
      [localIdRef, dispatchLocalMessage, openStroke]
    ),

    onEraseAll: useCallback(
      (layer: "foreground" | "background") => {
        if (localIdRef?.current == null) return;
        try {
          openStroke();
          dispatchLocalMessage(encodeEraseAll(localIdRef.current, layer));
          strokeOpenRef.current = false;
        } catch (error) {
          console.error("Failed to encode/send eraseAll event:", error);
        }
      },
      [localIdRef, dispatchLocalMessage, openStroke]
    ),

    onRegionPreview,
    onLinePreview,
    onBezierPreview,
    onHoverMove,
    onTextPlace,

    onPointerUp: useCallback(() => {
      strokeOpenRef.current = false;
      flushStroke();
      if (
        localIdRef?.current != null &&
        wsRef?.current?.readyState === WebSocket.OPEN
      ) {
        try {
          sendOrQueueMessage(encodePointerUp(localIdRef.current));
        } catch (error) {
          console.error("Failed to encode/send pointerup event:", error);
        }
      }
    }, [localIdRef, wsRef, sendOrQueueMessage, flushStroke]),
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
    if (!history || !history.canUndo() || localIdRef?.current == null) return;
    try {
      dispatchLocalMessage(encodeUndo(localIdRef.current, false));
    } catch (error) {
      console.error("Failed to encode/send undo:", error);
    }
  }, [canvasHistoryRef, localIdRef, dispatchLocalMessage]);

  /**
   * Commits text at a point. Unlike the other operations this is not driven
   * by a pointer callback -- the editor is a DOM box the app owns, and it
   * decides when Enter means commit -- so the app calls this directly.
   */
  const sendText = useCallback(
    (
      x: number,
      y: number,
      text: string,
      color: { r: number; g: number; b: number; a: number },
      brushSize: number,
      layer: "foreground" | "background"
    ) => {
      if (!text || localIdRef?.current == null) return;
      try {
        dispatchLocalMessage(
          encodeText(
            localIdRef.current, layer, x, y, text, color, brushSize,
            liveMaskRef.current
          )
        );
      } catch (error) {
        console.error("Failed to encode/send text event:", error);
      }
    },
    [localIdRef, dispatchLocalMessage]
  );

  const handleRedo = useCallback(() => {
    const history = canvasHistoryRef?.current;
    if (!history || !history.canRedo() || localIdRef?.current == null) return;
    try {
      dispatchLocalMessage(encodeUndo(localIdRef.current, true));
    } catch (error) {
      console.error("Failed to encode/send redo:", error);
    }
  }, [canvasHistoryRef, localIdRef, dispatchLocalMessage]);

  return {
    ...baseDrawing,
    undo: handleUndo,
    redo: handleRedo,
    sendText,
  };
};
