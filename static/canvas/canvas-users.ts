// Canvas User Management
// Handles user tracking, cursors, remote drawing state, and stroke buffers

interface UsersOptions {
    [key: string]: any;
}

interface User {
    user_id: number;
    name: string;
}


interface CursorPosition {
    x: number;
    y: number;
    timestamp: number;
}

interface StrokeBuffer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    isActive: boolean;
    opacity: number;
    blendMode: string;
    isHalftone: boolean; // Track if this stroke contains halftone content
}

interface Layer {
    id: number;
    ctx: CanvasRenderingContext2D;
    visible: boolean;
    opacity: number;
}

export class CanvasUsers {
    options: UsersOptions;
    private users: Map<number, User> = new Map();
    private userId: number = 0;
    
    // User state tracking
    private userCurrentLayers: Map<number, number> = new Map(); // Track each user's current layer
    private userCursorPositions: Map<number, CursorPosition> = new Map(); // Cursor positions
    private userStrokeBuffers: Map<number, StrokeBuffer> = new Map(); // Per-user stroke buffers for remote drawing
    
    // Cursor management
    private lastCursorBroadcast: number = 0;
    private cursorBroadcastInterval: number = 100; // ms
    
    // Overlay context for rendering cursors
    private overlayCtx: CanvasRenderingContext2D | null = null;

    constructor(options: UsersOptions = {}) {
        this.options = options;
    }
    
    setOverlayContext(ctx: CanvasRenderingContext2D): void {
        this.overlayCtx = ctx;
    }
    
    setUserId(userId: number): void {
        this.userId = userId;
    }
    
    updateUserList(users: User[]): void {
        this.users.clear();
        users.forEach(user => {
            this.users.set(user.user_id, user);
        });
    }
    
    getUser(userId: number): User | undefined {
        return this.users.get(userId);
    }
    
    getAllUsers(): User[] {
        return Array.from(this.users.values());
    }
    
    
    // Layer tracking
    setUserCurrentLayer(userId: number, layerId: number): void {
        this.userCurrentLayers.set(userId, layerId);
    }
    
    getUserCurrentLayer(userId: number): number {
        return this.userCurrentLayers.get(userId) || 0; // Default to background layer
    }
    
    // Cursor position management
    updateCursorPosition(userId: number, x: number, y: number): void {
        this.userCursorPositions.set(userId, { 
            x: x, 
            y: y, 
            timestamp: Date.now() 
        });
    }
    
    shouldBroadcastCursor(): boolean {
        const now = Date.now();
        if (now - this.lastCursorBroadcast > this.cursorBroadcastInterval) {
            this.lastCursorBroadcast = now;
            return true;
        }
        return false;
    }
    
    renderUserCursors(): void {
        if (!this.overlayCtx) return;
        
        // Clear overlay (this will be called as part of the main render loop)
        const now = Date.now();
        
        this.userCursorPositions.forEach((cursor, userId) => {
            // Only show cursors from the last 5 seconds
            if (now - cursor.timestamp < 5000 && userId !== this.userId) {
                const user = this.users.get(userId);
                const userName = user ? user.name : `User ${userId}`;
                const userColor = this.getUserColor(userId);
                
                this.overlayCtx!.save();
                
                // Draw cursor
                this.overlayCtx!.fillStyle = userColor;
                this.overlayCtx!.beginPath();
                this.overlayCtx!.moveTo(cursor.x, cursor.y);
                this.overlayCtx!.lineTo(cursor.x + 12, cursor.y + 4);
                this.overlayCtx!.lineTo(cursor.x + 5, cursor.y + 9);
                this.overlayCtx!.lineTo(cursor.x + 3, cursor.y + 16);
                this.overlayCtx!.closePath();
                this.overlayCtx!.fill();
                
                // Draw user name
                this.overlayCtx!.fillStyle = '#000000';
                this.overlayCtx!.font = '12px Arial';
                this.overlayCtx!.fillText(userName, cursor.x + 15, cursor.y + 12);
                
                this.overlayCtx!.restore();
            }
        });
    }
    
    private getUserColor(userId: number): string {
        // Generate consistent color for each user
        const hue = (userId * 137) % 360;
        return `hsl(${hue}, 70%, 50%)`;
    }
    
    // Stroke buffer management for remote users
    private getOrCreateUserStrokeBuffer(senderId: number, canvasWidth: number, canvasHeight: number): StrokeBuffer {
        if (!this.userStrokeBuffers.has(senderId)) {
            const canvas = document.createElement('canvas');
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
            
            // Set up pixel-perfect rendering
            ctx.imageSmoothingEnabled = false;
            (ctx as any).webkitImageSmoothingEnabled = false;
            (ctx as any).mozImageSmoothingEnabled = false;
            (ctx as any).msImageSmoothingEnabled = false;
            ctx.lineCap = 'square';
            ctx.lineJoin = 'miter';
            
            this.userStrokeBuffers.set(senderId, {
                canvas: canvas,
                ctx: ctx,
                isActive: false,
                opacity: 1.0,
                blendMode: 'source-over',
                isHalftone: false
            });
            
            console.log(`Created stroke buffer for user ${senderId}`);
        }
        return this.userStrokeBuffers.get(senderId)!;
    }
    
    beginRemoteStroke(senderId: number, opacity: number, blendMode: string, canvasWidth: number, canvasHeight: number): void {
        const buffer = this.getOrCreateUserStrokeBuffer(senderId, canvasWidth, canvasHeight);
        buffer.isActive = true;
        buffer.opacity = opacity;
        buffer.blendMode = blendMode;
        buffer.isHalftone = false; // Reset for new stroke
        
        // Clear the stroke buffer for new stroke
        buffer.ctx.clearRect(0, 0, buffer.canvas.width, buffer.canvas.height);
        buffer.ctx.globalCompositeOperation = 'source-over';
        
        console.log(`Started remote stroke for user ${senderId} with opacity=${opacity}, blendMode=${blendMode}`);
    }
    
    endRemoteStroke(senderId: number, layers: Map<number, Layer>): void {
        const buffer = this.userStrokeBuffers.get(senderId);
        if (!buffer || !buffer.isActive) return;
        
        console.log(`Ending remote stroke for user ${senderId}`);
        
        // Composite the stroke buffer to the main canvas
        const userLayerId = this.getUserCurrentLayer(senderId);
        const currentLayer = layers.get(userLayerId);
        if (currentLayer && currentLayer.visible) {
            const ctx = currentLayer.ctx;
            ctx.save();
            
            // For halftone strokes, use full opacity since opacity was already used for pattern density
            const finalOpacity = buffer.isHalftone ? 1.0 : buffer.opacity;
            ctx.globalAlpha = finalOpacity * currentLayer.opacity;
            ctx.globalCompositeOperation = buffer.blendMode as GlobalCompositeOperation;
            ctx.drawImage(buffer.canvas, 0, 0);
            ctx.restore();
            
            console.log(`Composited remote stroke for user ${senderId}: isHalftone=${buffer.isHalftone}, opacity=${buffer.opacity}, final=${finalOpacity * currentLayer.opacity}`);
        }
        
        buffer.isActive = false;
    }
    
    getUserStrokeBuffer(senderId: number): StrokeBuffer | undefined {
        return this.userStrokeBuffers.get(senderId);
    }
    
    getAllActiveStrokeBuffers(): Map<number, StrokeBuffer> {
        const activeBuffers = new Map();
        this.userStrokeBuffers.forEach((buffer, senderId) => {
            if (buffer.isActive) {
                activeBuffers.set(senderId, buffer);
            }
        });
        return activeBuffers;
    }
    
    renderRemoteStrokePreviews(overlayCtx: CanvasRenderingContext2D, layers: Map<number, Layer>): void {
        if (!overlayCtx) return;
        
        // Render all active remote stroke buffers in real-time
        for (const [senderId, buffer] of this.userStrokeBuffers) {
            if (buffer.isActive) {
                const userLayerId = this.getUserCurrentLayer(senderId);
                const currentLayer = layers.get(userLayerId);
                if (currentLayer && currentLayer.visible) {
                    overlayCtx.save();
                    
                    // For halftone strokes, use full opacity since opacity was already used for pattern density
                    const effectiveOpacity = buffer.isHalftone ? 1.0 : buffer.opacity;
                    const finalOpacity = effectiveOpacity * currentLayer.opacity;
                    overlayCtx.globalAlpha = finalOpacity;
                    overlayCtx.globalCompositeOperation = buffer.blendMode as GlobalCompositeOperation;
                    
                    console.log(`Rendering remote stroke preview for user ${senderId}: isHalftone=${buffer.isHalftone}, opacity=${buffer.opacity}, effective=${effectiveOpacity}, final=${finalOpacity}`);
                    
                    // Draw the remote stroke buffer to overlay for real-time preview
                    overlayCtx.drawImage(buffer.canvas, 0, 0);
                    
                    overlayCtx.restore();
                }
            }
        }
    }
    
    
    // Pixel art drawing methods for stroke buffers
    drawPixelToBuffer(senderId: number, x: number, y: number, color: string, size: number, roundData?: { [key: number]: Uint8Array } | null): void {
        const buffer = this.userStrokeBuffers.get(senderId);
        if (!buffer || !buffer.isActive) {
            console.warn(`No active stroke buffer for user ${senderId}`);
            return;
        }
        
        console.log(`drawPixelToBuffer: user=${senderId}, size=${size}`);
        
        if (roundData) {
            this.drawPixelPerfectPointToBufferWithShape(buffer.ctx, x, y, color, size, roundData);
        } else {
            this.drawSimplePixelToBuffer(buffer.ctx, x, y, color, size);
        }
    }
    
    private drawSimplePixelToBuffer(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, size: number): void {
        ctx.save();
        ctx.globalAlpha = 1.0;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = color;
        
        const halfSize = Math.floor(size / 2);
        const startX = Math.floor(x - halfSize);
        const startY = Math.floor(y - halfSize);
        
        ctx.fillRect(startX, startY, size, size);
        ctx.restore();
    }
    
    private drawPixelPerfectPointToBufferWithShape(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, size: number, roundData: { [key: number]: Uint8Array }): void {
        const d = Math.max(1, Math.min(30, size));
        const shape = roundData[d];
        if (!shape) {
            this.drawSimplePixelToBuffer(ctx, x, y, color, size);
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
        let r: number, g: number, b: number;
        if (color.startsWith('#')) {
            const hex = color.slice(1);
            r = parseInt(hex.substr(0, 2), 16);
            g = parseInt(hex.substr(2, 2), 16);
            b = parseInt(hex.substr(4, 2), 16);
        } else if (color.startsWith('rgb(')) {
            const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
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
        
        // Apply brush shape pixel by pixel with full alpha in buffer
        let shapeIndex = 0;
        let pixelIndex = 0;
        
        for (let i = 0; i < d; i++) {
            for (let j = 0; j < d; j++) {
                if (shape[shapeIndex++] && pixelIndex + 3 < buf8.length) {
                    buf8[pixelIndex + 0] = r;
                    buf8[pixelIndex + 1] = g;
                    buf8[pixelIndex + 2] = b;
                    buf8[pixelIndex + 3] = 255; // Full alpha in buffer
                }
                pixelIndex += 4;
            }
        }
        
        ctx.putImageData(imageData, startX, startY);
    }
    
    drawPixelLineToBuffer(senderId: number, x0: number, y0: number, x1: number, y1: number, color: string, size: number, roundData?: { [key: number]: Uint8Array } | null): void {
        const buffer = this.userStrokeBuffers.get(senderId);
        if (!buffer || !buffer.isActive) {
            console.warn(`No active stroke buffer for user ${senderId}`);
            return;
        }
        
        const points = this.bresenhamLine(
            Math.floor(x0), Math.floor(y0),
            Math.floor(x1), Math.floor(y1)
        );
        
        console.log(`drawPixelLineToBuffer: user=${senderId}, points=${points.length}`);
        
        points.forEach(point => {
            if (roundData) {
                this.drawPixelPerfectPointToBufferWithShape(buffer.ctx, point.x, point.y, color, size, roundData);
            } else {
                this.drawSimplePixelToBuffer(buffer.ctx, point.x, point.y, color, size);
            }
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
    
    // Halftone drawing methods for remote users
    drawHalftoneToBuffer(senderId: number, x: number, y: number, color: string, size: number, patternId: string, opacity: number, halftonePatterns: Map<string, any>): void {
        const buffer = this.userStrokeBuffers.get(senderId);
        if (!buffer || !buffer.isActive) {
            console.warn(`No active stroke buffer for user ${senderId}`);
            return;
        }
        
        // Mark this buffer as containing halftone content
        buffer.isHalftone = true;
        
        console.log(`drawHalftoneToBuffer: user=${senderId}, size=${size}, opacity=${opacity}`);
        
        const ctx = buffer.ctx;
        ctx.save();
        ctx.globalAlpha = 1.0; // Will be applied during final composite
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = color;
        
        const radius = size / 2;
        const centerX = Math.floor(x);
        const centerY = Math.floor(y);
        const intRadius = Math.ceil(radius);
        
        // Convert opacity (0-1) to tone level (0-15) using Neo's approach
        const toneLevel = this.getToneLevel(opacity);
        const tonePattern = halftonePatterns.get(`tone_${toneLevel}`);
        
        if (!tonePattern) {
            // Fallback to original method if tone pattern not found
            const pattern = halftonePatterns.get(patternId);
            if (!pattern) {
                ctx.restore();
                return;
            }
            
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
            // PaintBBS-style with circular pen: Use global canvas coordinates for pattern consistency
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
    
    drawHalftoneLineToBuffer(senderId: number, x0: number, y0: number, x1: number, y1: number, color: string, size: number, patternId: string, opacity: number, halftonePatterns: Map<string, any>): void {
        const buffer = this.userStrokeBuffers.get(senderId);
        if (!buffer || !buffer.isActive) {
            console.warn(`No active stroke buffer for user ${senderId}`);
            return;
        }
        
        const points = this.bresenhamLine(
            Math.floor(x0), Math.floor(y0),
            Math.floor(x1), Math.floor(y1)
        );
        
        console.log(`drawHalftoneLineToBuffer: user=${senderId}, points=${points.length}`);
        
        points.forEach(point => {
            this.drawHalftoneToBuffer(senderId, point.x, point.y, color, size, patternId, opacity, halftonePatterns);
        });
    }
    
    // Cleanup methods
    removeUser(userId: number): void {
        this.users.delete(userId);
        this.userCurrentLayers.delete(userId);
        this.userCursorPositions.delete(userId);
        
        // Clean up stroke buffer
        if (this.userStrokeBuffers.has(userId)) {
            this.userStrokeBuffers.delete(userId);
        }
    }
    
}