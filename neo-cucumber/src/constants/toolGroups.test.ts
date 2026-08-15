import { describe, expect, it } from "vitest";
import {
  ALL_TOOLS,
  CONVENIENCE_TOOLS,
  NEO_DRAWING_TOOLS,
  NON_NEO_TOOLS,
} from "./drawing";
import { NEO_TIPS, neoToolLabel } from "../neo/toolboxSpec";

describe("NEO's tool tips", () => {
  it("has exactly NEO's image-editing toolset", () => {
    // neo/src/painter.js: Painter.setToolByType. Hand and Slider are UI
    // helpers, not drawing tools; Mask is a drawing setting rather than a
    // tool. The order here is its switch order, so a missing case is visible.
    expect(NEO_DRAWING_TOOLS).toEqual([
      "solid",
      "eraser",
      "fill",
      "eraseAll",
      "eraseRect",
      "copy",
      "paste",
      "merge",
      "flipH",
      "flipV",
      "brush",
      "text",
      "halftone",
      "blur",
      "dodge",
      "burn",
      "rect",
      "rectFill",
      "ellipse",
      "ellipseFill",
      "blurRect",
      "turn",
    ]);
  });

  it("adds only explicitly non-drawing convenience tools", () => {
    expect(CONVENIENCE_TOOLS).toEqual(["pan"]);
    expect(ALL_TOOLS).toEqual([...NEO_DRAWING_TOOLS, ...CONVENIENCE_TOOLS]);
  });

  /**
   * The column is NEO's toolbox and nothing else -- no additions, no
   * omissions. Every tool the painter has is either on one of NEO's tips or
   * declared as one NEO has no button for; a tool in neither is unreachable.
   */
  it("reaches every tool, between NEO's tips and the ones NEO lacks", () => {
    const onTips = NEO_TIPS.flatMap((tip) => tip.tools);
    for (const tool of ALL_TOOLS) {
      expect(
        onTips.includes(tool) || NON_NEO_TOOLS.includes(tool),
        `${tool} has no button anywhere`
      ).toBe(true);
    }
  });

  it("keeps the tools NEO has no button for off its tips", () => {
    const onTips = NEO_TIPS.flatMap((tip) => tip.tools);
    for (const tool of NON_NEO_TOOLS) {
      expect(onTips, `${tool} is not NEO's to show`).not.toContain(tool);
    }
    // fill sits above NEO's canvas, paste is what a finished copy switches
    // to, and pan is ours outright
    expect([...NON_NEO_TOOLS]).toEqual(["fill", "paste", "pan"]);
  });

  it("puts each tool on exactly one tip", () => {
    const grouped = NEO_TIPS.flatMap((tip) => tip.tools);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("collapses the tools into NEO's seven buttons, exactly", () => {
    expect(NEO_TIPS).toHaveLength(7);
    expect(ALL_TOOLS.length).toBeGreaterThan(NEO_TIPS.length * 2);
  });

  it("keeps NEO's tips in NEO's order", () => {
    // createContainer writes the column in this order
    expect(NEO_TIPS.map((tip) => tip.name)).toEqual([
      "pen",
      "pen2",
      "effect",
      "effect2",
      "eraser",
      "draw",
      "mask",
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
    // Effect2Tip lists six tools; paste is not among them
    expect(byName.effect2).toEqual([
      "copy",
      "merge",
      "blurRect",
      "flipH",
      "flipV",
      "turn",
    ]);
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
    expect(neoToolLabel("rectFill", "en")).toBe("Rect");
    expect(neoToolLabel("rect", "en")).toBe("LineRect");
    expect(neoToolLabel("eraser", "en")).toBe("White");
    expect(neoToolLabel("freehand", "en")).toBe("Freehan");
    expect(neoToolLabel("brush", "en")).toBe("WaterCo");
  });

  it("shows a Japanese painter the words NEO is written in", () => {
    // Japanese is NEO's source language, so its dictionary has no entry to
    // look up -- the term itself is the label.
    expect(neoToolLabel("rectFill", "ja")).toBe("四角");
    expect(neoToolLabel("eraser", "ja")).toBe("消しペン");
    expect(neoToolLabel("brush", "ja")).toBe("水彩");
  });

  it("falls back to English for languages NEO was never translated into", () => {
    // NEO's own rule, and the right one here: this package is used in Korean
    // and Chinese, which its dictionary has never had a table for.
    expect(neoToolLabel("brush", "ko")).toBe("WaterCo");
    expect(neoToolLabel("brush", "zh")).toBe("WaterCo");
  });

  it("labels every tool it offers, in every locale the site has", () => {
    for (const tool of NEO_TIPS.flatMap((tip) => tip.tools)) {
      for (const locale of ["en", "ja", "ko", "zh"]) {
        expect(neoToolLabel(tool, locale)).toBeTruthy();
      }
    }
  });
});
