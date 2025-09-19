import { useCallback, useRef, useEffect } from "react";
import {
  decodeMessage,
  encodeJoin,
  type DecodedMessage,
} from "../utils/binaryProtocol";
import { type CollaborationMeta } from "../types/collaboration";
import { DrawingEngine } from "../DrawingEngine";

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
  handleSnapshotRequest: () => void;
}

export const useWebSocket = ({
  canvasMeta,
  userIdRef,
  localUserJoinTimeRef,
  drawingEngineRef,
  userEnginesRef,
  participantsRef,
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
  handleSnapshotRequest,
}: WebSocketHookParams) => {
  const wsRef = useRef<WebSocket | null>(null);
  const messageQueueRef = useRef<DecodedMessage[]>([]);
  const isConnectingRef = useRef(false);

  // Keep handleSnapshotRequest ref to avoid dependency issues
  const handleSnapshotRequestRef = useRef(handleSnapshotRequest);
  useEffect(() => {
    handleSnapshotRequestRef.current = handleSnapshotRequest;
  }, [handleSnapshotRequest]);

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

    ws.onmessage = async (event) => {
      try {
        // Clear any existing catch-up timeout since we now end catch-up when queue is empty
        if (catchupTimeoutRef.current) {
          clearTimeout(catchupTimeoutRef.current);
          catchupTimeoutRef.current = null;
        }

        // Handle binary messages (can be ArrayBuffer or Blob)
        if (event.data instanceof ArrayBuffer) {
          const message = decodeMessage(event.data);
          if (!message) {
            return;
          }

          if (isCatchingUpRef.current) {
            // During catch-up, queue messages for sequential processing
            messageQueueRef.current.push(message);
            console.log(`📥 Queued message during catch-up (queue size: ${messageQueueRef.current.length})`);
            // Process queue immediately if not already processing
            processMessageQueue();
          } else {
            // During normal operation, process immediately
            // Create drawing engine for new user if they don't exist (skip for messages without userId)
            if ("userId" in message && message.userId) {
              const username =
                "username" in message ? message.username : message.userId;
              createUserEngine(message.userId, username);
            }

            // Handle message types
            await handleBinaryMessage(message);
          }
        } else if (event.data instanceof Blob) {
          const arrayBuffer = await event.data.arrayBuffer();
          const message = decodeMessage(arrayBuffer);
          if (!message) {
            return;
          }

          if (isCatchingUpRef.current) {
            // During catch-up, queue messages for sequential processing
            messageQueueRef.current.push(message);
            console.log(`📥 Queued message during catch-up (queue size: ${messageQueueRef.current.length})`);
            // Process queue immediately if not already processing
            processMessageQueue();
          } else {
            // During normal operation, process immediately
            // Create drawing engine for new user if they don't exist (skip for messages without userId)
            if ("userId" in message && message.userId) {
              const username =
                "username" in message ? message.username : message.userId;
              createUserEngine(message.userId, username);
            }

            // Handle message types
            await handleBinaryMessage(message);
          }
        }
      } catch (error) {
        console.error("Failed to decode WebSocket message:", error);
      }
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
        const message = messageQueueRef.current.shift()!;

        // Create drawing engine for new user if they don't exist
        if ("userId" in message && message.userId) {
          createUserEngine(message.userId);
        }

        // Handle message types
        await handleBinaryMessage(message);
      }

      processingMessageRef.current = false;
      console.log(`✅ Completed processing all ${totalMessages} messages from catch-up queue`);
      
      // End catch-up phase now that queue is empty
      setIsCatchingUp(false);
      console.log("🎯 Catch-up phase completed - queue is empty");
    };

    // Helper function to handle decoded binary messages (moved inside connectWebSocket)
    const handleBinaryMessage = async (message: DecodedMessage) => {
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

            // Decode PNG data to ImageData
            try {
              const blob = new Blob([new Uint8Array(message.pngData)], { type: "image/png" });
              const img = new Image();
              const canvas = document.createElement("canvas");
              canvas.width = canvasMeta.width;
              canvas.height = canvasMeta.height;
              const ctx = canvas.getContext("2d");

              if (!ctx) {
                console.error("Failed to get 2D context for PNG decoding");
              } else {
                // Load PNG asynchronously and update canvases when ready
                const url = URL.createObjectURL(blob);
                img.onload = () => {
                  ctx.clearRect(0, 0, canvasMeta.width, canvasMeta.height);
                  ctx.drawImage(img, 0, 0);
                  const imageData = ctx.getImageData(
                    0,
                    0,
                    canvasMeta.width,
                    canvasMeta.height
                  );
                  URL.revokeObjectURL(url);

                  // Apply the decoded data to the appropriate canvas
                  if (message.userId === userIdRef.current) {
                    // Apply to local user's canvas
                    if (drawingEngineRef.current) {
                      const targetLayer =
                        message.layer === "foreground"
                          ? drawingEngineRef.current.layers.foreground
                          : drawingEngineRef.current.layers.background;

                      targetLayer.set(imageData.data);
                      drawingEngineRef.current.queueLayerUpdate(
                        message.layer as "foreground" | "background"
                      );

                      // Add to history for undo/redo
                      addSnapshotToHistory(
                        message.layer as "foreground" | "background",
                        imageData.data
                      );
                    }
                  } else {
                    // Apply to remote user's canvas AND add to their history
                    const userEngine = userEnginesRef.current?.get(
                      message.userId
                    );
                    if (userEngine) {
                      const engine = userEngine.engine;
                      const targetLayer =
                        message.layer === "foreground"
                          ? engine.layers.foreground
                          : engine.layers.background;

                      targetLayer.set(imageData.data);
                      engine.queueLayerUpdate(
                        message.layer as "foreground" | "background"
                      );

                      // Note: Remote canvases don't need undo/redo history
                    }
                  }
                };
                img.onerror = () => {
                  console.error("Failed to load PNG data for snapshot");
                  URL.revokeObjectURL(url);
                };
                img.src = url;
              }
            } catch (error) {
              console.error("Failed to decode PNG snapshot data:", error);
            }

            // Note: Canvas updates and history are now handled asynchronously
            // in the img.onload callback above after PNG decoding is complete
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

          case "snapshotRequest": {
            console.log("Snapshot request received:", {
              timestamp: message.timestamp,
            });

            // Call the provided snapshot request handler
            handleSnapshotRequestRef.current();
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
