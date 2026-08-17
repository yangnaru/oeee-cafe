/**
 * Where every `.pch` frame keeps its arguments.
 *
 * A frame is a JSON array whose first slot is a verb and whose remaining slots
 * are positional. Three places have to agree about which slot holds what: the
 * recorder that writes frames, the reader that plays them back, and the test
 * harness that hands the same frames to canonical NEO. Until now each of them
 * said so separately, in its own switch over `any[]`, and the only thing
 * keeping them in step was that someone had got all three right.
 *
 * The hazard is specific. Nine of those slots belong to `pushCurrent` -- the
 * colour, mask, width and mask type a verb was drawn with -- and a verb either
 * writes them before its own arguments or does not. So the same field lives at
 * slot 2 in one verb and slot 11 in another, and getting that boundary wrong
 * shifts every field after it: the file still loads, still replays, and draws
 * something else. Quietly, for as long as the file exists.
 *
 * The numbers here are transcribed from `neo/src/actions.js`, which is the
 * format. Nothing derives them from our own writer, because a table derived
 * from the writer could only ever agree with it.
 */

/** A decoded frame: heterogeneous by construction, so the reader narrows it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Frame = any[];

/**
 * The slots `pushCurrent` writes, 2 through 10, and where a verb that uses it
 * starts its own arguments.
 */
export const DRAWING_STATE_AT = 2;
export const AFTER_DRAWING_STATE = 11;

/** The layer index; every verb that has one keeps it here. */
export const LAYER_AT = 1;

/** Colour, mask, width and mask type, as `pushCurrent` laid them down. */
export interface FrameDrawingState {
  color: [number, number, number, number];
  mask: [number, number, number];
  width: number;
  maskType: number;
}

export function readDrawingState(frame: Frame): FrameDrawingState {
  return {
    color: [frame[2], frame[3], frame[4], frame[5]],
    mask: [frame[6], frame[7], frame[8]],
    width: frame[9],
    maskType: frame[10],
  };
}

/**
 * Every verb that can appear in a file, and where its own arguments begin.
 *
 * NEO's `ActionManager` has more methods than this: `freeHandFast` and
 * `freeHandMove` are playback and recording strategies that both record under
 * `freeHand`, and `dummy` is what an unrecognised verb is routed to. These
 * eighteen are the ones `push` ever writes.
 */
export const FRAME_ARGS_AT = {
  // No layer and no arguments at all; both slots below are simply the end.
  clearCanvas: LAYER_AT,
  // Two PNG data URLs and no layer, so these start where a layer would be.
  restore: LAYER_AT,

  // Geometry straight after the layer.
  floodFill: DRAWING_STATE_AT,
  eraseAll: DRAWING_STATE_AT,
  eraseRect: DRAWING_STATE_AT,
  blurRect: DRAWING_STATE_AT,
  merge: DRAWING_STATE_AT,
  flipH: DRAWING_STATE_AT,
  flipV: DRAWING_STATE_AT,
  turn: DRAWING_STATE_AT,
  copy: DRAWING_STATE_AT,
  paste: DRAWING_STATE_AT,
  text: DRAWING_STATE_AT,

  // Written after pushCurrent's nine slots.
  freeHand: AFTER_DRAWING_STATE,
  line: AFTER_DRAWING_STATE,
  bezier: AFTER_DRAWING_STATE,
  fill: AFTER_DRAWING_STATE,
  eraseRect2: AFTER_DRAWING_STATE,
} as const;

export type FrameVerb = keyof typeof FRAME_ARGS_AT;

/**
 * Where a `freeHand` frame's trailing x,y pairs begin: after its line type and
 * the start point the header repeats.
 */
export const FREEHAND_PAIRS_AT = FRAME_ARGS_AT.freeHand + 3;

/** Whether this server knows how to lay out a frame of this verb. */
export function isFrameVerb(verb: unknown): verb is FrameVerb {
  return typeof verb === "string" && verb in FRAME_ARGS_AT;
}

/**
 * A stroke's line type and its points.
 *
 * `freeHand` stores the start point twice -- once as the header's "from" and
 * again as the first recorded position -- then one x,y pair per move. Segments
 * are drawn from each new point back to the previous one, which is how NEO
 * draws them and why the pairs read newest-to-previous.
 */
export function readFreeHand(frame: Frame): {
  layer: number;
  lineType: number;
  firstX: number;
  firstY: number;
  /** Index of the first x in the trailing pairs. */
  pairsAt: number;
} {
  const at = FRAME_ARGS_AT.freeHand;
  return {
    layer: frame[LAYER_AT],
    lineType: frame[at],
    firstX: frame[at + 1],
    firstY: frame[at + 2],
    pairsAt: at + 3,
  };
}

/** A straight line: type, then both endpoints. */
export function readLine(frame: Frame): {
  layer: number;
  lineType: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  const at = FRAME_ARGS_AT.line;
  const x0 = frame[at + 1];
  const y0 = frame[at + 2];
  return {
    layer: frame[LAYER_AT],
    lineType: frame[at],
    x0,
    y0,
    // NEO's arithmetic treats a null endpoint as the start point.
    x1: frame[at + 3] === null ? x0 : frame[at + 3],
    y1: frame[at + 4] === null ? y0 : frame[at + 4],
  };
}

/** A cubic bezier: type, then four control points in NEO's order. */
export function readBezier(frame: Frame): {
  layer: number;
  lineType: number;
  points: [number, number, number, number, number, number, number, number];
} {
  const at = FRAME_ARGS_AT.bezier;
  return {
    layer: frame[LAYER_AT],
    lineType: frame[at],
    points: [
      frame[at + 1], frame[at + 2], frame[at + 3], frame[at + 4],
      frame[at + 5], frame[at + 6], frame[at + 7], frame[at + 8],
    ],
  };
}

/** A rectangle, from wherever this verb keeps its arguments. */
export function readRect(
  frame: Frame,
  verb: FrameVerb
): { layer: number; x: number; y: number; width: number; height: number } {
  const at = FRAME_ARGS_AT[verb];
  return {
    layer: frame[LAYER_AT],
    x: frame[at],
    y: frame[at + 1],
    width: frame[at + 2],
    height: frame[at + 3],
  };
}

/** `fill`'s rectangle plus the shape mask it is drawn through. */
export function readFill(frame: Frame): {
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  toolType: number;
} {
  const rect = readRect(frame, "fill");
  return { ...rect, toolType: frame[FRAME_ARGS_AT.fill + 4] };
}

/** `paste`'s rectangle plus the offset it is dropped at. */
export function readPaste(frame: Frame): {
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  dx: number;
  dy: number;
} {
  const rect = readRect(frame, "paste");
  const at = FRAME_ARGS_AT.paste;
  return { ...rect, dx: frame[at + 4], dy: frame[at + 5] };
}

/**
 * A text frame. Its alpha is 0..1 where every other verb's is 0..255, and its
 * colour is packed with red in the low byte -- both easy to write the other
 * way round and impossible to notice without reading one back.
 */
export function readText(frame: Frame): {
  layer: number;
  x: number;
  y: number;
  color: number;
  alpha: number;
  text: string;
  fontSize: string;
  fontFamily: string;
} {
  const at = FRAME_ARGS_AT.text;
  return {
    layer: frame[LAYER_AT],
    x: frame[at],
    y: frame[at + 1],
    color: frame[at + 2],
    alpha: frame[at + 3],
    text: frame[at + 4],
    fontSize: frame[at + 5],
    fontFamily: frame[at + 6],
  };
}

/** `floodFill`'s seed point and the ABGR colour it floods with. */
export function readFloodFill(frame: Frame): {
  layer: number;
  x: number;
  y: number;
  color: number;
} {
  const at = FRAME_ARGS_AT.floodFill;
  return {
    layer: frame[LAYER_AT],
    x: frame[at],
    y: frame[at + 1],
    color: frame[at + 2],
  };
}

/** `restore`'s two layer images, as PNG data URLs, background first. */
export function readRestore(frame: Frame): { background: string; foreground: string } {
  const at = FRAME_ARGS_AT.restore;
  return { background: frame[at], foreground: frame[at + 1] };
}
