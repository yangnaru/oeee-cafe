/**
 * NEO's toolbox as Tailwind utilities.
 *
 * These replace the three stylesheets this column used to carry: a verbatim
 * copy of neo.css, a generated transcription of the rules NEO builds at
 * runtime, and a hand-written chrome file that then had to fight both. Every
 * value here was read off a running NEO 1.7.0 rather than off its source, so
 * where the two disagreed the running instance won -- the column background is
 * `#ccccff`, not the `#ffffff` the generator had produced.
 *
 * They are strings rather than a stylesheet so Tailwind sees them: it scans
 * source text for candidates, so every utility below has to appear written out
 * in full at least once. Do not build these names by interpolation.
 */

/**
 * The column itself. `line-height: 18px` is NEO's, set on `.NEO`, and it is
 * what gives every 12px label an 18px box -- without it the labels sit a few
 * pixels high and nothing else lines up.
 *
 * The width is 50px where NEO's `#toolSet` is 52px, and that is deliberate.
 * NEO's widgets are 48px wide plus the 1px ring that box-shadow paints just
 * outside them, so they occupy 50px and leave 2px of slack in its column --
 * which NEO never shows, because it hangs the whole wrapper off the edge of
 * the painter (`#toolsWrapper { right: -3px }`). A floating panel has no edge
 * to hide slack behind, so keeping the raw 52px only produced a lopsided
 * panel: 3px of margin down one side and 7px down the other. The padding puts
 * the ring back inside, so every widget still sits exactly where NEO puts it.
 */
export const NEO_COLUMN =
  "w-[50px] px-[1px] shrink-0 bg-[#ccccff] font-[Arial] text-[#773333] " +
  "leading-[18px] cursor-default select-none";

/*
  -------------------------------------------------------------------------
    Tool tips
  -------------------------------------------------------------------------

  46x18 with a 1px bevel and a 1px black ring outside it, 3px of margin above
  and below. Adjacent margins collapse, so the tips sit 23px apart rather than
  26px; that is why these are margins and not a flex gap.
*/

/*
 * These are outer sizes, and deliberately so.
 *
 * NEO sizes a tip content-box: 46x18 of artwork inside a 1px bevel, measuring
 * 48x20 overall. The app sets border-box globally, so the same widget is
 * written here as its 48x20 outer box, which leaves exactly NEO's 46x18 for
 * the artwork canvas. Writing 46x18 under border-box instead would give a
 * 44x16 content area -- a 21px rhythm rather than NEO's 23px, and two pixels
 * clipped off every sprite.
 */
const TIP_BASE =
  "relative mx-0 my-[3px] block h-[20px] w-[48px] border p-0 " +
  "shadow-[0_0_0_1px_#000000]";

/** An unselected tool: raised, on `tool_color_button`. */
export const NEO_TIP_OFF =
  TIP_BASE +
  " bg-[#e8dfae] border-t-[#ffffff] border-l-[#ffffff] " +
  "border-r-[#9397b2] border-b-[#9397b2]";

/**
 * The selected tool: pressed, on `tool_color_button` darkened by NEO's own
 * 0.7 multiplier. Its top and left borders go transparent rather than dark,
 * which lets the black ring read as the shadow of a pressed button.
 */
export const NEO_TIP_ON =
  TIP_BASE +
  " bg-[#a29c7a] border-t-transparent border-l-transparent " +
  "border-r-[#ffffff] border-b-[#ffffff]";

/**
 * A tip that sets something rather than selecting a tool -- the draw mode and
 * the mask. NEO gives these `tool_color_button2` and never presses them.
 */
export const NEO_TIP_FIXED =
  TIP_BASE +
  " bg-[#f8daaa] border-t-[#ffffff] border-l-[#ffffff] " +
  "border-r-[#9397b2] border-b-[#9397b2]";

/**
 * The text over a tip's artwork.
 *
 * It hangs 4px below the button and is deliberately not clipped: NEO's own
 * labels overflow their buttons, which is why its English toolbox reads
 * "Halftone" spilling past the edge. Clipping them would be tidier and wrong.
 */
export const NEO_TIP_LABEL =
  "pointer-events-none absolute bottom-[-4px] left-[1px] whitespace-pre " +
  "text-[12px] tracking-normal";

/** The 46x18 artwork canvas, pinned under the label. */
export const NEO_TIP_CANVAS = "pointer-events-none absolute top-0 left-0";

/*
  -------------------------------------------------------------------------
    Colour swatches
  -------------------------------------------------------------------------
*/

/** The 48x144 block the fourteen swatches are positioned inside. */
export const NEO_COLORTIPS = "relative mt-[4px] h-[144px] w-[48px]";

/**
 * One swatch. Positioned absolutely by NEO rather than laid out, with a 1px
 * black ring and a 1px negative top margin that lifts the first row over the
 * block's edge.
 */
export const NEO_COLORTIP =
  "absolute m-0 mt-[-1px] mr-[4px] h-[18px] w-[22px] overflow-hidden p-0 " +
  "shadow-[0_0_0_1px_#000000]";

/** The bevel sprite laid over a swatch at half strength. */
export const NEO_COLORTIP_SPRITE_IMG =
  "pointer-events-none absolute top-0 h-[18px] w-[44px] max-w-[44px] opacity-50";

/*
  -------------------------------------------------------------------------
    Sliders, reserves, layers
  -------------------------------------------------------------------------

  All four share `tool_color_bar` and the same 1px black ring.
*/

const BAR = "relative bg-[#ddddff] shadow-[0_0_0_1px_#000000]";

/** One RGBA channel: 48x13, 3px above. */
export const NEO_COLOR_SLIDER = BAR + " mt-[3px] h-[13px] w-[48px]";

/** The brush size bar: 48x33, 4px above. */
export const NEO_SIZE_SLIDER = BAR + " mt-[4px] h-[33px] w-[48px]";

/** The three tool memories: 48x13, 4px above. */
export const NEO_RESERVE_CONTROL = BAR + " mt-[4px] h-[13px] w-[48px]";

/** The layer button: 48x20, 6px above. */
export const NEO_LAYER_CONTROL = BAR + " mt-[6px] h-[20px] w-[48px]";

/**
 * A channel's fill. The inset shadow darkens its leading edge, which is what
 * stops a full bar from looking like a flat block of colour.
 */
export const NEO_COLOR_SLIDER_FILL =
  "pointer-events-none absolute top-0 left-0 h-full " +
  "shadow-[inset_-1px_0_0_0_rgba(0,0,0,0.3)]";

/** The size fill grows downward, so its inset edge is on top. */
export const NEO_SIZE_SLIDER_FILL =
  "pointer-events-none absolute top-0 left-0 w-full " +
  "shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.3)]";

/** Every bar labels itself in the same place. */
export const NEO_BAR_LABEL =
  "pointer-events-none absolute bottom-[-3px] left-[2px] text-[12px] " +
  "tracking-normal";

/**
 * NEO's slider hit areas are larger than the bars they drive, and overhang
 * them: 6px each side on a channel, 4px above the size bar. Dragging outside
 * the bar is how it switches to fine adjustment, so the overhang is load
 * bearing rather than a courtesy.
 */
export const NEO_COLOR_SLIDER_HIT =
  "absolute top-0 left-[-6px] h-[13px] w-[60px] bg-white opacity-[0.01]";
export const NEO_SIZE_SLIDER_HIT =
  "absolute top-[-4px] left-0 h-[41px] w-[48px] bg-white opacity-[0.01]";

/** One saved tool: NEO's 11x8 inside a 1px black border, so 13x10 outer. */
export const NEO_RESERVE =
  "absolute top-[1px] h-[10px] w-[13px] border border-[#000000] p-0";

/** The strip behind the layer name, underlined in the label colour. */
export const NEO_LAYER_BG =
  "pointer-events-none absolute top-0 left-[2px] h-[10px] w-[44px] " +
  "border-b border-b-[#773333]";

/** The layer name. Two of them exist; NEO shows whichever layer is current. */
export const NEO_LAYER_LABEL =
  "pointer-events-none absolute left-[2px] text-[11px] tracking-normal";

/**
 * The diagonal NEO strikes through a hidden layer's half of the button. It is
 * a gradient rather than a border so it can cross the box corner to corner.
 */
export const NEO_LAYER_LINE =
  "pointer-events-none absolute left-[-1px] m-0 h-[10px] w-[50px] p-0 " +
  "bg-[linear-gradient(to_top_right,transparent,transparent_47%,red_47%,red_53%,transparent_53%,transparent)]";

/*
  -------------------------------------------------------------------------
    Panel chrome
  -------------------------------------------------------------------------

  The window the column sits in, and the controls beside it that NEO keeps
  outside its toolbox -- undo, zoom, saving. NEO's own values again: the face
  is `color_icon`, the bevels are it multiplied by 1.3 and 0.7, and the
  selected state is `color_iconselect`.
*/

/** The floating panel: NEO's face, raised off the page. */
export const NEO_PANEL =
  "bg-[#ccccff] text-[#666699] font-[Arial] text-[12px] leading-[18px] " +
  "border-t border-l border-t-[#ffffff] border-l-[#ffffff] " +
  "border-r border-b border-r-[#8f8fb3] border-b-[#8f8fb3] " +
  "cursor-default select-none";

/** The bevel and behaviour every control in the chrome shares. */
const BUTTON_FACE =
  "bg-[#ccccff] text-[#666699] rounded-none leading-[1.2] " +
  "border-t border-l border-t-[#ffffff] border-l-[#ffffff] " +
  "border-r border-b border-r-[#8f8fb3] border-b-[#8f8fb3] " +
  "hover:not-disabled:bg-[#eeeef4] " +
  "active:not-disabled:border-t-[#8f8fb3] active:not-disabled:border-l-[#8f8fb3] " +
  "active:not-disabled:border-r-[#ffffff] active:not-disabled:border-b-[#ffffff] " +
  "disabled:text-[#8f8fb3] disabled:opacity-100";

/** A pushable control carrying a label. */
export const NEO_BUTTON = BUTTON_FACE + " px-[6px] py-[2px]";

/**
 * A control carrying nothing but an icon.
 *
 * It has no horizontal padding on purpose. A flex item will not shrink below
 * its content, so a 14px icon plus NEO_BUTTON's padding refuses to go under
 * 28px -- two of those overflow the 52px NEO is wide and drag the whole panel
 * wider than the column it sits beside.
 */
export const NEO_ICON_BUTTON = BUTTON_FACE + " px-0 py-[2px]";

/**
 * The colour input, sized to the column. NEO has no colour picker at all --
 * its swatches and RGBA sliders are the picker -- so this only ever appears
 * in our own panel.
 */
export const NEO_COLOR_INPUT =
  "block h-[18px] w-full cursor-pointer rounded-none p-0 " +
  "border-t border-l border-t-[#8f8fb3] border-l-[#8f8fb3] " +
  "border-r border-b border-r-[#ffffff] border-b-[#ffffff] " +
  "[&::-webkit-color-swatch-wrapper]:p-[1px] " +
  "[&::-webkit-color-swatch]:border-none [&::-moz-color-swatch]:border-none";

/** A control that stays pressed while its setting is on. */
export const NEO_BUTTON_ON =
  "bg-[#ffaaaa] border-t-[#8f8fb3] border-l-[#8f8fb3] " +
  "border-r-[#ffffff] border-b-[#ffffff]";

/** The drag handle, which reads as a title bar. */
export const NEO_TITLEBAR =
  "bg-[linear-gradient(to_right,#9397b2,#b1d6fd)] text-white p-[1px]";

/** A key cap in the shortcut list. */
export const NEO_KBD =
  "bg-[#ccccff] rounded-none px-[3px] " +
  "border-t border-l border-t-[#ffffff] border-l-[#ffffff] " +
  "border-r border-b border-r-[#8f8fb3] border-b-[#8f8fb3]";
