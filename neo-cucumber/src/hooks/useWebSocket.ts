import { useCallback, useRef, useEffect } from "react";
import {
  decodeMessage,
  encodeJoin,
  unwrapSequenced,
  type DecodedMessage,
} from "../utils/binaryProtocol";
import { type CollaborationMeta } from "../types/collaboration";
import { DrawingEngine } from "../DrawingEngine";
import { pngDataToLayer } from "../utils/canvasSnapshot";
import { type LocalFork } from "../utils/localFork";

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
  drawingEngineRef: React.RefObject<DrawingEngine | null>;
  userEnginesRef: React.RefObject<
    Map<
      string,
      { engine: DrawingEngine; username: string; canvas: HTMLCanvasElement }
    >
  >;
  participantsRef: React.RefObject<Map<string, Participant>>;
  localForkRef: React.RefObject<LocalFork | null>;
  lastSeqRef: React.RefObject<number>;
  shouldConnectRef: React.RefObject<boolean>;
  catchupTimeoutRef: React.RefObject<number | null>;
  processingMessageRef: React.RefObject<boolean>;
  isCatchingUpRef: React.RefObject<boolean>;
  setConnectionState: (state: ConnectionState) => void;
  setIsCatchingUp: (catching: boolean) => void;
  createUserEngine: (userId: string, username?: string) => void;
  handleLocalDrawingChange: () => void;
  addSnapshotToHistory: (
    layerName: "foreground" | "background",
    layerData: Uint8ClampedArray
  ) => void;
  markDrawingComplete: () => void;
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
  drawingEngineRef,
  userEnginesRef,
  participantsRef,
  localForkRef,
  lastSeqRef,
  shouldConnectRef,
  catchupTimeoutRef,
  processingMessageRef,
  isCatchingUpRef,
  setConnectionState,
  setIsCatchingUp,
  createUserEngine,
  handleLocalDrawingChange,
  addSnapshotToHistory,
  markDrawingComplete,
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
    console.log("Generating WebSocket URL:", {
      canvasMeta: !!canvasMeta,
      pathname: window.location.pathname,
      hostname: window.location.hostname,
    });

    // Check for explicitly set environment variable
    const envWsUrl = import.meta.env.VITE_WS_URL;
    if (envWsUrl) {
      console.log(
        "Using environment WebSocket URL:",
        envWsUrl,
        "from VITE_WS_URL"
      );
      return envWsUrl;
    }

    // Detect if we're in development
    const isDevelopment = window.location.hostname === "localhost";

    if (isDevelopment) {
      // Extract session ID from URL path
      const pathSegments = window.location.pathname.split("/");
      const sessionId = pathSegments[2]; // /collaborate/:sessionId
      const wsUrl = `ws://localhost:3000/collaborate/${sessionId}/ws`;
      console.log("Generated WebSocket URL:", wsUrl);
      return wsUrl;
    } else {
      // Production: use current host with wss protocol
      const pathSegments = window.location.pathname.split("/");
      const sessionId = pathSegments[2]; // /collaborate/:sessionId
      const wsUrl = `wss://${window.location.host}/collaborate/${sessionId}/ws`;
      console.log("Generated WebSocket URL:", wsUrl);
      return wsUrl;
    }
  }, [canvasMeta]);

  const connectWebSocket = useCallback(async () => {
    console.log("WebSocket connection attempt started:", {
      shouldConnect: shouldConnectRef.current,
      existingConnection: !!wsRef.current,
      isConnecting: isConnectingRef.current,
      currentUser: userIdRef.current,
      timestamp: new Date().toISOString(),
    });

    // Only connect if we should be connecting
    if (!shouldConnectRef.current && wsRef.current) {
      console.log("Connection attempt aborted - should not connect");
      return;
    }

    // Prevent multiple simultaneous connection attempts
    if (isConnectingRef.current) {
      console.log("Connection attempt aborted - already connecting");
      return;
    }

    // If already connected, don't reconnect
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log("Connection attempt aborted - already connected");
      return;
    }

    // Set connecting flag
    isConnectingRef.current = true;

    // Clean up any existing connection
    if (wsRef.current) {
      console.log("Cleaning up existing WebSocket connection");
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

    console.log("Using initialized user ID:", userIdRef.current);

    try {
      const wsUrl = getWebSocketUrl();
      console.log("Creating WebSocket connection to:", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
    } catch (error) {
      console.error("Failed to create WebSocket:", {
        error: error,
        message: error instanceof Error ? error.message : String(error),
      });
      setConnectionState("disconnected");
      isConnectingRef.current = false;
      return;
    }

    const ws = wsRef.current!;

    ws.onopen = () => {
      console.log("WebSocket connected successfully:", {
        url: ws.url,
        readyState: ws.readyState,
        timestamp: new Date().toISOString(),
      });
      setConnectionState("connected");
      isConnectingRef.current = false;

      // Fresh connection: any unconfirmed local fork state is stale since the
      // server will replay the canonical history from scratch
      localForkRef.current?.clear();
      lastSeqRef.current = 0;

      // Don't add current user here - wait for server LAYERS message
      // This ensures all clients get consistent participant order from server

      // Send initial join message to establish user presence and layer order
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
        console.log(`📥 Queued message during catch-up (queue size: ${messageQueueRef.current.length})`);
        // Process queue immediately if not already processing
        await processMessageQueue();
      } else {
        // During normal operation, process immediately
        // Create drawing engine for new user if they don't exist (skip for messages without userId)
        if ("userId" in message && message.userId) {
          const username =
            "username" in message ? message.username : message.userId;
          createUserEngine(message.userId, username);
        }

        // Handle message types
        await handleBinaryMessage(message, raw);

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
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
      });
      setConnectionState("disconnected");
      isConnectingRef.current = false;
    };

    ws.onclose = (event) => {
      console.log("WebSocket closed details:", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        url: ws.url,
        timestamp: new Date().toISOString(),
        readyState: ws.readyState,
        shouldConnect: shouldConnectRef.current,
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

      console.log(
        `🚀 Processing ${totalMessages} queued messages during catch-up (no batching)`
      );

      // Process all messages immediately without artificial delays
      while (messageQueueRef.current.length > 0) {
        const { message, raw, seq } = messageQueueRef.current.shift()!;

        // Create drawing engine for new user if they don't exist
        if ("userId" in message && message.userId) {
          createUserEngine(message.userId);
        }

        // Handle message types
        await handleBinaryMessage(message, raw);

        if (seq !== undefined) {
          lastSeqRef.current = Math.max(lastSeqRef.current, seq);
        }
      }

      processingMessageRef.current = false;
      console.log(`✅ Completed processing all ${totalMessages} messages from catch-up queue`);
      
      // End catch-up phase now that queue is empty
      setIsCatchingUp(false);
      console.log("🎯 Catch-up phase completed - queue is empty");
    };

    // Applies a canvas-affecting message to the local user's engine. Used to
    // replay messages after a fork rollback.
    const applyMessageToLocalEngine = async (
      engine: DrawingEngine,
      m: DecodedMessage
    ) => {
      switch (m.type) {
        case "drawLine":
          engine.drawLine(
            engine.layers[m.layer],
            m.fromX,
            m.fromY,
            m.toX,
            m.toY,
            m.brushSize,
            m.brushType,
            m.color.r,
            m.color.g,
            m.color.b,
            m.color.a
          );
          break;
        case "drawPoint":
          engine.drawLine(
            engine.layers[m.layer],
            m.x,
            m.y,
            m.x,
            m.y,
            m.brushSize,
            m.brushType,
            m.color.r,
            m.color.g,
            m.color.b,
            m.color.a
          );
          break;
        case "fill":
          engine.doFloodFill(
            engine.layers[m.layer],
            m.x,
            m.y,
            m.color.r,
            m.color.g,
            m.color.b,
            m.color.a
          );
          break;
        case "snapshot": {
          if (canvasMeta?.width && canvasMeta?.height) {
            const layerData = await pngDataToLayer(
              m.pngData,
              canvasMeta.width,
              canvasMeta.height
            );
            engine.layers[m.layer].set(layerData);
          }
          break;
        }
      }
    };

    // Reconciles an echoed local-user message against the local fork
    // (Drawpile's local fork model): if the echo matches the fork head the
    // message is already on the canvas; if the server's order diverged, roll
    // the layers back to the savepoint and replay the confirmed messages.
    // Returns "handled" when the caller must not apply the message again.
    const reconcileLocalEcho = async (
      message: DecodedMessage,
      raw: Uint8Array | undefined
    ): Promise<"handled" | "apply"> => {
      const fork = localForkRef.current;
      const engine = drawingEngineRef.current;
      if (!fork || !engine || !raw) return "apply";

      const result = fork.reconcile(raw, message);
      if (result.action === "already-done") {
        return "handled";
      }
      if (result.action === "rollback") {
        console.warn(
          "Local fork rollback - server order diverged from local drawing"
        );
        engine.layers.foreground.set(result.savepoint.foreground);
        engine.layers.background.set(result.savepoint.background);
        for (const confirmedMsg of result.confirmed) {
          await applyMessageToLocalEngine(engine, confirmedMsg);
        }
        await applyMessageToLocalEngine(engine, message);
        engine.queueLayerUpdate("foreground");
        engine.queueLayerUpdate("background");
        handleLocalDrawingChange();
        return "handled";
      }
      return "apply";
    };

    // Helper function to handle decoded binary messages (moved inside connectWebSocket)
    const handleBinaryMessage = async (
      message: DecodedMessage,
      raw?: Uint8Array
    ) => {
      try {
        // Handle different message types
        switch (message.type) {
          case "drawLine": {
            console.log("Drawing event - drawLine", message);
            // Check if this is the local user's drawing event
            if (
              message.userId === userIdRef.current &&
              drawingEngineRef.current
            ) {
              if ((await reconcileLocalEcho(message, raw)) === "handled") {
                break;
              }
              const targetLayer =
                message.layer === "foreground"
                  ? drawingEngineRef.current.layers.foreground
                  : drawingEngineRef.current.layers.background;

              drawingEngineRef.current.drawLine(
                targetLayer,
                message.fromX,
                message.fromY,
                message.toX,
                message.toY,
                message.brushSize,
                message.brushType,
                message.color.r,
                message.color.g,
                message.color.b,
                message.color.a
              );

              // Queue DOM canvases for batched update for local drawing
              drawingEngineRef.current.queueLayerUpdate(
                message.layer as "foreground" | "background"
              );

              // Mark drawing operation as complete to prevent double-saving in pointerup
              markDrawingComplete();

              // Notify parent component that drawing has changed
              handleLocalDrawingChange();
            } else {
              // Handle remote user's drawing event
              const userEngine = userEnginesRef.current?.get(message.userId);
              if (userEngine) {
                const engine = userEngine.engine;
                const targetLayer =
                  message.layer === "foreground"
                    ? engine.layers.foreground
                    : engine.layers.background;

                engine.drawLine(
                  targetLayer,
                  message.fromX,
                  message.fromY,
                  message.toX,
                  message.toY,
                  message.brushSize,
                  message.brushType,
                  message.color.r,
                  message.color.g,
                  message.color.b,
                  message.color.a
                );

                // Queue DOM canvases for batched update for remote drawing
                engine.queueLayerUpdate(
                  message.layer as "foreground" | "background"
                );

                // Show cursor at the end position of the line
                const participant = participantsRef.current?.get(
                  message.userId
                );
                const username = participant?.username || userEngine.username;
                createOrUpdateCursor(
                  message.userId,
                  message.toX,
                  message.toY,
                  username
                );
              }
            }
            break;
          }

          case "drawPoint": {
            console.log("Drawing event - drawPoint:", {
              userId: message.userId.substring(0, 8),
              isLocalUser: message.userId === userIdRef.current,
              layer: message.layer,
              point: { x: message.x, y: message.y },
              brushSize: message.brushSize,
              brushType: message.brushType,
              color: message.color,
            });

            // Check if this is the local user's drawing event
            if (
              message.userId === userIdRef.current &&
              drawingEngineRef.current
            ) {
              if ((await reconcileLocalEcho(message, raw)) === "handled") {
                break;
              }
              const targetLayer =
                message.layer === "foreground"
                  ? drawingEngineRef.current.layers.foreground
                  : drawingEngineRef.current.layers.background;

              drawingEngineRef.current.drawLine(
                targetLayer,
                message.x,
                message.y,
                message.x,
                message.y,
                message.brushSize,
                message.brushType,
                message.color.r,
                message.color.g,
                message.color.b,
                message.color.a
              );

              // Queue DOM canvases for batched update for local drawing
              drawingEngineRef.current.queueLayerUpdate(
                message.layer as "foreground" | "background"
              );

              // Mark drawing operation as complete to prevent double-saving in pointerup
              markDrawingComplete();

              // Notify parent component that drawing has changed
              handleLocalDrawingChange();
            } else {
              // Handle remote user's drawing event
              const userEngine = userEnginesRef.current?.get(message.userId);
              if (userEngine) {
                const engine = userEngine.engine;
                const targetLayer =
                  message.layer === "foreground"
                    ? engine.layers.foreground
                    : engine.layers.background;

                engine.drawLine(
                  targetLayer,
                  message.x,
                  message.y,
                  message.x,
                  message.y,
                  message.brushSize,
                  message.brushType,
                  message.color.r,
                  message.color.g,
                  message.color.b,
                  message.color.a
                );

                // Queue DOM canvases for batched update for remote drawing
                engine.queueLayerUpdate(
                  message.layer as "foreground" | "background"
                );

                // Show cursor at the drawing point
                const participant = participantsRef.current?.get(
                  message.userId
                );
                const username = participant?.username || userEngine.username;
                createOrUpdateCursor(
                  message.userId,
                  message.x,
                  message.y,
                  username
                );
              }
            }
            break;
          }

          case "fill": {
            console.log("Drawing event - fill:", {
              userId: message.userId.substring(0, 8),
              isLocalUser: message.userId === userIdRef.current,
              layer: message.layer,
              point: { x: message.x, y: message.y },
              color: message.color,
            });

            // Check if this is the local user's drawing event
            if (
              message.userId === userIdRef.current &&
              drawingEngineRef.current
            ) {
              if ((await reconcileLocalEcho(message, raw)) === "handled") {
                break;
              }
              const targetLayer =
                message.layer === "foreground"
                  ? drawingEngineRef.current.layers.foreground
                  : drawingEngineRef.current.layers.background;

              drawingEngineRef.current.doFloodFill(
                targetLayer,
                message.x,
                message.y,
                message.color.r,
                message.color.g,
                message.color.b,
                message.color.a
              );

              // Queue DOM canvases for batched update for local drawing
              drawingEngineRef.current.queueLayerUpdate(
                message.layer as "foreground" | "background"
              );

              // Mark drawing operation as complete to prevent double-saving in pointerup
              markDrawingComplete();

              // Notify parent component that drawing has changed
              handleLocalDrawingChange();
            } else {
              // Handle remote user's drawing event
              const userEngine = userEnginesRef.current?.get(message.userId);
              if (userEngine) {
                const engine = userEngine.engine;
                const targetLayer =
                  message.layer === "foreground"
                    ? engine.layers.foreground
                    : engine.layers.background;

                engine.doFloodFill(
                  targetLayer,
                  message.x,
                  message.y,
                  message.color.r,
                  message.color.g,
                  message.color.b,
                  message.color.a
                );

                // Queue DOM canvases for batched update for remote drawing
                engine.queueLayerUpdate(
                  message.layer as "foreground" | "background"
                );

                // Show cursor at the fill point
                const participant = participantsRef.current?.get(
                  message.userId
                );
                const username = participant?.username || userEngine.username;
                createOrUpdateCursor(
                  message.userId,
                  message.x,
                  message.y,
                  username
                );
              }
            }
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
            console.log("User joined:", {
              userId: message.userId.substring(0, 8),
              username: message.username,
              timestamp: message.timestamp,
            });

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
            console.log("User left:", {
              userId: message.userId.substring(0, 8),
              username: message.username,
            });

            // Add leave notification to chat
            addChatMessage({
              id: `${message.userId}-${message.timestamp}-leave`,
              type: "leave" as const,
              userId: message.userId,
              username: message.username,
              message: `${message.username} left the session`,
              timestamp: message.timestamp,
            });

            // Hide cursor for the user (but keep participant in layer order)
            hideCursor(message.userId);
            break;
          }

          case "chat": {
            console.log("Chat message received:", {
              userId: message.userId.substring(0, 8),
              username: message.username,
              message:
                message.message.substring(0, 50) +
                (message.message.length > 50 ? "..." : ""),
              timestamp: message.timestamp,
            });

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

          case "snapshot": {
            console.log("Snapshot received:", {
              userId: message.userId.substring(0, 8),
              layer: message.layer,
              pngDataLength: message.pngData.length,
            });

            if (!canvasMeta?.width || !canvasMeta?.height) {
              console.error(
                "Canvas dimensions not available for snapshot processing"
              );
              break;
            }

            try {
              if (message.userId === userIdRef.current) {
                // Local user's snapshot (undo/redo or snapshot response echo)
                if ((await reconcileLocalEcho(message, raw)) === "handled") {
                  break;
                }
                if (drawingEngineRef.current) {
                  const layerData = await pngDataToLayer(
                    message.pngData,
                    canvasMeta.width,
                    canvasMeta.height
                  );
                  const targetLayer =
                    message.layer === "foreground"
                      ? drawingEngineRef.current.layers.foreground
                      : drawingEngineRef.current.layers.background;

                  targetLayer.set(layerData);
                  drawingEngineRef.current.queueLayerUpdate(
                    message.layer as "foreground" | "background"
                  );

                  // Add to history for undo/redo
                  addSnapshotToHistory(
                    message.layer as "foreground" | "background",
                    layerData
                  );
                }
              } else {
                // Apply to remote user's canvas
                const userEngine = userEnginesRef.current?.get(message.userId);
                if (userEngine) {
                  const layerData = await pngDataToLayer(
                    message.pngData,
                    canvasMeta.width,
                    canvasMeta.height
                  );
                  const engine = userEngine.engine;
                  const targetLayer =
                    message.layer === "foreground"
                      ? engine.layers.foreground
                      : engine.layers.background;

                  targetLayer.set(layerData);
                  engine.queueLayerUpdate(
                    message.layer as "foreground" | "background"
                  );

                  // Note: Remote canvases don't need undo/redo history
                }
              }
            } catch (error) {
              console.error("Failed to decode PNG snapshot data:", error);
            }
            break;
          }

          case "layers": {
            console.log("Layers message received:", {
              participants: message.participants.map((p) => ({
                userId: p.userId.substring(0, 8),
                username: p.username,
                joinTimestamp: p.joinTimestamp,
              })),
              participantCount: message.participants.length,
            });

            console.log(
              "LAYERS message - clearing and rebuilding participant order from server"
            );

            // Clear existing participants to avoid inconsistencies
            // This ensures all clients have identical participant ordering from server
            participantsRef.current?.clear();
            clearParticipants();

            // Sort participants by join timestamp to ensure correct layer ordering
            // (participants are already sorted on the server, but we verify here)
            const sortedParticipants = message.participants.sort(
              (a, b) => a.joinTimestamp - b.joinTimestamp
            );
            console.log("Sorted participants:", sortedParticipants);

            // Initialize participants from layers message - this provides complete
            // participant information with user IDs, usernames, and join timestamps
            for (const participant of sortedParticipants) {
              addParticipant(
                participant.userId,
                participant.username,
                participant.joinTimestamp
              );

              // Create drawing engine for the user
              createUserEngine(participant.userId, participant.username);
            }

            console.log("All participants processed, z-indices will update declaratively");
            
            // Z-index updates now happen declaratively via useEffect in useCanvas hook
            // No manual triggering needed - changes to userOrderRef will automatically update z-indices
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
              isLocalUser: message.userId === userIdRef.current,
            });

            // Redirect to the post page
            if (message.postUrl) {
              console.log("Redirecting to post:", message.postUrl);
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
    localForkRef,
    lastSeqRef,
    setConnectionState,
    setIsCatchingUp,
    createUserEngine,
    handleLocalDrawingChange,
    addSnapshotToHistory,
    markDrawingComplete,
    createOrUpdateCursor,
    hideCursor,
    addParticipant,
    clearParticipants,
    addChatMessage,
    catchupTimeoutRef,
    drawingEngineRef,
    isCatchingUpRef,
    localUserJoinTimeRef,
    participantsRef,
    processingMessageRef,
    shouldConnectRef,
    userEnginesRef,
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
