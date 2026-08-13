import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "./drawing";
import { NEO_TIPS, NEO_TOOL_LABELS } from "../neo/toolboxSpec";

describe("NEO's tool tips", () => {
  it("reaches every tool the painter has", () => {
    const grouped = NEO_TIPS.flatMap((tip) => tip.tools);
    for (const tool of ALL_TOOLS) {
      // A tool on no tip is a tool with no button, which is how line and
      // bezier ended up unreachable before
      expect(grouped).toContain(tool);
    }
  });

  it("puts each tool on exactly one tip", () => {
    const grouped = NEO_TIPS.flatMap((tip) => tip.tools);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("collapses the tools into far fewer buttons", () => {
    // The point of grouping: NEO shows seven buttons, not twenty-three
    expect(NEO_TIPS.length).toBeLessThanOrEqual(9);
    expect(ALL_TOOLS.length).toBeGreaterThan(NEO_TIPS.length * 2);
  });

  it("keeps NEO's tips in NEO's order, with ours after them", () => {
    // createContainer writes the column in this order
    expect(NEO_TIPS.map((tip) => tip.name)).toEqual([
      "pen",
      "pen2",
      "effect",
      "effect2",
      "eraser",
      "draw",
      "mask",
      // Ours: NEO's fill is a button above the canvas, and it has no pan
      "fill",
      "pan",
    ]);
    expect(NEO_TIPS.filter((tip) => tip.ours).map((tip) => tip.name)).toEqual([
      "fill",
      "pan",
    ]);
  });

  it("keeps NEO's order within each tip", () => {
    const byName = Object.fromEntries(NEO_TIPS.map((t) => [t.name, t.tools]));
    // widgets.js: the `tools` array on each Tip prototype
    expect(byName.pen).toEqual(["solid", "brush", "text"]);
    expect(byName.pen2).toEqual(["halftone", "blur", "dodge", "burn"]);
    expect(byName.effect).toEqual([
      "rectFill",
      "rect",
      "ellipseFill",
      "ellipse",
    ]);
    expect(byName.eraser).toEqual(["eraser", "eraseRect", "eraseAll"]);
  });

  it("labels the settings tips rather than leaving them tool-less", () => {
    // draw and mask hold settings, so they carry no tools and must not be
    // dropped by a filter that assumes every tip has some
    for (const name of ["draw", "mask"]) {
      const tip = NEO_TIPS.find((t) => t.name === name);
      expect(tip?.tools).toEqual([]);
      expect(tip?.fixed).toBe(true);
    }
  });

  it("uses NEO's own labels, quirks included", () => {
    // These come from its `enx` dictionary. They read like mistakes and are
    // not: "Rect" is the filled rectangle, and NEO truncates the long ones.
    expect(NEO_TOOL_LABELS.rectFill).toBe("Rect");
    expect(NEO_TOOL_LABELS.rect).toBe("LineRect");
    expect(NEO_TOOL_LABELS.eraser).toBe("White");
    expect(NEO_TOOL_LABELS.freehand).toBe("Freehan");
    expect(NEO_TOOL_LABELS.brush).toBe("WaterCo");
  });

  it("labels every tool it offers", () => {
    for (const tool of NEO_TIPS.flatMap((tip) => tip.tools)) {
      expect(NEO_TOOL_LABELS[tool]).toBeTruthy();
    }
  });
});
