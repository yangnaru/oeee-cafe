import { useCallback, useRef, useEffect } from "react";
import { DrawingEngine } from "../DrawingEngine";
import { type CollaborationMeta } from "../types/collaboration";

interface CanvasElements {
  bgCanvas: HTMLCanvasElement;
  fgCanvas: HTMLCanvasElement;
}

interface CanvasHookParams {
  canvasMeta: CollaborationMeta | null;
  userOrderRef: React.RefObject<string[]>;
  userEnginesRef: React.RefObject<Map<string, { engine: DrawingEngine; username: string; canvas: HTMLCanvasElement }>>;
  drawingEngine: DrawingEngine | null;
  userIdRef: React.RefObject<string | null>;
  currentZoom: number;
  drawingState: {
    fgVisible: boolean;
    bgVisible: boolean;
  };
}

export const useCanvas = ({
  canvasMeta,
  userOrderRef,
  userEnginesRef,
  drawingEngine,
  userIdRef,
  currentZoom,
  drawingState,
}: CanvasHookParams) => {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const userCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const localUserCanvasRef = useRef<HTMLCanvasElement>(null);

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

      // Set z-index based on user order from server
      // Earlier users (lower index in userOrderRef) should appear on top (higher z-index)
      // Later users (higher index in userOrderRef) should appear below (lower z-index)
      const userIndex = userOrderRef.current?.indexOf(userId) ?? -1;
      const baseZIndex = userIndex !== -1 ? 1000 - userIndex * 10 : 100; // Higher index = lower z-index

      // Background layer gets base z-index, foreground gets +1
      bgCanvas.style.zIndex = baseZIndex.toString();
      fgCanvas.style.zIndex = (baseZIndex + 1).toString();

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
    [canvasMeta?.width, canvasMeta?.height, userOrderRef]
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
    [canvasMeta?.width, canvasMeta?.height, createUserCanvasElements, userEnginesRef]
  );

  // Function to update z-indices for all existing canvases based on current user order
  const updateCanvasZIndices = useCallback(() => {
    userCanvasRefs.current.forEach((canvas, key) => {
      const userId = key.replace(/-[bf]g$/, ""); // Remove -bg or -fg suffix
      const isBackground = key.endsWith("-bg");
      const userIndex = userOrderRef.current?.indexOf(userId) ?? -1;
      const baseZIndex = userIndex !== -1 ? 1000 - userIndex * 10 : 100;
      
      canvas.style.zIndex = (baseZIndex + (isBackground ? 0 : 1)).toString();
      console.log(`Updated z-index for ${key}: ${canvas.style.zIndex}`);
    });
  }, [userOrderRef]);

  // Function to composite all canvases for export only
  const compositeCanvasesForExport = useCallback(() => {
    if (!canvasMeta?.width || !canvasMeta?.height) return null;

    // Create a temporary canvas for compositing
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvasMeta.width;
    tempCanvas.height = canvasMeta.height;
    const tempCtx = tempCanvas.getContext("2d");

    if (!tempCtx) return null;

    // Fill background with white
    tempCtx.fillStyle = "#FFFFFF";
    tempCtx.fillRect(0, 0, canvasMeta.width, canvasMeta.height);

    // Composite all user layer canvases onto the temp canvas in z-index order
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

    // Draw all layers in z-index order
    canvasElements.forEach(({ canvas }) => {
      if (canvas.style.display !== "none") {
        tempCtx.drawImage(canvas, 0, 0);
      }
    });

    return tempCanvas;
  }, [canvasMeta]);

  // Function to download current canvas as PNG
  const downloadCanvasAsPNG = useCallback(() => {
    if (!canvasMeta?.width || !canvasMeta?.height) return;

    try {
      // Use the composite function to create a single canvas with all layers
      const tempCanvas = compositeCanvasesForExport();
      if (!tempCanvas) return;

      // Create download link
      const link = document.createElement("a");
      link.download = `canvas-${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/:/g, "-")}.png`;
      link.href = tempCanvas.toDataURL("image/png");

      // Trigger download
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
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
    updateCanvasZIndices,
    compositeCanvasesForExport,
    downloadCanvasAsPNG,
  };
};