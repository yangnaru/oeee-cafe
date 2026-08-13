/**
 * NEO paints both artwork layers first, then draws tool previews and the
 * brush cursor over the composite. Keep the DOM canvas stack in that order.
 */
export const CANVAS_Z_INDEX = {
  background: 1,
  foreground: 2,
  preview: 10,
  cursor: 11,
  textEditor: 20,
} as const;
