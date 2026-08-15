/**
 * NEO's own translations of its own toolbox.
 *
 * PaintBBS NEO is written in Japanese and translated at runtime: every label in
 * its column is a Japanese string looked up in `Neo.dictionary` (neo/src/
 * dictionary.js). This is that table, for the terms this package renders.
 *
 * The keys are therefore Japanese, exactly as NEO writes them -- including its
 * half-width katakana (`ﾃｷｽﾄ`, `ﾚｲﾔ結合`, `逆ﾏｽｸ`), which are not typos and must
 * not be normalised, since they are what NEO looks up by.
 *
 * Two of NEO's four sets are here. `ja` needs no table: Japanese is the source,
 * so a Japanese painter shows the key itself, which is why `Neo.dictionary.ja`
 * is an empty object. `enx` is the alternate English NEO selects when its
 * emulation mode ends in "x" -- ours is "2.22_8x", so `enx` is what an English
 * browser gets from NEO and what this package has always shown. NEO's plain
 * `en` set is deliberately absent: nothing here can select it, and a table
 * nobody reads is a table nobody maintains.
 *
 * The labels are odd on purpose. "WaterCo", "Freehan" and "flipHorita" are
 * truncated in NEO's dictionary rather than by us, and "Rect" is the *filled*
 * rectangle while the outline is "LineRect". Tidying them is a divergence.
 */

/** The locales NEO itself has a table for. Everything else falls back. */
type NeoDictionaryLocale = "enx" | "es";

/**
 * Japanese term to NEO's translation of it.
 *
 * Every key here is a string this package puts on screen. NEO's dictionary is
 * larger -- it also covers dialogs and buttons for features we do not
 * reproduce, like posting a picture to a BBS -- and copying entries we never
 * look up would only invite them to drift.
 */
const NEO_DICTIONARY: Record<NeoDictionaryLocale, Record<string, string>> = {
  enx: {
    鉛筆: "Solid",
    水彩: "WaterCo",
    ﾃｷｽﾄ: "Text",
    トーン: "Halftone",
    ぼかし: "Blur",
    覆い焼き: "Light",
    焼き込み: "Dark",
    消しペン: "White",
    消し四角: "WhiteRe",
    全消し: "Clear",
    四角: "Rect",
    線四角: "LineRect",
    楕円: "Oval",
    線楕円: "LineOval",
    コピー: "Copy",
    ﾚｲﾔ結合: "layerUnit",
    角取り: "antiAlias",
    左右反転: "flipHorita",
    上下反転: "flipVertic",
    傾け: "rotate",
    通常: "Normal",
    マスク: "Mask",
    逆ﾏｽｸ: "ReMask",
    加算: "And",
    逆加算: "Divide",
    手書き: "Freehan",
    直線: "Line",
    BZ曲線: "Bezier",
    塗り潰し: "Fill",
    Layer0: "LayerBG",
    Layer1: "LayerFG",
  },
  es: {
    鉛筆: "Lápiz",
    水彩: "Acuarela",
    ﾃｷｽﾄ: "Texto",
    トーン: "Tono",
    ぼかし: "Gradación",
    覆い焼き: "Sobreexp.",
    焼き込み: "Quemar",
    消しペン: "Goma",
    消し四角: "GomaRect",
    全消し: "Borrar",
    四角: "Rect",
    線四角: "LíneaRect",
    楕円: "Óvalo",
    線楕円: "LíneaÓvalo",
    コピー: "Copiar",
    ﾚｲﾔ結合: "UnirCapa",
    角取り: "Antialias",
    左右反転: "Inv.Izq/Der",
    上下反転: "Inv.Arr/Aba",
    傾け: "Inclinar",
    通常: "Normal",
    マスク: "Masc.",
    逆ﾏｽｸ: "Masc.Inv",
    加算: "Adición",
    逆加算: "Subtrac",
    手書き: "Libre",
    直線: "Línea",
    BZ曲線: "Curva",
    塗り潰し: "Llenar",
    Layer0: "Capa0",
    Layer1: "Capa1",
  },
};

/**
 * NEO's label for a term, in the painter's locale.
 *
 * The selection is NEO's own, in `Neo.translate`: Japanese gets the source
 * string, and anything NEO has no table for gets English rather than an empty
 * label. That last part matters here in a way it does not in NEO -- this
 * package is used in Korean and Chinese, which NEO was never translated into,
 * and NEO's rule is exactly right for them.
 */
export function neoTranslate(term: string, locale: string): string {
  const language = locale.split("-")[0];
  if (language === "ja") return term;
  const table = NEO_DICTIONARY[language as NeoDictionaryLocale];
  return table?.[term] ?? NEO_DICTIONARY.enx[term] ?? term;
}
