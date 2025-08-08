// Canvas Layer Management
// Handles layer system, operations, and Z-index management

interface LayersOptions {
    canvasWidth?: number;
    canvasHeight?: number;
    [key: string]: any;
}

interface Layer {
    id: number;
    name: string;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    visible: boolean;
    opacity: number;
    blendMode: string;
}

interface MergeResult {
    sourceLayerId: number;
    targetLayerId: number;
}

export class CanvasLayers {
    options: LayersOptions;
    layers: Map<number, Layer> = new Map();
    currentLayerId: number = 0;
    layerOrder: number[] = [];
    private canvasWrapper: HTMLElement | null = null;
    private overlayCanvas: HTMLCanvasElement | null = null;

    constructor(options: LayersOptions = {}) {
        this.options = options;
    }
    
    initialize(canvasWrapper: HTMLElement, overlayCanvas: HTMLCanvasElement): void {
        this.canvasWrapper = canvasWrapper;
        this.overlayCanvas = overlayCanvas;
        this.initializeLayers();
    }
    
    private initializeLayers(): void {
        // Create background layer
        const backgroundCanvas = document.getElementById('backgroundCanvas') as HTMLCanvasElement;
        
        if (!backgroundCanvas) {
            console.error('Background canvas not found! Canvas creation failed.');
            return;
        }
        
        const backgroundCtx = backgroundCanvas.getContext('2d')!;
        
        // Fill background with white
        backgroundCtx.fillStyle = '#ffffff';
        backgroundCtx.fillRect(0, 0, backgroundCanvas.width, backgroundCanvas.height);
                
        this.layers.set(0, {
            id: 0,
            name: 'Background',
            canvas: backgroundCanvas,
            ctx: backgroundCtx,
            visible: true,
            opacity: 1.0,
            blendMode: 'source-over'
        });
        
        this.layerOrder = [0];
        this.currentLayerId = 0;
        
        // Update z-indices for proper stacking
        this.updateLayerZIndices();
        
        // Apply pixel art rendering setup
        this.setupCanvasProperties();
        
        console.log('Initialized layer system with background canvas:', backgroundCanvas);
    }
    
    private setupCanvasProperties(): void {
        // Set up all layer canvas properties for pixel art
        this.layers.forEach(layer => {
            const ctx = layer.ctx;
            ctx.imageSmoothingEnabled = false;
            (ctx as any).webkitImageSmoothingEnabled = false;
            (ctx as any).mozImageSmoothingEnabled = false;
            (ctx as any).msImageSmoothingEnabled = false;
            ctx.lineCap = 'square';
            ctx.lineJoin = 'miter';
        });
    }
    
    addLayer(): number {
        const newLayerId = Math.max(...this.layerOrder) + 1;
        
        // Create new canvas element
        const canvas = document.createElement('canvas');
        canvas.width = this.options.canvasWidth || 800;
        canvas.height = this.options.canvasHeight || 600;
        canvas.className = 'layer-canvas';
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.setAttribute('data-layer-id', newLayerId.toString());
        
        // Insert before overlay canvas
        this.canvasWrapper!.insertBefore(canvas, this.overlayCanvas);
        
        const ctx = canvas.getContext('2d')!;
        // Pixel art rendering setup
        ctx.imageSmoothingEnabled = false;
        (ctx as any).webkitImageSmoothingEnabled = false;
        (ctx as any).mozImageSmoothingEnabled = false;
        (ctx as any).msImageSmoothingEnabled = false;
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        
        // Add to layer system
        this.layers.set(newLayerId, {
            id: newLayerId,
            name: `Layer ${newLayerId}`,
            canvas: canvas,
            ctx: ctx,
            visible: true,
            opacity: 1.0,
            blendMode: 'source-over'
        });
        
        this.layerOrder.push(newLayerId);
        this.updateLayerZIndices();
        this.setCurrentLayer(newLayerId);
        
        console.log('Added layer:', newLayerId);
        return newLayerId;
    }
    
    deleteLayer(layerId?: number | null): boolean {
        const targetLayerId = layerId || this.currentLayerId;
        
        if (this.layerOrder.length <= 1) {
            console.warn('Cannot delete the last layer');
            return false;
        }
        
        const layer = this.layers.get(targetLayerId);
        if (layer) {
            // Remove canvas element
            layer.canvas.remove();
            
            // Remove from layer system
            this.layers.delete(targetLayerId);
            this.layerOrder = this.layerOrder.filter(id => id !== targetLayerId);
            
            // Set new current layer if needed
            if (this.currentLayerId === targetLayerId) {
                const newCurrentLayer = this.layerOrder[Math.min(this.layerOrder.indexOf(targetLayerId), this.layerOrder.length - 1)] || this.layerOrder[0];
                this.setCurrentLayer(newCurrentLayer);
            }
            
            this.updateLayerZIndices();
            
            console.log('Deleted layer:', targetLayerId);
            return true;
        }
        return false;
    }
    
    mergeDown(sourceLayerId?: number | null): MergeResult | false {
        const targetSourceLayerId = sourceLayerId || this.currentLayerId;
        const currentIndex = this.layerOrder.indexOf(targetSourceLayerId);
        
        if (currentIndex <= 0) {
            console.warn('Cannot merge down - no layer below');
            return false;
        }
        
        const targetLayerId = this.layerOrder[currentIndex - 1];
        const sourceLayer = this.layers.get(targetSourceLayerId);
        const targetLayer = this.layers.get(targetLayerId);
        
        if (sourceLayer && targetLayer) {
            // Draw source layer onto target layer
            targetLayer.ctx.drawImage(sourceLayer.canvas, 0, 0);
            
            // Delete source layer
            this.deleteLayer(targetSourceLayerId);
            
            console.log(`Merged layer ${targetSourceLayerId} down to layer ${targetLayerId}`);
            return { sourceLayerId: targetSourceLayerId, targetLayerId: targetLayerId };
        }
        return false;
    }
    
    setCurrentLayer(layerId: number): boolean {
        this.currentLayerId = layerId;
        const layer = this.layers.get(layerId);
        if (!layer) {
            console.warn(`Layer ${layerId} not found`);
            return false;
        }
        return true;
    }
    
    getCurrentLayer(): Layer | undefined {
        return this.layers.get(this.currentLayerId);
    }
    
    getLayer(layerId: number): Layer | undefined {
        return this.layers.get(layerId);
    }
    
    private updateLayerZIndices(): void {
        // Update z-index values based on layer order
        this.layerOrder.forEach((layerId, index) => {
            const layer = this.layers.get(layerId);
            if (layer && layer.canvas) {
                // Background layer gets z-index 1, subsequent layers get higher values
                layer.canvas.style.zIndex = (index + 1).toString();
            }
        });
    }
    
    toggleLayerVisibility(layerId: number): boolean {
        const layer = this.layers.get(layerId);
        if (layer) {
            layer.visible = !layer.visible;
            layer.canvas.style.display = layer.visible ? 'block' : 'none';
            return layer.visible;
        }
        return false;
    }
    
    setLayerOpacity(layerId: number, opacity: number): number | false {
        const layer = this.layers.get(layerId);
        if (layer) {
            layer.opacity = Math.max(0, Math.min(1, opacity));
            return layer.opacity;
        }
        return false;
    }
    
    // Remote layer operations
    handleRemoteLayerCreation(layerId: number): void {
        // Check if layer already exists
        if (this.layers.has(layerId)) {
            console.log(`Layer ${layerId} already exists, skipping creation`);
            return;
        }
        
        // Create new canvas element
        const canvas = document.createElement('canvas');
        canvas.width = this.options.canvasWidth || 800;
        canvas.height = this.options.canvasHeight || 600;
        canvas.className = 'layer-canvas';
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.setAttribute('data-layer-id', layerId.toString());
        
        // Insert before overlay canvas
        this.canvasWrapper!.insertBefore(canvas, this.overlayCanvas);
        
        const ctx = canvas.getContext('2d')!;
        // Pixel art rendering setup
        ctx.imageSmoothingEnabled = false;
        (ctx as any).webkitImageSmoothingEnabled = false;
        (ctx as any).mozImageSmoothingEnabled = false;
        (ctx as any).msImageSmoothingEnabled = false;
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        
        // Add to layer system
        this.layers.set(layerId, {
            id: layerId,
            name: `Layer ${layerId}`,
            canvas: canvas,
            ctx: ctx,
            visible: true,
            opacity: 1.0,
            blendMode: 'source-over'
        });
        
        // Add to layer order (maintain proper ordering)
        let insertIndex = this.layerOrder.length;
        for (let i = 0; i < this.layerOrder.length; i++) {
            if (layerId < this.layerOrder[i]) {
                insertIndex = i;
                break;
            }
        }
        this.layerOrder.splice(insertIndex, 0, layerId);
        
        // Update z-indices
        this.updateLayerZIndices();
        
        console.log(`Remotely created layer: ${layerId}`);
    }
    
    handleRemoteLayerDeletion(layerId: number): void {
        const layer = this.layers.get(layerId);
        if (!layer) {
            console.log(`Layer ${layerId} not found for deletion`);
            return;
        }
        
        // Don't allow deletion of the last layer
        if (this.layerOrder.length <= 1) {
            console.log('Cannot delete the last layer remotely');
            return;
        }
        
        // Remove canvas element
        layer.canvas.remove();
        
        // Remove from layer system
        this.layers.delete(layerId);
        this.layerOrder = this.layerOrder.filter(id => id !== layerId);
        
        // If the deleted layer was the current layer, switch to another layer
        if (this.currentLayerId === layerId) {
            const newCurrentLayer = this.layerOrder[0] || 0;
            this.setCurrentLayer(newCurrentLayer);
        }
        
        // Update z-indices
        this.updateLayerZIndices();
        
        console.log(`Remotely deleted layer: ${layerId}`);
    }
    
    handleRemoteLayerMerge(sourceLayerId: number, targetLayerId: number): void {
        const sourceLayer = this.layers.get(sourceLayerId);
        const targetLayer = this.layers.get(targetLayerId);
        
        if (!sourceLayer) {
            console.log(`Source layer ${sourceLayerId} not found for merge`);
            return;
        }
        
        if (!targetLayer) {
            console.log(`Target layer ${targetLayerId} not found for merge`);
            return;
        }
        
        // Merge the source layer onto the target layer
        targetLayer.ctx.drawImage(sourceLayer.canvas, 0, 0);
        
        console.log(`Remotely merged layer ${sourceLayerId} down to layer ${targetLayerId}`);
    }
    
    // Utility methods
    getAllLayers(): Layer[] {
        return Array.from(this.layers.values());
    }
    
    getLayerOrder(): number[] {
        return [...this.layerOrder];
    }
    
    saveCompositeCanvas(): HTMLCanvasElement {
        // Create a composite canvas with all layers
        const compositeCanvas = document.createElement('canvas');
        compositeCanvas.width = this.options.canvasWidth || 800;
        compositeCanvas.height = this.options.canvasHeight || 600;
        const compositeCtx = compositeCanvas.getContext('2d')!;
        
        // Draw all visible layers in order
        this.layerOrder.forEach(layerId => {
            const layer = this.layers.get(layerId);
            if (layer && layer.visible) {
                compositeCtx.globalAlpha = layer.opacity;
                compositeCtx.drawImage(layer.canvas, 0, 0);
            }
        });
        
        return compositeCanvas;
    }
    
    clearLayer(layerId?: number | null): boolean {
        const targetLayerId = layerId || this.currentLayerId;
        const layer = this.layers.get(targetLayerId);
        if (layer) {
            layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
            
            // Fill background layer with white
            if (targetLayerId === 0) {
                layer.ctx.fillStyle = '#ffffff';
                layer.ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
            }
            
            return true;
        }
        return false;
    }
    
    clearAllLayers(): void {
        // Clear all layers for rollback purposes
        for (const [layerId, layer] of this.layers) {
            layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
            
            // Fill background layer with white
            if (layerId === 0) {
                layer.ctx.fillStyle = '#ffffff';
                layer.ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
            }
        }
    }
}