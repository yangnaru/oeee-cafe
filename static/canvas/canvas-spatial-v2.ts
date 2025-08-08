// Enhanced Canvas Spatial Consistency System V2
// Improvements over V1:
// 1. Operation coalescing for performance
// 2. Adaptive conflict resolution
// 3. Predictive conflict detection
// 4. Optimized area calculations with caching
// 5. Priority-based operation ordering
// 6. Operation compression for network efficiency

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
    // Enhanced indirect effects tracking
    indirect?: {
        affectsLayers?: number[];
        affectsSelections?: number[];
        affectsCanvas?: boolean;
        affectsRegion?: Rectangle; // New: specific region affected indirectly
    };
    // New: cache for performance
    _boundsHash?: string;
}

export interface DrawOperation {
    id: string;
    userId: number;
    sequence: number;
    timestamp: number;
    type: string;
    data: any;
    affectedArea: AffectedArea;
    // New fields for enhanced system
    priority?: number; // Operation priority (higher = more important)
    coalescable?: boolean; // Can be combined with adjacent operations
    compressed?: boolean; // Has been compressed for network
    predictedConflicts?: string[]; // Predicted conflicting operation IDs
}

export interface LocalFork {
    baseSequence: number;
    localOps: DrawOperation[];
    remoteOps: DrawOperation[];
    startsAtUndoPoint: boolean;
    fallbehind: number;
    // New: conflict tracking
    conflictMap: Map<string, string[]>; // op ID -> conflicting op IDs
    coalescedOps: Map<string, DrawOperation[]>; // coalesced op ID -> original ops
}

// Operation priority levels
export enum OperationPriority {
    SYSTEM = 100,     // System operations (highest)
    ERASER = 90,      // Eraser operations
    DRAWING = 50,     // Normal drawing
    ANNOTATION = 30,  // Annotations
    CURSOR = 10       // Cursor movements (lowest)
}

// Conflict resolution strategies
export enum ConflictStrategy {
    REMOTE_FIRST,     // Remote operation takes precedence
    LOCAL_FIRST,      // Local operation takes precedence
    MERGE,            // Attempt to merge operations
    SELECTIVE,        // Apply selective rollback
    TIMESTAMP         // Use timestamp ordering
}

export class EnhancedSpatialConsistency {
    private localUserId: number;
    private currentSequence: number = 0;
    private fork: LocalFork | null = null;
    private pendingLocalOps: DrawOperation[] = [];
    private operationBuffer: DrawOperation[] = [];
    private bufferCapacity: number = 8192;
    private maxFallbehind: number = 100; // Reduced from 10000 for faster reconciliation
    private localDrawingInProgress: boolean = false;
    
    // New: Performance optimization caches
    private areaCache: Map<string, Rectangle> = new Map();
    private conflictCache: Map<string, boolean> = new Map();
    private coalescenceWindow: number = 50; // ms window for coalescing
    private lastCoalescenceTime: number = 0;
    
    // New: Adaptive parameters
    private conflictStrategy: ConflictStrategy = ConflictStrategy.SELECTIVE;
    private adaptiveThreshold: number = 0.3; // 30% conflict rate triggers adaptation
    private conflictHistory: boolean[] = [];
    private historySize: number = 100;
    
    // New: Predictive system
    private operationPatterns: Map<string, number[]> = new Map(); // user -> operation type frequencies
    private spatialHeatmap: Map<string, number> = new Map(); // grid cell -> activity count
    private gridSize: number = 50; // 50x50 pixel grid cells
    
    constructor(userId: number) {
        this.localUserId = userId;
    }
    
    // Enhanced rectangle intersection with caching
    private rectanglesIntersect(r1: Rectangle, r2: Rectangle): boolean {
        const cacheKey = `${this.rectHash(r1)}-${this.rectHash(r2)}`;
        
        if (this.conflictCache.has(cacheKey)) {
            return this.conflictCache.get(cacheKey)!;
        }
        
        const result = !(
            r1.x + r1.width <= r2.x ||
            r2.x + r2.width <= r1.x ||
            r1.y + r1.height <= r2.y ||
            r2.y + r2.height <= r1.y
        );
        
        // Cache result
        this.conflictCache.set(cacheKey, result);
        
        // Limit cache size
        if (this.conflictCache.size > 1000) {
            const firstKey = this.conflictCache.keys().next().value;
            if (firstKey !== undefined) {
                this.conflictCache.delete(firstKey);
            }
        }
        
        return result;
    }
    
    private rectHash(r: Rectangle | undefined): string {
        if (!r) return 'undefined';
        return `${r.x},${r.y},${r.width},${r.height}`;
    }
    
    // Calculate operation priority
    private calculatePriority(op: DrawOperation): number {
        if (op.priority !== undefined) return op.priority;
        
        switch (op.type) {
            case 'erase':
            case 'clear':
                return OperationPriority.ERASER;
            case 'dab':
            case 'line':
            case 'fill':
                return OperationPriority.DRAWING;
            case 'annotation':
            case 'text':
                return OperationPriority.ANNOTATION;
            case 'cursor':
                return OperationPriority.CURSOR;
            default:
                return OperationPriority.DRAWING;
        }
    }
    
    // Operation coalescing for performance
    private coalesceOperations(ops: DrawOperation[]): DrawOperation[] {
        if (ops.length < 2) return ops;
        
        const coalesced: DrawOperation[] = [];
        let currentGroup: DrawOperation[] = [ops[0]];
        
        for (let i = 1; i < ops.length; i++) {
            const prev = ops[i - 1];
            const curr = ops[i];
            
            if (this.canCoalesce(prev, curr)) {
                currentGroup.push(curr);
            } else {
                // Finish current group
                if (currentGroup.length > 1) {
                    coalesced.push(this.mergeOperations(currentGroup));
                } else {
                    coalesced.push(currentGroup[0]);
                }
                currentGroup = [curr];
            }
        }
        
        // Handle last group
        if (currentGroup.length > 1) {
            coalesced.push(this.mergeOperations(currentGroup));
        } else {
            coalesced.push(currentGroup[0]);
        }
        
        return coalesced;
    }
    
    private canCoalesce(op1: DrawOperation, op2: DrawOperation): boolean {
        // Check basic compatibility
        if (op1.userId !== op2.userId ||
            op1.type !== op2.type ||
            op1.data.layerId !== op2.data.layerId ||
            op1.data.tool !== op2.data.tool) {
            return false;
        }
        
        // Check temporal proximity
        if (Math.abs(op2.timestamp - op1.timestamp) > this.coalescenceWindow) {
            return false;
        }
        
        // Check spatial proximity for line operations
        if (op1.type === 'line' && op2.type === 'line') {
            const distance = Math.hypot(
                op1.data.x2 - op2.data.x1,
                op1.data.y2 - op2.data.y1
            );
            return distance < 5; // Within 5 pixels
        }
        
        return false;
    }
    
    private mergeOperations(ops: DrawOperation[]): DrawOperation {
        const first = ops[0];
        const last = ops[ops.length - 1];
        
        // Create merged operation
        const merged: DrawOperation = {
            id: `coalesced-${first.id}-${last.id}`,
            userId: first.userId,
            sequence: last.sequence,
            timestamp: last.timestamp,
            type: 'coalesced',
            data: {
                originalOps: ops.map(op => op.id),
                operations: ops.map(op => ({ type: op.type, data: op.data }))
            },
            affectedArea: this.mergeAffectedAreas(ops.map(op => op.affectedArea)),
            coalescable: false,
            priority: Math.max(...ops.map(op => this.calculatePriority(op)))
        };
        
        // Store original operations for potential rollback
        if (this.fork) {
            this.fork.coalescedOps.set(merged.id, ops);
        }
        
        return merged;
    }
    
    private mergeAffectedAreas(areas: AffectedArea[]): AffectedArea {
        if (areas.length === 0) throw new Error('Cannot merge empty areas');
        if (areas.length === 1) return areas[0];
        
        // Calculate bounding box
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        for (const area of areas) {
            minX = Math.min(minX, area.bounds.x);
            minY = Math.min(minY, area.bounds.y);
            maxX = Math.max(maxX, area.bounds.x + area.bounds.width);
            maxY = Math.max(maxY, area.bounds.y + area.bounds.height);
        }
        
        // Merge indirect effects
        const merged: AffectedArea = {
            domain: areas[0].domain,
            bounds: {
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY
            },
            layerId: areas[0].layerId
        };
        
        // Merge indirect effects
        const allLayers = new Set<number>();
        const allSelections = new Set<number>();
        let affectsCanvas = false;
        
        for (const area of areas) {
            if (area.indirect) {
                area.indirect.affectsLayers?.forEach(l => allLayers.add(l));
                area.indirect.affectsSelections?.forEach(s => allSelections.add(s));
                affectsCanvas = affectsCanvas || area.indirect.affectsCanvas || false;
            }
        }
        
        if (allLayers.size > 0 || allSelections.size > 0 || affectsCanvas) {
            merged.indirect = {
                affectsLayers: Array.from(allLayers),
                affectsSelections: Array.from(allSelections),
                affectsCanvas
            };
        }
        
        return merged;
    }
    
    // Predictive conflict detection
    private predictConflicts(op: DrawOperation): string[] {
        const predictions: string[] = [];
        
        // Update spatial heatmap
        const gridX = Math.floor(op.affectedArea.bounds.x / this.gridSize);
        const gridY = Math.floor(op.affectedArea.bounds.y / this.gridSize);
        const gridKey = `${gridX},${gridY}`;
        
        const activity = this.spatialHeatmap.get(gridKey) || 0;
        this.spatialHeatmap.set(gridKey, activity + 1);
        
        // High activity areas are more likely to have conflicts
        if (activity > 5) {
            // Check pending operations in the same grid cell
            for (const pendingOp of this.operationBuffer) {
                const pendingGridX = Math.floor(pendingOp.affectedArea.bounds.x / this.gridSize);
                const pendingGridY = Math.floor(pendingOp.affectedArea.bounds.y / this.gridSize);
                
                if (pendingGridX === gridX && pendingGridY === gridY) {
                    predictions.push(pendingOp.id);
                }
            }
        }
        
        // Update operation patterns for the user
        const pattern = this.operationPatterns.get(String(op.userId)) || [];
        pattern.push(this.calculatePriority(op));
        if (pattern.length > 10) pattern.shift(); // Keep last 10 operations
        this.operationPatterns.set(String(op.userId), pattern);
        
        return predictions;
    }
    
    // Adaptive conflict resolution
    private selectConflictStrategy(): ConflictStrategy {
        // Calculate recent conflict rate
        const recentConflicts = this.conflictHistory.slice(-20);
        const conflictRate = recentConflicts.filter(c => c).length / recentConflicts.length;
        
        // Adapt strategy based on conflict rate
        if (conflictRate > 0.6) {
            // High conflict rate - use timestamp ordering for fairness
            return ConflictStrategy.TIMESTAMP;
        } else if (conflictRate > 0.3) {
            // Medium conflict rate - selective rollback
            return ConflictStrategy.SELECTIVE;
        } else if (this.localDrawingInProgress) {
            // Low conflict, local drawing - favor local
            return ConflictStrategy.LOCAL_FIRST;
        } else {
            // Low conflict, no local drawing - favor remote
            return ConflictStrategy.REMOTE_FIRST;
        }
    }
    
    // Enhanced concurrency check
    public areConcurrent(a1: AffectedArea, a2: AffectedArea): boolean {
        // Use cached result if available
        const cacheKey = `${a1._boundsHash || this.rectHash(a1.bounds)}-${a2._boundsHash || this.rectHash(a2.bounds)}`;
        if (this.conflictCache.has(cacheKey)) {
            return !this.conflictCache.get(cacheKey)!;
        }
        
        let concurrent = true;
        
        // Check indirect effects first (most likely to conflict)
        if (a1.indirect || a2.indirect) {
            if (this.hasIndirectConflict(a1, a2)) {
                concurrent = false;
            }
        }
        
        // Different domains might conflict
        if (concurrent && a1.domain !== a2.domain) {
            concurrent = this.areCrossDomainsCompatible(a1, a2);
        }
        
        // Same domain - check for spatial/resource conflicts
        if (concurrent && a1.domain === a2.domain) {
            concurrent = this.areSameDomainConcurrent(a1, a2);
        }
        
        // Cache result (inverted because cache stores conflicts)
        this.conflictCache.set(cacheKey, !concurrent);
        
        return concurrent;
    }
    
    private hasIndirectConflict(a1: AffectedArea, a2: AffectedArea): boolean {
        const i1 = a1.indirect;
        const i2 = a2.indirect;
        
        // Canvas-wide effects conflict with everything
        if (i1?.affectsCanvas || i2?.affectsCanvas) {
            return true;
        }
        
        // Check specific region conflicts
        if (i1?.affectsRegion && i2?.affectsRegion) {
            if (this.rectanglesIntersect(i1.affectsRegion, i2.affectsRegion)) {
                return true;
            }
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
        // Priority-based conflict resolution for cross-domain operations
        const priorityMap: { [key: string]: number } = {
            'transform': 5,
            'layer': 4,
            'selection': 3,
            'drawing': 2,
            'annotation': 1
        };
        
        const p1 = priorityMap[a1.domain] || 0;
        const p2 = priorityMap[a2.domain] || 0;
        
        // Higher priority operations can override lower priority ones
        if (Math.abs(p1 - p2) > 2) {
            return true; // Large priority difference = concurrent
        }
        
        // Special cases
        if ((a1.domain === 'drawing' && a2.domain === 'selection') ||
            (a1.domain === 'selection' && a2.domain === 'drawing')) {
            return !this.rectanglesIntersect(a1.bounds, a2.bounds);
        }
        
        if ((a1.domain === 'layer' && a2.domain === 'drawing') ||
            (a1.domain === 'drawing' && a2.domain === 'layer')) {
            return a1.layerId !== a2.layerId;
        }
        
        if ((a1.domain === 'transform' && a2.domain === 'drawing') ||
            (a1.domain === 'drawing' && a2.domain === 'transform')) {
            return a1.layerId !== a2.layerId;
        }
        
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
                // Same layer - check spatial overlap with tolerance
                const expanded1 = this.expandRectangle(a1.bounds, 2); // 2px tolerance
                const expanded2 = this.expandRectangle(a2.bounds, 2);
                return !this.rectanglesIntersect(expanded1, expanded2);
                
            case 'layer':
                return a1.layerId !== a2.layerId;
                
            case 'selection':
                if (a1.selectionId !== a2.selectionId) {
                    return true;
                }
                return !this.rectanglesIntersect(a1.bounds, a2.bounds);
                
            case 'annotation':
                // Annotations rarely conflict unless exact same position
                return !this.rectanglesIntersect(a1.bounds, a2.bounds);
                
            case 'transform':
                // Transforms on different layers are concurrent
                return a1.layerId !== a2.layerId;
                
            default:
                return !this.rectanglesIntersect(a1.bounds, a2.bounds);
        }
    }
    
    private expandRectangle(rect: Rectangle, amount: number): Rectangle {
        return {
            x: rect.x - amount,
            y: rect.y - amount,
            width: rect.width + amount * 2,
            height: rect.height + amount * 2
        };
    }
    
    // Process local operation with enhancements
    public processLocalOperation(op: DrawOperation): void {
        // Add priority if not set
        op.priority = op.priority || this.calculatePriority(op);
        
        // Predict potential conflicts
        op.predictedConflicts = this.predictConflicts(op);
        
        // Add to pending operations
        this.pendingLocalOps.push(op);
        
        // Try to coalesce if possible
        const now = Date.now();
        if (now - this.lastCoalescenceTime > this.coalescenceWindow) {
            this.pendingLocalOps = this.coalesceOperations(this.pendingLocalOps);
            this.lastCoalescenceTime = now;
        }
        
        // Initialize fork if needed
        if (!this.fork) {
            this.fork = {
                baseSequence: this.currentSequence,
                localOps: [],
                remoteOps: [],
                startsAtUndoPoint: false,
                fallbehind: 0,
                conflictMap: new Map(),
                coalescedOps: new Map()
            };
        }
        
        // Add to fork
        this.fork.localOps.push(op);
    }
    
    // Process remote operation with enhancements
    public processRemoteOperation(op: DrawOperation): ConflictStrategy {
        // Track conflict for adaptation
        let hasConflict = false;
        
        if (this.fork && this.fork.localOps.length > 0) {
            for (const localOp of this.fork.localOps) {
                if (!this.areConcurrent(op.affectedArea, localOp.affectedArea)) {
                    hasConflict = true;
                    // Track conflict in map
                    const conflicts = this.fork.conflictMap.get(op.id) || [];
                    conflicts.push(localOp.id);
                    this.fork.conflictMap.set(op.id, conflicts);
                }
            }
        }
        
        // Update conflict history
        this.conflictHistory.push(hasConflict);
        if (this.conflictHistory.length > this.historySize) {
            this.conflictHistory.shift();
        }
        
        // Select and return appropriate strategy
        return this.selectConflictStrategy();
    }
    
    // Compress operations for network efficiency
    public compressOperations(ops: DrawOperation[]): DrawOperation[] {
        // Group operations by type and layer
        const groups = new Map<string, DrawOperation[]>();
        
        for (const op of ops) {
            const key = `${op.type}-${op.data.layerId}`;
            const group = groups.get(key) || [];
            group.push(op);
            groups.set(key, group);
        }
        
        const compressed: DrawOperation[] = [];
        
        for (const [key, group] of groups) {
            if (group.length > 3) {
                // Compress large groups
                compressed.push(this.compressGroup(group));
            } else {
                // Keep small groups as-is
                compressed.push(...group);
            }
        }
        
        return compressed;
    }
    
    private compressGroup(ops: DrawOperation[]): DrawOperation {
        // Create a compressed representation
        const compressed: DrawOperation = {
            id: `compressed-${ops[0].id}-${ops[ops.length - 1].id}`,
            userId: ops[0].userId,
            sequence: ops[ops.length - 1].sequence,
            timestamp: ops[ops.length - 1].timestamp,
            type: 'compressed',
            data: {
                originalCount: ops.length,
                operations: this.deltaEncode(ops)
            },
            affectedArea: this.mergeAffectedAreas(ops.map(op => op.affectedArea)),
            compressed: true,
            priority: Math.max(...ops.map(op => this.calculatePriority(op)))
        };
        
        return compressed;
    }
    
    private deltaEncode(ops: DrawOperation[]): any[] {
        // Delta encoding for efficient compression
        const encoded: any[] = [];
        let prevOp: DrawOperation | null = null;
        
        for (const op of ops) {
            if (!prevOp) {
                encoded.push(op.data);
            } else {
                // Encode only differences
                const delta: any = {};
                for (const key in op.data) {
                    if (op.data[key] !== prevOp.data[key]) {
                        delta[key] = op.data[key];
                    }
                }
                encoded.push(delta);
            }
            prevOp = op;
        }
        
        return encoded;
    }
    
    // Clean up old cached data
    public cleanup(): void {
        // Clear old conflict cache entries
        if (this.conflictCache.size > 1000) {
            const toDelete = this.conflictCache.size - 500;
            let deleted = 0;
            for (const key of this.conflictCache.keys()) {
                if (deleted >= toDelete) break;
                this.conflictCache.delete(key);
                deleted++;
            }
        }
        
        // Clear old spatial heatmap entries
        if (this.spatialHeatmap.size > 500) {
            // Keep only hot spots
            const entries = Array.from(this.spatialHeatmap.entries());
            entries.sort((a, b) => b[1] - a[1]);
            this.spatialHeatmap = new Map(entries.slice(0, 100));
        }
        
        // Clear old operation patterns
        if (this.operationPatterns.size > 100) {
            const toDelete = this.operationPatterns.size - 50;
            let deleted = 0;
            for (const key of this.operationPatterns.keys()) {
                if (deleted >= toDelete) break;
                this.operationPatterns.delete(key);
                deleted++;
            }
        }
    }
    
    // Get performance metrics
    public getMetrics(): {
        conflictRate: number;
        cacheHitRate: number;
        coalescenceRate: number;
        avgFallbehind: number;
        hotspots: string[];
    } {
        const conflictRate = this.conflictHistory.filter(c => c).length / 
                           (this.conflictHistory.length || 1);
        
        const cacheHitRate = this.conflictCache.size / 
                            (this.conflictCache.size + this.areaCache.size || 1);
        
        const coalescenceRate = this.fork ? 
            (this.fork.coalescedOps.size / (this.fork.localOps.length || 1)) : 0;
        
        const avgFallbehind = this.fork ? this.fork.fallbehind : 0;
        
        const hotspots = Array.from(this.spatialHeatmap.entries())
            .filter(([_, count]) => count > 10)
            .map(([key, _]) => key);
        
        return {
            conflictRate,
            cacheHitRate,
            coalescenceRate,
            avgFallbehind,
            hotspots
        };
    }
    
    // Reset state
    public reset(): void {
        this.fork = null;
        this.pendingLocalOps = [];
        this.operationBuffer = [];
        this.conflictCache.clear();
        this.areaCache.clear();
        this.conflictHistory = [];
        this.currentSequence = 0;
    }
    
    // Set local drawing state
    public setLocalDrawingInProgress(inProgress: boolean): void {
        this.localDrawingInProgress = inProgress;
        
        if (!inProgress && this.fork) {
            // Drawing ended, adjust strategy
            this.conflictStrategy = this.selectConflictStrategy();
        }
    }
}

export default EnhancedSpatialConsistency;