/**
 * NEO's toolbox, described rather than guessed at.
 *
 * Every number and string here was read off a running PaintBBS NEO 1.7.0
 * (its own `dist` bundle) rather than inferred from its source: the colours
 * are computed styles, the labels are what `Neo.translate` actually produced,
 * and the geometry is `getBoundingClientRect`. Reconstructing this by reading
 * container.js is what previously produced a white `#toolSet` (its `color_bk`
 * is `#ccccff`) and invented labels like "RectFill" for a tool NEO calls
 * "Rect".
 *
 * Anything marked "ours" has no counterpart in NEO -- it is a tool we added --
 * and is kept out of the way at the end rather than mixed into NEO's order.
 */
import type { DrawType, ToolId } from "./tools";

/*
  -------------------------------------------------------------------------
    Colours
  -------------------------------------------------------------------------

  NEO derives its bevels by multiplying a base colour by 1.3 and 0.7
  (Neo.multColor). These are the results for its default config, taken from
  the computed styles of a live instance, so the arithmetic is its own.
*/

export const NEO_COLORS = {
  /** color_bk -- the column behind the widgets. */
  toolSetBackground: "#ccccff",
  /** tool_color_button, the face of an unselected tool. */
  tipFace: "#e8dfae",
  /** tool_color_button x 0.7, the face of the selected tool. */
  tipFaceSelected: "#a29c7a",
  /** tool_color_button2, the face of a tip that is a setting, not a tool. */
  tipFaceFixed: "#f8daaa",
  /** tool_color_bar, behind the sliders, reserves and layer control. */
  bar: "#ddddff",
  /** tool_color_text, every label in the column. */
  text: "#773333",
  /** tool_color_frame, the 1px ring around every widget. */
  frame: "#000000",
  /** The bevel highlight and shadow on an unpressed widget. */
  bevelLight: "#ffffff",
  bevelShadow: "#9397b2",
} as const;

/** The fill colour of each channel's bar, from Neo.ColorSlider.init. */
export const NEO_SLIDER_COLORS = {
  r: "#fa9696",
  g: "#82f238",
  b: "#8080ff",
  a: "#aaaaaa",
} as const;

/*
  -------------------------------------------------------------------------
    Labels
  -------------------------------------------------------------------------

  NEO's `enx` dictionary, which is what an English browser gets: its default
  emulation mode is "2.22_8x", and the trailing "x" turns on the alternate
  translation (container.js, initConfig).

  They are odd on purpose. "WaterCo", "Freehan" and "flipHorita" are truncated
  in NEO's own dictionary, not by us, and "Rect" means the *filled* rectangle
  while the outline is "LineRect". Tidying them up would be a divergence.
*/

export const NEO_TOOL_LABELS: Record<string, string> = {
  // PenTip
  solid: "Solid",
  brush: "WaterCo",
  text: "Text",
  // Pen2Tip
  halftone: "Halftone",
  blur: "Blur",
  dodge: "Light",
  burn: "Dark",
  // EffectTip -- "Rect" is the filled one
  rectFill: "Rect",
  rect: "LineRect",
  ellipseFill: "Oval",
  ellipse: "LineOval",
  // Effect2Tip
  copy: "Copy",
  merge: "layerUnit",
  blurRect: "antiAlias",
  flipH: "flipHorita",
  flipV: "flipVertic",
  turn: "rotate",
  // EraserTip -- NEO calls erasing "White"
  eraser: "White",
  eraseRect: "WhiteRe",
  eraseAll: "Clear",
  // DrawTip
  freehand: "Freehan",
  line: "Line",
  bezier: "Bezier",
  // Neo.fillButton, which NEO puts in the bar above the canvas
  fill: "Fill",
  // Ours: NEO reaches paste through the copy tool, and has no pan tool
  paste: "Paste",
  pan: "Pan",
};

/** MaskTip's five modes, in `Neo.Painter.MASKTYPE` order. */
export const NEO_MASK_LABELS = [
  "Normal",
  "Mask",
  "ReMask",
  "And",
  "Divide",
] as const;

/** LayerControl's two labels: index 0 is the background layer. */
export const NEO_LAYER_LABELS = ["LayerBG", "LayerFG"] as const;

/*
  -------------------------------------------------------------------------
    Tool tips
  -------------------------------------------------------------------------
*/

export interface NeoTipSpec {
  /** NEO's element id, kept because it is also how it keys the group. */
  name: string;
  /** The tools this tip cycles through, in NEO's order. */
  tools: readonly ToolId[];
  /**
   * A tip that is a setting rather than a tool. NEO gives these its
   * `toolTipFixed` face and never marks them selected, because selecting one
   * would not deselect the tool you are drawing with.
   */
  fixed?: boolean;
  /** True for the tips NEO does not have. */
  ours?: boolean;
}

/**
 * The column, in the order NEO's `createContainer` writes it.
 *
 * Note this is the *DOM* order, not `Neo.toolButtons` order -- the latter
 * lists the fill button first and is only used for deselecting.
 */
export const NEO_TIPS: readonly NeoTipSpec[] = [
  { name: "pen", tools: ["solid", "brush", "text"] },
  { name: "pen2", tools: ["halftone", "blur", "dodge", "burn"] },
  { name: "effect", tools: ["rectFill", "rect", "ellipseFill", "ellipse"] },
  {
    name: "effect2",
    // `paste` is ours, slotted next to the copy it belongs with
    tools: ["copy", "paste", "merge", "blurRect", "flipH", "flipV", "turn"],
  },
  { name: "eraser", tools: ["eraser", "eraseRect", "eraseAll"] },
  // Settings rather than tools, so they always wear the fixed face and list
  // no tools: the draw tip cycles NEO's three draw types, the mask tip its
  // five mask modes.
  { name: "draw", tools: [], fixed: true },
  { name: "mask", tools: [], fixed: true },
  // Ours. NEO's fill is a text button above the canvas and it has no pan.
  { name: "fill", tools: ["fill"], ours: true },
  { name: "pan", tools: ["pan"], ours: true },
];

/*
  -------------------------------------------------------------------------
    Tip artwork
  -------------------------------------------------------------------------
*/

/**
 * What a tip draws into its 46x18 canvas.
 *
 * - `icon` is one of NEO's sprites, optionally recoloured. NEO recolours by
 *   keeping each pixel's alpha and replacing its RGB (Neo.tintImage), so the
 *   sprite is really a stencil.
 * - `tone` is Pen2Tip's halftone preview: a dither block rather than a sprite,
 *   drawn from the current colour and alpha.
 * - `maskBar` is MaskTip's swatch of the current mask colour.
 * - `none` is a tip with no artwork at all, which is what ours get.
 */
export type NeoTipArt =
  | { kind: "icon"; icon: string; tint: "foreground" | string | null }
  | { kind: "tone" }
  | { kind: "maskBar" }
  | { kind: "none" };

/**
 * Which sprite each tool wears, from the `toolIcons` arrays in widgets.js.
 *
 * Two of NEO's quirks are preserved deliberately. `dodge` wears the *burn*
 * sprite, because Pen2Tip lists `Neo.ToolTip.burn` twice -- there is a
 * `tip-dodge.png` in NEO's Design folder that its runtime never loads. And
 * flipH, flipV and turn share the single flip sprite.
 */
const ICON_FOR_TOOL: Record<string, string> = {
  solid: "pen",
  brush: "brush",
  text: "text",

  halftone: "tone",
  blur: "blur",
  dodge: "burn",
  burn: "burn",

  eraser: "eraser",
  eraseRect: "eraser",
  eraseAll: "eraser",

  rectFill: "rectfill",
  rect: "rect",
  ellipseFill: "ellipsefill",
  ellipse: "ellipse",

  copy: "copy",
  paste: "copy2",
  merge: "merge",
  blurRect: "blurrect",
  flipH: "flip",
  flipV: "flip",
  turn: "flip",

  freehand: "freehand",
  line: "line",
  bezier: "bezier",
};

/**
 * NEO's fixed tints, from Pen2Tip.update: it previews dodge and burn against
 * grey rather than the drawing colour, since neither paints with it.
 */
const FIXED_TINTS: Record<string, string> = {
  dodge: "#c0c0c0",
  burn: "#404040",
};

/**
 * The tips NEO leaves untinted. EraserTip has no `hasTintImage`, so it draws
 * its sprite once and never recolours it -- an eraser is always white.
 */
const UNTINTED = new Set(["eraser", "eraseRect", "eraseAll"]);

/**
 * What the given tool's tip should draw. Takes a draw type as readily as a
 * tool, since NEO's draw tip wears sprites from the same set; `null` is the
 * mask tip, which has no tool behind it at all.
 */
export function neoTipArt(tool: ToolId | DrawType | null): NeoTipArt {
  if (tool === null) return { kind: "maskBar" };
  if (tool === "halftone") return { kind: "tone" };

  const icon = ICON_FOR_TOOL[tool];
  if (!icon) return { kind: "none" };

  return {
    kind: "icon",
    icon,
    tint: UNTINTED.has(tool) ? null : (FIXED_TINTS[tool] ?? "foreground"),
  };
}

/*
  -------------------------------------------------------------------------
    Reserves
  -------------------------------------------------------------------------
*/

export interface NeoReserve {
  size: number;
  color: string;
  /** 0..1, as NEO stores it. */
  alpha: number;
  tool: ToolId;
  drawType: DrawType;
}

/** `Neo.config.reserves`, from initConfig. */
export const NEO_DEFAULT_RESERVES: readonly NeoReserve[] = [
  { size: 1, color: "#000000", alpha: 1, tool: "solid", drawType: "freehand" },
  { size: 5, color: "#FFFFFF", alpha: 1, tool: "eraser", drawType: "freehand" },
  { size: 10, color: "#FFFFFF", alpha: 1, tool: "eraser", drawType: "freehand" },
];

/*
  -------------------------------------------------------------------------
    Palette
  -------------------------------------------------------------------------
*/

/**
 * `Neo.config.colors`, in NEO's own indexing.
 *
 * Its markup lays them out two per row as `color2, color1`, `color4, color3`
 * and so on, and ColorTip.init then positions odd indices at x=26 and even at
 * x=0 -- so the pair really does render as "second, first". Our palette array
 * is in *display* order, which is why this list looks transposed against it.
 */
export const NEO_PALETTE_ORDER = [
  "#000000",
  "#FFFFFF",
  "#B47575",
  "#888888",
  "#FA9696",
  "#C096C0",
  "#FFB6FF",
  "#8080FF",
  "#25C7C9",
  "#E7E58D",
  "#E7962D",
  "#99CB7B",
  "#FCECE2",
  "#F9DDCF",
] as const;
