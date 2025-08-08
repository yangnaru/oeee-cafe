// Canvas UI Components
// Handles DOM creation, event listeners, and user interface controls

interface UIOptions {
    canvasWidth?: number;
    canvasHeight?: number;
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

interface Layer {
    id: number;
    name: string;
    visible: boolean;
    opacity: number;
}

interface User {
    user_id: number;
    name: string;
}

export class CanvasUI {
    options: UIOptions;
    private strings: { [key: string]: string };
    
    // UI elements
    private canvasWrapper: HTMLElement | null = null;
    private overlayCanvas: HTMLCanvasElement | null = null;
    private overlayCtx: CanvasRenderingContext2D | null = null;
    private statusIndicator: HTMLElement | null = null;
    private statusText: HTMLElement | null = null;
    private catchupOverlay: HTMLElement | null = null;
    
    // Event callbacks
    onToolChange: ((tool: string) => void) | null = null;
    onBrushChange: ((change: BrushChange) => void) | null = null;
    onColorChange: ((color: string) => void) | null = null;
    onLayerAction: ((action: string, layerId?: number) => void) | null = null;
    onCanvasAction: ((action: string) => void) | null = null;
    onZoomChange: ((action: string) => void) | null = null;
    onChatMessage: ((message: string) => void) | null = null;
    onMouseEvent: ((type: string, data: MouseEventData) => void) | null = null;
    onGridToggle: ((visible: boolean) => void) | null = null;
    onPrecisionToolChange: ((tool: string) => void) | null = null;

    constructor(options: UIOptions = {}) {
        this.options = options;
        this.strings = ((window as any).CANVAS_CONFIG && (window as any).CANVAS_CONFIG.strings) || {};
    }
    
    // Helper method to get localized string with fallback
    private t(key: string, fallback: string = key): string {
        return this.strings[key] || fallback;
    }
    
    createUI(): void {
        console.log('Canvas dimensions:', this.options.canvasWidth, 'x', this.options.canvasHeight);
        
        const app = document.createElement('div');
        app.className = 'canvas-app';
        app.innerHTML = `
            <header class="canvas-header">
                <h1 class="canvas-title">Collaborative Drawing</h1>
                <div class="connection-status">
                    <span class="status-indicator status-disconnected" id="statusIndicator"></span>
                    <span id="statusText">Disconnected</span>
                </div>
            </header>
            
            <main class="canvas-main">
                <aside class="toolbar">
                    <div class="toolbar-section">
                        <h3>${this.t('tools', 'Tools')}</h3>
                        <div class="tool-group">
                            <button class="tool-btn active" data-tool="brush" title="${this.t('brush', 'Brush')}">
                                ✏️
                            </button>
                            <button class="tool-btn" data-tool="eraser" title="${this.t('eraser', 'Eraser')}">
                                🗑️
                            </button>
                            <button class="tool-btn" data-tool="eyedropper" title="${this.t('colorPicker', 'Color Picker')}">
                                💧
                            </button>
                            <button class="tool-btn" data-tool="pan" title="${this.t('pan', 'Pan')}">
                                ✋
                            </button>
                        </div>
                    </div>
                    
                    <div class="toolbar-section">
                        <h3>${this.t('precisionTools', 'Precision Tools')}</h3>
                        <div class="tool-group">
                            <button class="tool-btn precision-tool active" data-precision-tool="pixel" title="${this.t('pixel', 'Pixel')}">⬛</button>
                            <button class="tool-btn precision-tool" data-precision-tool="halftone" title="${this.t('halftone', 'Halftone')}">⬜</button>
                        </div>
                        <div class="control-group">
                            <label class="control-label">
                                <input type="checkbox" id="gridToggle"> ${this.t('showGrid', 'Show Grid')}
                            </label>
                        </div>
                    </div>
                    
                    <div class="toolbar-section">
                        <h3>${this.t('brush', 'Brush')}</h3>
                        <div class="brush-controls">
                            <div class="control-group">
                                <label class="control-label">${this.t('size', 'Size')}: <span id="brushSizeValue">30</span>px</label>
                                <input type="range" id="brushSize" class="range-slider" min="1" max="30" value="30">
                            </div>
                            <div class="control-group">
                                <label class="control-label">${this.t('opacity', 'Opacity')}: <span id="brushOpacityValue">100</span>%</label>
                                <input type="range" id="brushOpacity" class="range-slider" min="1" max="100" value="100">
                            </div>
                            <div class="brush-preview" id="brushPreview">
                                <div class="brush-dot" style="width: 10px; height: 10px;"></div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="toolbar-section">
                        <h3>${this.t('colors', 'Colors')}</h3>
                        <div class="color-picker-container">
                            <input type="color" id="colorPicker" class="color-input" value="#000000">
                            <div class="color-palette" id="colorPalette">
                                ${this.generateColorPalette()}
                            </div>
                        </div>
                    </div>
                    
                    <div class="toolbar-section">
                        <h3>${this.t('layers', 'Layers')}</h3>
                        <div class="layer-controls">
                            <div class="layer-list" id="layerList">
                                <div class="layer-item active" data-layer-id="0">
                                    <span class="layer-name">${this.t('background', 'Background')}</span>
                                    <div class="layer-actions">
                                        <button class="layer-btn" title="${this.t('toggleVisibility', 'Toggle Visibility')}">👁️</button>
                                    </div>
                                </div>
                            </div>
                            <div class="layer-buttons">
                                <button class="tool-btn" id="addLayer" title="${this.t('addLayer', 'Add Layer')}">➕</button>
                                <button class="tool-btn" id="deleteLayer" title="${this.t('deleteLayer', 'Delete Layer')}">🗑️</button>
                                <button class="tool-btn" id="mergeDown" title="${this.t('mergeDown', 'Merge Down')}">⬇️</button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="toolbar-section">
                        <h3>${this.t('actions', 'Actions')}</h3>
                        <div class="tool-group">
                            <button class="tool-btn" id="clearCanvas" title="${this.t('clearCanvas', 'Clear Canvas')}">
                                🗑️
                            </button>
                            <button class="tool-btn" id="saveCanvas" title="${this.t('saveImage', 'Save Image')}">
                                💾
                            </button>
                            <button class="tool-btn" id="undoAction" title="${this.t('undo', 'Undo')}">
                                ↶
                            </button>
                            <button class="tool-btn" id="redoAction" title="${this.t('redo', 'Redo')}">
                                ↷
                            </button>
                        </div>
                    </div>
                </aside>
                
                <div class="canvas-container">
                    <div class="canvas-wrapper" id="canvasWrapper">
                        <canvas id="backgroundCanvas" class="layer-canvas" width="${this.options.canvasWidth}" height="${this.options.canvasHeight}" data-layer-id="0" style="position: absolute; top: 0; left: 0;"></canvas>
                        <canvas id="overlayCanvas" class="canvas-overlay" width="${this.options.canvasWidth}" height="${this.options.canvasHeight}" style="position: absolute; top: 0; left: 0; z-index: 100; pointer-events: none;"></canvas>
                    </div>
                    
                    <div class="zoom-controls">
                        <button class="zoom-btn" id="zoomOut">−</button>
                        <div class="zoom-level" id="zoomLevel">100%</div>
                        <button class="zoom-btn" id="zoomIn">+</button>
                        <button class="zoom-btn" id="zoomFit" title="${this.t('fitToScreen', 'Fit to Screen')}">⌂</button>
                    </div>
                </div>
                
                <aside class="sidebar">
                    <div class="user-list">
                        <h3>${this.t('users', 'Users')} (<span id="userCount">0</span>)</h3>
                        <div id="userListContainer"></div>
                    </div>
                    
                    <div class="chat-area">
                        <div class="chat-messages" id="chatMessages">
                            <div class="chat-message">
                                <div class="message-author">${this.t('system', 'System')}</div>
                                <div class="message-content">${this.t('welcomeMessage', 'Welcome to the collaborative drawing room!')}</div>
                                <div class="message-time">${new Date().toLocaleTimeString()}</div>
                            </div>
                        </div>
                        <div class="chat-input-area">
                            <textarea id="chatInput" class="chat-input" placeholder="${this.t('chatPlaceholder', 'Type a message...')}" rows="2"></textarea>
                        </div>
                    </div>
                </aside>
            </main>
        `;

        document.body.innerHTML = '';
        document.body.appendChild(app);
        
        // Store references
        this.canvasWrapper = document.getElementById('canvasWrapper');
        this.overlayCanvas = document.getElementById('overlayCanvas') as HTMLCanvasElement;
        this.overlayCtx = this.overlayCanvas.getContext('2d')!;
        this.statusIndicator = document.getElementById('statusIndicator');
        this.statusText = document.getElementById('statusText');
        
        // Set canvas wrapper dimensions
        this.canvasWrapper!.style.width = (this.options.canvasWidth || 800) + 'px';
        this.canvasWrapper!.style.height = (this.options.canvasHeight || 600) + 'px';
        this.canvasWrapper!.style.boxSizing = 'content-box';
        
        // Create catchup overlay
        this.createCatchupOverlay();
        
        // Setup event listeners
        this.setupEventListeners();
        
        console.log('UI created successfully');
    }
    
    private generateColorPalette(): string {
        const colors = [
            '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
            '#800000', '#808080', '#C0C0C0', '#800080', '#008000', '#008080', '#000080', '#808000',
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'
        ];
        
        return colors.map(color => 
            `<div class="color-swatch" style="background-color: ${color}" data-color="${color}"></div>`
        ).join('');
    }
    
    private createCatchupOverlay(): void {
        this.catchupOverlay = document.createElement('div');
        this.catchupOverlay.id = 'catchupOverlay';
        this.catchupOverlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            display: none;
            justify-content: center;
            align-items: center;
            flex-direction: column;
            z-index: 9999;
            font-family: Arial, sans-serif;
        `;
        
        this.catchupOverlay.innerHTML = `
            <div style="text-align: center;">
                <div style="
                    width: 40px;
                    height: 40px;
                    border: 4px solid #ccc;
                    border-top: 4px solid #007bff;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                    margin: 0 auto 1rem;
                "></div>
                <h2 style="margin: 0 0 1rem;">Catching up to canvas state...</h2>
                <p style="margin: 0; opacity: 0.8;">Please wait while we sync the latest changes</p>
                <p id="catchupProgress" style="margin: 0.5rem 0 0; font-size: 0.9em; opacity: 0.6;"></p>
            </div>
            <style>
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
        `;
        
        document.body.appendChild(this.catchupOverlay);
    }
    
    showCatchupOverlay(): void {
        if (this.catchupOverlay) {
            this.catchupOverlay.style.display = 'flex';
            
            // Disable UI interactions
            const canvasWrapper = document.getElementById('canvasWrapper');
            const toolbar = document.querySelector('.toolbar') as HTMLElement;
            if (canvasWrapper) canvasWrapper.style.pointerEvents = 'none';
            if (toolbar) toolbar.style.pointerEvents = 'none';
        }
    }

    hideCatchupOverlay(): void {
        if (this.catchupOverlay) {
            this.catchupOverlay.style.display = 'none';
            
            // Re-enable UI interactions
            const canvasWrapper = document.getElementById('canvasWrapper');
            const toolbar = document.querySelector('.toolbar') as HTMLElement;
            if (canvasWrapper) canvasWrapper.style.pointerEvents = 'auto';
            if (toolbar) toolbar.style.pointerEvents = 'auto';
        }
    }

    updateCatchupProgress(current: number, total: number): void {
        const progressElement = document.getElementById('catchupProgress');
        if (progressElement && total > 0) {
            const percentage = Math.round((current / total) * 100);
            progressElement.textContent = `${current}/${total} messages (${percentage}%)`;
        }
    }
    
    private setupEventListeners(): void {
        // Tool selection
        document.querySelectorAll('[data-tool]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (this.onToolChange) {
                    this.onToolChange((btn as HTMLElement).dataset.tool!);
                }
            });
        });
        
        // Precision tool selection
        document.querySelectorAll('[data-precision-tool]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('[data-precision-tool]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (this.onPrecisionToolChange) {
                    this.onPrecisionToolChange((btn as HTMLElement).dataset.precisionTool!);
                }
            });
        });
        
        // Grid toggle
        const gridToggle = document.getElementById('gridToggle') as HTMLInputElement;
        if (gridToggle && this.onGridToggle) {
            gridToggle.addEventListener('change', (e) => {
                this.onGridToggle!((e.target as HTMLInputElement).checked);
            });
        }

        // Brush controls
        (document.getElementById('brushSize') as HTMLInputElement).addEventListener('input', (e) => {
            const size = parseInt((e.target as HTMLInputElement).value);
            (document.getElementById('brushSizeValue') as HTMLElement).textContent = size.toString();
            if (this.onBrushChange) {
                this.onBrushChange({ type: 'size', value: size });
            }
        });

        (document.getElementById('brushOpacity') as HTMLInputElement).addEventListener('input', (e) => {
            const sliderValue = parseInt((e.target as HTMLInputElement).value);
            const opacity = sliderValue / 100;
            (document.getElementById('brushOpacityValue') as HTMLElement).textContent = sliderValue.toString();
            if (this.onBrushChange) {
                this.onBrushChange({ type: 'opacity', value: opacity });
            }
        });

        // Layer management
        document.getElementById('addLayer')!.addEventListener('click', () => {
            if (this.onLayerAction) this.onLayerAction('add');
        });
        document.getElementById('deleteLayer')!.addEventListener('click', () => {
            if (this.onLayerAction) this.onLayerAction('delete');
        });
        document.getElementById('mergeDown')!.addEventListener('click', () => {
            if (this.onLayerAction) this.onLayerAction('merge');
        });

        // Color picker
        (document.getElementById('colorPicker') as HTMLInputElement).addEventListener('change', (e) => {
            if (this.onColorChange) {
                this.onColorChange((e.target as HTMLInputElement).value);
            }
        });

        // Color palette
        document.querySelectorAll('.color-swatch').forEach(swatch => {
            swatch.addEventListener('click', (e) => {
                const color = (swatch as HTMLElement).dataset.color!;
                (document.getElementById('colorPicker') as HTMLInputElement).value = color;
                if (this.onColorChange) {
                    this.onColorChange(color);
                }
            });
        });

        // Canvas events
        this.canvasWrapper!.addEventListener('mousedown', (e) => this.handleMouseEvent('down', e));
        this.canvasWrapper!.addEventListener('mousemove', (e) => this.handleMouseEvent('move', e));
        this.canvasWrapper!.addEventListener('mouseup', (e) => this.handleMouseEvent('up', e));
        this.canvasWrapper!.addEventListener('mouseleave', (e) => this.handleMouseEvent('up', e));

        // Touch events
        this.canvasWrapper!.addEventListener('touchstart', (e) => this.handleTouchEvent('start', e));
        this.canvasWrapper!.addEventListener('touchmove', (e) => this.handleTouchEvent('move', e));
        this.canvasWrapper!.addEventListener('touchend', (e) => this.handleTouchEvent('end', e));

        // Action buttons
        document.getElementById('clearCanvas')!.addEventListener('click', () => {
            if (this.onCanvasAction) this.onCanvasAction('clear');
        });
        document.getElementById('saveCanvas')!.addEventListener('click', () => {
            if (this.onCanvasAction) this.onCanvasAction('save');
        });

        // Zoom controls
        document.getElementById('zoomIn')!.addEventListener('click', () => {
            if (this.onZoomChange) this.onZoomChange('in');
        });
        document.getElementById('zoomOut')!.addEventListener('click', () => {
            if (this.onZoomChange) this.onZoomChange('out');
        });
        document.getElementById('zoomFit')!.addEventListener('click', () => {
            if (this.onZoomChange) this.onZoomChange('fit');
        });

        // Chat
        const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const message = chatInput.value.trim();
                if (message && this.onChatMessage) {
                    this.onChatMessage(message);
                    chatInput.value = '';
                }
            }
        });

        // Window resize
        window.addEventListener('resize', () => {
            if (this.onZoomChange) {
                this.onZoomChange('fit');
            }
        });
    }
    
    private handleMouseEvent(type: string, e: MouseEvent): void {
        if (!this.onMouseEvent) return;
        
        const rect = this.canvasWrapper!.getBoundingClientRect();
        const x = Math.floor((e.clientX - rect.left));
        const y = Math.floor((e.clientY - rect.top));
        
        this.onMouseEvent(type, { x, y, originalEvent: e });
    }
    
    private handleTouchEvent(type: string, e: TouchEvent): void {
        e.preventDefault();
        if (!this.onMouseEvent) return;
        
        const touch = e.touches[0] || e.changedTouches[0];
        if (!touch) return;
        
        const rect = this.canvasWrapper!.getBoundingClientRect();
        const x = Math.floor((touch.clientX - rect.left));
        const y = Math.floor((touch.clientY - rect.top));
        
        const eventTypeMap: { [key: string]: string } = { 'start': 'down', 'move': 'move', 'end': 'up' };
        this.onMouseEvent(eventTypeMap[type], { x, y, originalEvent: e });
    }
    
    // UI update methods
    updateConnectionStatus(status: string, text: string): void {
        if (this.statusIndicator && this.statusText) {
            this.statusIndicator.className = `status-indicator status-${status}`;
            this.statusText.textContent = text;
        }
    }
    
    updateBrushPreview(color: string, size: number, opacity: number): void {
        const preview = document.querySelector('.brush-dot') as HTMLElement;
        if (preview) {
            const displaySize = Math.max(4, Math.min(60, size * 2));
            preview.style.width = displaySize + 'px';
            preview.style.height = displaySize + 'px';
            preview.style.backgroundColor = color;
            preview.style.opacity = opacity.toString();
            preview.style.borderRadius = '50%';
            preview.style.imageRendering = 'auto';
        }
    }
    
    updateColorPalette(currentColor: string): void {
        document.querySelectorAll('.color-swatch').forEach(swatch => {
            swatch.classList.toggle('active', (swatch as HTMLElement).dataset.color === currentColor);
        });
    }
    
    updateCursor(tool: string): void {
        const cursor = tool === 'brush' ? 'crosshair' : 
                     tool === 'eraser' ? 'crosshair' :
                     tool === 'eyedropper' ? 'crosshair' :
                     tool === 'pan' ? 'grab' : 'default';
        this.canvasWrapper!.style.cursor = cursor;
    }
    
    updateLayerList(layers: Layer[], currentLayerId: number): void {
        const layerList = document.getElementById('layerList');
        if (!layerList) return;
        
        layerList.innerHTML = '';
        
        // Display layers in reverse order (top to bottom)
        for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i];
            
            const layerItem = document.createElement('div');
            layerItem.className = `layer-item ${layer.id === currentLayerId ? 'active' : ''}`;
            layerItem.setAttribute('data-layer-id', layer.id.toString());
            
            layerItem.innerHTML = `
                <span class="layer-name">${layer.name}</span>
                <div class="layer-actions">
                    <button class="layer-btn" title="Toggle Visibility">${layer.visible ? '👁️' : '🙈'}</button>
                </div>
            `;
            
            // Add click handler to select layer
            layerItem.addEventListener('click', () => {
                if (this.onLayerAction) {
                    this.onLayerAction('select', layer.id);
                }
            });
            
            // Add visibility toggle
            const visibilityBtn = layerItem.querySelector('.layer-btn') as HTMLElement;
            visibilityBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.onLayerAction) {
                    this.onLayerAction('toggleVisibility', layer.id);
                }
            });
            
            layerList.appendChild(layerItem);
        }
    }
    
    updateUserList(users: User[]): void {
        const container = document.getElementById('userListContainer');
        const count = document.getElementById('userCount');
        
        if (count) count.textContent = users.length.toString();
        
        if (container) {
            container.innerHTML = users.map(user => `
                <div class="user-item">
                    <div class="user-name">${user.name}</div>
                    <div class="user-status"></div>
                </div>
            `).join('');
        }
    }

    addChatMessage(author: string, content: string): void {
        const messages = document.getElementById('chatMessages');
        if (!messages) return;
        
        const message = document.createElement('div');
        message.className = 'chat-message';
        message.innerHTML = `
            <div class="message-author">${author}</div>
            <div class="message-content">${content}</div>
            <div class="message-time">${new Date().toLocaleTimeString()}</div>
        `;
        
        messages.appendChild(message);
        messages.scrollTop = messages.scrollHeight;
    }
    
    setZoom(zoom: number): void {
        // Update zoom display
        const zoomLevel = document.getElementById('zoomLevel');
        if (zoomLevel) {
            zoomLevel.textContent = Math.round(zoom * 100) + '%';
        }
        
        // Apply zoom to canvas wrapper
        const scaledWidth = (this.options.canvasWidth || 800) * zoom;
        const scaledHeight = (this.options.canvasHeight || 600) * zoom;
        this.canvasWrapper!.style.width = scaledWidth + 'px';
        this.canvasWrapper!.style.height = scaledHeight + 'px';
        
        // Apply transform to canvases
        const canvases = this.canvasWrapper!.querySelectorAll('canvas');
        canvases.forEach(canvas => {
            (canvas as HTMLCanvasElement).style.transform = `scale(${zoom})`;
        });
    }
    
    // Utility methods
    getCanvasWrapper(): HTMLElement {
        return this.canvasWrapper!;
    }
    
    getOverlayCanvas(): HTMLCanvasElement {
        return this.overlayCanvas!;
    }
    
    getOverlayContext(): CanvasRenderingContext2D {
        return this.overlayCtx!;
    }
}