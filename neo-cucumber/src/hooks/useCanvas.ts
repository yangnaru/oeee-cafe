import { useCallback, useRef, useEffect, useMemo } from "react";
import { DrawingEngine } from "../DrawingEngine";
import { type CollaborationMeta } from "../types/collaboration";
import {
  compositeLayersToCanvas,
  downloadCanvasAsPNG as downloadCanvas,
} from "../utils/canvasExport";

interface CanvasElements {
  bgCanvas: HTMLCanvasElement;
  fgCanvas: HTMLCanvasElement;
}

interface Participant {
  userId: string;
  username: string;
  joinedAt: number;
}

interface CanvasHookParams {
  canvasMeta: CollaborationMeta | null;
  participants: Map<string, Participant>;
  userEnginesRef: React.RefObject<
    Map<
      string,
      { engine: DrawingEngine; username: string; canvas: HTMLCanvasElement }
    >
  >;
  drawingEngine: DrawingEngine | null;
  userIdRef: React.RefObject<string | null>;
  currentZoom: number;
  drawingState: {
    fgVisible: boolean;
    bgVisible: boolean;
  };
}

// Declarative z-index calculation system
const LAYER_Z_INDEX = {
  // Base z-index for layers - each user gets 100 z-index levels
  BASE: 1000,
  USER_SEPARATION: 100,

  // Within each user's 100 levels:
  // Background: 0-39 (40 levels for background)
  // Foreground: 40-79 (40 levels for foreground)
  // Reserved: 80-99 (20 levels for future use)
  BACKGROUND_OFFSET: 0,
  FOREGROUND_OFFSET: 40,
} as const;

/**
 * Calculate z-index for a user's layer in a declarative way
 * Earlier users (lower index) get higher z-index values
 * Each user gets 100 z-index levels to prevent any overlap
 */
function calculateLayerZIndex(
  userIndex: number,
  layerType: "background" | "foreground"
): number {
  if (userIndex < 0) {
    console.warn(
      `calculateLayerZIndex: userIndex is ${userIndex}, using fallback z-index ${LAYER_Z_INDEX.BASE}`
    );
    return LAYER_Z_INDEX.BASE; // Fallback for unknown users
  }

  const userBaseZIndex =
    LAYER_Z_INDEX.BASE - userIndex * LAYER_Z_INDEX.USER_SEPARATION;
  const layerOffset =
    layerType === "background"
      ? LAYER_Z_INDEX.BACKGROUND_OFFSET
      : LAYER_Z_INDEX.FOREGROUND_OFFSET;

  const finalZIndex = userBaseZIndex + layerOffset;

  console.log(
    `calculateLayerZIndex: userIndex=${userIndex}, layerType=${layerType}, userBaseZIndex=${userBaseZIndex}, layerOffset=${layerOffset}, finalZIndex=${finalZIndex}`
  );

  return finalZIndex;
}

export const useCanvas = ({
  canvasMeta,
  participants,
  userEnginesRef,
  drawingEngine,
  userIdRef,
  currentZoom,
  drawingState,
}: CanvasHookParams) => {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const userCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const localUserCanvasRef = useRef<HTMLCanvasElement>(null);

  // Derive user order from participants (sorted by join time)
  const userOrder = useMemo(() => {
    return Array.from(participants.values())
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => p.userId);
  }, [participants]);

  // Function to create DOM canvas elements for a user (foreground and background)
  const createUserCanvasElements = useCallback(
    (userId: string, insertionIndex: number): CanvasElements | null => {
      console.log("createUserCanvasElements called for:", userId, {
        containerExists: !!canvasContainerRef.current,
        canvasWidth: canvasMeta?.width,
        canvasHeight: canvasMeta?.height,
      });

      if (
        !canvasContainerRef.current ||
        !canvasMeta?.width ||
        !canvasMeta?.height
      ) {
        console.log("Cannot create canvases - missing requirements");
        return null;
      }

      // Create background canvas
      const bgCanvas = document.createElement("canvas");
      bgCanvas.width = canvasMeta.width;
      bgCanvas.height = canvasMeta.height;
      bgCanvas.className = "absolute top-0 left-0 canvas-bg";
      bgCanvas.style.pointerEvents = "none"; // Background never handles events
      bgCanvas.style.width = `${canvasMeta.width}px`; // Set base dimensions - container handles zoom
      bgCanvas.style.height = `${canvasMeta.height}px`;
      bgCanvas.id = `bg-${userId}`;

      const bgCtx = bgCanvas.getContext("2d");
      if (bgCtx) {
        bgCtx.imageSmoothingEnabled = false;
      }

      // Create foreground canvas
      const fgCanvas = document.createElement("canvas");
      fgCanvas.width = canvasMeta.width;
      fgCanvas.height = canvasMeta.height;
      fgCanvas.className = "absolute top-0 left-0 canvas-bg";
      fgCanvas.style.pointerEvents = "none"; // Events handled by interaction canvas
      fgCanvas.style.width = `${canvasMeta.width}px`; // Set base dimensions - container handles zoom
      fgCanvas.style.height = `${canvasMeta.height}px`;
      fgCanvas.id = `fg-${userId}`;

      const fgCtx = fgCanvas.getContext("2d");
      if (fgCtx) {
        fgCtx.imageSmoothingEnabled = false;
      }

      console.log(
        `Creating canvases for user ${userId}, inserting at position ${insertionIndex}`
      );

      const container = canvasContainerRef.current;
      const interactionCanvas = container.querySelector("#canvas"); // Find interaction canvas

      // Calculate correct z-index immediately based on current userOrder
      const userIndex = userOrder.indexOf(userId);
      const bgZIndex = calculateLayerZIndex(userIndex, "background");
      const fgZIndex = calculateLayerZIndex(userIndex, "foreground");

      bgCanvas.style.zIndex = bgZIndex.toString();
      fgCanvas.style.zIndex = fgZIndex.toString();

      console.log(
        `Created canvases for user ${userId.substring(
          0,
          8
        )} with z-indices: bg=${bgZIndex}, fg=${fgZIndex}`
      );

      // Simple insertion before interaction canvas
      if (interactionCanvas) {
        container.insertBefore(bgCanvas, interactionCanvas);
        container.insertBefore(fgCanvas, interactionCanvas);
      } else {
        container.appendChild(bgCanvas);
        container.appendChild(fgCanvas);
      }

      // Store both canvases
      userCanvasRefs.current.set(`${userId}-bg`, bgCanvas);
      userCanvasRefs.current.set(`${userId}-fg`, fgCanvas);

      console.log(`Created canvases for user ${userId}`);

      return { bgCanvas, fgCanvas };
    },
    [canvasMeta?.width, canvasMeta?.height, userOrder]
  );

  // Function to create drawing engine for a new user
  const createUserEngine = useCallback(
    (userId: string, username?: string) => {
      // Only create user engines when canvas dimensions are available
      if (!canvasMeta?.width || !canvasMeta?.height) {
        return;
      }

      // Check if user already exists
      const existingUser = userEnginesRef.current?.get(userId);
      if (existingUser) {
        // Update username if provided
        if (username && existingUser.username !== username) {
          existingUser.username = username;
        }
        return;
      }

      console.log(`Creating drawing engine for user: ${userId}`, { username });

      const engine = new DrawingEngine(canvasMeta.width, canvasMeta.height);

      // Only store the engine, not DOM canvases
      // Create DOM canvases for this user and attach to container (only if they don't exist)
      const existingBgCanvas = userCanvasRefs.current.get(`${userId}-bg`);
      const existingFgCanvas = userCanvasRefs.current.get(`${userId}-fg`);

      let canvasElements = null;
      if (!existingBgCanvas || !existingFgCanvas) {
        canvasElements = createUserCanvasElements(userId, 0);
      } else {
        canvasElements = {
          bgCanvas: existingBgCanvas,
          fgCanvas: existingFgCanvas,
        };
      }

      if (canvasElements) {
        // Attach DOM canvases to the drawing engine
        engine.attachDOMCanvases(
          canvasElements.bgCanvas,
          canvasElements.fgCanvas
        );

        // Update DOM canvases to show any existing content (immediate for initialization)
        engine.updateAllDOMCanvasesImmediate();

        // Show canvases
        canvasElements.bgCanvas.style.display = "block";
        canvasElements.fgCanvas.style.display = "block";
      }

      // Create offscreen canvas for this user (still needed for drawing operations)
      const canvas = document.createElement("canvas");
      canvas.width = canvasMeta.width;
      canvas.height = canvasMeta.height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = false;
      }

      userEnginesRef.current?.set(userId, {
        engine,
        username: username || "Unknown",
        canvas,
      });
    },
    [
      canvasMeta?.width,
      canvasMeta?.height,
      createUserCanvasElements,
      userEnginesRef,
    ]
  );

  // userOrder is now derived directly from participants via useMemo

  // Declaratively update z-indices when userOrder changes
  useEffect(() => {
    if (!userOrder.length) return; // Wait until we have participants

    console.log(
      "Declaratively updating canvas z-indices based on user order:",
      userOrder.map((id) => id.substring(0, 8))
    );
    console.log(
      "Available canvases:",
      Array.from(userCanvasRefs.current.keys())
    );

    userCanvasRefs.current.forEach((canvas, key) => {
      const userId = key.replace(/-[bf]g$/, ""); // Remove -bg or -fg suffix
      const layerType = key.endsWith("-bg") ? "background" : "foreground";
      const userIndex = userOrder.indexOf(userId);

      const zIndex = calculateLayerZIndex(userIndex, layerType);
      canvas.style.zIndex = zIndex.toString();

      console.log(
        `Set z-index for ${key} (user ${userId.substring(
          0,
          8
        )}, index ${userIndex}): ${zIndex}`
      );
    });
  }, [userOrder]); // React when userOrder derived from participants changes

  // Function to composite all canvases for export only
  const compositeCanvasesForExport = useCallback(() => {
    if (!canvasMeta?.width || !canvasMeta?.height) return null;

    // Composite all user layer canvases in z-index order
    const canvasElements = Array.from(userCanvasRefs.current.entries()).map(
      ([key, canvas]) => ({
        key,
        canvas,
        zIndex: parseInt(canvas.style.zIndex) || 0,
        isBackground: key.endsWith("-bg"),
      })
    );

    // Sort by z-index (lower z-index drawn first, appears below)
    canvasElements.sort((a, b) => a.zIndex - b.zIndex);

    // Extract sorted canvases
    const layers = canvasElements.map(({ canvas }) => canvas);

    return compositeLayersToCanvas(canvasMeta.width, canvasMeta.height, layers);
  }, [canvasMeta]);

  // Function to download current canvas as PNG
  const downloadCanvasAsPNG = useCallback(() => {
    if (!canvasMeta?.width || !canvasMeta?.height) return;

    try {
      // Use the composite function to create a single canvas with all layers
      const tempCanvas = compositeCanvasesForExport();
      if (!tempCanvas) return;

      downloadCanvas(tempCanvas);
    } catch (error) {
      console.error("Error in downloadCanvasAsPNG:", error);
    }
  }, [compositeCanvasesForExport, canvasMeta?.width, canvasMeta?.height]);

  // Update canvas when layer visibility changes
  useEffect(() => {
    // Update visibility for local user canvases only
    const localUserId = userIdRef.current;
    if (localUserId) {
      const localBgCanvas = userCanvasRefs.current.get(`${localUserId}-bg`);
      const localFgCanvas = userCanvasRefs.current.get(`${localUserId}-fg`);

      if (localBgCanvas) {
        localBgCanvas.style.display = drawingState.bgVisible ? "block" : "none";
      }
      if (localFgCanvas) {
        localFgCanvas.style.display = drawingState.fgVisible ? "block" : "none";
      }
    }
  }, [drawingState.fgVisible, drawingState.bgVisible, userIdRef]);

  // Trigger initial compositing when drawing engine is ready
  useEffect(() => {
    if (drawingEngine && userIdRef.current) {
      // Set up DOM canvases for local user (only once, avoid duplicates)
      const localUserId = userIdRef.current;
      const existingBgCanvas = userCanvasRefs.current.get(`${localUserId}-bg`);
      const existingFgCanvas = userCanvasRefs.current.get(`${localUserId}-fg`);

      let canvasElements = null;
      if (!existingBgCanvas || !existingFgCanvas) {
        canvasElements = createUserCanvasElements(localUserId, 0);
      } else {
        canvasElements = {
          bgCanvas: existingBgCanvas,
          fgCanvas: existingFgCanvas,
        };
      }

      if (canvasElements) {
        // Attach DOM canvases to the local drawing engine
        drawingEngine.attachDOMCanvases(
          canvasElements.bgCanvas,
          canvasElements.fgCanvas
        );

        // Update DOM canvases to show any existing content (immediate for initialization)
        drawingEngine.updateAllDOMCanvasesImmediate();

        // Set up initial layer visibility for local user
        canvasElements.bgCanvas.style.display = drawingState.bgVisible
          ? "block"
          : "none";
        canvasElements.fgCanvas.style.display = drawingState.fgVisible
          ? "block"
          : "none";
      }
    }
  }, [
    drawingEngine,
    createUserCanvasElements,
    drawingState.bgVisible,
    drawingState.fgVisible,
    userIdRef,
  ]);

  // Update canvas transform when zoom changes
  useEffect(() => {
    if (drawingEngine && canvasContainerRef.current) {
      drawingEngine.adjustPanForZoom(
        0,
        0,
        canvasContainerRef.current,
        currentZoom
      );
    }
  }, [currentZoom, drawingEngine]);

  // Force drawing system initialization when local canvas is ready
  useEffect(() => {
    if (localUserCanvasRef.current && canvasMeta?.width && canvasMeta?.height) {
      // The useDrawing hook should pick this up and initialize
    }
  }, [canvasMeta?.width, canvasMeta?.height]);

  return {
    canvasContainerRef,
    userCanvasRefs,
    localUserCanvasRef,
    createUserCanvasElements,
    createUserEngine,
    compositeCanvasesForExport,
    downloadCanvasAsPNG,
  };
};
