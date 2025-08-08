// Canvas Drawing Engine
// Handles pixel-perfect drawing, brush mechanics, and drawing tools

interface DrawingOptions {
    canvasWidth?: number;
    canvasHeight?: number;
    [key: string]: any;
}

interface HalftonePattern {
    width: number;
    height: number;
    data: number[];
}

interface Layer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    visible: boolean;
    opacity: number;
}

export class CanvasDrawing {
    options: DrawingOptions;
    
    // Drawing state
    currentTool: string = 'brush';
    brushSize: number = 30;
    brushOpacity: number = 1;
    currentColor: string = '#000000';
    blendMode: string = 'source-over';
    brushSpacing: number = 0.1;
    
    // Precision drawing features
    currentPrecisionTool: string = 'pixel';
    halftonePatterns: Map<string, HalftonePattern> = new Map();
    
    // Stroke buffering for opacity handling
    strokeCanvas: HTMLCanvasElement | null = null;
    strokeCtx: CanvasRenderingContext2D | null = null;
    isStrokeActive: boolean = false;
    
    // Initialize round brush data for pixel-perfect drawing
    roundData: { [key: number]: Uint8Array } = {};

    constructor(options: DrawingOptions = {}) {
        this.options = options;
        this.init();
    }
    
    private init(): void {
        this.initializeHalftonePatterns();
        this.initializeRoundData();
    }
    
    private initializeHalftonePatterns(): void {
        // Generate PaintBBS-style tone data arrays for different densities
        const bayerPattern = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
        
        // Create tone patterns at different density levels (like PaintBBS)
        for (let density = 0; density < 16; density++) {
            const toneData = new Array(16);
            for (let j = 0; j < 16; j++) {
                toneData[j] = density >= bayerPattern[j] ? 1 : 0;
            }
            this.halftonePatterns.set(`tone_${density}`, {
                width: 4, height: 4,
                data: toneData
            });
        }
        
        // Keep original 4x4 Bayer for compatibility
        this.halftonePatterns.set('bayer4x4', {
            width: 4, height: 4,
            data: bayerPattern
        });
        
        // 2x2 Bayer pattern
        this.halftonePatterns.set('bayer2x2', {
            width: 2, height: 2,
            data: [0, 2, 3, 1]
        });
        
        
        // Line patterns
        this.halftonePatterns.set('lines4x4', {
            width: 4, height: 4,
            data: [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15]
        });
    }
    
    
    private initializeRoundData(): void {
        // Initialize brush shape data similar to Neo's _roundData
        for (let r = 1; r <= 30; r++) {
            this.roundData[r] = new Uint8Array(r * r);
            const mask = this.roundData[r];
            let index = 0;
            
            for (let x = 0; x < r; x++) {
                for (let y = 0; y < r; y++) {
                    const xx = x + 0.5 - r / 2.0;
                    const yy = y + 0.5 - r / 2.0;
                    mask[index++] = (xx * xx + yy * yy <= (r * r) / 4) ? 1 : 0;
                }
            }
        }
        
        // Apply Neo's specific tweaks for small brushes
        if (this.roundData[3]) {
            this.roundData[3][0] = 0;
            this.roundData[3][2] = 0;
            this.roundData[3][6] = 0;
            this.roundData[3][8] = 0;
        }
        
        if (this.roundData[5]) {
            this.roundData[5][1] = 0;
            this.roundData[5][3] = 0;
            this.roundData[5][5] = 0;
            this.roundData[5][9] = 0;
            this.roundData[5][15] = 0;
            this.roundData[5][19] = 0;
            this.roundData[5][21] = 0;
            this.roundData[5][23] = 0;
        }
    }
    
    private getToneLevel(opacity: number): number {
        // Neo's alpha-to-tone mapping: Convert opacity (0-1) to alpha (0-255), then map to tone level (0-15)
        const alpha = Math.floor(opacity * 255);
        
        // Neo's alphaTable - maps alpha values to tone levels
        const alphaTable = [
            23, 47, 69, 92, 114, 114, 114, 138, 161, 184, 184, 207, 230, 230, 253
        ];
        
        for (let i = 0; i < alphaTable.length; i++) {
            if (alpha < alphaTable[i]) {
                return i;
            }
        }
        return alphaTable.length; // Return max tone level (15) for highest opacity
    }
    
    initializeStrokeBuffer(canvasWidth: number, canvasHeight: number): void {
        // Create an off-screen canvas for stroke buffering
        this.strokeCanvas = document.createElement('canvas');
        this.strokeCanvas.width = canvasWidth;
        this.strokeCanvas.height = canvasHeight;
        this.strokeCtx = this.strokeCanvas.getContext('2d', { willReadFrequently: true })!;
        
        // Set same properties as main canvas
        this.strokeCtx.imageSmoothingEnabled = false;
        (this.strokeCtx as any).webkitImageSmoothingEnabled = false;
        (this.strokeCtx as any).mozImageSmoothingEnabled = false;
        (this.strokeCtx as any).msImageSmoothingEnabled = false;
        this.strokeCtx.lineCap = 'square';
        this.strokeCtx.lineJoin = 'miter';
    }
    
    beginStroke(): void {
        // Ensure stroke buffer is initialized
        if (!this.strokeCanvas || !this.strokeCtx) {
            console.warn('Stroke buffer not initialized, reinitializing');
            this.initializeStrokeBuffer(this.options.canvasWidth || 800, this.options.canvasHeight || 600);
        }
        
        // Clear the stroke buffer and prepare for new stroke
        this.isStrokeActive = true;
        this.strokeCtx!.clearRect(0, 0, this.strokeCanvas!.width, this.strokeCanvas!.height);
        this.strokeCtx!.globalCompositeOperation = 'source-over';
    }
    
    endStroke(targetLayer: Layer): void {
        if (!this.isStrokeActive || !targetLayer) return;
        
        // Composite the stroke buffer to the main canvas with the brush opacity
        const ctx = targetLayer.ctx;
        ctx.save();
        ctx.globalAlpha = this.brushOpacity * targetLayer.opacity;
        ctx.globalCompositeOperation = this.blendMode as GlobalCompositeOperation;
        ctx.drawImage(this.strokeCanvas!, 0, 0);
        ctx.restore();
        
        this.isStrokeActive = false;
    }
    
    // Pixel-perfect drawing method
    drawPixelPerfectPoint(x: number, y: number, color?: string, size?: number, opacity?: number, targetLayer?: Layer | null): void {
        const ctx = this.isStrokeActive ? this.strokeCtx! : targetLayer!.ctx;
        const d = Math.max(1, Math.min(30, size || this.brushSize));
        
        const shape = this.roundData[d];
        if (!shape) {
            console.warn('No brush shape data for size:', d);
            return;
        }
        
        const r0 = Math.floor(d / 2);
        const startX = Math.floor(x) - r0;
        const startY = Math.floor(y) - r0;
        
        // Bounds checking
        if (startX < 0 || startY < 0 || startX + d > ctx.canvas.width || startY + d > ctx.canvas.height) {
            return;
        }
        
        const imageData = ctx.getImageData(startX, startY, d, d);
        const buf8 = imageData.data;
        
        // Parse color
        const brushColor = color || this.currentColor;
        let r: number, g: number, b: number;
        
        if (typeof brushColor === 'string') {
            if (brushColor.startsWith('#')) {
                const hex = brushColor.slice(1);
                if (hex.length === 6) {
                    r = parseInt(hex.substr(0, 2), 16);
                    g = parseInt(hex.substr(2, 2), 16);
                    b = parseInt(hex.substr(4, 2), 16);
                } else if (hex.length === 3) {
                    r = parseInt(hex.substr(0, 1) + hex.substr(0, 1), 16);
                    g = parseInt(hex.substr(1, 1) + hex.substr(1, 1), 16);
                    b = parseInt(hex.substr(2, 1) + hex.substr(2, 1), 16);
                } else {
                    r = g = b = 0;
                }
            } else if (brushColor.startsWith('rgb(')) {
                const match = brushColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                if (match) {
                    r = parseInt(match[1]);
                    g = parseInt(match[2]);
                    b = parseInt(match[3]);
                } else {
                    r = g = b = 0;
                }
            } else {
                r = g = b = 0;
            }
        } else {
            r = g = b = 0;
        }
        
        // Calculate final opacity
        // When drawing to stroke buffer, use full opacity (opacity will be applied during final composite)
        // When drawing directly to layer, apply the requested opacity
        const finalOpacity = this.isStrokeActive ? 1.0 : ((opacity !== undefined && opacity !== null) ? opacity : this.brushOpacity);
        const alpha = finalOpacity;
        
        // Apply brush shape pixel by pixel
        let shapeIndex = 0;
        let pixelIndex = 0;
        
        if (this.isStrokeActive) {
            // When drawing to stroke buffer, just set pixels directly (no alpha blending)
            // The opacity will be applied when compositing the entire stroke
            for (let i = 0; i < d; i++) {
                for (let j = 0; j < d; j++) {
                    if (shape[shapeIndex++] && pixelIndex + 3 < buf8.length) {
                        buf8[pixelIndex + 0] = r;
                        buf8[pixelIndex + 1] = g;
                        buf8[pixelIndex + 2] = b;
                        buf8[pixelIndex + 3] = 255; // Full alpha in stroke buffer
                    }
                    pixelIndex += 4;
                }
            }
        } else {
            // When drawing directly to layer, use Neo's exact alpha blending formula
            for (let i = 0; i < d; i++) {
                for (let j = 0; j < d; j++) {
                    if (shape[shapeIndex++] && pixelIndex + 3 < buf8.length) {
                        const r0 = buf8[pixelIndex + 0];
                        const g0 = buf8[pixelIndex + 1];
                        const b0 = buf8[pixelIndex + 2];
                        const a0 = buf8[pixelIndex + 3] / 255.0;
                        
                        // Use Neo's exact alpha blending formula
                        const a1 = alpha;
                        const a = a0 + a1 - a0 * a1;
                        
                        if (a > 0) {
                            const a1x = Math.max(a1, 1.0 / 255);
                            
                            let rOut = (r * a1x + r0 * a0 * (1 - a1x)) / a;
                            let gOut = (g * a1x + g0 * a0 * (1 - a1x)) / a;
                            let bOut = (b * a1x + b0 * a0 * (1 - a1x)) / a;
                            
                            // Neo's rounding logic
                            rOut = r > r0 ? Math.ceil(rOut) : Math.floor(rOut);
                            gOut = g > g0 ? Math.ceil(gOut) : Math.floor(gOut);
                            bOut = b > b0 ? Math.ceil(bOut) : Math.floor(bOut);
                            
                            buf8[pixelIndex + 0] = rOut;
                            buf8[pixelIndex + 1] = gOut;
                            buf8[pixelIndex + 2] = bOut;
                            buf8[pixelIndex + 3] = Math.ceil(a * 255);
                        }
                    }
                    pixelIndex += 4;
                }
            }
        }
        
        ctx.putImageData(imageData, startX, startY);
    }
    
    drawPixelLineWithOpacity(x0: number, y0: number, x1: number, y1: number, color: string, size: number, opacity: number, targetLayer?: Layer | null): void {
        const points = this.bresenhamLine(
            Math.floor(x0), Math.floor(y0),
            Math.floor(x1), Math.floor(y1)
        );
        
        points.forEach(point => {
            this.drawPixelPerfectPoint(point.x, point.y, color, size, opacity, targetLayer);
        });
    }
    
    private bresenhamLine(x0: number, y0: number, x1: number, y1: number): Array<{x: number, y: number}> {
        const points: Array<{x: number, y: number}> = [];
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        
        let x = x0, y = y0;
        
        while (true) {
            points.push({x, y});
            
            if (x === x1 && y === y1) break;
            
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x += sx;
            }
            if (e2 < dx) {
                err += dx;
                y += sy;
            }
        }
        
        return points;
    }
    
    drawHalftoneWithOpacity(x: number, y: number, size: number, color: string, patternId: string, density: number, opacity: number = 1.0, targetLayer?: Layer | null): void {
        if (!targetLayer || !targetLayer.visible) return;
        
        const ctx = targetLayer.ctx;
        ctx.save();
        ctx.globalAlpha = targetLayer.opacity; // Remove opacity from alpha - it controls pattern density
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = color;
        
        const radius = size / 2;
        const centerX = Math.floor(x);
        const centerY = Math.floor(y);
        const intRadius = Math.ceil(radius);
        
        // Convert opacity (0-1) to tone level (0-15) using Neo's approach
        const toneLevel = this.getToneLevel(opacity);
        const tonePattern = this.halftonePatterns.get(`tone_${toneLevel}`);
        
        if (!tonePattern) {
            // Fallback to original method if tone pattern not found
            const pattern = this.halftonePatterns.get(patternId);
            if (!pattern) return;
            
            // Use circular pen shape like Neo
            for (let dy = -intRadius; dy <= intRadius; dy++) {
                for (let dx = -intRadius; dx <= intRadius; dx++) {
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    if (distance <= radius) {
                        const globalX = centerX + dx;
                        const globalY = centerY + dy;
                        const patternIndex = (globalY % pattern.height) * pattern.width + (globalX % pattern.width);
                        const shouldDraw = (pattern.data[patternIndex] / 15) < opacity;
                        if (shouldDraw) {
                            ctx.fillRect(globalX, globalY, 1, 1);
                        }
                    }
                }
            }
        } else {
            // Neo-style with circular pen: Use global canvas coordinates for pattern consistency
            for (let dy = -intRadius; dy <= intRadius; dy++) {
                for (let dx = -intRadius; dx <= intRadius; dx++) {
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    if (distance <= radius) {
                        const globalX = centerX + dx;
                        const globalY = centerY + dy;
                        
                        const patternIndex = (globalY % 4) + (globalX % 4) * 4;
                        const shouldDraw = tonePattern.data[patternIndex] === 1;
                        
                        if (shouldDraw) {
                            ctx.fillRect(globalX, globalY, 1, 1);
                        }
                    }
                }
            }
        }
        
        ctx.restore();
    }
    
    drawHalftoneLineWithOpacity(x0: number, y0: number, x1: number, y1: number, size: number, color: string, patternId: string, density: number, opacity: number = 1.0, targetLayer?: Layer | null): void {
        const points = this.bresenhamLine(
            Math.floor(x0), Math.floor(y0),
            Math.floor(x1), Math.floor(y1)
        );
        
        points.forEach(point => {
            this.drawHalftoneWithOpacity(point.x, point.y, size, color, patternId, density, opacity, targetLayer);
        });
    }
    
    pickColor(x: number, y: number, ctx: CanvasRenderingContext2D): string {
        const imageData = ctx.getImageData(x, y, 1, 1);
        const [r, g, b] = imageData.data;
        const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
        return hex;
    }
}