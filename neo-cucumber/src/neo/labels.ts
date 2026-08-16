/**
 * What the painter calls things.
 *
 * PaintBBS NEO is written in Japanese and translates itself at runtime, by
 * looking each label up in a table keyed by its own Japanese prose. We keep its
 * words, not its mechanism: every label here is an ordinary message, so it
 * travels through the same catalogs as the rest of this package and a
 * translator meets it where they meet everything else.
 *
 * They carry a context, which is what keeps "Copy", "Text", "Line" and "Normal"
 * from colliding with the same words used elsewhere -- this catalog derives its
 * ids from the message, so a bare "Copy" would be one entry for two meanings.
 *
 * The English is NEO's, oddities included -- "WaterCo" and "flipHorita" are
 * truncated in NEO's own dictionary rather than by us, and "Rect" is the
 * *filled* rectangle while its outline is "LineRect". Each message carries the
 * Japanese term NEO knows it by, so the correspondence stays checkable against
 * `neo/src/dictionary.js`.
 *
 * Korean and Chinese are ours: NEO was never translated into either. They are
 * kept short on purpose, because the widget wearing them is 48px wide.
 */
import { msg } from "@lingui/core/macro";
import type { I18n, MessageDescriptor } from "@lingui/core";

/** Every label the painter shows, resolved into the active locale. */
export interface PainterLabels {
  /** Keyed by tool id; see `ToolId`. */
  tools: Record<string, string>;
  /** In `Neo.Painter.MASKTYPE` order. */
  masks: string[];
  /** Index 0 is the background layer. */
  layers: string[];
}

/**
 * Labels a host would rather choose itself.
 *
 * Anything left out keeps the painter's own word for it. A host that renders
 * controls beside the toolbox is the case this exists for: it should be able to
 * agree with the column next to it, or to disagree deliberately.
 */
export interface PainterLabelOverrides {
  tools?: Readonly<Record<string, string>>;
  masks?: Readonly<Record<number, string>>;
  layers?: Readonly<Record<number, string>>;
}

/** NEO's tools, and the three of ours it has no word for. */
const TOOL_MESSAGES: Record<string, MessageDescriptor> = {
  // PenTip
  solid: msg({ message: "Solid", context: "painter tool", comment: "NEO 鉛筆" }),
  brush: msg({ message: "WaterCo", context: "painter tool", comment: "NEO 水彩, truncated by NEO itself" }),
  text: msg({ message: "Text", context: "painter tool", comment: "NEO ﾃｷｽﾄ" }),
  // Pen2Tip
  halftone: msg({ message: "Halftone", context: "painter tool", comment: "NEO トーン" }),
  blur: msg({ message: "Blur", context: "painter tool", comment: "NEO ぼかし" }),
  dodge: msg({ message: "Light", context: "painter tool", comment: "NEO 覆い焼き, dodge" }),
  burn: msg({ message: "Dark", context: "painter tool", comment: "NEO 焼き込み, burn" }),
  // EffectTip -- the filled rectangle is the one NEO calls "Rect"
  rectFill: msg({ message: "Rect", context: "painter tool", comment: "NEO 四角, the filled rectangle" }),
  rect: msg({ message: "LineRect", context: "painter tool", comment: "NEO 線四角, the outlined rectangle" }),
  ellipseFill: msg({ message: "Oval", context: "painter tool", comment: "NEO 楕円, the filled ellipse" }),
  ellipse: msg({ message: "LineOval", context: "painter tool", comment: "NEO 線楕円, the outlined ellipse" }),
  // Effect2Tip
  copy: msg({ message: "Copy", context: "painter tool", comment: "NEO コピー" }),
  merge: msg({ message: "layerUnit", context: "painter tool", comment: "NEO ﾚｲﾔ結合, merge the two layers" }),
  blurRect: msg({ message: "antiAlias", context: "painter tool", comment: "NEO 角取り, soften edges within a region" }),
  flipH: msg({ message: "flipHorita", context: "painter tool", comment: "NEO 左右反転, truncated by NEO itself" }),
  flipV: msg({ message: "flipVertic", context: "painter tool", comment: "NEO 上下反転, truncated by NEO itself" }),
  turn: msg({ message: "rotate", context: "painter tool", comment: "NEO 傾け, tilt a region" }),
  // EraserTip -- NEO calls erasing "White"
  eraser: msg({ message: "White", context: "painter tool", comment: "NEO 消しペン, the eraser" }),
  eraseRect: msg({ message: "WhiteRe", context: "painter tool", comment: "NEO 消し四角, erase a rectangle" }),
  eraseAll: msg({ message: "Clear", context: "painter tool", comment: "NEO 全消し, erase the layer" }),
  // DrawTip
  freehand: msg({ message: "Freehan", context: "painter tool", comment: "NEO 手書き, truncated by NEO itself" }),
  line: msg({ message: "Line", context: "painter tool", comment: "NEO 直線" }),
  bezier: msg({ message: "Bezier", context: "painter tool", comment: "NEO BZ曲線" }),
  // NEO's flood fill has a button above its canvas rather than in the column
  fill: msg({ message: "Fill", context: "painter tool", comment: "NEO 塗り潰し" }),
  // Ours outright: NEO has no paste button and no pan tool at all
  paste: msg({ message: "Paste", context: "painter tool" }),
  pan: msg({ message: "Pan", context: "painter tool" }),
};

/** MaskTip's five modes, in `Neo.Painter.MASKTYPE` order. */
const MASK_MESSAGES: MessageDescriptor[] = [
  msg({ message: "Normal", context: "painter mask mode", comment: "NEO 通常" }),
  msg({ message: "Mask", context: "painter mask mode", comment: "NEO マスク" }),
  msg({ message: "ReMask", context: "painter mask mode", comment: "NEO 逆ﾏｽｸ" }),
  msg({ message: "And", context: "painter mask mode", comment: "NEO 加算" }),
  msg({ message: "Divide", context: "painter mask mode", comment: "NEO 逆加算" }),
];

/**
 * LayerControl's two labels.
 *
 * The English is NEO's. The Japanese is not: NEO keys this pair in English and
 * only its alternate tables translate them, so its own Japanese build shows
 * "Layer0" -- an untranslated key rather than a Japanese word. Reproducing that
 * would be reproducing a gap.
 */
const LAYER_MESSAGES: MessageDescriptor[] = [
  msg({ message: "LayerBG", context: "painter layer", comment: "NEO Layer0" }),
  msg({ message: "LayerFG", context: "painter layer", comment: "NEO Layer1" }),
];

/** Every tool the painter has a name for. */
export const LABELLED_TOOLS = Object.keys(TOOL_MESSAGES);

/**
 * Resolve every label against an i18n instance, applying a host's overrides.
 *
 * Takes the instance rather than reaching for the shared one so that a painter
 * mounted with its own locale resolves in that locale, whoever else is on the
 * page.
 */
export function resolvePainterLabels(
  i18n: I18n,
  overrides?: PainterLabelOverrides,
): PainterLabels {
  const tools: Record<string, string> = {};
  for (const [tool, message] of Object.entries(TOOL_MESSAGES)) {
    tools[tool] = overrides?.tools?.[tool] ?? i18n._(message);
  }
  return {
    tools,
    masks: MASK_MESSAGES.map(
      (message, index) => overrides?.masks?.[index] ?? i18n._(message),
    ),
    layers: LAYER_MESSAGES.map(
      (message, index) => overrides?.layers?.[index] ?? i18n._(message),
    ),
  };
}
