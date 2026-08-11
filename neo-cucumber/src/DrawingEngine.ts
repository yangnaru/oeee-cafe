import { LINETYPE, NeoPainter } from "./neo/NeoPainter";
import { BufferSurface } from "./neo/PixelSurface";
import { fillToolTypeFor, type RegionTool } from "./neo/tools";

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

  /** The verified NEO transcription; all pixel work goes through it. */
  private readonly neo: NeoPainter;
  private readonly backgroundSurface: BufferSurface;
  private readonly foregroundSurface: BufferSurface;

  /** Mask settings, applied to every stroke. NEO's MASKTYPE_NONE by default. */
  public maskType = 0;
  public maskColor: [number, number, number] = [0, 0, 0];

  // Stroke continuation state accessors: collaborative replay tracks a
  // per-user stroke state externally so line-joint deduplication is a
  // deterministic function of the canonical message sequence
  public getStrokeState(): [[number, number], [number, number]] | null {
    const prev = this.neo.prevLine;
    return prev === null
      ? null
      : [
          [prev[0][0], prev[0][1]],
          [prev[1][0], prev[1][1]],
        ];
  }

  public setStrokeState(
    state: [[number, number], [number, number]] | null
  ): void {
    this.neo.prevLine = state;
  }
  private panOffsetX = 0;
  private panOffsetY = 0;
  private isFlippedHorizontal = false;

  // Alpha calculation constants

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

    this.neo = new NeoPainter(width, height);
    this.backgroundSurface = new BufferSurface(this.layers.background, width, height);
    this.foregroundSurface = new BufferSurface(this.layers.foreground, width, height);
    // Layer-addressed operations (the region tools) resolve through this, so
    // it has to point at the engine's buffers rather than the painter's own
    // canvases, which nothing here draws to.
    this.neo.surfaces = [this.backgroundSurface, this.foregroundSurface];
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
      new Uint8ClampedArray(layerData),
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
        new Uint8ClampedArray(layerData),
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

  // Pan offset management - applies to all canvases
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

  public setFlippedHorizontal(isFlipped: boolean, container?: HTMLCanvasElement | HTMLDivElement, zoomScale?: number) {
    this.isFlippedHorizontal = isFlipped;
    this.updateCanvasPan(container, zoomScale);
  }

  private updateCanvasPan(container?: HTMLCanvasElement | HTMLDivElement, zoomScale?: number) {
    if (!container) return;

    // Combine flip, scale, and translate transforms
    const flipTransform = this.isFlippedHorizontal ? 'scaleX(-1)' : '';
    const scaleTransform = zoomScale ? `scale(${zoomScale})` : '';
    const translateTransform = `translate(${this.panOffsetX}px, ${this.panOffsetY}px)`;

    // Build transform string with all active transforms
    const transforms = [flipTransform, scaleTransform, translateTransform].filter(t => t);
    const transform = transforms.join(' ');
    
    // Find the actual canvas container
    let actualContainer: HTMLElement | null = null;
    
    if (container.tagName === 'CANVAS') {
      // If we got a canvas, find its parent container
      actualContainer = container.closest('.canvas-container');
    } else {
      // If we got a div, use it directly
      actualContainer = container;
    }
    
    if (!actualContainer) {
      // Fallback: find container in document
      const containerDiv = document.querySelector('.canvas-container') as HTMLElement;
      if (containerDiv) {
        containerDiv.style.transform = transform;
      }
      return;
    }
    
    // Apply transform to the container itself
    actualContainer.style.transform = transform;
  }

  /** Maps the painter's brush names onto NEO's line types. */
  private static lineTypeFor(brushType: string): number {
    switch (brushType) {
      case "eraser":
        return LINETYPE.ERASER;
      case "halftone":
        return LINETYPE.TONE;
      case "brush":
        return LINETYPE.BRUSH;
      case "dodge":
        return LINETYPE.DODGE;
      case "burn":
        return LINETYPE.BURN;
      case "blur":
        return LINETYPE.BLUR;
      default:
        // solid, and the non-drawing tools that still stamp a pixel
        return LINETYPE.PEN;
    }
  }

  private surfaceFor(ctx: Uint8ClampedArray): BufferSurface {
    return ctx === this.layers.background
      ? this.backgroundSurface
      : this.foregroundSurface;
  }

  public doFloodFill(
    ctx: Uint8ClampedArray,
    startX: number,
    startY: number,
    fillR: number,
    fillG: number,
    fillB: number,
    fillA: number
  ) {
    // NEO packs the fill colour ABGR
    const color =
      ((fillA & 0xff) << 24) |
      ((fillB & 0xff) << 16) |
      ((fillG & 0xff) << 8) |
      (fillR & 0xff);
    this.neo.doFloodFill(this.surfaceFor(ctx), startX, startY, color);

    const layerName = ctx === this.layers.background ? "background" : "foreground";
    this.queueLayerUpdate(layerName);
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
    this.neo._currentColor = [r, g, b, opacity];
    this.neo._currentWidth = brushSize;
    this.neo._currentMaskType = this.maskType;
    this.neo._currentMask = this.maskColor;

    this.neo.drawLine(
      this.surfaceFor(ctx),
      x0,
      y0,
      x1,
      y1,
      DrawingEngine.lineTypeFor(brushType)
    );

    const layerName = ctx === this.layers.background ? "background" : "foreground";
    this.queueLayerUpdate(layerName);
  }

  /**
   * Applies a region tool to a rectangle, in the layer the caller names.
   *
   * One entry point rather than a switch at every call site: the painter, the
   * replay recorder and the collaborative history all need the same mapping
   * from tool to kernel, and three copies of it would eventually disagree.
   */
  public applyRegionTool(
    tool: RegionTool,
    layer: "foreground" | "background",
    rect: { x: number; y: number; width: number; height: number },
    color: { r: number; g: number; b: number; a: number },
    brushSize: number
  ): void {
    const index = layer === "foreground" ? 1 : 0;
    const { x, y, width, height } = rect;

    this.neo._currentColor = [color.r, color.g, color.b, color.a];
    this.neo._currentWidth = brushSize;
    this.neo._currentMaskType = this.maskType;
    this.neo._currentMask = this.maskColor;

    const fillType = fillToolTypeFor(tool);
    if (fillType !== null) {
      this.neo.doFill(index, x, y, width, height, fillType);
    } else {
      switch (tool) {
        case "eraseRect":
          this.neo.eraseRect(index, x, y, width, height);
          break;
        case "blurRect":
          this.neo.blurRect(index, x, y, width, height);
          break;
        case "merge":
          this.neo.merge(index, x, y, width, height);
          break;
        case "flipH":
          this.neo.flipH(index, x, y, width, height);
          break;
        case "flipV":
          this.neo.flipV(index, x, y, width, height);
          break;
        case "turn":
          this.neo.turn(index, x, y, width, height);
          break;
        case "copy":
          // Reads into the clipboard; writes nothing
          this.neo.copy(index, x, y, width, height);
          break;
        case "paste":
          // Dropped at the dragged rectangle rather than offset from the
          // source, so the destination is the drag and dx/dy are zero.
          this.neo.paste(index, x, y, width, height, 0, 0);
          break;
      }
    }

    // merge writes both layers; the rest write one, but queueing both costs a
    // repaint rather than a correctness problem.
    this.queueLayerUpdate("background");
    this.queueLayerUpdate("foreground");
  }

  /** Clears a whole layer, NEO's EraseAllTool. */
  public eraseAll(layer: "foreground" | "background"): void {
    this.neo.eraseAll(layer === "foreground" ? 1 : 0);
    this.queueLayerUpdate(layer);
  }

  /**
   * Draws text onto a layer.
   *
   * NEO rasterises text through a scratch canvas and composites the result, so
   * this does the same and then blends that canvas into the layer buffer --
   * fillText has no buffer equivalent to call.
   */
  public drawText(
    layer: "foreground" | "background",
    x: number,
    y: number,
    color: { r: number; g: number; b: number },
    alpha: number,
    text: string,
    fontSize: string,
    fontFamily: string
  ): void {
    if (!text) return;
    const scratch = this.neo.canvasCtx[0];
    scratch.clearRect(0, 0, this.imageWidth, this.imageHeight);

    // NEO packs the colour with red in the low byte
    const packed = color.r | (color.g << 8) | (color.b << 16);
    this.neo.doText(0, x, y, packed, alpha, text, fontSize, fontFamily);

    const drawn = scratch.getImageData(0, 0, this.imageWidth, this.imageHeight).data;
    const target = this.layers[layer];
    for (let i = 0; i < target.length; i += 4) {
      const a1 = drawn[i + 3] / 255;
      if (a1 === 0) continue;
      const a0 = target[i + 3] / 255;
      const a = a0 + a1 - a0 * a1;
      target[i] = (drawn[i] * a1 + target[i] * a0 * (1 - a1)) / a;
      target[i + 1] = (drawn[i + 1] * a1 + target[i + 1] * a0 * (1 - a1)) / a;
      target[i + 2] = (drawn[i + 2] * a1 + target[i + 2] * a0 * (1 - a1)) / a;
      target[i + 3] = Math.round(a * 255);
    }
    scratch.clearRect(0, 0, this.imageWidth, this.imageHeight);
    this.queueLayerUpdate(layer);
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
        new ImageData(new Uint8ClampedArray(this.compositeBuffer), this.imageWidth, this.imageHeight),
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
