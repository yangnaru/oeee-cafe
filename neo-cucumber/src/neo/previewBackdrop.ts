import type { DrawingEngine } from "../DrawingEngine";
import type { Backdrop } from "./xorOverlay";

/**
 * NEO draws XOR cursors into its destination canvas after compositing the
 * visible layers. Sample our mounted layer canvases for the same result: they
 * are the pixels the user currently sees, including the brief interval while
 * engine updates are being batched. Before the DOM canvases mount, the engine
 * buffers are an equivalent fallback.
 */
export function previewBackdrop(
  engine: DrawingEngine,
  width: number,
  height: number,
  scale: number,
  bgVisible: boolean,
  fgVisible: boolean
): Backdrop {
  const pixels = (layer: "background" | "foreground") => {
    const context = engine.domContextFor(layer);
    if (context) {
      // `getImageData` hands back a buffer nobody else holds, and this only
      // ever reads it, so copying it again was a second full-canvas
      // allocation per pointer move of every region, line and bezier drag.
      return context.getImageData(0, 0, width, height).data;
    }
    return engine.layers[layer];
  };

  const layers: Uint8ClampedArray[] = [];
  if (bgVisible) layers.push(pixels("background"));
  if (fgVisible) layers.push(pixels("foreground"));
  return { width, height, scale, layers };
}
