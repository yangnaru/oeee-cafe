// Canvas Spatial Concurrency System
// Based on Drawpile's approach: operations on different areas are concurrent

export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface AffectedArea {
    domain: 'drawing' | 'layer' | 'selection' | 'annotation' | 'transform';
    bounds: Rectangle;
    layerId?: number;
    selectionId?: number;
    // Drawpile-style indirect areas for complex operations
    indirect?: {
        affectsLayers?: number[];
        affectsSelections?: number[];
        affectsCanvas?: boolean;
    };
}

export interface DrawOperation {
    id: string;
    userId: number;
    sequence: number;
    timestamp: number;
    type: string;
    data: any;
    affectedArea: AffectedArea;
    priority?: number;
    coalescable?: boolean;
    compressed?: boolean;
    predictedConflicts?: string[];
}

export interface LocalFork {
    baseSequence: number;
    localOps: DrawOperation[];
    remoteOps: DrawOperation[];
    startsAtUndoPoint: boolean;
    fallbehind: number; // Track how far behind we are like Drawpile
}

export class SpatialConcurrency {
    private localUserId: number;
    private currentSequence: number = 0;
    private fork: LocalFork | null = null;
    private pendingLocalOps: DrawOperation[] = [];
    private operationBuffer: DrawOperation[] = [];
    private bufferCapacity: number = 8192; // Like Drawpile's REPLAY_BUFFER_CAPACITY
    private maxFallbehind: number = 10000; // Like Drawpile's MAX_FALLBEHIND
    private localDrawingInProgress: boolean = false;
    
    constructor(userId: number) {
        this.localUserId = userId;
    }
    
    // Check if two rectangles intersect
    private rectanglesIntersect(r1: Rectangle, r2: Rectangle): boolean {
        return !(r1.x + r1.width <= r2.x ||
                 r2.x + r2.width <= r1.x ||
                 r1.y + r1.height <= r2.y ||
                 r2.y + r2.height <= r1.y);
    }
    
    // Enhanced concurrency check based on Drawpile's affected_area_concurrent_with
    private areConcurrent(a1: AffectedArea, a2: AffectedArea): boolean {
        // Check indirect effects first
        if (a1.indirect || a2.indirect) {
            if (this.hasIndirectConflict(a1, a2)) {
                return false;
            }
        }
        
        // Different domains might conflict
        if (a1.domain !== a2.domain) {
            return this.areCrossDomainsCompatible(a1, a2);
        }
        
        // Same domain - check for spatial/resource conflicts
        return this.areSameDomainConcurrent(a1, a2);
    }
    
    private hasIndirectConflict(a1: AffectedArea, a2: AffectedArea): boolean {
        const i1 = a1.indirect;
        const i2 = a2.indirect;
        
        // Canvas-wide effects conflict with everything
        if (i1?.affectsCanvas || i2?.affectsCanvas) {
            return true;
        }
        
        // Check layer conflicts
        if (i1?.affectsLayers && i2?.affectsLayers) {
            const overlap = i1.affectsLayers.some(l => i2.affectsLayers!.includes(l));
            if (overlap) return true;
        }
        
        // Check selection conflicts
        if (i1?.affectsSelections && i2?.affectsSelections) {
            const overlap = i1.affectsSelections.some(s => i2.affectsSelections!.includes(s));
            if (overlap) return true;
        }
        
        return false;
    }
    
    private areCrossDomainsCompatible(a1: AffectedArea, a2: AffectedArea): boolean {
        // Drawing and selection operations might conflict spatially
        if ((a1.domain === 'drawing' && a2.domain === 'selection') ||
            (a1.domain === 'selection' && a2.domain === 'drawing')) {
            return !this.rectanglesIntersect(a1.bounds, a2.bounds);
        }
        
        // Layer operations conflict with drawing on the same layer
        if ((a1.domain === 'layer' && a2.domain === 'drawing') ||
            (a1.domain === 'drawing' && a2.domain === 'layer')) {
            return a1.layerId !== a2.layerId;
        }
        
        // Transform conflicts with drawing on same layer
        if ((a1.domain === 'transform' && a2.domain === 'drawing') ||
            (a1.domain === 'drawing' && a2.domain === 'transform')) {
            return a1.layerId !== a2.layerId;
        }
        
        // Most other cross-domain operations are concurrent
        return true;
    }
    
    private areSameDomainConcurrent(a1: AffectedArea, a2: AffectedArea): boolean {
        switch (a1.domain) {
            case 'drawing':
                // Different layers are always concurrent
                if (a1.layerId !== a2.layerId && 
                    a1.layerId !== undefined && 
                    a2.layerId !== undefined) {
                    return true;
                }
                // Same layer - check spatial overlap
                return !this.rectanglesIntersect(a1.bounds, a2.bounds);
                
            case 'layer':
                // Different layers don't conflict
                return a1.layerId !== a2.layerId;
                
            case 'selection':
                // Different selections are concurrent
                if (a1.selectionId !== a2.selectionId) {
                    return true;
                }
                // Same selection - check spatial overlap
                return !this.rectanglesIntersect(a1.bounds, a2.bounds);
                
            case 'annotation':
                // Annotations conflict if they overlap spatially
                return !this.rectanglesIntersect(a1.bounds, a2.bounds);
                
            case 'transform':
                // Transforms on different layers are concurrent
                return a1.layerId !== a2.layerId;
                
            default:
                return false;
        }
    }
    
    // Enhanced affected area calculation with indirect effects
    calculateAffectedArea(type: string, data: any): AffectedArea {
        switch (type) {
            case 'dab':
                const radius = Math.ceil((data.size || 1) * (data.brushSize || 1) / 2);
                return {
                    domain: 'drawing',
                    bounds: {
                        x: data.x - radius,
                        y: data.y - radius,
                        width: radius * 2,
                        height: radius * 2
                    },
                    layerId: data.layerId
                };
                
            case 'line':
                const lineRadius = Math.ceil((data.size || 1) * (data.brushSize || 1) / 2);
                const minX = Math.min(data.x1, data.x2) - lineRadius;
                const minY = Math.min(data.y1, data.y2) - lineRadius;
                const maxX = Math.max(data.x1, data.x2) + lineRadius;
                const maxY = Math.max(data.y1, data.y2) + lineRadius;
                return {
                    domain: 'drawing',
                    bounds: {
                        x: minX,
                        y: minY,
                        width: maxX - minX,
                        height: maxY - minY
                    },
                    layerId: data.layerId
                };
                
            case 'fill':
                // Flood fills affect uncertain area and potentially entire layer
                return {
                    domain: 'drawing',
                    bounds: {
                        x: data.x - 100,
                        y: data.y - 100,
                        width: 200,
                        height: 200
                    },
                    layerId: data.layerId,
                    indirect: {
                        affectsLayers: [data.layerId]
                    }
                };
                
            case 'layer_create':
            case 'layer_delete':
            case 'layer_opacity':
            case 'layer_blend':
                return {
                    domain: 'layer',
                    bounds: { x: 0, y: 0, width: 0, height: 0 },
                    layerId: data.layerId,
                    indirect: {
                        affectsLayers: [data.layerId],
                        affectsCanvas: data.type === 'layer_delete'
                    }
                };
                
            case 'selection_create':
            case 'selection_modify':
                return {
                    domain: 'selection',
                    bounds: data.bounds || { x: 0, y: 0, width: 0, height: 0 },
                    selectionId: data.selectionId
                };
                
            case 'transform':
                return {
                    domain: 'transform',
                    bounds: { x: 0, y: 0, width: 0, height: 0 },
                    layerId: data.layerId
                };
                
            default:
                // Unknown operations affect everything (conservative)
                return {
                    domain: 'drawing',
                    bounds: { x: 0, y: 0, width: 9999, height: 9999 },
                    indirect: {
                        affectsCanvas: true
                    }
                };
        }
    }
    
    // Process a local operation
    processLocalOperation(type: string, data: any): DrawOperation {
        const op: DrawOperation = {
            id: `${this.localUserId}-${Date.now()}-${Math.random()}`,
            userId: this.localUserId,
            sequence: ++this.currentSequence,
            timestamp: Date.now(),
            type,
            data,
            affectedArea: this.calculateAffectedArea(type, data)
        };
        
        // Add to pending local operations
        this.pendingLocalOps.push(op);
        
        // Add to buffer for batching
        this.operationBuffer.push(op);
        
        // If we have a fork, add to local fork operations
        if (this.fork) {
            this.fork.localOps.push(op);
        }
        
        return op;
    }
    
    // Enhanced remote operation processing with message matching
    processRemoteOperation(op: DrawOperation): 'concurrent' | 'conflict' | 'already_done' | 'rollback' {
        // Check if we've already processed this operation
        if (op.sequence <= this.currentSequence && op.userId === this.localUserId) {
            return 'already_done';
        }
        
        // Update sequence number
        if (op.sequence > this.currentSequence) {
            this.currentSequence = op.sequence;
        }
        
        // If we have no pending local operations, remote operations are always concurrent
        if (this.pendingLocalOps.length === 0) {
            return 'concurrent';
        }
        
        return this.reconcileRemoteOperation(op);
    }
    
    private reconcileRemoteOperation(op: DrawOperation): 'concurrent' | 'conflict' | 'already_done' | 'rollback' {
        if (!this.fork) {
            // Check against pending local operations
            for (const localOp of this.pendingLocalOps) {
                if (!this.areConcurrent(localOp.affectedArea, op.affectedArea)) {
                    // Conflict detected - need to create a fork
                    this.createFork();
                    this.fork!.remoteOps.push(op);
                    return 'conflict';
                }
            }
            return 'concurrent';
        }
        
        // We have a fork - check for message matching first
        const peekedOp = this.fork.localOps[0];
        if (peekedOp && op.userId === peekedOp.userId) {
            if (this.messagesMatch(op, peekedOp)) {
                // Same message - remove from local fork
                this.fork.localOps.shift();
                if (this.fork.localOps.length === 0) {
                    this.clearForkFallbehind();
                }
                return 'already_done';
            } else {
                // Different message from same user - rollback
                this.fork.fallbehind = 0;
                this.fork.localOps = [];
                this.fork.remoteOps = [];
                return 'rollback';
            }
        }
        
        // Different user - check fallbehind and concurrency
        this.fork.remoteOps.push(op);
        
        if (++this.fork.fallbehind >= this.maxFallbehind) {
            // Too far behind - force rollback
            this.fork.fallbehind = 0;
            this.fork.localOps = [];
            this.fork.remoteOps = [];
            return 'rollback';
        }
        
        // Check concurrency with all local fork operations
        for (const localOp of this.fork.localOps) {
            if (!this.areConcurrent(localOp.affectedArea, op.affectedArea)) {
                // Non-concurrent operation
                if (this.localDrawingInProgress) {
                    // Don't clear fork during drawing to avoid feedback loop
                    return 'conflict';
                } else {
                    // Clear fork and rollback
                    this.fork.localOps = [];
                    this.fork.remoteOps = [];
                    return 'rollback';
                }
            }
        }
        
        return 'concurrent';
    }
    
    private messagesMatch(op1: DrawOperation, op2: DrawOperation): boolean {
        // Simple message matching - in a real implementation this would be more sophisticated
        return op1.type === op2.type && 
               JSON.stringify(op1.data) === JSON.stringify(op2.data);
    }
    
    private clearForkFallbehind(): void {
        if (this.fork) {
            this.fork.fallbehind = 0;
        }
    }
    
    // Create a local fork for conflict resolution
    private createFork(): void {
        if (!this.fork) {
            this.fork = {
                baseSequence: this.currentSequence,
                localOps: [...this.pendingLocalOps],
                remoteOps: [],
                startsAtUndoPoint: false, // Could be enhanced to detect undo points
                fallbehind: 0
            };
        }
    }
    
    // Resolve conflicts by rolling back and replaying
    resolveConflicts(applyOperation: (op: DrawOperation) => void, 
                     rollbackOperation: (op: DrawOperation) => void): void {
        if (!this.fork) return;
        
        // Rollback all local operations
        for (let i = this.fork.localOps.length - 1; i >= 0; i--) {
            rollbackOperation(this.fork.localOps[i]);
        }
        
        // Apply remote operations first
        for (const remoteOp of this.fork.remoteOps) {
            applyOperation(remoteOp);
        }
        
        // Reapply local operations that don't conflict
        const reappliedOps: DrawOperation[] = [];
        for (const localOp of this.fork.localOps) {
            let hasConflict = false;
            
            // Check against all remote operations
            for (const remoteOp of this.fork.remoteOps) {
                if (!this.areConcurrent(localOp.affectedArea, remoteOp.affectedArea)) {
                    hasConflict = true;
                    break;
                }
            }
            
            if (!hasConflict) {
                // Update sequence number for reapplied operation
                localOp.sequence = ++this.currentSequence;
                applyOperation(localOp);
                reappliedOps.push(localOp);
            }
        }
        
        // Update pending operations
        this.pendingLocalOps = reappliedOps;
        
        // Clear the fork
        this.fork = null;
    }
    
    // Get buffered operations for batching
    getBufferedOperations(): DrawOperation[] {
        const ops = [...this.operationBuffer];
        this.operationBuffer = [];
        return ops;
    }
    
    // Check if buffer is full
    isBufferFull(): boolean {
        return this.operationBuffer.length >= this.bufferCapacity;
    }
    
    // Clear pending operations after they're confirmed by server
    clearPendingOperations(upToSequence: number): void {
        this.pendingLocalOps = this.pendingLocalOps.filter(op => op.sequence > upToSequence);
    }
    
    // Set local drawing state to prevent rollback storms
    setLocalDrawingInProgress(inProgress: boolean): void {
        this.localDrawingInProgress = inProgress;
    }
    
    // Get current fork status
    getForkStatus(): { hasFork: boolean; localOps: number; remoteOps: number; fallbehind: number } {
        if (!this.fork) {
            return { hasFork: false, localOps: 0, remoteOps: 0, fallbehind: 0 };
        }
        return {
            hasFork: true,
            localOps: this.fork.localOps.length,
            remoteOps: this.fork.remoteOps.length,
            fallbehind: this.fork.fallbehind
        };
    }
}