import { describe, expect, it } from "vitest";
import { SHORTCUTS, describeAction } from "./shortcuts";
import { ALL_TOOLS } from "./drawing";

describe("the shortcut table", () => {
  it("binds no two actions to the same chord", () => {
    const chords = SHORTCUTS.map(
      (s) => `${s.ctrl ? "ctrl+" : ""}${s.shift ? "shift+" : ""}${s.alt ? "alt+" : ""}${s.key}`
    );
    // Two entries may share a chord only if they do the same thing, which no
    // sensible table does -- so any duplicate is a binding that shadows another
    expect(new Set(chords).size).toBe(chords.length);
  });

  it("only selects tools the painter actually has", () => {
    for (const s of SHORTCUTS) {
      if (s.action.kind === "tool") {
        expect(ALL_TOOLS).toContain(s.action.tool);
      }
    }
  });

  it("describes every action, so the help screen has no blanks", () => {
    for (const s of SHORTCUTS) {
      expect(describeAction(s.action)).toBeTruthy();
      expect(s.label).toBeTruthy();
    }
  });

  it("keeps NEO's history and zoom bindings", () => {
    const has = (
      key: string,
      kind: string,
      mods: { ctrl?: boolean; shift?: boolean } = {}
    ) =>
      SHORTCUTS.some(
        (s) =>
          s.key === key &&
          s.action.kind === kind &&
          Boolean(s.ctrl) === Boolean(mods.ctrl) &&
          Boolean(s.shift) === Boolean(mods.shift)
      );

    // NEO takes both spellings of undo
    expect(has("z", "undo", { ctrl: true })).toBe(true);
    expect(has("u", "undo", { ctrl: true })).toBe(true);
    expect(has("y", "redo", { ctrl: true })).toBe(true);
    expect(has("+", "zoom")).toBe(true);
    expect(has("-", "zoom")).toBe(true);
  });

  it("writes letter keys in lower case, since matching lower-cases the event", () => {
    for (const s of SHORTCUTS) {
      expect(s.key).toBe(s.key.toLowerCase());
    }
  });
});
