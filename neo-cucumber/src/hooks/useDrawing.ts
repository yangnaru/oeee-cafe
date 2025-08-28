import { useEffect, useRef, useCallback } from 'react';
import { DrawingEngine } from '../DrawingEngine';
import { useCanvasHistory } from './useCanvasHistory';

interface DrawingState {
  brushSize: number;
  opacity: number;
  color: string;
  brushType: 'solid' | 'halftone' | 'eraser' | 'fill';
  layerType: 'foreground' | 'background';
  fgVisible: boolean;
  bgVisible: boolean;
}

export const useDrawing = (
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  appRef: React.RefObject<HTMLDivElement | null>,
  fgThumbnailRef: React.RefObject<HTMLCanvasElement | null>,
  bgThumbnailRef: React.RefObject<HTMLCanvasElement | null>,
  drawingState: DrawingState,
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void,
  zoomLevel?: number,
  canvasWidth: number = 500,
  canvasHeight: number = 500,
  wsRef?: React.RefObject<WebSocket | null>,
  userIdRef?: React.RefObject<string>,
  onDrawingChange?: () => void
) => {
  console.log('🚀 useDrawing hook START');
  console.log('useDrawing hook called with canvas dimensions:', canvasWidth, canvasHeight);
  console.log('🔧 Creating refs and history');
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingEngineRef = useRef<DrawingEngine | null>(null);
  const isInitializedRef = useRef(false);
  const onHistoryChangeRef = useRef(onHistoryChange);
  const history = useCanvasHistory(30);
  console.log('✅ Refs and history created');

  // Update the ref when callback changes
  useEffect(() => {
    onHistoryChangeRef.current = onHistoryChange;
  }, [onHistoryChange]);

  // Initialize drawing engine
  const initializeDrawing = useCallback(() => {
    console.log('initializeDrawing called, isInitialized:', isInitializedRef.current, 'canvas available:', !!canvasRef.current, 'engine exists:', !!drawingEngineRef.current);
    if (!canvasRef.current) return;
    if (isInitializedRef.current && drawingEngineRef.current) return; // Only skip if both initialized AND engine exists

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.imageSmoothingEnabled = false;
    canvas.style.imageRendering = 'pixelated';
    contextRef.current = ctx;

    // Set up thumbnail canvases
    if (fgThumbnailRef.current) {
      const fgCtx = fgThumbnailRef.current.getContext('2d');
      if (fgCtx) fgCtx.imageSmoothingEnabled = false;
    }
    if (bgThumbnailRef.current) {
      const bgCtx = bgThumbnailRef.current.getContext('2d');
      if (bgCtx) bgCtx.imageSmoothingEnabled = false;
    }

    // Create and initialize drawing engine
    console.log('Creating DrawingEngine with ctx:', !!ctx);
    drawingEngineRef.current = new DrawingEngine(canvasWidth, canvasHeight);
    drawingEngineRef.current.initialize(ctx, fgThumbnailRef.current || undefined, bgThumbnailRef.current || undefined);
    console.log('DrawingEngine initialized');

    // Save initial state to history
    if (drawingEngineRef.current.layers.foreground && drawingEngineRef.current.layers.background) {
      history.saveState(drawingEngineRef.current.layers.foreground, drawingEngineRef.current.layers.background);
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
    }

    isInitializedRef.current = true;
  }, [canvasRef, fgThumbnailRef, bgThumbnailRef, history, canvasWidth, canvasHeight]);

  // Handle drawing events
  const setupDrawingEvents = useCallback(() => {
    const app = appRef.current;
    console.log('Setting up drawing events, app available:', !!app, 'engine available:', !!drawingEngineRef.current);
    if (!app) return;

    let isDrawing = false;
    let prevX = 0;
    let prevY = 0;
    let currentX = 0;
    let currentY = 0;
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let activePointerId: number | null = null;

    // Convert screen coordinates to canvas coordinates
    const getCanvasCoordinates = (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };

      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };

      // Calculate the scale between canvas internal coordinates and displayed size
      const cssScaleX = canvas.width / rect.width;
      const cssScaleY = canvas.height / rect.height;

      // Convert screen coordinates to canvas coordinates
      // The CSS transform (pan) is already included in rect.left/rect.top, 
      // so we don't need to manually account for it here
      const x = (clientX - rect.left) * cssScaleX;
      const y = (clientY - rect.top) * cssScaleY;

      return { x: Math.round(x), y: Math.round(y) };
    };

    const handlePointerDown = (e: PointerEvent) => {
      console.log('handlePointerDown called:', e.button, e.pointerType, e.target);
      const target = e.target as Element;
      const controlsElement = document.getElementById('controls');
      
      // Don't interfere with controls interaction
      if (controlsElement?.contains(target as Node)) return;
      
      // Only handle drawing area interactions
      if (!(target.id === 'canvas' || target.closest('#canvas') || 
           (target.closest('#app') && !target.closest('#controls')))) {
        return;
      }

      // Prevent default touch behaviors like scrolling for drawing area only
      e.preventDefault();

      // Only handle one pointer at a time
      if (activePointerId !== null && activePointerId !== e.pointerId) return;
      
      activePointerId = e.pointerId;
      app.setPointerCapture(e.pointerId);

      if (e.button === 1 || (e.pointerType === 'touch' && e.buttons === 0)) {
        // Middle mouse button or touch (for panning)
        isPanning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
        return;
      }

      if (e.button === 0 || e.pointerType === 'touch' || e.pointerType === 'pen') {
        const coords = getCanvasCoordinates(e.clientX, e.clientY);

        if (drawingState.brushType === 'fill') {
          console.log('Fill tool selected');
          if (!drawingEngineRef.current) {
            console.log('No drawing engine available for fill');
            return;
          }
          
          // Perform flood fill
          const r = parseInt(drawingState.color.slice(1, 3), 16);
          const g = parseInt(drawingState.color.slice(3, 5), 16);
          const b = parseInt(drawingState.color.slice(5, 7), 16);
          console.log('Fill with color:', { r, g, b });

          drawingEngineRef.current.doFloodFill(
            drawingEngineRef.current.layers[drawingState.layerType],
            Math.floor(coords.x),
            Math.floor(coords.y),
            r, g, b,
            drawingState.opacity
          );

          // Send fill event through WebSocket
          if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN) {
            const fillEventData = {
              type: 'fill',
              userId: userIdRef?.current,
              layer: drawingState.layerType,
              x: Math.floor(coords.x),
              y: Math.floor(coords.y),
              color: {
                r: r,
                g: g,
                b: b,
                a: drawingState.opacity
              },
              timestamp: Date.now()
            };
            
            try {
              wsRef.current.send(JSON.stringify(fillEventData));
              console.log('Sent fill event:', fillEventData);
            } catch (error) {
              console.error('Failed to send fill event:', error);
            }
          }

          drawingEngineRef.current.updateLayerThumbnails(
            fgThumbnailRef.current?.getContext('2d') || undefined, 
            bgThumbnailRef.current?.getContext('2d') || undefined
          );
          // Notify parent component that drawing has changed
          onDrawingChange?.();

          // Save state after fill operation
          if (drawingEngineRef.current.layers.foreground && drawingEngineRef.current.layers.background) {
            history.saveState(drawingEngineRef.current.layers.foreground, drawingEngineRef.current.layers.background);
            onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
          }
        } else {
          console.log('Drawing tool selected, starting stroke at:', coords);
          console.log('Engine check in pointerdown:', !!drawingEngineRef.current);
          if (!drawingEngineRef.current) {
            console.log('No drawing engine available for drawing');
            return;
          }
          
          // Draw at the initial click position
          const r = parseInt(drawingState.color.slice(1, 3), 16);
          const g = parseInt(drawingState.color.slice(3, 5), 16);
          const b = parseInt(drawingState.color.slice(5, 7), 16);
          
          // Use pressure if available (for pen/stylus)
          let effectiveOpacity = drawingState.opacity;
          if (e.pointerType === 'pen' && e.pressure > 0) {
            effectiveOpacity = Math.floor(drawingState.opacity * e.pressure);
          }
          
          // Draw single point using drawLine method (works for all brush types)
          drawingEngineRef.current.drawLine(
            drawingEngineRef.current.layers[drawingState.layerType],
            coords.x,
            coords.y,
            coords.x,
            coords.y,
            drawingState.brushSize,
            drawingState.brushType,
            r, g, b,
            effectiveOpacity
          );
          
          // Update thumbnails and composite
          drawingEngineRef.current.updateLayerThumbnails(
            fgThumbnailRef.current?.getContext('2d') || undefined, 
            bgThumbnailRef.current?.getContext('2d') || undefined
          );
          // Notify parent component that drawing has changed
          onDrawingChange?.();
          
          // Send single click drawing event through WebSocket
          if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN) {
            const drawEventData = {
              type: 'drawPoint',
              userId: userIdRef?.current,
              layer: drawingState.layerType,
              x: coords.x,
              y: coords.y,
              brushSize: drawingState.brushSize,
              brushType: drawingState.brushType,
              pointerType: e.pointerType,
              color: {
                r: r,
                g: g,
                b: b,
                a: effectiveOpacity
              },
              timestamp: Date.now()
            };
            
            try {
              wsRef.current.send(JSON.stringify(drawEventData));
              console.log('Sent drawPoint event:', drawEventData);
            } catch (error) {
              console.error('Failed to send drawPoint event:', error);
            }
          }
          
          isDrawing = true;
          currentX = coords.x;
          currentY = coords.y;
          prevX = currentX;
          prevY = currentY;
        }
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      // Only handle the active pointer
      if (activePointerId !== e.pointerId) return;
      
      // Send pointerup event through WebSocket
      if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN) {
        const coords = getCanvasCoordinates(e.clientX, e.clientY);
        const eventData = {
          type: 'pointerup',
          userId: userIdRef?.current,
          x: coords.x,
          y: coords.y,
          button: e.button,
          pointerType: e.pointerType,
          pressure: e.pressure,
          timestamp: Date.now()
        };
        
        try {
          wsRef.current.send(JSON.stringify(eventData));
          console.log('Sent pointerup event:', eventData);
        } catch (error) {
          console.error('Failed to send pointerup event:', error);
        }
      }
      
      if (e.button === 1 || isPanning) {
        isPanning = false;
      }

      if ((e.button === 0 || e.pointerType === 'touch' || e.pointerType === 'pen') && isDrawing) {
        // Save state after stroke ends
        if (drawingEngineRef.current && drawingEngineRef.current.layers.foreground && drawingEngineRef.current.layers.background) {
          history.saveState(drawingEngineRef.current.layers.foreground, drawingEngineRef.current.layers.background);
          onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
        }

        isDrawing = false;
      }
      
      // Release pointer capture
      if (app.hasPointerCapture(e.pointerId)) {
        app.releasePointerCapture(e.pointerId);
      }
      activePointerId = null;
    };

    const handlePointerMove = (e: PointerEvent) => {
      // Only handle the active pointer
      if (activePointerId !== e.pointerId) return;

      if (isPanning) {
        const deltaX = e.clientX - panStartX;
        const deltaY = e.clientY - panStartY;
        
        // Update the engine's pan offset
        if (drawingEngineRef.current) {
          drawingEngineRef.current.updatePanOffset(deltaX, deltaY, canvasRef.current || undefined);
        }
        
        panStartX = e.clientX;
        panStartY = e.clientY;
        return;
      }

      if (!isDrawing || drawingState.brushType === 'fill') return;

      prevX = currentX;
      prevY = currentY;
      const coords = getCanvasCoordinates(e.clientX, e.clientY);
      currentX = coords.x;
      currentY = coords.y;

      if (!drawingEngineRef.current) {
        console.log('No drawing engine available for pointer move');
        return;
      }
      
      console.log('Drawing line from', {prevX, prevY}, 'to', {currentX, currentY});
      
      const r = parseInt(drawingState.color.slice(1, 3), 16);
      const g = parseInt(drawingState.color.slice(3, 5), 16);
      const b = parseInt(drawingState.color.slice(5, 7), 16);

      // Use pressure if available (for pen/stylus)
      let effectiveOpacity = drawingState.opacity;
      if (e.pointerType === 'pen' && e.pressure > 0) {
        // Scale opacity based on pressure (0-1 range)
        effectiveOpacity = Math.floor(drawingState.opacity * e.pressure);
      }

      drawingEngineRef.current.drawLine(
        drawingEngineRef.current.layers[drawingState.layerType],
        prevX, prevY,
        currentX, currentY,
        drawingState.brushSize,
        drawingState.brushType,
        r, g, b,
        effectiveOpacity
      );

      // Send drawLine event through WebSocket
      if (wsRef?.current && wsRef.current.readyState === WebSocket.OPEN) {
        const drawEventData = {
          type: 'drawLine',
          userId: userIdRef?.current,
          layer: drawingState.layerType,
          fromX: prevX,
          fromY: prevY,
          toX: currentX,
          toY: currentY,
          brushSize: drawingState.brushSize,
          brushType: drawingState.brushType,
          pointerType: e.pointerType,
          color: {
            r: r,
            g: g,
            b: b,
            a: effectiveOpacity
          },
          timestamp: Date.now()
        };
        
        try {
          wsRef.current.send(JSON.stringify(drawEventData));
          console.log('Sent drawLine event:', drawEventData);
        } catch (error) {
          console.error('Failed to send drawLine event:', error);
        }
      }

      drawingEngineRef.current.updateLayerThumbnails(
        fgThumbnailRef.current?.getContext('2d') || undefined, 
        bgThumbnailRef.current?.getContext('2d') || undefined
      );
      // Notify parent component that drawing has changed
      onDrawingChange?.();
    };

    // Add pointer event listeners (handles mouse, touch, and pen)
    app.addEventListener('pointerdown', handlePointerDown);
    app.addEventListener('pointerup', handlePointerUp);
    app.addEventListener('pointermove', handlePointerMove);
    
    // Prevent touch behaviors that interfere with drawing - only on canvas area
    const preventTouchOnCanvas = (e: TouchEvent) => {
      const target = e.target as Element;
      // Only prevent touch events if they're on the canvas or drawing area, not on controls
      if (target.id === 'canvas' || target.closest('#canvas') || 
          (target.closest('#app') && !target.closest('#controls'))) {
        e.preventDefault();
      }
    };
    
    app.addEventListener('touchstart', preventTouchOnCanvas, { passive: false });
    app.addEventListener('touchmove', preventTouchOnCanvas, { passive: false });
    app.addEventListener('touchend', preventTouchOnCanvas, { passive: false });

    return () => {
      app.removeEventListener('pointerdown', handlePointerDown);
      app.removeEventListener('pointerup', handlePointerUp);
      app.removeEventListener('pointermove', handlePointerMove);
      
      // Clean up touch event listeners
      app.removeEventListener('touchstart', preventTouchOnCanvas);
      app.removeEventListener('touchmove', preventTouchOnCanvas);
      app.removeEventListener('touchend', preventTouchOnCanvas);
    };
  }, [appRef, canvasRef, drawingState, history, wsRef, userIdRef]);

  useEffect(() => {
    console.log('useEffect for initializeDrawing triggered');
    console.log('Canvas available:', !!canvasRef.current, 'isInitialized:', isInitializedRef.current);
    initializeDrawing();
  }, [initializeDrawing]);

  // Additional effect to force initialization once refs are available
  useEffect(() => {
    console.log('Direct initialization check - canvas:', !!canvasRef.current, 'app:', !!appRef.current);
    if (canvasRef.current && !isInitializedRef.current) {
      console.log('Force calling initializeDrawing');
      initializeDrawing();
    }
  }, [canvasRef.current, appRef.current]);

  useEffect(() => {
    const cleanup = setupDrawingEvents();
    return cleanup;
  }, [setupDrawingEvents]);

  // Undo function
  const handleUndo = useCallback(() => {
    const previousState = history.undo();
    if (previousState && contextRef.current && drawingEngineRef.current) {
      // Restore layer states
      drawingEngineRef.current.layers.foreground.set(previousState.foreground);
      drawingEngineRef.current.layers.background.set(previousState.background);
      
      // Update display
      drawingEngineRef.current.updateLayerThumbnails(
        fgThumbnailRef.current?.getContext('2d') || undefined, 
        bgThumbnailRef.current?.getContext('2d') || undefined
      );
      // Notify parent component that drawing has changed
      onDrawingChange?.();
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
    }
  }, [history]);

  // Redo function
  const handleRedo = useCallback(() => {
    const nextState = history.redo();
    if (nextState && contextRef.current && drawingEngineRef.current) {
      // Restore layer states
      drawingEngineRef.current.layers.foreground.set(nextState.foreground);
      drawingEngineRef.current.layers.background.set(nextState.background);
      
      // Update display
      drawingEngineRef.current.updateLayerThumbnails(
        fgThumbnailRef.current?.getContext('2d') || undefined, 
        bgThumbnailRef.current?.getContext('2d') || undefined
      );
      // Notify parent component that drawing has changed
      onDrawingChange?.();
      onHistoryChangeRef.current?.(history.canUndo(), history.canRedo());
    }
  }, [history]);

  // Update canvas zoom when zoom level changes
  useEffect(() => {
    if (canvasRef.current && zoomLevel) {
      const canvas = canvasRef.current;
      const zoom = zoomLevel / 100; // Convert percentage to decimal
      
      // The drawing engine doesn't need zoom state since React handles sizing
      
      // Use React-provided canvas dimensions instead of DOM properties
      const displayWidth = canvasWidth * zoom;
      const displayHeight = canvasHeight * zoom;
      
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
    }
  }, [zoomLevel, canvasRef, canvasWidth, canvasHeight]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      console.log('Cleaning up drawing engine on unmount');
      if (drawingEngineRef.current) {
        drawingEngineRef.current.dispose();
        drawingEngineRef.current = null;
      }
    };
  }, []); // Empty dependency array - only runs on unmount

  return {
    context: contextRef.current,
    drawingEngine: drawingEngineRef.current,
    initializeDrawing,
    undo: handleUndo,
    redo: handleRedo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    getHistoryInfo: history.getHistoryInfo
  };
};