import type { ToolId } from "../neo/tools";
import type { DrawType } from "../neo/tools";

/**
 * Every shortcut the painter binds, in one table.
 *
 * The binding and the help screen both read this, because the failure mode of
 * keeping two lists is a help screen that confidently teaches a key that does
 * nothing.
 *
 * Where NEO defines a key we use NEO's -- undo, redo and zoom below are its
 * bindings, quirks included: it accepts both Ctrl+Z and Ctrl+U for undo, and
 * both Ctrl+Y and Ctrl+Alt+Z for redo. NEO binds no keys for tool selection,
 * so those are ours and conventional rather than canonical.
 */
export type ShortcutAction =
  | { kind: "tool"; tool: ToolId }
  | { kind: "drawType"; drawType: DrawType }
  | { kind: "size"; delta: number }
  | { kind: "zoom"; delta: number }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "toggleLayer" }
  | { kind: "help" };

export interface Shortcut {
  /** Displayed as written; matching is case-insensitive on `key`. */
  label: string;
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: ShortcutAction;
  group: "Tools" | "Shape" | "Drawing" | "Canvas" | "History";
}

export const SHORTCUTS: readonly Shortcut[] = [
  // Tools. NEO binds none of these; they follow the usual painter conventions.
  { label: "P", key: "p", action: { kind: "tool", tool: "solid" }, group: "Tools" },
  { label: "B", key: "b", action: { kind: "tool", tool: "brush" }, group: "Tools" },
  { label: "H", key: "h", action: { kind: "tool", tool: "halftone" }, group: "Tools" },
  { label: "E", key: "e", action: { kind: "tool", tool: "eraser" }, group: "Tools" },
  { label: "G", key: "g", action: { kind: "tool", tool: "fill" }, group: "Tools" },
  { label: "U", key: "u", action: { kind: "tool", tool: "blur" }, group: "Tools" },
  { label: "D", key: "d", action: { kind: "tool", tool: "dodge" }, group: "Tools" },
  { label: "N", key: "n", action: { kind: "tool", tool: "burn" }, group: "Tools" },
  { label: "T", key: "t", action: { kind: "tool", tool: "text" }, group: "Tools" },

  // Region tools. Shift fills the shape, matching how the toolbar pairs them.
  { label: "R", key: "r", action: { kind: "tool", tool: "rect" }, group: "Shape" },
  { label: "Shift R", key: "r", shift: true, action: { kind: "tool", tool: "rectFill" }, group: "Shape" },
  { label: "O", key: "o", action: { kind: "tool", tool: "ellipse" }, group: "Shape" },
  { label: "Shift O", key: "o", shift: true, action: { kind: "tool", tool: "ellipseFill" }, group: "Shape" },

  // How a drawing tool lays itself down
  { label: "1", key: "1", action: { kind: "drawType", drawType: "freehand" }, group: "Drawing" },
  { label: "2", key: "2", action: { kind: "drawType", drawType: "line" }, group: "Drawing" },
  { label: "3", key: "3", action: { kind: "drawType", drawType: "bezier" }, group: "Drawing" },
  { label: "[", key: "[", action: { kind: "size", delta: -1 }, group: "Drawing" },
  { label: "]", key: "]", action: { kind: "size", delta: 1 }, group: "Drawing" },

  // Canvas. + and - are NEO's.
  { label: "+", key: "+", action: { kind: "zoom", delta: 1 }, group: "Canvas" },
  { label: "-", key: "-", action: { kind: "zoom", delta: -1 }, group: "Canvas" },
  { label: "L", key: "l", action: { kind: "toggleLayer" }, group: "Canvas" },
  { label: "?", key: "?", action: { kind: "help" }, group: "Canvas" },

  // History. Both spellings of each, as NEO accepts both.
  { label: "Ctrl Z", key: "z", ctrl: true, action: { kind: "undo" }, group: "History" },
  { label: "Ctrl U", key: "u", ctrl: true, action: { kind: "undo" }, group: "History" },
  { label: "Ctrl Y", key: "y", ctrl: true, action: { kind: "redo" }, group: "History" },
  { label: "Ctrl Shift Z", key: "z", ctrl: true, shift: true, action: { kind: "redo" }, group: "History" },
];

/** What each shortcut does, for the help screen. */
export function describeAction(action: ShortcutAction): string {
  switch (action.kind) {
    case "tool":
      return action.tool;
    case "drawType":
      return action.drawType;
    case "size":
      return action.delta < 0 ? "smaller" : "larger";
    case "zoom":
      return action.delta < 0 ? "zoom out" : "zoom in";
    case "undo":
      return "undo";
    case "redo":
      return "redo";
    case "toggleLayer":
      return "switch layer";
    case "help":
      return "this list";
  }
}
