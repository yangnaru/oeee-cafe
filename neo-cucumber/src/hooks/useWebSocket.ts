import { useCallback, useRef, useEffect } from "react";
import {
  decodeMessage,
  encodeJoin,
  unwrapSequenced,
  type DecodedMessage,
} from "../utils/binaryProtocol";
import { type CollaborationMeta } from "../types/collaboration";
import { type CanvasHistory } from "../utils/canvasHistory";

export type ConnectionState = "disconnected" | "connecting" | "connected";

interface Participant {
  userId: string;
  username: string;
  joinedAt: number;
}

interface WebSocketHookParams {
  canvasMeta: CollaborationMeta | null;
  userIdRef: React.RefObject<string | null>;
  userLoginNameRef: React.RefObject<string>;
  localUserJoinTimeRef: React.RefObject<number>;
  canvasHistoryRef: React.RefObject<CanvasHistory | null>;
  participantsRef: React.RefObject<Map<string, Participant>>;
  lastSeqRef: React.RefObject<number>;
  shouldConnectRef: React.RefObject<boolean>;
  catchupTimeoutRef: React.RefObject<number | null>;
  processingMessageRef: React.RefObject<boolean>;
  isCatchingUpRef: React.RefObject<boolean>;
  setConnectionState: (state: ConnectionState) => void;
  setIsCatchingUp: (catching: boolean) => void;
  createOrUpdateCursor: (
    userId: string,
    x: number,
    y: number,
    username: string
  ) => void;
  hideCursor: (userId: string) => void;
  addParticipant: (userId: string, username: string, joinedAt: number) => void;
  clearParticipants: () => void;
  addChatMessage: (message: {
    id: string;
    type: "user" | "join" | "leave";
    userId: string;
    username: string;
    message: string;
    timestamp: number;
  }) => void;
  handleResetRequest: () => void;
}

export const useWebSocket = ({
  canvasMeta,
  userIdRef,
  localUserJoinTimeRef,
  canvasHistoryRef,
  participantsRef,
  lastSeqRef,
  shouldConnectRef,
  catchupTimeoutRef,
  processingMessageRef,
  isCatchingUpRef,
  setConnectionState,
  setIsCatchingUp,
  createOrUpdateCursor,
  hideCursor,
  addParticipant,
  clearParticipants,
  addChatMessage,
  handleResetRequest,
}: WebSocketHookParams) => {
  const wsRef = useRef<WebSocket | null>(null);
  const messageQueueRef = useRef<
    { message: DecodedMessage; raw: Uint8Array; seq?: number }[]
  >([]);
  const isConnectingRef = useRef(false);
  // Serializes async message processing so messages are always applied in
  // arrival order (the server's canonical order), even when handling involves
  // awaits like PNG decoding
  const processingChainRef = useRef<Promise<void>>(Promise.resolve());

  // Keep handleResetRequest ref to avoid dependency issues
  const handleResetRequestRef = useRef(handleResetRequest);
  useEffect(() => {
    handleResetRequestRef.current = handleResetRequest;
  }, [handleResetRequest]);

  // Function to get WebSocket URL dynamically
  const getWebSocketUrl = useCallback(() => {
    // Check for explicitly set environment variable
    const envWsUrl = import.meta.env.VITE_WS_URL;
    if (envWsUrl) {
      return envWsUrl;
    }

    // Detect if we're in development
    const isDevelopment = window.location.hostname === "localhost";
    const pathSegments = window.location.pathname.split("/");
    const sessionId = pathSegments[2]; // /collaborate/:sessionId

    if (isDevelopment) {
      return `ws://localhost:3000/collaborate/${sessionId}/ws`;
    }
    return `wss://${window.location.host}/collaborate/${sessionId}/ws`;
  }, []);

  const connectWebSocket = useCallback(async () => {
    // Only connect if we should be connecting
    if (!shouldConnectRef.current && wsRef.current) {
      return;
    }

    // Prevent multiple simultaneous connection attempts
    if (isConnectingRef.current) {
      return;
    }

    // If already connected, don't reconnect
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return;
    }

    // Set connecting flag
    isConnectingRef.current = true;

    // Clean up any existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setConnectionState("connecting");

    // Check if we have user ID and canvas meta - don't proceed if not initialized
    if (!userIdRef.current || !canvasMeta) {
      console.error(
        "App not properly initialized - missing user ID or canvas meta"
      );
      setConnectionState("disconnected");
      isConnectingRef.current = false;
      return;
    }

    try {
      const wsUrl = getWebSocketUrl();
      console.log("Creating WebSocket connection to:", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
    } catch (error) {
      console.error("Failed to create WebSocket:", error);
      setConnectionState("disconnected");
      isConnectingRef.current = false;
      return;
    }

    const ws = wsRef.current!;

    ws.onopen = () => {
      console.log("WebSocket connected successfully:", ws.url);
      setConnectionState("connected");
      isConnectingRef.current = false;

      // Fresh connection: the server replays the canonical history from
      // scratch, so any local history state is stale
      canvasHistoryRef.current?.reset();
      lastSeqRef.current = 0;

      // Send initial join message to establish user presence
      try {
        const binaryMessage = encodeJoin(userIdRef.current!, Date.now());
        ws.send(binaryMessage);
      } catch (error) {
        console.error("Failed to send join message:", error);
      }

      // Start catching up phase - drawing will be disabled
      setIsCatchingUp(true);

      // Set a timeout to end catching up phase if no more messages arrive
      if (catchupTimeoutRef.current) {
        clearTimeout(catchupTimeoutRef.current);
      }
      catchupTimeoutRef.current = window.setTimeout(() => {
        setIsCatchingUp(false);
        console.log("Catch-up phase completed");
      }, 1000); // 1 second timeout for catch-up

      // Set join timestamp after a short delay to let stored messages arrive first
      setTimeout(() => {
        if (localUserJoinTimeRef.current === 0) {
          // Only set if not already set
          localUserJoinTimeRef.current = Date.now();
        }
      }, 100); // 100ms should be enough for stored messages
    };

    const processIncomingData = async (data: ArrayBuffer | Blob) => {
      // Clear any existing catch-up timeout since we now end catch-up when queue is empty
      if (catchupTimeoutRef.current) {
        clearTimeout(catchupTimeoutRef.current);
        catchupTimeoutRef.current = null;
      }

      let arrayBuffer =
        data instanceof ArrayBuffer ? data : await data.arrayBuffer();

      // History messages arrive wrapped in a SEQUENCED envelope carrying their
      // canonical position; the position is recorded only after the message
      // has been fully applied so lastSeq always describes the canvas state
      const sequenced = unwrapSequenced(arrayBuffer);
      if (sequenced) {
        arrayBuffer = sequenced.payload;
      }

      const message = decodeMessage(arrayBuffer);
      if (!message) {
        return;
      }
      const raw = new Uint8Array(arrayBuffer);

      if (isCatchingUpRef.current) {
        // During catch-up, queue messages for sequential processing
        messageQueueRef.current.push({ message, raw, seq: sequenced?.seq });
        // Process queue immediately if not already processing
        await processMessageQueue();
      } else {
        await handleBinaryMessage(message, raw, sequenced?.seq);

        if (sequenced) {
          lastSeqRef.current = Math.max(lastSeqRef.current, sequenced.seq);
        }
      }
    };

    ws.onmessage = (event) => {
      // Chain message handling so messages are applied strictly in arrival
      // order even when processing involves awaits (e.g. PNG decoding)
      processingChainRef.current = processingChainRef.current
        .then(() => processIncomingData(event.data))
        .catch((error) => {
          console.error("Failed to process WebSocket message:", error);
        });
    };

    ws.onerror = (event) => {
      console.error("WebSocket error details:", {
        readyState: ws.readyState,
        url: ws.url,
        event: event,
      });
      setConnectionState("disconnected");
      isConnectingRef.current = false;
    };

    ws.onclose = (event) => {
      console.log("WebSocket closed:", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      setConnectionState("disconnected");
      isConnectingRef.current = false;
      // No automatic reconnection - user must manually reconnect
    };

    // Process all queued messages immediately during catch-up
    const processMessageQueue = async () => {
      if (
        processingMessageRef.current ||
        messageQueueRef.current.length === 0
      ) {
        return;
      }

      processingMessageRef.current = true;
      const totalMessages = messageQueueRef.current.length;

      // Process all messages immediately without artificial delays
      while (messageQueueRef.current.length > 0) {
        const { message, raw, seq } = messageQueueRef.current.shift()!;

        await handleBinaryMessage(message, raw, seq);

        if (seq !== undefined) {
          lastSeqRef.current = Math.max(lastSeqRef.current, seq);
        }
      }

      processingMessageRef.current = false;
      console.log(`✅ Processed ${totalMessages} messages from catch-up queue`);

      // End catch-up phase now that queue is empty
      setIsCatchingUp(false);
    };

    // Helper function to handle decoded binary messages (moved inside connectWebSocket)
    const handleBinaryMessage = async (
      message: DecodedMessage,
      raw?: Uint8Array,
      seq?: number
    ) => {
      try {
        // Handle different message types
        switch (message.type) {
          // All canvas-affecting messages fold into the shared canonical
          // canvas history, which owns conflict resolution (local fork
          // reconciliation) and collaborative undo
          case "drawLine":
          case "drawPoint":
          case "fill":
          case "snapshot":
          case "undoPoint":
          case "undo": {
            if (raw) {
              await canvasHistoryRef.current?.handleRemote(raw, message, seq);
            }

            // Show remote users' cursors at their latest drawing position
            if (
              "userId" in message &&
              message.userId !== userIdRef.current &&
              (message.type === "drawLine" ||
                message.type === "drawPoint" ||
                message.type === "fill")
            ) {
              const participant = participantsRef.current?.get(message.userId);
              const username = participant?.username || message.userId;
              const x = message.type === "drawLine" ? message.toX : message.x;
              const y = message.type === "drawLine" ? message.toY : message.y;
              createOrUpdateCursor(message.userId, x, y, username);
            }
            break;
          }

          case "resetPoint": {
            await canvasHistoryRef.current?.handleResetPoint(message.baseSeq);
            break;
          }

          case "pointerup": {
            // Hide cursor for remote users when they stop drawing
            if (message.userId !== userIdRef.current) {
              hideCursor(message.userId);
            }
            break;
          }

          case "join": {
            // Don't add participant here - wait for LAYERS message
            // This ensures consistent participant ordering from server

            // Add join notification to chat
            addChatMessage({
              id: `${message.userId}-${message.timestamp}-join`,
              type: "join" as const,
              userId: message.userId,
              username: message.username,
              message: `${message.username} joined`,
              timestamp: message.timestamp,
            });
            break;
          }

          case "leave": {
            // Add leave notification to chat
            addChatMessage({
              id: `${message.userId}-${message.timestamp}-leave`,
              type: "leave" as const,
              userId: message.userId,
              username: message.username,
              message: `${message.username} left the session`,
              timestamp: message.timestamp,
            });

            // Hide cursor for the user (but keep participant in the list)
            hideCursor(message.userId);
            break;
          }

          case "chat": {
            // Add chat message to the chat component via the callback
            addChatMessage({
              id: `${message.userId}-${message.timestamp}`,
              type: "user" as const,
              userId: message.userId,
              username: message.username,
              message: message.message,
              timestamp: message.timestamp,
            });
            break;
          }

          case "layers": {
            console.log("Layers message received:", {
              participantCount: message.participants.length,
            });

            // Clear existing participants to avoid inconsistencies
            // This ensures all clients have identical participant ordering from server
            participantsRef.current?.clear();
            clearParticipants();

            // Sort participants by join timestamp (already sorted on the
            // server, but we verify here)
            const sortedParticipants = message.participants.sort(
              (a, b) => a.joinTimestamp - b.joinTimestamp
            );

            for (const participant of sortedParticipants) {
              addParticipant(
                participant.userId,
                participant.username,
                participant.joinTimestamp
              );
            }
            break;
          }

          case "resetRequest": {
            console.log("Session reset request received:", {
              timestamp: message.timestamp,
            });

            // The server chose this client to upload a session reset
            handleResetRequestRef.current();
            break;
          }

          case "endSession": {
            console.log("Session ended:", {
              userId: message.userId.substring(0, 8),
              postUrl: message.postUrl,
            });

            // Redirect to the post page
            if (message.postUrl) {
              window.location.href = message.postUrl;
            }
            break;
          }

          default: {
            console.log("Unknown message type:", message);
            break;
          }
        }
      } catch (error) {
        console.error("Failed to handle binary message:", error);
      }
    };
  }, [
    getWebSocketUrl,
    canvasMeta,
    canvasHistoryRef,
    lastSeqRef,
    setConnectionState,
    setIsCatchingUp,
    createOrUpdateCursor,
    hideCursor,
    addParticipant,
    clearParticipants,
    addChatMessage,
    catchupTimeoutRef,
    isCatchingUpRef,
    localUserJoinTimeRef,
    participantsRef,
    processingMessageRef,
    shouldConnectRef,
    userIdRef,
  ]);

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  return {
    wsRef,
    connectWebSocket,
    getWebSocketUrl,
  };
};
