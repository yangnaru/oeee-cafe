import { initializeBrushes, initializeTones } from "./constants/drawing";

export class DrawingEngine {
  public imageWidth: number;
  public imageHeight: number;
  public layers: { [key: string]: Uint8ClampedArray };
  public compositeBuffer: Uint8ClampedArray;
  public canvas: HTMLCanvasElement | null = null;

  // Offscreen canvases for hardware-accelerated compositing
  public layerCanvases: { [key: string]: HTMLCanvasElement } = {};
  public layerContexts: { [key: string]: CanvasRenderingContext2D } = {};
  public compositeCanvas: HTMLCanvasElement | null = null;
  public compositeContext: CanvasRenderingContext2D | null = null;

  // DOM canvases for direct rendering
  public domCanvases: { [key: string]: HTMLCanvasElement } = {};
  public domContexts: { [key: string]: CanvasRenderingContext2D } = {};

  // Batched update system
  private pendingUpdates = new Set<"foreground" | "background">();
  private updateScheduled = false;
  private rafId: number | null = null;

  private brush: { [key: number]: Uint8Array } = {};
  private tone: { [key: string]: Uint8Array } = {};
  private aerr = 0;
  private prevLine: [[number, number], [number, number]] | null = null;
  private panOffsetX = 0;
  private panOffsetY = 0;

  // Alpha calculation constants
  private static readonly ALPHATYPE_PEN = 0;
  private static readonly ALPHATYPE_FILL = 1;
  private static readonly ALPHATYPE_BRUSH = 2;

  constructor(width: number = 500, height: number = 500) {
    this.imageWidth = width;
    this.imageHeight = height;

    this.layers = {
      background: new Uint8ClampedArray(width * height * 4),
      foreground: new Uint8ClampedArray(width * height * 4),
    };

    this.compositeBuffer = new Uint8ClampedArray(width * height * 4);

    // Initialize offscreen canvases for hardware acceleration
    this.initializeOffscreenCanvases();

    this.brush = initializeBrushes();
    this.tone = initializeTones();
  }

  private initializeOffscreenCanvases() {
    // Create offscreen canvases for each layer
    ["background", "foreground"].forEach((layerName) => {
      const canvas = document.createElement("canvas");
      canvas.width = this.imageWidth;
      canvas.height = this.imageHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = false;
        this.layerCanvases[layerName] = canvas;
        this.layerContexts[layerName] = ctx;
      }
    });

  }


  // Function to get tone data based on alpha value
  private getToneData(alpha: number): Uint8Array {
    const alphaTable = [
      23, 47, 69, 92, 114, 114, 114, 138, 161, 184, 184, 207, 230, 230, 253,
    ];
    for (let i = 0; i < alphaTable.length; i++) {
      if (alpha < alphaTable[i]) {
        return this.tone[i] as Uint8Array;
      }
    }
    return this.tone[alphaTable.length] as Uint8Array;
  }

  private getAlpha(type: number, opacity: number): number {
    let a1 = opacity / 255.0;

    switch (type) {
      case DrawingEngine.ALPHATYPE_PEN:
        if (a1 > 0.5) {
          a1 = 1.0 / 16 + ((a1 - 0.5) * 30.0) / 16;
        } else {
          a1 = Math.sqrt(2 * a1) / 16.0;
        }
        a1 = Math.min(1, Math.max(0, a1));
        break;

      case DrawingEngine.ALPHATYPE_FILL:
        a1 = -0.00056 * a1 + 0.0042 / (1.0 - a1) - 0.0042;
        a1 = Math.min(1.0, Math.max(0, a1 * 10));
        break;

      case DrawingEngine.ALPHATYPE_BRUSH:
        a1 = -0.00056 * a1 + 0.0042 / (1.0 - a1) - 0.0042;
        a1 = Math.min(1.0, Math.max(0, a1));
        break;
    }

    if (a1 < 1.0 / 255) {
      this.aerr += a1;
      a1 = 0;
      while (this.aerr > 1.0 / 255) {
        a1 = 1.0 / 255;
        this.aerr -= 1.0 / 255;
      }
    }

    return a1;
  }

  // Function to composite layers with FG on top of BG
  public compositeLayers(fgVisible: boolean = true, bgVisible: boolean = true) {
    for (let i = 0; i < this.compositeBuffer.length; i += 4) {
      // Get background layer values (only if visible)
      const bgR = bgVisible ? this.layers.background[i] : 0;
      const bgG = bgVisible ? this.layers.background[i + 1] : 0;
      const bgB = bgVisible ? this.layers.background[i + 2] : 0;
      const bgA = bgVisible ? this.layers.background[i + 3] / 255 : 0;

      // Get foreground layer values (only if visible)
      const fgR = fgVisible ? this.layers.foreground[i] : 0;
      const fgG = fgVisible ? this.layers.foreground[i + 1] : 0;
      const fgB = fgVisible ? this.layers.foreground[i + 2] : 0;
      const fgA = fgVisible ? this.layers.foreground[i + 3] / 255 : 0;

      // Alpha composite: FG over BG
      const outA = fgA + bgA * (1 - fgA);

      if (outA > 0) {
        this.compositeBuffer[i] = Math.round(
          (fgR * fgA + bgR * bgA * (1 - fgA)) / outA
        );
        this.compositeBuffer[i + 1] = Math.round(
          (fgG * fgA + bgG * bgA * (1 - fgA)) / outA
        );
        this.compositeBuffer[i + 2] = Math.round(
          (fgB * fgA + bgB * bgA * (1 - fgA)) / outA
        );
        this.compositeBuffer[i + 3] = Math.round(outA * 255);
      } else {
        this.compositeBuffer[i] = 0;
        this.compositeBuffer[i + 1] = 0;
        this.compositeBuffer[i + 2] = 0;
        this.compositeBuffer[i + 3] = 0;
      }
    }
  }

  // Get individual layer canvas for hardware compositing
  public getLayerCanvas(
    layerName: "foreground" | "background"
  ): HTMLCanvasElement | null {
    // Update the offscreen canvas with current layer data
    const layerData = this.layers[layerName];
    const context = this.layerContexts[layerName];
    const canvas = this.layerCanvases[layerName];

    if (!context || !canvas || !layerData) {
      return null;
    }

    // Push current layer data to canvas
    const imageData = new ImageData(
      layerData,
      this.imageWidth,
      this.imageHeight
    );
    context.putImageData(imageData, 0, 0);

    return canvas;
  }

  // Get individual layer canvas for direct rendering
  public getLayerCanvasForRendering(layerName: "foreground" | "background"): HTMLCanvasElement | null {
    return this.layerCanvases[layerName] || null;
  }

  // Attach DOM canvases for direct updating
  public attachDOMCanvases(
    backgroundCanvas: HTMLCanvasElement,
    foregroundCanvas: HTMLCanvasElement
  ) {
    this.domCanvases.background = backgroundCanvas;
    this.domCanvases.foreground = foregroundCanvas;

    const bgCtx = backgroundCanvas.getContext("2d");
    const fgCtx = foregroundCanvas.getContext("2d");

    if (bgCtx) {
      bgCtx.imageSmoothingEnabled = false;
      this.domContexts.background = bgCtx;
    }

    if (fgCtx) {
      fgCtx.imageSmoothingEnabled = false;
      this.domContexts.foreground = fgCtx;
    }
  }

  // Update DOM canvas for a specific layer
  private updateDOMCanvas(layerName: "foreground" | "background") {
    const domCtx = this.domContexts[layerName];
    const layerData = this.layers[layerName];

    if (domCtx && layerData) {
      const imageData = new ImageData(
        layerData,
        this.imageWidth,
        this.imageHeight
      );
      domCtx.putImageData(imageData, 0, 0);
    }
  }

  // Update all attached DOM canvases
  public updateAllDOMCanvases() {
    this.updateDOMCanvas("background");
    this.updateDOMCanvas("foreground");
  }

  // Batched update methods
  private scheduleBatchedUpdate() {
    if (!this.updateScheduled) {
      this.updateScheduled = true;
      this.rafId = requestAnimationFrame(() => this.processBatchedUpdates());
    }
  }

  private processBatchedUpdates() {
    // Process all pending updates
    for (const layerName of this.pendingUpdates) {
      this.updateDOMCanvas(layerName);
    }
    
    // Clear pending updates
    this.pendingUpdates.clear();
    this.updateScheduled = false;
    this.rafId = null;
  }

  // Queue a layer for batched update
  public queueLayerUpdate(layerName: "foreground" | "background") {
    this.pendingUpdates.add(layerName);
    this.scheduleBatchedUpdate();
  }

  // Force immediate update of all pending layers
  public flushBatchedUpdates() {
    if (this.updateScheduled && this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.processBatchedUpdates();
    }
  }

  // For critical operations that need immediate rendering (like initialization)
  public updateAllDOMCanvasesImmediate() {
    // Cancel any pending batched update and clear queue
    if (this.updateScheduled && this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.updateScheduled = false;
    }
    this.pendingUpdates.clear();
    
    // Immediate update
    this.updateDOMCanvas("background");
    this.updateDOMCanvas("foreground");
  }

  // Pan offset management
  public updatePanOffset(
    deltaX: number,
    deltaY: number,
    container?: HTMLCanvasElement | HTMLDivElement,
    zoomScale?: number
  ) {
    this.panOffsetX += deltaX;
    this.panOffsetY += deltaY;
    this.updateCanvasPan(container, zoomScale);
  }

  public adjustPanForZoom(
    deltaX: number,
    deltaY: number,
    container?: HTMLCanvasElement | HTMLDivElement,
    zoomScale?: number
  ) {
    this.panOffsetX += deltaX;
    this.panOffsetY += deltaY;
    this.updateCanvasPan(container, zoomScale);
  }

  public resetPan(container?: HTMLCanvasElement | HTMLDivElement, zoomScale?: number) {
    this.panOffsetX = 0;
    this.panOffsetY = 0;
    this.updateCanvasPan(container, zoomScale);
  }

  private updateCanvasPan(container?: HTMLCanvasElement | HTMLDivElement, zoomScale?: number) {
    if (!container) return;

    // Combine scale and translate transforms
    const scaleTransform = zoomScale ? `scale(${zoomScale})` : '';
    const translateTransform = `translate(${this.panOffsetX}px, ${this.panOffsetY}px)`;
    
    container.style.transform = scaleTransform 
      ? `${scaleTransform} ${translateTransform}` 
      : translateTransform;
  }

  public drawPoint(
    ctx: Uint8ClampedArray,
    px: number,
    py: number,
    size: number,
    r: number,
    g: number,
    b: number,
    a: number,
    updatePrevLine: boolean = true
  ) {
    const d = size;
    const r0 = Math.floor(d / 2);
    const x = px - r0;
    const y = py - r0;

    const shape = this.brush[d];
    let shapeIndex = 0;

    const r1 = r;
    const g1 = g;
    const b1 = b;
    const a1 = a;

    if (a1 === 0) return;

    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        const currentX = x + j;
        const currentY = y + i;

        if (
          currentX >= 0 &&
          currentX < this.imageWidth &&
          currentY >= 0 &&
          currentY < this.imageHeight &&
          shape[shapeIndex]
        ) {
          const index = (currentY * this.imageWidth + currentX) * 4;

          const r0 = ctx[index + 0];
          const g0 = ctx[index + 1];
          const b0 = ctx[index + 2];
          const a0 = ctx[index + 3] / 255.0;

          const alpha = a0 + a1 - a0 * a1;
          if (alpha > 0) {
            const a1x = Math.max(a1, 1.0 / 255);

            let r = (r1 * a1x + r0 * a0 * (1 - a1x)) / alpha;
            let g = (g1 * a1x + g0 * a0 * (1 - a1x)) / alpha;
            let b = (b1 * a1x + b0 * a0 * (1 - a1x)) / alpha;

            r = r1 > r0 ? Math.ceil(r) : Math.floor(r);
            g = g1 > g0 ? Math.ceil(g) : Math.floor(g);
            b = b1 > b0 ? Math.ceil(b) : Math.floor(b);

            const finalAlpha = Math.ceil(alpha * 255);

            ctx[index + 0] = r;
            ctx[index + 1] = g;
            ctx[index + 2] = b;
            ctx[index + 3] = finalAlpha;
          }
        }
        shapeIndex++;
      }
    }

    // Update prevLine to track this point (used for standalone point drawing)
    if (updatePrevLine) {
      this.prevLine = [
        [px, py],
        [px, py],
      ];
    }
  }

  private erasePoint(
    ctx: Uint8ClampedArray,
    px: number,
    py: number,
    size: number,
    a: number,
    updatePrevLine: boolean = true
  ) {
    const d = size;
    const r0 = Math.floor(d / 2);
    const x = px - r0;
    const y = py - r0;

    const shape = this.brush[d];
    let shapeIndex = 0;
    const eraserAlpha = Math.floor(a * 255); // Convert to 0-255 range

    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        const currentX = x + j;
        const currentY = y + i;

        if (
          currentX >= 0 &&
          currentX < this.imageWidth &&
          currentY >= 0 &&
          currentY < this.imageHeight &&
          shape[shapeIndex]
        ) {
          const index = (currentY * this.imageWidth + currentX) * 4;

          // Neo.Painter eraser algorithm
          ctx[index + 3] -= eraserAlpha / ((d * (255.0 - eraserAlpha)) / 255.0);

          // Clamp alpha to valid range
          ctx[index + 3] = Math.max(0, Math.min(255, ctx[index + 3]));
        }
        shapeIndex++;
      }
    }

    // Update prevLine to track this point (used for standalone point drawing)
    if (updatePrevLine) {
      this.prevLine = [
        [px, py],
        [px, py],
      ];
    }

    // Queue DOM canvas update if layer is attached
    const layerName = ctx === this.layers.background ? "background" : "foreground";
    this.queueLayerUpdate(layerName);
  }

  // Helper function to fill a horizontal line with direct replacement
  private fillHorizontalLine(
    buf8: Uint8ClampedArray,
    x0: number,
    x1: number,
    y: number,
    r: number,
    g: number,
    b: number,
    a: number
  ) {
    const width = this.imageWidth;
    for (let x = x0; x <= x1; x++) {
      const index = (y * width + x) * 4;
      buf8[index] = r;
      buf8[index + 1] = g;
      buf8[index + 2] = b;
      buf8[index + 3] = a;
    }
  }

  // Helper function to scan a line for connected pixels (Neo.Painter version)
  private scanLine(
    x0: number,
    x1: number,
    y: number,
    stack: { x: number; y: number }[]
  ) {
    for (let x = x0; x <= x1; x++) {
      stack.push({ x: x, y: y });
    }
  }

  // Neo.Painter flood fill algorithm with alpha support
  public doFloodFill(
    ctx: Uint8ClampedArray,
    startX: number,
    startY: number,
    fillR: number,
    fillG: number,
    fillB: number,
    fillA: number
  ) {
    const x = Math.round(startX);
    const y = Math.round(startY);

    if (x < 0 || x >= this.imageWidth || y < 0 || y >= this.imageHeight) {
      return;
    }

    const width = this.imageWidth;
    const stack: { x: number; y: number }[] = [{ x: x, y: y }];

    // Get starting pixel color
    const startIndex = (y * width + x) * 4;
    const baseR = ctx[startIndex];
    const baseG = ctx[startIndex + 1];
    const baseB = ctx[startIndex + 2];
    const baseA = ctx[startIndex + 3];

    // Don't fill if colors are the same
    if (
      baseR === fillR &&
      baseG === fillG &&
      baseB === fillB &&
      baseA === fillA
    ) {
      return;
    }

    // Scale stack limit proportionally to canvas size
    // Base limit of 1M for a 500x500 canvas, scale proportionally
    const baseCanvasSize = 500 * 500;
    const currentCanvasSize = this.imageWidth * this.imageHeight;
    const scaleFactor = currentCanvasSize / baseCanvasSize;
    const maxStackSize = Math.floor(1000000 * scaleFactor);

    while (stack.length > 0) {
      if (stack.length > maxStackSize) {
        break;
      }

      const point = stack.pop()!;
      const px = point.x;
      const py = point.y;
      let x0 = px;
      let x1 = px;

      const pixelIndex = (py * width + px) * 4;

      // Check if pixel matches base color
      if (
        ctx[pixelIndex] !== baseR ||
        ctx[pixelIndex + 1] !== baseG ||
        ctx[pixelIndex + 2] !== baseB ||
        ctx[pixelIndex + 3] !== baseA
      )
        continue;

      // Expand left
      for (; x0 > 0; x0--) {
        const leftIndex = (py * width + (x0 - 1)) * 4;
        if (
          ctx[leftIndex] !== baseR ||
          ctx[leftIndex + 1] !== baseG ||
          ctx[leftIndex + 2] !== baseB ||
          ctx[leftIndex + 3] !== baseA
        )
          break;
      }

      // Expand right
      for (; x1 < this.imageWidth - 1; x1++) {
        const rightIndex = (py * width + (x1 + 1)) * 4;
        if (
          ctx[rightIndex] !== baseR ||
          ctx[rightIndex + 1] !== baseG ||
          ctx[rightIndex + 2] !== baseB ||
          ctx[rightIndex + 3] !== baseA
        )
          break;
      }

      this.fillHorizontalLine(ctx, x0, x1, py, fillR, fillG, fillB, fillA);

      if (py + 1 < this.imageHeight) {
        this.scanLine(x0, x1, py + 1, stack);
      }
      if (py - 1 >= 0) {
        this.scanLine(x0, x1, py - 1, stack);
      }
    }

    // Queue DOM canvas update if layer is attached
    const layerName = ctx === this.layers.background ? "background" : "foreground";
    this.queueLayerUpdate(layerName);
  }

  private drawTone(
    buf8: Uint8ClampedArray,
    x0: number,
    y0: number,
    d: number,
    r: number,
    g: number,
    b: number,
    a: number
  ) {
    const r0 = Math.floor(d / 2);

    const x = x0 - r0;
    const y = y0 - r0;

    const shape = this.brush[d];
    let shapeIndex = 0;

    const toneData = this.getToneData(a);

    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        const currentX = x + j;
        const currentY = y + i;

        if (
          currentX >= 0 &&
          currentX < this.imageWidth &&
          currentY >= 0 &&
          currentY < this.imageHeight &&
          shape[shapeIndex]
        ) {
          // Use absolute screen coordinates for tone pattern
          if (toneData[(currentY % 4) * 4 + (currentX % 4)]) {
            const index = (currentY * this.imageWidth + currentX) * 4;
            buf8[index + 0] = r;
            buf8[index + 1] = g;
            buf8[index + 2] = b;
            buf8[index + 3] = 255;
          }
        }
        shapeIndex++;
      }
    }
  }

  public drawLine(
    ctx: Uint8ClampedArray,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    brushSize: number,
    brushType: string,
    r: number,
    g: number,
    b: number,
    opacity: number
  ) {
    this.aerr = 0;
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = (dx > dy ? dx : -dy) / 2;

    let currentX = x0;
    let currentY = y0;

    let a = 1;
    if (brushType === "solid") {
      a = this.getAlpha(DrawingEngine.ALPHATYPE_PEN, opacity);
    } else if (brushType === "halftone") {
      a = opacity / 255.0;
    } else if (brushType === "eraser") {
      a = opacity / 255.0;
    }

    while (true) {
      // Check if this point should be plotted (avoid double-plotting)
      if (
        this.prevLine === null ||
        !(
          (this.prevLine[0][0] === currentX &&
            this.prevLine[0][1] === currentY) ||
          (this.prevLine[1][0] === currentX && this.prevLine[1][1] === currentY)
        )
      ) {
        if (brushType === "solid") {
          this.drawPoint(ctx, currentX, currentY, brushSize, r, g, b, a, false);
        } else if (brushType === "halftone") {
          this.drawTone(ctx, currentX, currentY, brushSize, r, g, b, a * 255);
        } else if (brushType === "eraser") {
          this.erasePoint(ctx, currentX, currentY, brushSize, a, false);
        }
      }

      if (currentX === x1 && currentY === y1) break;

      const e2 = err;
      if (e2 > -dx) {
        err -= dy;
        currentX += sx;
      }
      if (e2 < dy) {
        err += dx;
        currentY += sy;
      }
    }

    // Update prevLine to track this line segment
    this.prevLine = [
      [x0, y0],
      [x1, y1],
    ];

    // Queue DOM canvas update if layer is attached
    const layerName = ctx === this.layers.background ? "background" : "foreground";
    this.queueLayerUpdate(layerName);
  }

  public initialize(ctx?: CanvasRenderingContext2D) {
    // Store the canvas reference
    if (ctx) {
      this.canvas = ctx.canvas;
    }

    // Initial composite and render
    this.compositeLayers();

    if (ctx) {
      ctx.imageSmoothingEnabled = false;
      ctx.putImageData(
        new ImageData(this.compositeBuffer, this.imageWidth, this.imageHeight),
        0,
        0
      );
    }
  }

  public dispose() {
    // Cancel any pending animation frame
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // Clean up resources if needed
    this.layers.background = new Uint8ClampedArray(0);
    this.layers.foreground = new Uint8ClampedArray(0);
    this.compositeBuffer = new Uint8ClampedArray(0);

    // Clean up offscreen canvases
    this.layerCanvases = {};
    this.layerContexts = {};
    this.compositeCanvas = null;
    this.compositeContext = null;

    // Reset batched update state
    this.pendingUpdates.clear();
    this.updateScheduled = false;
  }
}
