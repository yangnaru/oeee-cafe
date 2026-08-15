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
 * Nothing here is ours. Tools NEO has no button for live in NON_NEO_TOOLS and
 * are offered beside this column rather than inside it.
 */
import type { DrawType, ToolId } from "./tools";
import { neoTranslate } from "./dictionary";

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

  NEO writes its toolbox in Japanese and translates it at runtime, so what a
  tool is *called* belongs to `./dictionary`, and what a tool is named here is
  the Japanese term NEO looks it up by. Resolving a label therefore needs a
  locale, which is why these are functions rather than the flat English table
  this used to be -- that table showed "Halftone" to a Japanese painter whose
  NEO says トーン.
*/

/** Tool id to the term NEO's dictionary keys it by. */
export const NEO_TOOL_TERMS: Record<string, string> = {
  // PenTip
  solid: "鉛筆",
  brush: "水彩",
  text: "ﾃｷｽﾄ",
  // Pen2Tip
  halftone: "トーン",
  blur: "ぼかし",
  dodge: "覆い焼き",
  burn: "焼き込み",
  // EffectTip -- 四角 is the filled one
  rectFill: "四角",
  rect: "線四角",
  ellipseFill: "楕円",
  ellipse: "線楕円",
  // Effect2Tip
  copy: "コピー",
  merge: "ﾚｲﾔ結合",
  blurRect: "角取り",
  flipH: "左右反転",
  flipV: "上下反転",
  turn: "傾け",
  // EraserTip -- NEO calls erasing 消しペン, "White"
  eraser: "消しペン",
  eraseRect: "消し四角",
  eraseAll: "全消し",
  // DrawTip
  freehand: "手書き",
  line: "直線",
  bezier: "BZ曲線",
  // NEO has a fill button of its own, above its canvas rather than in the
  // column, so the term is its. Paste and pan are ours outright and NEO has
  // no word for them; they stay as they are until they have one.
  fill: "塗り潰し",
};

/** Tools of ours that NEO has no name for, so no dictionary entry either. */
const OUR_TOOL_LABELS: Record<string, string> = {
  paste: "Paste",
  pan: "Pan",
};

/** What to call a tool, in the painter's locale. */
export function neoToolLabel(tool: string, locale: string): string {
  const term = NEO_TOOL_TERMS[tool];
  if (term) return neoTranslate(term, locale);
  return OUR_TOOL_LABELS[tool] ?? tool;
}

/** MaskTip's five modes, in `Neo.Painter.MASKTYPE` order. */
export const NEO_MASK_TERMS = [
  "通常",
  "マスク",
  "逆ﾏｽｸ",
  "加算",
  "逆加算",
] as const;

/** What to call a mask mode, in the painter's locale. */
export function neoMaskLabel(maskType: number, locale: string): string {
  return neoTranslate(NEO_MASK_TERMS[maskType] ?? NEO_MASK_TERMS[0], locale);
}

/**
 * LayerControl's two labels: index 0 is the background layer.
 *
 * The one pair NEO keys in English rather than Japanese -- its dictionary maps
 * "Layer0" and "Layer1", and only its alternate tables have them at all, which
 * is why a NEO without the alternate translation shows "Layer0" here.
 */
export const NEO_LAYER_TERMS = ["Layer0", "Layer1"] as const;

/** What to call a layer, in the painter's locale. */
export function neoLayerLabel(layer: number, locale: string): string {
  return neoTranslate(NEO_LAYER_TERMS[layer] ?? NEO_LAYER_TERMS[0], locale);
}

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
}

/**
 * The column, in the order NEO's `createContainer` writes it.
 *
 * Note this is the *DOM* order, not `Neo.toolButtons` order -- the latter
 * lists the fill button first and is only used for deselecting.
 *
 * This is all of NEO's toolbox and nothing else. Tools we added live in
 * NON_NEO_TOOLS and are offered elsewhere, because a column that claims to be
 * NEO's stops being a reference the moment it grows an eighth button. That
 * includes `paste`: NEO has a paste *tool*, but no button for it -- finishing
 * a copy switches the painter to it (CopyTool.doEffect).
 */
export const NEO_TIPS: readonly NeoTipSpec[] = [
  { name: "pen", tools: ["solid", "brush", "text"] },
  { name: "pen2", tools: ["halftone", "blur", "dodge", "burn"] },
  { name: "effect", tools: ["rectFill", "rect", "ellipseFill", "ellipse"] },
  { name: "effect2", tools: ["copy", "merge", "blurRect", "flipH", "flipV", "turn"] },
  { name: "eraser", tools: ["eraser", "eraseRect", "eraseAll"] },
  // Settings rather than tools, so they always wear the fixed face and list
  // no tools: the draw tip cycles NEO's three draw types, the mask tip its
  // five mask modes.
  { name: "draw", tools: [], fixed: true },
  { name: "mask", tools: [], fixed: true },
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
 * - `none` is a tip with no artwork at all.
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
