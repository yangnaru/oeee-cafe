/**
 * Painting a tool tip's 46x18 face, the way NEO paints it.
 *
 * NEO does this on a canvas rather than in CSS, and so do we, because two of
 * the three cases cannot be done with an image at all: the halftone tip draws
 * a live dither of the current colour and alpha, and the mask tip draws a bar
 * of the current mask colour. Only the sprite case would survive as a CSS
 * mask, and splitting the three across two mechanisms is how they drift.
 */
import { neoToneIndex, neoToneMatrix } from "./NeoPainter";
import { NEO_TOOL_ICONS } from "./toolIcons";
import type { NeoTipArt } from "./toolboxSpec";

/** NEO's tip canvas, from ToolTip.init. */
export const TIP_WIDTH = 46;
export const TIP_HEIGHT = 18;

/**
 * NEO's tintImage: keep every pixel's alpha, replace its RGB.
 *
 * The sprites are solid black with an alpha channel, so this is really
 * "stencil the sprite in colour c". Anything fully transparent stays that
 * way, which is what preserves the artwork's shape.
 */
function tint(ctx: CanvasRenderingContext2D, color: string): void {
  const { r, g, b } = parseHex(color);
  const image = ctx.getImageData(0, 0, TIP_WIDTH, TIP_HEIGHT);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function parseHex(color: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(color.slice(1, 3), 16),
    g: parseInt(color.slice(3, 5), 16),
    b: parseInt(color.slice(5, 7), 16),
  };
}

/**
 * Pen2Tip.drawTone: a 24x11 block of NEO's ordered dither at x2,y1, in the
 * drawing colour, at the density the current alpha selects. It is a preview of
 * what the halftone pen will actually lay down, not an icon of one.
 */
function drawTone(
  ctx: CanvasRenderingContext2D,
  color: string,
  alpha: number
): void {
  const { r, g, b } = parseHex(color);
  const tone = neoToneMatrix(neoToneIndex(Math.floor(alpha)));
  const image = ctx.createImageData(TIP_WIDTH, TIP_HEIGHT);
  const data = image.data;

  for (let y = 0; y < TIP_HEIGHT; y++) {
    for (let x = 0; x < TIP_WIDTH; x++) {
      const inBlock = y >= 1 && y < 12 && x >= 2 && x < 26;
      if (!inBlock || !tone[(x % 4) + (y % 4) * 4]) continue;
      const i = (y * TIP_WIDTH + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** MaskTip.draw: a flat bar of the mask colour, inset one pixel. */
function drawMaskBar(ctx: CanvasRenderingContext2D, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(1, 1, 43, 9);
}

/**
 * Sprites decode asynchronously, so keep them once decoded. Without this a
 * tip blanks for a frame every time the colour changes, which during a slider
 * drag is every frame.
 */
const decoded = new Map<string, HTMLImageElement>();

function sprite(icon: string): HTMLImageElement | null {
  const src = NEO_TOOL_ICONS[icon];
  if (!src) return null;

  const held = decoded.get(icon);
  if (held) return held;

  const img = new Image();
  img.src = src;
  decoded.set(icon, img);
  return img;
}

export interface TipPaint {
  art: NeoTipArt;
  /** The current drawing colour, "#rrggbb". */
  color: string;
  /** The current alpha, 0-255; only the halftone tip reads it. */
  alpha: number;
  /** The current mask colour, "#rrggbb"; only the mask tip reads it. */
  maskColor: string;
}

/**
 * Paint one tip.
 *
 * Returns a function that cancels a pending first decode. A sprite is only
 * undecoded the first time it is used, but in that window the tool or colour
 * can change again -- and a late `load` firing after a newer paint would put
 * the previous tool's artwork on the button and leave it there.
 */
export function paintTip(
  canvas: HTMLCanvasElement,
  { art, color, alpha, maskColor }: TipPaint
): () => void {
  const noop = () => {};
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return noop;

  ctx.clearRect(0, 0, TIP_WIDTH, TIP_HEIGHT);

  switch (art.kind) {
    case "none":
      return noop;

    case "tone":
      drawTone(ctx, color, alpha);
      return noop;

    case "maskBar":
      drawMaskBar(ctx, maskColor);
      return noop;

    case "icon": {
      const img = sprite(art.icon);
      if (!img) return noop;

      const paint = () => {
        ctx.clearRect(0, 0, TIP_WIDTH, TIP_HEIGHT);
        ctx.drawImage(img, 0, 0);
        // A null tint is NEO's EraserTip, which never recolours its sprite
        if (art.tint !== null) {
          tint(ctx, art.tint === "foreground" ? color : art.tint);
        }
      };

      if (img.complete && img.naturalWidth > 0) {
        paint();
        return noop;
      }
      img.addEventListener("load", paint, { once: true });
      return () => img.removeEventListener("load", paint);
    }
  }
}
