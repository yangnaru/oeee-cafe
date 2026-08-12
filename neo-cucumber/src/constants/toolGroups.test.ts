import { describe, expect, it } from "vitest";
import { ALL_TOOLS, TOOL_GROUPS } from "./drawing";

describe("NEO's tool groups", () => {
  it("reaches every tool the painter has", () => {
    const grouped = TOOL_GROUPS.flatMap((g) => g.tools);
    for (const tool of ALL_TOOLS) {
      // A tool in no group is a tool with no button, which is how line and
      // bezier ended up unreachable before
      expect(grouped).toContain(tool);
    }
  });

  it("puts each tool in exactly one group", () => {
    const grouped = TOOL_GROUPS.flatMap((g) => g.tools);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("collapses the tools into far fewer buttons", () => {
    // The point of grouping: NEO shows seven buttons, not twenty-three
    expect(TOOL_GROUPS.length).toBeLessThanOrEqual(8);
    expect(ALL_TOOLS.length).toBeGreaterThan(TOOL_GROUPS.length * 2);
  });

  it("keeps NEO's order within the groups it defines", () => {
    const byName = Object.fromEntries(TOOL_GROUPS.map((g) => [g.name, g.tools]));
    // container.js: PenTip, Pen2Tip, EraserTip, EffectTip
    expect(byName.pen).toEqual(["solid", "brush", "text"]);
    expect(byName.pen2).toEqual(["halftone", "blur", "dodge", "burn"]);
    expect(byName.eraser).toEqual(["eraser", "eraseRect", "eraseAll"]);
    expect(byName.shape).toEqual(["rectFill", "rect", "ellipseFill", "ellipse"]);
  });
});
