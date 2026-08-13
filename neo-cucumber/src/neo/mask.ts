/**
 * The mask a stroke is drawn through.
 *
 * NEO tests each pixel it is about to touch against a colour and one of five
 * modes, so a mask is not a property of the canvas but of the operation: it
 * has to travel with the stroke, into the replay file and over the wire, or
 * the same stroke redrawn later lands differently.
 *
 * One shape serves all three, which is the point of this module -- the .pch
 * frame, the websocket message and the engine all take the same four numbers,
 * and the colour is parsed from the UI's hex string exactly once.
 */

export interface Mask {
  /** NEO's MASKTYPE: 0 none, 1 mask, 2 reverse, 3 add, 4 subtract. */
  type: number;
  r: number;
  g: number;
  b: number;
}

/** MASKTYPE_NONE, which is what almost every stroke carries. */
export const NO_MASK: Mask = { type: 0, r: 0, g: 0, b: 0 };

/**
 * The mask implied by a drawing state, or none.
 *
 * A zero type means no mask, and the colour is then irrelevant -- so it is
 * flattened to `NO_MASK` rather than carrying a colour nothing will read.
 * That is also what keeps an unmasked message byte-identical to one written
 * before masks existed.
 */
export function maskFrom(state: {
  maskType?: number;
  maskColor?: string;
}): Mask {
  const type = state.maskType ?? 0;
  if (!type) return NO_MASK;

  const hex = state.maskColor ?? "#000000";
  return {
    type,
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}
