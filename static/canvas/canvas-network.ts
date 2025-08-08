// Canvas Network Communication
// Handles WebSocket connections, protocol messages, and network state

import { SpatialConcurrency, DrawOperation } from './canvas-concurrency.js';

interface NetworkOptions {
    wsUrl?: string;
    roomId?: string;
    userName?: string;
    [key: string]: any;
}

interface MessageHandler {
    (data: any): void;
}

interface LayerOperationData {
    opacity?: number;
    visible?: boolean;
    targetLayerId?: number;
}

interface PixelCommandExtraData {
    size?: number;
    patternId?: string;
    density?: number;
    opacity?: number;
    x1?: number;
    y1?: number;
}

interface ColorRgb {
    r: number;
    g: number;
    b: number;
}

export class CanvasNetwork {
    options: NetworkOptions;
    private ws: WebSocket | null = null;
    private isConnected: boolean = false;
    userId: number = 0;
    
    // Spatial concurrency system
    private spatialConcurrency: SpatialConcurrency | null = null;
    private batchTimer: number | null = null;
    private batchInterval: number = 16; // ~60fps batching
    
    // Temporal ordering system for proper stroke layering
    private operationQueue: DrawOperation[] = [];
    private queueProcessTimer: number | null = null;
    private queueProcessInterval: number = 10; // Process queue every 10ms
    private logicalClock: number = 0; // Lamport logical clock for ordering
    
    // Network state tracking
    isReceivingInitialState: boolean = false;
    private initialStateMessageCount: number = 0;
    private hasReceivedDrawingCommands: boolean = false;
    
    // Callback handlers
    private messageHandlers: Map<string, MessageHandler> = new Map();
    onConnectionChange: ((status: string, text: string) => void) | null = null;
    onCatchupProgress: ((current: number, total: number) => void) | null = null;
    onConflictResolution: ((rollback: DrawOperation[], reapply: DrawOperation[]) => void) | null = null;

    constructor(options: NetworkOptions = {}) {
        this.options = options;
    }
    
    connect(): void {
        const wsUrl = `${this.options.wsUrl}?room_id=${encodeURIComponent(this.options.roomId || 'default')}&user_name=${encodeURIComponent(this.options.userName || 'Anonymous')}`;
        
        this.updateConnectionStatus('connecting', 'Connecting...');
        
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            this.isConnected = true;
            this.updateConnectionStatus('connected', 'Connected');
            this.callHandler('system_message', { type: 'connected', message: 'Connected to drawing room' });
            
            // Setup initial state tracking
            this.isReceivingInitialState = true;
            this.initialStateMessageCount = 0;
            this.hasReceivedDrawingCommands = false;
        };
        
        this.ws.onmessage = (event) => {
            if (event.data instanceof Blob) {
                event.data.arrayBuffer().then(buffer => {
                    const data = new Uint8Array(buffer);
                    this.handleCanvasMessage(data);
                });
            } else if (typeof event.data === 'string') {
                // Handle JSON messages from server with timestamps
                try {
                    const message = JSON.parse(event.data);
                    this.handleServerMessage(message);
                } catch (e) {
                    console.error('Failed to parse server message:', e);
                }
            }
        };
        
        this.ws.onclose = () => {
            this.isConnected = false;
            this.updateConnectionStatus('disconnected', 'Disconnected');
            this.callHandler('system_message', { type: 'disconnected', message: 'Disconnected from drawing room' });
            
            // Attempt reconnection
            setTimeout(() => this.connect(), 3000);
        };
        
        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.callHandler('system_message', { type: 'error', message: 'Connection error occurred' });
        };
    }
    
    private updateConnectionStatus(status: string, text: string): void {
        if (this.onConnectionChange) {
            this.onConnectionChange(status, text);
        }
    }
    
    private handleServerMessage(message: any): void {
        if (!message || !message.msg_type) return;
        
        switch (message.msg_type) {
            case 'catchup_start':
                this.callHandler('catchup_start', message.data);
                break;
                
            case 'catchup_progress':
                if (this.onCatchupProgress) {
                    this.onCatchupProgress(message.data.current, message.data.total);
                }
                break;
                
            case 'catchup_complete':
                this.callHandler('catchup_complete', {});
                break;
                
            default:
                // Handle drawing messages with server timestamps
                if (message.server_timestamp && message.sequence_number) {
                    this.handleTimestampedDrawingMessage(message);
                } else {
                    // Fallback for other message types
                    this.callHandler(message.msg_type, message.data);
                }
                break;
        }
    }
    
    private handleTimestampedDrawingMessage(message: any): void {
        // Convert server message to DrawOperation with server timestamp
        const op = this.convertServerMessageToDrawOperation(message);
        if (op) {
            this.processRemoteDrawOperationWithTimestamp(op);
        }
    }
    
    private convertServerMessageToDrawOperation(message: any): DrawOperation | null {
        // This would need to parse the server's JSON message format
        // For now, let's assume the server sends the same binary data in the 'data' field
        if (message.data && message.data.payload) {
            const op = this.convertNetworkMessageToDrawOperation(
                new Uint8Array(message.data.payload), 
                parseInt(message.client_id) || 0
            );
            
            if (op) {
                // Use server timestamp and sequence number for proper ordering
                op.timestamp = message.server_timestamp;
                op.sequence = message.sequence_number;
                return op;
            }
        }
        return null;
    }
    
    // Message handling system
    registerHandler(messageType: string, handler: MessageHandler): void {
        this.messageHandlers.set(messageType, handler);
    }
    
    private callHandler(messageType: string, data: any): void {
        const handler = this.messageHandlers.get(messageType);
        if (handler) {
            handler(data);
        }
    }
    
    // Canvas message parsing
    private handleCanvasMessage(data: Uint8Array): void {
        if (data.length < 8) return;

        const length = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
        const msgType = data[4];
        const senderId = (data[6] << 8) | data[7];
        const payload = data.slice(8, 8 + length);

        // Track initial state loading progress
        if (this.isReceivingInitialState && this.isDrawingMessage(msgType)) {
            if (!this.hasReceivedDrawingCommands) {
                this.hasReceivedDrawingCommands = true;
                this.callHandler('catchup_start', {});
            }
            this.initialStateMessageCount++;
            if (this.onCatchupProgress) {
                this.onCatchupProgress(this.initialStateMessageCount, this.initialStateMessageCount + 10);
            }
        }

        switch (msgType) {
            case 200: // User list
                this.handleUserList(payload);
                break;
            case 201: // Chat message
                this.callHandler('chat_message', { payload, senderId });
                break;
            case 64: // Pen down
                this.callHandler('pen_down', { payload, senderId });
                break;
            case 65: // Pen move
                this.callHandler('pen_move', { payload, senderId });
                break;
            case 66: // Pen up
                this.callHandler('pen_up', { payload, senderId });
                break;
            case 68: // Cursor position
                this.callHandler('cursor_position', { payload, senderId });
                break;
            case 69: // Layer operation
                this.callHandler('layer_operation', { payload, senderId });
                break;
            case 70: // Annotation/text
                this.callHandler('annotation', { payload, senderId });
                break;
            case 74: // Pixel art command
                this.callHandler('pixel_command', { payload, senderId });
                break;
            case 71: // Halftone pattern
                this.callHandler('halftone_pattern', { payload, senderId });
                break;
        }
    }
    
    private isDrawingMessage(msgType: number): boolean {
        return [64, 65, 66, 74].includes(msgType);
    }
    
    private handleUserList(payload: Uint8Array): void {
        try {
            const users = JSON.parse(new TextDecoder().decode(payload));
            
            // Find our user ID
            users.forEach((user: any) => {
                if (user.name === this.options.userName) {
                    this.userId = user.user_id;
                    // Initialize spatial concurrency with our user ID
                    this.spatialConcurrency = new SpatialConcurrency(this.userId);
                }
            });
            
            this.callHandler('user_list', users);
            
            // Hide catchup overlay as initial state loading is complete
            if (this.isReceivingInitialState) {
                this.isReceivingInitialState = false;
                
                if (this.hasReceivedDrawingCommands) {
                    setTimeout(() => {
                        this.callHandler('catchup_complete', {});
                    }, 500);
                }
            }
        } catch (e) {
            console.error('Error parsing user list:', e);
        }
    }
    
    // Message sending methods
    private sendCanvasMessage(msgType: number, payload: Uint8Array): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const length = payload.length;
        const header = new Uint8Array(8);
        
        header[0] = (length >> 24) & 0xFF;
        header[1] = (length >> 16) & 0xFF;
        header[2] = (length >> 8) & 0xFF;
        header[3] = length & 0xFF;
        header[4] = msgType;
        header[5] = 0;
        header[6] = 0;
        header[7] = 0;

        const message = new Uint8Array(8 + length);
        message.set(header, 0);
        message.set(payload, 8);

        this.ws.send(message);
    }
    
    
    sendPenUp(): void {
        this.sendCanvasMessage(66, new Uint8Array(0));
    }
    
    sendCursorPosition(x: number, y: number): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        
        const payload = new Uint8Array(4);
        payload[0] = (x >> 8) & 0xFF;
        payload[1] = x & 0xFF;
        payload[2] = (y >> 8) & 0xFF;
        payload[3] = y & 0xFF;
        
        this.sendCanvasMessage(68, payload);
    }
    
    sendLayerOperation(operation: string, layerId: number, data: LayerOperationData = {}): void {
        const operationMap: { [key: string]: number } = { 'create': 1, 'delete': 2, 'switch': 3, 'opacity': 4, 'visibility': 5, 'merge': 6 };
        const opCode = operationMap[operation] || 1;
        
        const payload = new Uint8Array(8);
        payload[0] = opCode;
        payload[1] = layerId & 0xFF;
        payload[2] = (layerId >> 8) & 0xFF;
        payload[3] = Math.floor((data.opacity || 1.0) * 255);
        payload[4] = data.visible ? 1 : 0;
        payload[5] = data.targetLayerId !== undefined ? (data.targetLayerId & 0xFF) : 0;
        payload[6] = data.targetLayerId !== undefined ? ((data.targetLayerId >> 8) & 0xFF) : 0;
        payload[7] = 0; // reserved
        
        this.sendCanvasMessage(69, payload);
    }
    
    sendPixelCommand(command: string, x: number, y: number, color: string, targetLayerId: number | null = null, extraData: PixelCommandExtraData = {}): void {
        const isLineCommand = command === 'line' || command === 'halftone_line';
        const payloadSize = isLineCommand ? 20 : 16;
        const payload = new Uint8Array(payloadSize);
        
        // Position
        payload[0] = Math.floor(x) >> 8;
        payload[1] = Math.floor(x) & 0xFF;
        payload[2] = Math.floor(y) >> 8;
        payload[3] = Math.floor(y) & 0xFF;
        
        // Color
        const colorRgb = this.parseColor(color);
        payload[4] = colorRgb.r;
        payload[5] = colorRgb.g;
        payload[6] = colorRgb.b;
        payload[7] = Math.floor((extraData.opacity || 1.0) * 255);
        
        // Command type
        const commandMap: { [key: string]: number } = { 
            'pixel': 1, 
            'line': 2, 
            'halftone': 3, 
            'halftone_line': 4
        };
        payload[8] = commandMap[command] || 1;
        
        // Layer ID
        payload[9] = (targetLayerId || 0) & 0xFF;
        payload[10] = ((targetLayerId || 0) >> 8) & 0xFF;
        
        if (isLineCommand && extraData.x1 !== undefined && extraData.y1 !== undefined) {
            // For line commands
            payload[11] = extraData.size || 1;
            payload[12] = extraData.patternId ? this.getPatternId(extraData.patternId) : 0;
            payload[13] = extraData.density || 32;
            payload[14] = 0;
            payload[15] = 0;
            payload[16] = Math.floor(extraData.x1) >> 8;
            payload[17] = Math.floor(extraData.x1) & 0xFF;
            payload[18] = Math.floor(extraData.y1) >> 8;
            payload[19] = Math.floor(extraData.y1) & 0xFF;
        } else {
            // Extra data
            payload[11] = extraData.size || 1;
            payload[12] = extraData.patternId ? this.getPatternId(extraData.patternId) : 0;
            payload[13] = extraData.density || 32;
            payload[14] = 0;
            payload[15] = 0;
        }
        
        this.sendCanvasMessage(74, payload);
    }
    
    sendChatMessage(content: string): void {
        if (!content || !this.isConnected) return;
        
        const messageBytes = new TextEncoder().encode(content);
        this.sendCanvasMessage(201, messageBytes);
    }
    
    
    // Utility methods
    private parseColor(color: string): ColorRgb {
        if (typeof color === 'string') {
            if (color.startsWith('#')) {
                const hex = color.substring(1);
                return {
                    r: parseInt(hex.substring(0, 2), 16),
                    g: parseInt(hex.substring(2, 4), 16),
                    b: parseInt(hex.substring(4, 6), 16)
                };
            } else if (color.startsWith('rgb')) {
                const match = color.match(/\d+/g);
                if (match && match.length >= 3) {
                    return {
                        r: parseInt(match[0]),
                        g: parseInt(match[1]),
                        b: parseInt(match[2])
                    };
                }
            }
        }
        return { r: 0, g: 0, b: 0 };
    }
    
    private getBlendModeId(blendMode: string): number {
        const blendModeMap: { [key: string]: number } = {
            'source-over': 0,
            'multiply': 1,
            'screen': 2,
            'overlay': 3,
            'soft-light': 4,
            'hard-light': 5,
            'color-dodge': 6,
            'color-burn': 7,
            'destination-out': 8
        };
        return blendModeMap[blendMode] || 0;
    }
    
    
    private getPatternId(patternName: string): number {
        const patternIds: { [key: string]: number } = {
            'bayer4x4': 1,
            'bayer2x2': 2,
            'lines4x4': 3
        };
        return patternIds[patternName] || 0;
    }
    
    // Spatial concurrency methods
    processLocalDrawOperation(type: string, data: any): void {
        if (!this.spatialConcurrency) return;
        
        // Process operation through spatial concurrency system
        const op = this.spatialConcurrency.processLocalOperation(type, data);
        
        // Queue the operation for temporal ordering instead of applying immediately
        this.queueOperationForTemporal(op, true); // true = local operation
        
        // Start batch timer if not already running
        if (!this.batchTimer) {
            this.batchTimer = window.setTimeout(() => {
                this.flushBatch();
            }, this.batchInterval);
        }
        
        // If buffer is full, flush immediately
        if (this.spatialConcurrency.isBufferFull()) {
            this.flushBatch();
        }
    }
    
    private flushBatch(): void {
        if (!this.spatialConcurrency) return;
        
        // Clear timer
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        
        // Get buffered operations
        const operations = this.spatialConcurrency.getBufferedOperations();
        if (operations.length === 0) return;
        
        // Convert spatial concurrency operations to network messages
        for (const op of operations) {
            this.sendDrawOperationAsNetworkMessage(op);
        }
    }
    
    private sendDrawOperationAsNetworkMessage(op: DrawOperation): void {
        switch (op.type) {
            case 'dab':
                this.sendPixelCommand(op.data.tool, op.data.x, op.data.y, op.data.color, op.data.layerId, {
                    size: op.data.size,
                    patternId: op.data.patternId,
                    density: op.data.density,
                    opacity: op.data.opacity
                });
                break;
                
            case 'line':
                const command = op.data.tool === 'pixel' ? 'line' : 'halftone_line';
                this.sendPixelCommand(command, op.data.x1, op.data.y1, op.data.color, op.data.layerId, {
                    x1: op.data.x2, 
                    y1: op.data.y2, 
                    size: op.data.size, 
                    opacity: op.data.opacity,
                    patternId: op.data.patternId,
                    density: op.data.density
                });
                break;
        }
    }
    
    handleRemoteDrawOperation(op: DrawOperation): void {
        if (!this.spatialConcurrency) return;
        
        const result = this.spatialConcurrency.processRemoteOperation(op);
        
        switch (result) {
            case 'concurrent':
                // Operation doesn't conflict, queue for temporal ordering
                this.queueOperationForTemporal(op, false); // false = remote operation
                break;
                
            case 'conflict':
                // Conflict detected, need to resolve
                this.resolveConflicts();
                break;
                
            case 'rollback':
                // Rollback requested, need to resolve
                this.resolveConflicts();
                break;
                
            case 'already_done':
                // Operation already processed, ignore
                break;
        }
    }
    
    private resolveConflicts(): void {
        if (!this.spatialConcurrency) return;
        
        const rollbackOps: DrawOperation[] = [];
        const reapplyOps: DrawOperation[] = [];
        
        this.spatialConcurrency.resolveConflicts(
            (op) => {
                // Apply operation callback - queue for temporal ordering
                reapplyOps.push(op);
                this.queueOperationForTemporal(op, op.userId === this.userId); // Check if it's our operation
            },
            (op) => {
                // Rollback operation callback
                rollbackOps.push(op);
                this.callHandler('rollback_operation', op);
            }
        );
        
        // Notify about conflict resolution
        if (this.onConflictResolution) {
            this.onConflictResolution(rollbackOps, reapplyOps);
        }
    }
    
    // Set local drawing state for spatial concurrency
    setLocalDrawingInProgress(inProgress: boolean): void {
        if (this.spatialConcurrency) {
            this.spatialConcurrency.setLocalDrawingInProgress(inProgress);
        }
    }
    
    // Process remote operations with server timestamps for proper ordering
    private processRemoteDrawOperationWithTimestamp(op: DrawOperation): void {
        if (!this.spatialConcurrency) return;
        
        // Use server timestamp as the authoritative ordering mechanism
        // Server timestamps ensure global consistency across all clients
        const result = this.spatialConcurrency.processRemoteOperation(op);
        
        switch (result) {
            case 'concurrent':
                // Operation doesn't conflict, queue with server timestamp for temporal ordering
                this.queueOperationForTemporal(op, false);
                break;
                
            case 'conflict':
            case 'rollback':
                // Conflict detected, need to resolve
                this.resolveConflicts();
                break;
                
            case 'already_done':
                // Operation already processed, ignore
                break;
        }
    }
    
    // Temporal ordering system for proper stroke layering
    private queueOperationForTemporal(op: DrawOperation, isLocal: boolean = false): void {
        // For operations with server timestamps, use those directly for ordering
        // For local operations, use logical clock until server confirms with timestamp
        if (isLocal) {
            // Local operation - use logical clock temporarily
            this.logicalClock++;
            op.sequence = this.logicalClock;
        } else if (op.timestamp && op.sequence) {
            // Remote operation with server timestamp - use server's authoritative ordering
            // Update our logical clock to stay in sync
            this.logicalClock = Math.max(this.logicalClock, op.sequence) + 1;
        }
        
        // Add operation to temporal queue
        this.operationQueue.push(op);
        
        // Start queue processing timer if not running
        if (!this.queueProcessTimer) {
            this.queueProcessTimer = window.setTimeout(() => {
                this.processTemporalQueue();
            }, this.queueProcessInterval);
        }
    }
    
    private processTemporalQueue(): void {
        if (this.queueProcessTimer) {
            clearTimeout(this.queueProcessTimer);
            this.queueProcessTimer = null;
        }
        
        if (this.operationQueue.length === 0) return;
        
        // Sort operations by server timestamp for authoritative ordering
        // Server timestamps are the source of truth for global operation order
        this.operationQueue.sort((a, b) => {
            // Operations with server timestamps (from server) take priority
            const aHasServerTime = a.timestamp && a.sequence && a.userId !== this.userId;
            const bHasServerTime = b.timestamp && b.sequence && b.userId !== this.userId;
            
            if (aHasServerTime && bHasServerTime) {
                // Both have server timestamps - sort by server sequence number
                if (a.sequence !== b.sequence) {
                    return a.sequence - b.sequence;
                }
                // Fallback to server timestamp
                return a.timestamp - b.timestamp;
            } else if (aHasServerTime && !bHasServerTime) {
                // Server-timestamped operations come before local operations with same logical time
                if (a.sequence <= b.sequence) return -1;
                return a.timestamp - b.timestamp;
            } else if (!aHasServerTime && bHasServerTime) {
                // Server-timestamped operations come before local operations with same logical time
                if (b.sequence <= a.sequence) return 1;
                return a.timestamp - b.timestamp;
            } else {
                // Both are local operations - use logical clock ordering
                if (a.sequence !== b.sequence) {
                    return a.sequence - b.sequence;
                }
                // Tie-break by user ID for deterministic ordering
                if (a.userId !== b.userId) {
                    return a.userId - b.userId;
                }
                // Final fallback to timestamp
                return a.timestamp - b.timestamp;
            }
        });
        
        // Apply all queued operations in logical order
        const opsToApply = [...this.operationQueue];
        this.operationQueue = [];
        
        for (const op of opsToApply) {
            this.callHandler('apply_operation', op);
        }
        
        // If more operations were added during processing, schedule another round
        if (this.operationQueue.length > 0) {
            this.queueProcessTimer = window.setTimeout(() => {
                this.processTemporalQueue();
            }, this.queueProcessInterval);
        }
    }
    
    // Convert network message to DrawOperation
    convertNetworkMessageToDrawOperation(payload: Uint8Array, senderId: number): DrawOperation | null {
        if (payload.length < 16) return null;
        
        // If spatial concurrency is not initialized yet, return null to use fallback handling
        if (!this.spatialConcurrency) return null;
        
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
        
        const baseData = {
            x, y, color,
            layerId: targetLayerId,
            size, brushSize: size,
            opacity,
            tool: 'pixel'
        };
        
        switch (command) {
            case 1: // pixel
                return {
                    id: `remote-${senderId}-${Date.now()}-${Math.random()}`,
                    userId: senderId,
                    sequence: Date.now(), // Use timestamp as logical clock for remote operations
                    timestamp: Date.now(),
                    type: 'dab',
                    data: { ...baseData, tool: 'pixel' },
                    affectedArea: this.spatialConcurrency.calculateAffectedArea('dab', baseData)
                };
                
            case 2: // line
                if (payload.length >= 20) {
                    const x2 = (payload[16] << 8) | payload[17];
                    const y2 = (payload[18] << 8) | payload[19];
                    const lineData = {
                        x1: x, y1: y, x2, y2,
                        color, layerId: targetLayerId,
                        size, brushSize: size, opacity,
                        tool: 'pixel'
                    };
                    return {
                        id: `remote-${senderId}-${Date.now()}-${Math.random()}`,
                        userId: senderId,
                        sequence: Date.now(), // Use timestamp as logical clock for remote operations
                        timestamp: Date.now(),
                        type: 'line',
                        data: lineData,
                        affectedArea: this.spatialConcurrency.calculateAffectedArea('line', lineData)
                    };
                }
                break;
                
            case 3: // halftone
                const patternId = payload[12] || 0;
                const patternName = this.getPatternNameFromId(patternId);
                const density = payload[13] || 32;
                return {
                    id: `remote-${senderId}-${Date.now()}-${Math.random()}`,
                    userId: senderId,
                    sequence: Date.now(), // Use timestamp as logical clock for remote operations
                    timestamp: Date.now(),
                    type: 'dab',
                    data: { ...baseData, tool: 'halftone', patternId: patternName, density },
                    affectedArea: this.spatialConcurrency.calculateAffectedArea('dab', baseData)
                };
                
            case 4: // halftone_line
                if (payload.length >= 20) {
                    const x2h = (payload[16] << 8) | payload[17];
                    const y2h = (payload[18] << 8) | payload[19];
                    const patternIdLine = payload[12] || 0;
                    const patternNameLine = this.getPatternNameFromId(patternIdLine);
                    const densityLine = payload[13] || 32;
                    const halftoneLineData = {
                        x1: x, y1: y, x2: x2h, y2: y2h,
                        color, layerId: targetLayerId,
                        size, brushSize: size, opacity,
                        tool: 'halftone', patternId: patternNameLine, density: densityLine
                    };
                    return {
                        id: `remote-${senderId}-${Date.now()}-${Math.random()}`,
                        userId: senderId,
                        sequence: 0,
                        timestamp: Date.now(),
                        type: 'line',
                        data: halftoneLineData,
                        affectedArea: this.spatialConcurrency.calculateAffectedArea('line', halftoneLineData)
                    };
                }
                break;
        }
        
        return null;
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
    
    // Get fork status for debugging
    getForkStatus(): { hasFork: boolean; localOps: number; remoteOps: number } {
        if (!this.spatialConcurrency) {
            return { hasFork: false, localOps: 0, remoteOps: 0 };
        }
        return this.spatialConcurrency.getForkStatus();
    }
    
}