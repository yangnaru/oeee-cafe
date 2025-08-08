// Canvas Web Client - Main orchestrator
import { CanvasDrawing } from './canvas-drawing.js';
import { CanvasLayers } from './canvas-layers.js';
import { CanvasNetwork } from './canvas-network.js';
import { CanvasUI } from './canvas-ui.js';
import { CanvasUsers } from './canvas-users.js';
import { CanvasUtils } from './canvas-utils.js';
import { DrawOperation, AffectedArea, LocalFork } from './canvas-concurrency.js';
import { EnhancedSpatialConsistency, ConflictStrategy, OperationPriority } from './canvas-spatial-v2.js';

interface CanvasClientOptions {
    canvasWidth?: number;
    canvasHeight?: number;
    roomId?: string;
    userName?: string;
    wsUrl?: string;
    [key: string]: any;
}

interface BrushChange {
    type: 'size' | 'opacity' | 'blendMode';
    value: number | string;
}

interface MouseEventData {
    x: number;
    y: number;
    originalEvent?: Event;
}

class CanvasClient {
    private options: CanvasClientOptions;
    private drawing: CanvasDrawing;
    private layers: CanvasLayers;
    private network: CanvasNetwork;
    private ui: CanvasUI;
    private users: CanvasUsers;
    
    // State
    private isDrawing: boolean = false;
    private lastX: number = 0;
    private lastY: number = 0;
    private zoom: number = 1;
    private panX: number = 0;
    private panY: number = 0;
    private gridVisible: boolean = false;
    
    // Fork/Rollback/Replay mechanism (Drawpile-style)
    private localFork: LocalFork | null = null;
    private operationHistory: DrawOperation[] = [];
    private canvasSnapshots: Map<number, Map<number, ImageData>> = new Map(); // sequence -> layerId -> ImageData
    private lastSnapshotSequence: number = 0;
    private snapshotInterval: number = 50; // Take snapshot every N operations
    private currentSequence: number = 0;
    private maxFallbehind: number = 100;
    private isCatchingUp: boolean = false; // Disable fork/rollback during catchup
    
    // Enhanced spatial consistency system
    private spatialSystem: EnhancedSpatialConsistency;
    private metricsInterval: number | null = null;
    
    // Track uncommitted operations in stroke buffer for proper interleaving
    private uncommittedOps: DrawOperation[] = [];

    constructor(options: CanvasClientOptions = {}) {
        this.options = {
            canvasWidth: options.canvasWidth || 800,
            canvasHeight: options.canvasHeight || 600,
            roomId: options.roomId || 'default',
            userName: options.userName || this.generateUsername(),
            wsUrl: options.wsUrl || `${window.location.host === 'localhost' ? 'ws' : 'wss'}://${window.location.host}/collaborate/ws`,
            ...options
        };
        console.log(this.options)

        // Initialize subsystems
        this.drawing = new CanvasDrawing(this.options);
        this.layers = new CanvasLayers(this.options);
        this.network = new CanvasNetwork(this.options);
        this.ui = new CanvasUI(this.options);
        this.users = new CanvasUsers(this.options);
        
        // Initialize enhanced spatial consistency
        this.spatialSystem = new EnhancedSpatialConsistency(this.network.userId || 0);
        
        this.init();
    }

    private generateUsername(): string {
        const adjectives = ['Creative', 'Artistic', 'Inspired', 'Talented', 'Skilled'];
        const nouns = ['Artist', 'Painter', 'Drawer', 'Creator', 'Designer'];
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        return `${adj}${noun}${Math.floor(Math.random() * 1000)}`;
    }

    private init(): void {
        this.setupUI();
        this.setupNetworking();
        this.setupDrawingSystem();
        this.connect();
    }
    
    private setupUI(): void {
        this.ui.createUI();
        
        // Set up UI event callbacks
        this.ui.onToolChange = (tool: string) => {
            this.drawing.currentTool = tool;
            this.ui.updateCursor(tool);
        };
        
        this.ui.onPrecisionToolChange = (tool: string) => {
            this.drawing.currentPrecisionTool = tool;
        };
        
        this.ui.onBrushChange = (change: BrushChange) => {
            switch (change.type) {
                case 'size':
                    this.drawing.brushSize = change.value as number;
                    break;
                case 'opacity':
                    this.drawing.brushOpacity = change.value as number;
                    break;
                case 'blendMode':
                    this.drawing.blendMode = change.value as string;
                    break;
            }
            this.ui.updateBrushPreview(this.drawing.currentColor, this.drawing.brushSize, this.drawing.brushOpacity);
        };
        
        this.ui.onColorChange = (color: string) => {
            this.drawing.currentColor = color;
            this.ui.updateColorPalette(color);
            this.ui.updateBrushPreview(color, this.drawing.brushSize, this.drawing.brushOpacity);
        };
        
        this.ui.onLayerAction = (action: string, layerId?: number) => {
            switch (action) {
                case 'add':
                    const newLayerId = this.layers.addLayer();
                    this.network.sendLayerOperation('create', newLayerId);
                    this.updateLayerUI();
                    break;
                case 'delete':
                    if (this.layers.deleteLayer(layerId)) {
                        this.network.sendLayerOperation('delete', layerId || this.layers.currentLayerId);
                        this.updateLayerUI();
                    }
                    break;
                case 'merge':
                    const mergeResult = this.layers.mergeDown(layerId);
                    if (mergeResult) {
                        this.network.sendLayerOperation('merge', mergeResult.sourceLayerId, { targetLayerId: mergeResult.targetLayerId });
                        this.updateLayerUI();
                    }
                    break;
                case 'select':
                    this.layers.setCurrentLayer(layerId!);
                    this.network.sendLayerOperation('switch', layerId!);
                    this.updateLayerUI();
                    break;
                case 'toggleVisibility':
                    const visible = this.layers.toggleLayerVisibility(layerId!);
                    this.network.sendLayerOperation('visibility', layerId!, { visible });
                    this.updateLayerUI();
                    break;
            }
        };
        
        this.ui.onCanvasAction = (action: string) => {
            switch (action) {
                case 'clear':
                    if (confirm('Clear the current layer? This action cannot be undone.')) {
                        this.layers.clearLayer();
                    }
                    break;
                case 'save':
                    this.saveCanvas();
                    break;
            }
        };
        
        this.ui.onZoomChange = (action: string) => {
            switch (action) {
                case 'in':
                    this.setZoom(this.zoom * 1.2);
                    break;
                case 'out':
                    this.setZoom(this.zoom / 1.2);
                    break;
                case 'fit':
                    this.fitToScreen();
                    break;
            }
        };
        
        this.ui.onChatMessage = (message: string) => {
            this.network.sendChatMessage(message);
            this.ui.addChatMessage(this.options.userName!, message);
        };
        
        this.ui.onMouseEvent = (type: string, data: MouseEventData) => {
            const { x, y } = data;
            const canvasX = Math.floor(x / this.zoom);
            const canvasY = Math.floor(y / this.zoom);
            
            switch (type) {
                case 'down':
                    this.startDrawing(canvasX, canvasY);
                    break;
                case 'move':
                    if (this.isDrawing) {
                        this.continueDrawing(canvasX, canvasY);
                    }
                    this.updateCursorPosition(canvasX, canvasY);
                    break;
                case 'up':
                    if (this.isDrawing) {
                        this.stopDrawing();
                    }
                    break;
            }
        };
        
        this.ui.onGridToggle = (visible: boolean) => {
            this.gridVisible = visible;
            this.updateGridDisplay();
        };
    }
    
    private setupNetworking(): void {
        // Set up network event callbacks
        this.network.onConnectionChange = (status: string, text: string) => {
            this.ui.updateConnectionStatus(status, text);
        };
        
        this.network.onCatchupProgress = (current: number, total: number) => {
            this.ui.updateCatchupProgress(current, total);
        };
        
        // Register message handlers
        this.network.registerHandler('system_message', (data: any) => {
            this.ui.addChatMessage('System', data.message);
            // Check for initial state messages
            if (data.type === 'initial_state_start') {
                this.isCatchingUp = true;
                this.clearLocalFork();
                this.operationHistory = [];
                this.currentSequence = 0;
            } else if (data.type === 'initial_state_complete') {
                this.isCatchingUp = false;
                this.takeSnapshot();
            }
        });
        
        this.network.registerHandler('catchup_start', () => {
            console.log('Starting catchup - clearing canvas and resetting state');
            this.isCatchingUp = true;
            this.clearLocalFork(); // Clear any local fork during catchup
            this.operationHistory = []; // Reset operation history
            this.currentSequence = 0; // Reset sequence
            this.canvasSnapshots.clear(); // Clear all snapshots
            this.layers.clearAllLayers(); // Clear all layers before replay
            this.ui.showCatchupOverlay();
        });
        
        this.network.registerHandler('catchup_complete', () => {
            console.log('Catchup complete - taking snapshot');
            this.isCatchingUp = false;
            // Take a snapshot after catchup completes for future rollbacks
            this.takeSnapshot();
            this.ui.hideCatchupOverlay();
        });
        
        this.network.registerHandler('user_list', (users: any[]) => {
            this.users.updateUserList(users);
            this.ui.updateUserList(users);
        });
        
        this.network.registerHandler('chat_message', (data: any) => {
            const message = new TextDecoder().decode(data.payload);
            const user = this.users.getUser(data.senderId);
            const userName = user ? user.name : `User ${data.senderId}`;
            
            if (data.senderId !== this.network.userId) {
                this.ui.addChatMessage(userName, message);
            }
        });
                
        this.network.registerHandler('cursor_position', (data: any) => {
            // Cursor movements don't need spatial consistency as they don't modify canvas state
            this.handleRemoteCursorPosition(data.payload, data.senderId);
        });
        
        this.network.registerHandler('layer_operation', (data: any) => {
            // Layer operations are handled directly as they have their own conflict resolution
            this.handleRemoteLayerOperation(data.payload, data.senderId);
        });
        
        this.network.registerHandler('pixel_command', (data: any) => {
            // During catchup, apply operations directly without fork/rollback
            if (this.isCatchingUp) {
                // During catchup, all operations should be applied in order
                const op = this.network.convertNetworkMessageToDrawOperation(data.payload, data.senderId);
                if (op) {
                    // Apply operation directly during catchup
                    this.applyDrawOperationDirect(op);
                    this.operationHistory.push(op);
                    this.currentSequence++;
                } else {
                    // Fallback for operations that can't be converted
                    this.handleRemotePixelCommand(data.payload, data.senderId);
                }
                return;
            }
            
            // Normal operation - use fork/rollback/replay mechanism
            const op = this.network.convertNetworkMessageToDrawOperation(data.payload, data.senderId);
            if (op && data.senderId !== this.network.userId) {
                // Process remote operation through fork reconciliation
                this.reconcileRemoteOperation(op);
            } else if (op && data.senderId === this.network.userId) {
                // Check if this is our own operation from the fork
                if (this.localFork && this.localFork.localOps.length > 0) {
                    const headOp = this.localFork.localOps[0];
                    if (this.operationsMatch(headOp, op)) {
                        // Remove from fork as it's been confirmed by server
                        this.localFork.localOps.shift();
                        if (this.localFork.localOps.length === 0) {
                            this.clearLocalFork();
                        }
                    }
                }
                return;
            } else {
                // Fallback for when spatial concurrency not ready
                this.handleRemotePixelCommand(data.payload, data.senderId);
            }
        });
        
        this.network.registerHandler('pen_up', (data: any) => {
            // During catchup, handle pen_up differently
            if (this.isCatchingUp) {
                // During catchup, we don't need to handle stroke buffers
                // as operations are applied directly
                return;
            }
            this.handleRemotePenUp(data.senderId);
        });
        
        this.network.registerHandler('annotation', (data: any) => {
            this.handleRemoteAnnotation(data.payload, data.senderId);
        });
        
        // Register spatial concurrency handlers
        this.network.registerHandler('apply_operation', (op: DrawOperation) => {
            this.applyDrawOperation(op);
        });
        
        this.network.registerHandler('rollback_operation', (op: DrawOperation) => {
            this.rollbackDrawOperation(op);
        });
        
        // Set conflict resolution callback
        this.network.onConflictResolution = (rollback, reapply) => {
            console.log(`Spatial conflict resolved: ${rollback.length} ops rolled back, ${reapply.length} reapplied`);
        };
        
        // Take periodic snapshots for efficient rollback
        setInterval(() => {
            if (this.currentSequence - this.lastSnapshotSequence >= this.snapshotInterval) {
                this.takeSnapshot();
            }
        }, 5000); // Check every 5 seconds
        
        // Start metrics collection for spatial system
        this.metricsInterval = window.setInterval(() => {
            const metrics = this.spatialSystem.getMetrics();
            if (metrics.conflictRate > 0.5) {
                console.warn('High conflict rate detected:', metrics);
            }
            // Clean up old cached data
            this.spatialSystem.cleanup();
        }, 10000); // Every 10 seconds
    }
    
    private setupDrawingSystem(): void {
        // Initialize drawing system with canvas dimensions
        this.drawing.initializeStrokeBuffer(this.options.canvasWidth!, this.options.canvasHeight!);
        
        // Initialize layers
        this.layers.initialize(this.ui.getCanvasWrapper(), this.ui.getOverlayCanvas());
        
        // Initialize users system
        this.users.setOverlayContext(this.ui.getOverlayContext());
        
        // Start render loop
        this.startRenderLoop();
        
        // Set initial zoom
        this.setZoom(1);
        
        // Take initial snapshot
        this.takeSnapshot();
        
        // Update initial UI state
        this.updateLayerUI();
        this.ui.updateBrushPreview(this.drawing.currentColor, this.drawing.brushSize, this.drawing.brushOpacity);
    }
    
    private startRenderLoop(): void {
        const render = () => {
            this.renderStrokePreview();
            requestAnimationFrame(render);
        };
        requestAnimationFrame(render);
    }
    
    private renderStrokePreview(): void {
        const overlayCtx = this.ui.getOverlayContext();
        const overlayCanvas = this.ui.getOverlayCanvas();
        
        // Clear overlay
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        
        // Render local stroke buffer preview only if actively drawing
        if (this.isDrawing && this.drawing.isStrokeActive && this.drawing.strokeCanvas) {
            const currentLayer = this.layers.getCurrentLayer();
            if (currentLayer && currentLayer.visible) {
                overlayCtx.save();
                overlayCtx.globalAlpha = this.drawing.brushOpacity * currentLayer.opacity;
                overlayCtx.globalCompositeOperation = 'source-over';
                overlayCtx.drawImage(this.drawing.strokeCanvas, 0, 0);
                overlayCtx.restore();
            }
        }
        
        // Render remote stroke previews (if any)
        this.users.renderRemoteStrokePreviews(overlayCtx, this.layers.layers);
        
        // Render user cursors
        this.users.renderUserCursors();
        
        // Render grid if visible
        if (this.gridVisible && this.zoom >= 4) {
            this.drawPixelGrid();
        }
    }
    
    // Drawing methods
    private startDrawing(x: number, y: number): void {
        if (this.drawing.currentTool === 'eyedropper') {
            this.pickColor(x, y);
            return;
        }
        
        if (this.drawing.currentTool === 'pan') {
            return;
        }
        
        // Don't allow drawing during catchup
        if (this.isCatchingUp) {
            return;
        }
        
        this.isDrawing = true;
        // Use stroke buffer for smooth local drawing
        // Only begin stroke if not already active (protect against re-entrance)
        if (!this.drawing.isStrokeActive) {
            this.drawing.beginStroke();
        }
        this.lastX = x;
        this.lastY = y;
        
        // Initialize local fork if needed
        if (!this.localFork) {
            this.localFork = {
                baseSequence: this.currentSequence,
                localOps: [],
                remoteOps: [],
                startsAtUndoPoint: false,
                fallbehind: 0
            };
        }
        
        // Notify spatial system of drawing state
        this.spatialSystem.setLocalDrawingInProgress(true);
        
        // Create operation with affected area
        const op = this.createDrawOperation('dab', {
            x, y,
            color: this.drawing.currentColor,
            layerId: this.layers.currentLayerId,
            size: this.drawing.brushSize,
            brushSize: this.drawing.brushSize,
            patternId: 'bayer4x4',
            density: 32,
            opacity: this.drawing.brushOpacity,
            tool: this.drawing.currentPrecisionTool
        });
        
        // Add to local fork
        this.localFork.localOps.push(op);
        
        // Apply to stroke buffer for smooth drawing
        this.applyLocalOperationToStroke(op);
        
        // Send to network (with error handling to prevent stopping)
        try {
            this.network.processLocalDrawOperation('dab', op.data);
        } catch (error) {
            console.error('Failed to send draw operation:', error);
            // Don't stop drawing even if network fails
        }
    }
    
    private continueDrawing(x: number, y: number): void {
        if (!this.isDrawing) return;
        
        // Create operation with affected area
        const op = this.createDrawOperation('line', {
            x1: this.lastX,
            y1: this.lastY,
            x2: x,
            y2: y,
            color: this.drawing.currentColor,
            layerId: this.layers.currentLayerId,
            size: this.drawing.brushSize,
            brushSize: this.drawing.brushSize,
            opacity: this.drawing.brushOpacity,
            tool: this.drawing.currentPrecisionTool,
            patternId: 'bayer4x4',
            density: 32
        });
        
        // Add to local fork if active
        if (this.localFork) {
            this.localFork.localOps.push(op);
        }
        
        // Apply to stroke buffer for smooth drawing
        this.applyLocalOperationToStroke(op);
        
        // Send to network (with error handling to prevent stopping)
        try {
            this.network.processLocalDrawOperation('line', op.data);
        } catch (error) {
            console.error('Failed to send draw operation:', error);
            // Don't stop drawing even if network fails
        }
        
        this.lastX = x;
        this.lastY = y;
    }
    
    private stopDrawing(): void {
        if (!this.isDrawing) return;
        
        this.isDrawing = false;
        
        // Commit any remaining uncommitted operations
        const currentLayer = this.layers.getCurrentLayer();
        if (currentLayer && this.drawing.isStrokeActive) {
            // Commit the buffer to the layer
            this.drawing.endStroke(currentLayer);
            
            // Clear uncommitted operations
            this.uncommittedOps = [];
            
            // Clear tracked remote ops if any
            if (this.localFork) {
                this.localFork.remoteOps = [];
                this.localFork.fallbehind = 0;
            }
        }
        
        // Notify spatial system of drawing state change
        this.spatialSystem.setLocalDrawingInProgress(false);
        
        // After stroke ends, reconcile any pending remote operations
        if (this.localFork && this.localFork.remoteOps.length > 0) {
            console.log(`Reconciling ${this.localFork.remoteOps.length} remote operations after stroke end`);
            
            // Get metrics to understand conflict patterns
            const metrics = this.spatialSystem.getMetrics();
            if (metrics.conflictRate > 0.3) {
                console.log('Conflict metrics:', metrics);
            }
            
            // Clear remote ops as they've already been applied
            this.localFork.remoteOps = [];
            this.localFork.fallbehind = 0;
        }
        
        // Send pen up message to indicate stroke end
        this.network.sendPenUp();
    }
                
    private drawPointWithBlendMode(x: number, y: number, color: string, size: number, opacity: number, blendMode: string, targetLayer: any): void {
        const ctx = targetLayer.ctx;
        ctx.save();
        ctx.globalAlpha = opacity * targetLayer.opacity;
        ctx.globalCompositeOperation = blendMode as GlobalCompositeOperation;
        
        if (size <= 3) {
            // Use pixel-perfect drawing for small sizes
            const imageData = ctx.getImageData(x - 1, y - 1, 3, 3);
            // Simple pixel drawing for eraser
            for (let py = 0; py < 3; py++) {
                for (let px = 0; px < 3; px++) {
                    const index = (py * 3 + px) * 4;
                    imageData.data[index + 3] = 0; // Set alpha to 0 for erasing
                }
            }
            ctx.putImageData(imageData, x - 1, y - 1);
        } else {
            const brushRadius = size / 2;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, brushRadius, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.restore();
    }
    
    private drawLineWithBlendMode(x1: number, y1: number, x2: number, y2: number, color: string, size: number, opacity: number, blendMode: string, targetLayer: any): void {
        const ctx = targetLayer.ctx;
        ctx.save();
        ctx.globalAlpha = opacity * targetLayer.opacity;
        ctx.globalCompositeOperation = blendMode as GlobalCompositeOperation;
        
        const dx = x2 - x1;
        const dy = y2 - y1;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance > 0) {
            const steps = Math.max(1, Math.floor(distance / (this.drawing.brushSpacing * size)));
            
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const x = x1 + dx * t;
                const y = y1 + dy * t;
                
                const pressure = 0.8 + 0.2 * Math.sin(t * Math.PI);
                const brushSize = size * pressure;
                
                const brushRadius = brushSize / 2;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(x, y, brushRadius, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        
        ctx.restore();
    }
    
    private pickColor(x: number, y: number): void {
        const currentLayer = this.layers.getCurrentLayer();
        if (!currentLayer) return;
        
        const pickedColor = this.drawing.pickColor(x, y, currentLayer.ctx);
        
        this.drawing.currentColor = pickedColor;
        (document.getElementById('colorPicker') as HTMLInputElement).value = pickedColor;
        this.ui.updateColorPalette(pickedColor);
        this.ui.updateBrushPreview(pickedColor, this.drawing.brushSize, this.drawing.brushOpacity);
        
        this.ui.addChatMessage('System', `Picked color: ${pickedColor}`);
    }
    
        // Remote drawing handlers
    private handleRemoteCursorPosition(payload: Uint8Array, senderId: number): void {
        // During catchup, skip cursor updates to avoid noise
        if (this.isCatchingUp) return;
        if (senderId === this.network.userId) return;
        
        if (payload.length >= 4) {
            const x = (payload[0] << 8) | payload[1];
            const y = (payload[2] << 8) | payload[3];
            this.users.updateCursorPosition(senderId, x, y);
        }
    }
    
    private handleRemoteLayerOperation(payload: Uint8Array, senderId: number): void {
        // During catchup, don't skip our own operations
        if (!this.isCatchingUp && senderId === this.network.userId) return;
        
        if (payload.length >= 8) {
            const operation = payload[0];
            const layerId = payload[1] | (payload[2] << 8);
            const opacity = payload[3] / 255;
            const visible = payload[4] === 1;
            const targetLayerId = payload[5] | (payload[6] << 8);
            
            switch (operation) {
                case 1: // create
                    this.layers.handleRemoteLayerCreation(layerId);
                    break;
                case 2: // delete
                    this.layers.handleRemoteLayerDeletion(layerId);
                    break;
                case 3: // switch
                    this.users.setUserCurrentLayer(senderId, layerId);
                    break;
                case 4: // opacity
                    this.layers.setLayerOpacity(layerId, opacity);
                    break;
                case 5: // visibility
                    this.layers.toggleLayerVisibility(layerId);
                    break;
                case 6: // merge
                    this.layers.handleRemoteLayerMerge(layerId, targetLayerId);
                    break;
            }
            
            this.updateLayerUI();
        }
    }
    
    private handleRemotePixelCommand(payload: Uint8Array, senderId: number): void {
        // During catchup, don't skip our own operations
        if (!this.isCatchingUp && senderId === this.network.userId) return;
        
        if (payload.length >= 16) {
            const x = (payload[0] << 8) | payload[1];
            const y = (payload[2] << 8) | payload[3];
            const r = payload[4];
            const g = payload[5];
            const b = payload[6];
            const opacity = payload[7] / 255.0;
            const command = payload[8];
            const targetLayerId = payload[9] | (payload[10] << 8);
            const size = payload[11];
            const color = `rgb(${r}, ${g}, ${b})`;
            
            // During catchup, apply directly to layers instead of using stroke buffers
            if (this.isCatchingUp) {
                const layer = this.layers.getLayer(targetLayerId) || this.layers.getCurrentLayer();
                if (!layer) return;
                
                switch (command) {
                    case 1: // pixel
                        this.drawing.drawPixelPerfectPoint(x, y, color, size, opacity, layer);
                        break;
                    case 2: // line
                        let x1: number, y1: number;
                        if (payload.length >= 20) {
                            x1 = (payload[16] << 8) | payload[17];
                            y1 = (payload[18] << 8) | payload[19];
                        } else {
                            x1 = payload[14];
                            y1 = payload[15];
                        }
                        this.drawing.drawPixelLineWithOpacity(x, y, x1, y1, color, size, opacity, layer);
                        break;
                    case 3: // halftone
                        const patternId = payload[12] || 0;
                        const patternName = this.getPatternNameFromId(patternId);
                        this.drawing.drawHalftoneWithOpacity(x, y, size, color, patternName, 32, opacity, layer);
                        break;
                    case 4: // halftone_line
                        let x1h: number, y1h: number;
                        if (payload.length >= 20) {
                            x1h = (payload[16] << 8) | payload[17];
                            y1h = (payload[18] << 8) | payload[19];
                        } else {
                            x1h = payload[14];
                            y1h = payload[15];
                        }
                        const patternIdLine = payload[12] || 0;
                        const patternNameLine = this.getPatternNameFromId(patternIdLine);
                        this.drawing.drawHalftoneLineWithOpacity(x, y, x1h, y1h, size, color, patternNameLine, 32, opacity, layer);
                        break;
                }
                return;
            }
            
            // Normal operation - use stroke buffers
            let buffer = this.users.getUserStrokeBuffer(senderId);
            if (!buffer || !buffer.isActive) {
                this.users.beginRemoteStroke(senderId, opacity, 'source-over', this.options.canvasWidth!, this.options.canvasHeight!);
                buffer = this.users.getUserStrokeBuffer(senderId);
            }
            
            switch (command) {
                case 1: // pixel
                    this.users.drawPixelToBuffer(senderId, x, y, color, size, this.drawing.roundData);
                    break;
                case 2: // line
                    let x1: number, y1: number;
                    if (payload.length >= 20) {
                        x1 = (payload[16] << 8) | payload[17];
                        y1 = (payload[18] << 8) | payload[19];
                    } else {
                        x1 = payload[14];
                        y1 = payload[15];
                    }
                    this.users.drawPixelLineToBuffer(senderId, x, y, x1, y1, color, size, this.drawing.roundData);
                    break;
                case 3: // halftone
                    const patternId = payload[12] || 0; // Pattern ID from network payload
                    const patternName = this.getPatternNameFromId(patternId);
                    this.users.drawHalftoneToBuffer(senderId, x, y, color, size, patternName, opacity, this.drawing.halftonePatterns);
                    break;
                case 4: // halftone_line
                    let x1h: number, y1h: number;
                    if (payload.length >= 20) {
                        x1h = (payload[16] << 8) | payload[17];
                        y1h = (payload[18] << 8) | payload[19];
                    } else {
                        x1h = payload[14];
                        y1h = payload[15];
                    }
                    const patternIdLine = payload[12] || 0;
                    const patternNameLine = this.getPatternNameFromId(patternIdLine);
                    this.users.drawHalftoneLineToBuffer(senderId, x, y, x1h, y1h, color, size, patternNameLine, opacity, this.drawing.halftonePatterns);
                    break;
            }
        }
    }
    
    private handleRemotePenUp(senderId: number): void {
        // During catchup, we handle operations directly without stroke buffers
        if (this.isCatchingUp) return;
        if (senderId === this.network.userId) return;
        
        // End any active stroke for this user
        this.users.endRemoteStroke(senderId, this.layers.layers);
    }
    
    private getPatternNameFromId(patternId: number): string {
        const patternNames: { [key: number]: string } = {
            0: 'bayer4x4',
            1: 'bayer4x4',
            2: 'bayer2x2',
            3: 'lines4x4'
        };
        return patternNames[patternId] || 'bayer4x4';
    }
    
    private handleRemoteAnnotation(payload: Uint8Array, senderId: number): void {
        // During catchup, process all annotations including our own
        if (!this.isCatchingUp && senderId === this.network.userId) return;
        
        if (payload.length >= 8) {
            const x = (payload[0] << 8) | payload[1];
            const y = (payload[2] << 8) | payload[3];
            const r = payload[4];
            const g = payload[5];
            const b = payload[6];
            const textLength = payload[7];
            
            if (payload.length >= 8 + textLength) {
                const text = new TextDecoder().decode(payload.slice(8, 8 + textLength));
                const color = `rgb(${r}, ${g}, ${b})`;
                
                const userLayerId = this.users.getUserCurrentLayer(senderId);
                this.drawAnnotation(x, y, text, color, userLayerId);
            }
        }
    }
    
    private drawAnnotation(x: number, y: number, text: string, color: string, targetLayerId: number): void {
        const layer = this.layers.getLayer(targetLayerId);
        if (!layer) return;
        
        const ctx = layer.ctx;
        ctx.save();
        ctx.fillStyle = color;
        ctx.font = '14px Arial';
        ctx.fillText(text, x, y);
        ctx.restore();
    }
    
    // Cursor and grid methods
    private updateCursorPosition(x: number, y: number): void {
        if (this.users.shouldBroadcastCursor()) {
            this.network.sendCursorPosition(x, y);
        }
    }
    
    private updateGridDisplay(): void {
        // Grid rendering is handled in the render loop
    }
    
    private drawPixelGrid(): void {
        const overlayCtx = this.ui.getOverlayContext();
        const overlayCanvas = this.ui.getOverlayCanvas();
        
        overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        overlayCtx.lineWidth = 1;
        
        const canvasWidth = this.options.canvasWidth!;
        const canvasHeight = this.options.canvasHeight!;
        
        // Vertical lines
        for (let x = 0; x <= canvasWidth; x++) {
            overlayCtx.beginPath();
            overlayCtx.moveTo(x, 0);
            overlayCtx.lineTo(x, canvasHeight);
            overlayCtx.stroke();
        }
        
        // Horizontal lines
        for (let y = 0; y <= canvasHeight; y++) {
            overlayCtx.beginPath();
            overlayCtx.moveTo(0, y);
            overlayCtx.lineTo(canvasWidth, y);
            overlayCtx.stroke();
        }
    }
    
    // Zoom and view methods
    private setZoom(newZoom: number): void {
        this.zoom = Math.max(0.1, Math.min(5, newZoom));
        this.ui.setZoom(this.zoom);
        this.updateGridDisplay();
    }
    
    private fitToScreen(): void {
        const container = document.querySelector('.canvas-container') as HTMLElement;
        const containerRect = container.getBoundingClientRect();
        
        const scaleX = (containerRect.width - 40) / this.options.canvasWidth!;
        const scaleY = (containerRect.height - 40) / this.options.canvasHeight!;
        const scale = Math.min(scaleX, scaleY, 1);
        
        this.setZoom(scale);
    }
    
    // Canvas actions
    // Fork/Rollback/Replay methods (Drawpile-style)
    private createDrawOperation(type: string, data: any): DrawOperation {
        const op: DrawOperation = {
            id: `${this.network.userId}-${this.currentSequence}`,
            userId: this.network.userId,
            sequence: this.currentSequence++,
            timestamp: Date.now(),
            type: type,
            data: data,
            affectedArea: this.calculateAffectedArea(type, data),
            priority: this.getOperationPriority(type),
            coalescable: this.isCoalescable(type)
        };
        
        // Process through enhanced spatial system
        this.spatialSystem.processLocalOperation(op);
        
        return op;
    }
    
    private getOperationPriority(type: string): number {
        switch (type) {
            case 'erase':
            case 'clear':
                return OperationPriority.ERASER;
            case 'dab':
            case 'line':
                return OperationPriority.DRAWING;
            case 'annotation':
                return OperationPriority.ANNOTATION;
            default:
                return OperationPriority.DRAWING;
        }
    }
    
    private isCoalescable(type: string): boolean {
        return type === 'line' || type === 'dab';
    }
    
    private calculateAffectedArea(type: string, data: any): AffectedArea {
        let bounds;
        
        if (type === 'dab') {
            const radius = Math.ceil(data.size / 2);
            bounds = {
                x: data.x - radius,
                y: data.y - radius,
                width: radius * 2,
                height: radius * 2
            };
        } else if (type === 'line') {
            const radius = Math.ceil(data.size / 2);
            const minX = Math.min(data.x1, data.x2) - radius;
            const minY = Math.min(data.y1, data.y2) - radius;
            const maxX = Math.max(data.x1, data.x2) + radius;
            const maxY = Math.max(data.y1, data.y2) + radius;
            bounds = {
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY
            };
        } else {
            // Default bounds for unknown operations
            bounds = { x: 0, y: 0, width: this.options.canvasWidth!, height: this.options.canvasHeight! };
        }
        
        return {
            domain: 'drawing',
            bounds: bounds,
            layerId: data.layerId
        };
    }
    
    private areasIntersect(a1: AffectedArea, a2: AffectedArea): boolean {
        // Use enhanced spatial system for more accurate conflict detection
        return !this.spatialSystem.areConcurrent(a1, a2);
    }
    
    private operationsMatch(op1: DrawOperation, op2: DrawOperation): boolean {
        // Check if two operations match (same operation from same user)
        return op1.userId === op2.userId && 
               op1.type === op2.type &&
               JSON.stringify(op1.data) === JSON.stringify(op2.data);
    }
    
    private reconcileRemoteOperation(remoteOp: DrawOperation): void {
        // This is the core of the Drawpile-style fork/rollback/replay mechanism
        
        // Skip reconciliation during catchup
        if (this.isCatchingUp) {
            this.applyDrawOperationDirect(remoteOp);
            this.operationHistory.push(remoteOp);
            this.currentSequence++;
            return;
        }
        
        if (!this.localFork || this.localFork.localOps.length === 0) {
            // No local fork, just apply the remote operation
            this.applyDrawOperation(remoteOp);
            this.operationHistory.push(remoteOp);
            return;
        }
        
        // Check if remote operation matches head of our local fork
        const headOp = this.localFork.localOps[0];
        if (this.operationsMatch(headOp, remoteOp)) {
            // Our operation was confirmed, remove from fork
            this.localFork.localOps.shift();
            if (this.localFork.localOps.length === 0) {
                this.clearLocalFork();
            }
            this.operationHistory.push(remoteOp);
            return;
        }
        
        // Use enhanced spatial system for conflict resolution strategy
        const strategy = this.spatialSystem.processRemoteOperation(remoteOp);
        
        // When we're actively drawing, ensure proper chronological interleaving
        if (this.isDrawing && this.drawing.isStrokeActive) {
            // Separate uncommitted ops by timestamp relative to remote op
            const opsToCommit: DrawOperation[] = [];
            const opsToKeep: DrawOperation[] = [];
            
            for (const uncommittedOp of this.uncommittedOps) {
                // Operations that happened before the remote op should be committed first
                if (uncommittedOp.timestamp <= remoteOp.timestamp) {
                    opsToCommit.push(uncommittedOp);
                } else {
                    opsToKeep.push(uncommittedOp);
                }
            }
            
            // If we have ops to commit, apply them to layer first
            if (opsToCommit.length > 0) {
                const currentLayer = this.layers.getCurrentLayer();
                if (currentLayer) {
                    // Commit the stroke buffer up to this point
                    this.drawing.endStroke(currentLayer);
                    
                    // Apply the remote operation
                    this.applyDrawOperationDirect(remoteOp);
                    this.operationHistory.push(remoteOp);
                    
                    // Start new buffer and reapply newer operations
                    if (opsToKeep.length > 0 || this.isDrawing) {
                        this.drawing.beginStroke();
                        this.uncommittedOps = [];
                        
                        // Reapply newer operations to the new buffer
                        for (const op of opsToKeep) {
                            this.applyLocalOperationToStroke(op);
                            this.uncommittedOps.push(op);
                        }
                    } else {
                        this.uncommittedOps = [];
                    }
                }
            } else {
                // All local ops are newer than remote, just apply remote underneath
                this.applyDrawOperationDirect(remoteOp);
                this.operationHistory.push(remoteOp);
            }
            
            // Track for reconciliation
            this.localFork.remoteOps.push(remoteOp);
            this.localFork.fallbehind++;
            
            // Only force sync if extremely out of sync
            if (this.localFork.fallbehind >= this.maxFallbehind) {
                console.warn(`Fork fallbehind ${this.localFork.fallbehind} >= max ${this.maxFallbehind}, forcing sync`);
                // Commit stroke and clear
                const currentLayer = this.layers.getCurrentLayer();
                if (currentLayer && this.drawing.isStrokeActive) {
                    this.drawing.endStroke(currentLayer);
                }
                this.uncommittedOps = [];
                this.clearLocalFork();
            }
            return;
        }
        
        // If we're not actively drawing, check for conflicts
        let hasConflict = false;
        for (const localOp of this.localFork.localOps) {
            if (this.areasIntersect(remoteOp.affectedArea, localOp.affectedArea)) {
                hasConflict = true;
                break;
            }
        }
        
        if (!hasConflict) {
            // No conflict, apply normally
            this.applyDrawOperation(remoteOp);
            this.operationHistory.push(remoteOp);
            this.localFork.fallbehind++;
        } else {
            // Conflict detected, but only do selective rollback
            console.log('Conflict detected, performing selective rollback');
            this.performSelectiveRollback(remoteOp);
        }
    }
    
    private performSelectiveRollback(conflictOp: DrawOperation): void {
        if (!this.localFork) return;
        
        // For selective rollback, we only rollback and replay the conflicting area
        // This preserves non-overlapping parts of strokes
        
        const conflictBounds = conflictOp.affectedArea.bounds;
        const affectedLayerId = conflictOp.data.layerId;
        const layer = this.layers.getLayer(affectedLayerId);
        if (!layer) return;
        
        // Save the current state of the conflicting area
        const ctx = layer.ctx;
        const areaImageData = ctx.getImageData(
            conflictBounds.x,
            conflictBounds.y,
            conflictBounds.width,
            conflictBounds.height
        );
        
        // Find which local operations conflict with this area
        const conflictingLocalOps: DrawOperation[] = [];
        const nonConflictingLocalOps: DrawOperation[] = [];
        
        for (const localOp of this.localFork.localOps) {
            if (this.areasIntersect(conflictOp.affectedArea, localOp.affectedArea)) {
                conflictingLocalOps.push(localOp);
            } else {
                nonConflictingLocalOps.push(localOp);
            }
        }
        
        if (conflictingLocalOps.length === 0) {
            // No actual conflicts, just apply the operation
            this.applyDrawOperationDirect(conflictOp);
            this.operationHistory.push(conflictOp);
            return;
        }
        
        // Apply the remote operation first
        this.applyDrawOperationDirect(conflictOp);
        this.operationHistory.push(conflictOp);
        
        // Then reapply only the conflicting local operations on top
        // This creates a "remote-first" ordering for the conflicting area
        for (const localOp of conflictingLocalOps) {
            // If we're still drawing, reapply to stroke buffer
            if (this.isDrawing && this.drawing.isStrokeActive) {
                // Apply to stroke buffer to preserve the in-progress stroke
                this.applyDrawOperation(localOp);
            } else {
                // Apply directly if stroke is complete
                this.applyDrawOperationDirect(localOp);
            }
        }
        
        // Update fork with non-conflicting operations
        this.localFork.localOps = nonConflictingLocalOps;
        
        // Add back conflicting operations if we're still drawing
        if (this.isDrawing) {
            this.localFork.localOps.push(...conflictingLocalOps);
        }
        
        // Reset fallbehind counter after reconciliation
        this.localFork.fallbehind = 0;
    }
    
    private performRollbackAndReplay(): void {
        // Keep this method for full rollback scenarios (e.g., max fallbehind)
        if (!this.localFork) return;
        
        console.log(`Performing full rollback with ${this.localFork.localOps.length} local operations`);
        
        // Only do full rollback if absolutely necessary
        // This should be rare with selective rollback in place
        
        // Find the nearest snapshot before fork start
        let snapshotSequence = this.localFork.baseSequence;
        while (snapshotSequence > 0 && !this.canvasSnapshots.has(snapshotSequence)) {
            snapshotSequence--;
        }
        
        // Rollback to snapshot or clear canvas
        if (this.canvasSnapshots.has(snapshotSequence)) {
            this.restoreFromSnapshot(snapshotSequence);
        } else {
            // No snapshot available, clear and replay everything
            console.warn('No snapshot available for rollback, clearing canvas');
            this.layers.clearAllLayers();
        }
        
        // Replay operations from snapshot to fork start
        const replayStart = snapshotSequence + 1;
        const replayEnd = this.localFork.baseSequence;
        for (let i = replayStart; i <= replayEnd && i < this.operationHistory.length; i++) {
            this.applyDrawOperationDirect(this.operationHistory[i]);
        }
        
        // Apply all remote operations that occurred during our fork
        for (const remoteOp of this.localFork.remoteOps) {
            this.applyDrawOperationDirect(remoteOp);
        }
        
        // Store local operations temporarily
        const localOps = [...this.localFork.localOps];
        
        // Clear fork
        this.clearLocalFork();
        
        // Replay local operations if still drawing
        if (this.isDrawing) {
            // Reinitialize fork
            this.localFork = {
                baseSequence: this.currentSequence,
                localOps: [],
                remoteOps: [],
                startsAtUndoPoint: false,
                fallbehind: 0
            };
            
            // Re-add local operations to new fork
            for (const op of localOps) {
                this.localFork.localOps.push(op);
                this.applyDrawOperation(op);
            }
        }
    }
    
    private clearLocalFork(): void {
        this.localFork = null;
        // Reset spatial system when fork is cleared
        this.spatialSystem.reset();
    }
    
    private applyLocalOperationToStroke(op: DrawOperation): void {
        // Ensure stroke buffer is active before drawing
        if (!this.drawing.isStrokeActive) {
            console.warn('Stroke buffer inactive, reinitializing for operation:', op.type);
            this.drawing.beginStroke();
        }
        
        try {
            // Apply a local operation to the stroke buffer
            switch (op.type) {
                case 'dab':
                    if (op.data.tool === 'pixel') {
                        this.drawing.drawPixelPerfectPoint(
                            op.data.x, op.data.y,
                            op.data.color,
                            op.data.size,
                            op.data.opacity,
                            null // null means use stroke buffer
                        );
                    } else if (op.data.tool === 'halftone') {
                        this.drawing.drawHalftoneWithOpacity(
                            op.data.x, op.data.y,
                            op.data.size,
                            op.data.color,
                            op.data.patternId,
                            op.data.density,
                            op.data.opacity,
                            null // null means use stroke buffer
                        );
                    }
                    break;
                    
                case 'line':
                    if (op.data.tool === 'pixel') {
                        this.drawing.drawPixelLineWithOpacity(
                            op.data.x1, op.data.y1,
                            op.data.x2, op.data.y2,
                            op.data.color,
                            op.data.size,
                            op.data.opacity,
                            null // null means use stroke buffer
                        );
                    } else if (op.data.tool === 'halftone') {
                        this.drawing.drawHalftoneLineWithOpacity(
                            op.data.x1, op.data.y1,
                            op.data.x2, op.data.y2,
                            op.data.size,
                            op.data.color,
                            op.data.patternId,
                            op.data.density,
                            op.data.opacity,
                            null // null means use stroke buffer
                        );
                    }
                    break;
            }
        } catch (error) {
            console.error('Error applying operation to stroke:', error, op);
            // Try to recover by reinitializing stroke buffer
            this.drawing.initializeStrokeBuffer(this.options.canvasWidth!, this.options.canvasHeight!);
            this.drawing.beginStroke();
        }
    }
    
    private hasDirectConflict(remoteOp: DrawOperation): boolean {
        if (!this.localFork) return false;
        
        for (const localOp of this.localFork.localOps) {
            if (this.areasIntersect(remoteOp.affectedArea, localOp.affectedArea)) {
                return true;
            }
        }
        return false;
    }
    
    private mergeAndApply(remoteOp: DrawOperation): void {
        // Attempt to merge remote operation with local operations
        // This is useful for operations that can be combined (e.g., overlapping strokes)
        
        if (!this.localFork || this.localFork.localOps.length === 0) {
            this.applyDrawOperationDirect(remoteOp);
            return;
        }
        
        // Find operations that can be merged
        const mergeCandidates = this.localFork.localOps.filter(localOp => {
            return localOp.type === remoteOp.type &&
                   localOp.data.layerId === remoteOp.data.layerId &&
                   this.areasIntersect(localOp.affectedArea, remoteOp.affectedArea);
        });
        
        if (mergeCandidates.length === 0) {
            // No merge candidates, apply normally
            this.applyDrawOperationDirect(remoteOp);
        } else {
            // Create merged operation
            console.log(`Merging ${mergeCandidates.length} operations with remote operation`);
            
            // Apply remote first (remote-first strategy for merges)
            this.applyDrawOperationDirect(remoteOp);
            
            // Reapply local operations on top with adjusted parameters
            for (const candidate of mergeCandidates) {
                // Adjust opacity or other parameters based on overlap
                const adjustedOp = { ...candidate };
                adjustedOp.data.opacity = Math.min(1, candidate.data.opacity * 0.7); // Reduce opacity for overlap
                this.applyDrawOperation(adjustedOp);
            }
        }
        
        this.operationHistory.push(remoteOp);
    }
    
    private takeSnapshot(): void {
        // Take a snapshot of all layers for rollback purposes
        const snapshot = new Map<number, ImageData>();
        const layers = this.layers.getAllLayers();
        
        for (const layer of layers) {
            const ctx = layer.ctx;
            const imageData = ctx.getImageData(0, 0, this.options.canvasWidth!, this.options.canvasHeight!);
            snapshot.set(layer.id, imageData);
        }
        
        this.canvasSnapshots.set(this.currentSequence, snapshot);
        this.lastSnapshotSequence = this.currentSequence;
        
        // Clean up old snapshots (keep last 5)
        const sequences = Array.from(this.canvasSnapshots.keys()).sort((a, b) => a - b);
        while (sequences.length > 5) {
            const oldSeq = sequences.shift()!;
            this.canvasSnapshots.delete(oldSeq);
        }
    }
    
    private restoreFromSnapshot(sequence: number): void {
        const snapshot = this.canvasSnapshots.get(sequence);
        if (!snapshot) return;
        
        for (const [layerId, imageData] of snapshot) {
            const layer = this.layers.getLayer(layerId);
            if (layer) {
                layer.ctx.putImageData(imageData, 0, 0);
            }
        }
    }
    
    // Apply operation directly without stroke buffer (for catchup)
    private applyDrawOperationDirect(op: DrawOperation): void {
        const targetLayer = this.layers.getLayer(op.data.layerId) || this.layers.getCurrentLayer();
        if (!targetLayer) return;
        
        // Always apply directly to the layer during catchup
        switch (op.type) {
            case 'dab':
                if (op.data.tool === 'pixel') {
                    this.drawing.drawPixelPerfectPoint(
                        op.data.x, op.data.y, 
                        op.data.color, 
                        op.data.size, 
                        op.data.opacity, 
                        targetLayer
                    );
                } else if (op.data.tool === 'halftone') {
                    this.drawing.drawHalftoneWithOpacity(
                        op.data.x, op.data.y, 
                        op.data.size, 
                        op.data.color, 
                        op.data.patternId, 
                        op.data.density, 
                        op.data.opacity, 
                        targetLayer
                    );
                }
                break;
                
            case 'line':
                if (op.data.tool === 'pixel') {
                    this.drawing.drawPixelLineWithOpacity(
                        op.data.x1, op.data.y1, 
                        op.data.x2, op.data.y2, 
                        op.data.color, 
                        op.data.size, 
                        op.data.opacity, 
                        targetLayer
                    );
                } else if (op.data.tool === 'halftone') {
                    this.drawing.drawHalftoneLineWithOpacity(
                        op.data.x1, op.data.y1, 
                        op.data.x2, op.data.y2, 
                        op.data.size, 
                        op.data.color, 
                        op.data.patternId, 
                        op.data.density, 
                        op.data.opacity, 
                        targetLayer
                    );
                }
                break;
        }
    }
    
    // Modified spatial concurrency methods
    private applyDrawOperation(op: DrawOperation): void {
        const targetLayer = this.layers.getLayer(op.data.layerId) || this.layers.getCurrentLayer();
        if (!targetLayer) return;
        
        // Use stroke buffer for local operations, direct for remote
        const isLocal = op.userId === this.network.userId;
        const useBuffer = isLocal && this.isDrawing && this.drawing.isStrokeActive;
        const drawTarget = useBuffer ? null : targetLayer;
        
        switch (op.type) {
            case 'dab':
                if (op.data.tool === 'pixel') {
                    this.drawing.drawPixelPerfectPoint(
                        op.data.x, op.data.y, 
                        op.data.color, 
                        op.data.size, 
                        op.data.opacity, 
                        drawTarget
                    );
                } else if (op.data.tool === 'halftone') {
                    this.drawing.drawHalftoneWithOpacity(
                        op.data.x, op.data.y, 
                        op.data.size, 
                        op.data.color, 
                        op.data.patternId, 
                        op.data.density, 
                        op.data.opacity, 
                        drawTarget
                    );
                }
                break;
                
            case 'line':
                if (op.data.tool === 'pixel') {
                    this.drawing.drawPixelLineWithOpacity(
                        op.data.x1, op.data.y1, 
                        op.data.x2, op.data.y2, 
                        op.data.color, 
                        op.data.size, 
                        op.data.opacity, 
                        drawTarget
                    );
                } else if (op.data.tool === 'halftone') {
                    this.drawing.drawHalftoneLineWithOpacity(
                        op.data.x1, op.data.y1, 
                        op.data.x2, op.data.y2, 
                        op.data.size, 
                        op.data.color, 
                        op.data.patternId, 
                        op.data.density, 
                        op.data.opacity, 
                        drawTarget
                    );
                }
                break;
        }
    }
    
    private rollbackDrawOperation(op: DrawOperation): void {
        // For rollback, we need to restore from a snapshot
        // This is simplified - in production you'd maintain snapshots
        console.warn('Rollback operation:', op);
        // In a full implementation, you would:
        // 1. Restore canvas to state before this operation
        // 2. Or maintain an undo stack with canvas snapshots
    }
    
    private saveCanvas(): void {
        const compositeCanvas = this.layers.saveCompositeCanvas();
        const link = document.createElement('a');
        link.download = `drawing-${CanvasUtils.getDateString()}.png`;
        link.href = compositeCanvas.toDataURL();
        link.click();
    }
    
    // UI update methods
    private updateLayerUI(): void {
        const layers = this.layers.getAllLayers();
        this.ui.updateLayerList(layers, this.layers.currentLayerId);
    }
    
    // Network connection
    connect(): void {
        // Check if we're in initial state loading
        if (this.network.isReceivingInitialState) {
            this.isCatchingUp = true;
        }
        this.network.connect();
    }
    
    // Clean up on disconnect
    disconnect(): void {
        if (this.metricsInterval) {
            clearInterval(this.metricsInterval);
            this.metricsInterval = null;
        }
        this.spatialSystem.reset();
        // Network doesn't have disconnect method yet, just reset state
        this.clearLocalFork();
        this.operationHistory = [];
        this.currentSequence = 0;
    }
}

// Initialize the client when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    const config = (window as any).CANVAS_CONFIG || {};
    const urlParams = new URLSearchParams(window.location.search);
    
    const roomId = config.roomId || urlParams.get('room') || 'default';
    const userName = config.userName || urlParams.get('user') || null;
    const canvasWidth = config.canvasWidth || 800;
    const canvasHeight = config.canvasHeight || 600;
    
    (window as any).canvasClient = new CanvasClient({
        roomId: roomId,
        userName: userName,
        canvasWidth: canvasWidth,
        canvasHeight: canvasHeight
    });
});

export { CanvasClient };