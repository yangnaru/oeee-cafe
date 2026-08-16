import { describe, expect, it } from "vitest";
import { i18n } from "@lingui/core";
import { NEO_TIPS } from "./toolboxSpec";
import { LABELLED_TOOLS, resolvePainterLabels } from "./labels";
import { setupI18n } from "../utils/i18n";

/**
 * The painter's vocabulary.
 *
 * English is NEO's own and has to stay so, truncations and all -- it is what a
 * reader comparing this toolbox against a running NEO will see. The rest is a
 * translation like any other in this package, which is the point: they live in
 * the catalogs rather than in a table of their own.
 */

function labelsFor(locale: string) {
  setupI18n(locale);
  return resolvePainterLabels(i18n);
}

describe("the painter's labels", () => {
  it("keeps NEO's English, quirks included", () => {
    const { tools, masks, layers } = labelsFor("en");

    // "Rect" is the filled rectangle; NEO truncates the long ones itself.
    expect(tools.rectFill).toBe("Rect");
    expect(tools.rect).toBe("LineRect");
    expect(tools.eraser).toBe("White");
    expect(tools.freehand).toBe("Freehan");
    expect(tools.brush).toBe("WaterCo");
    expect(masks[0]).toBe("Normal");
    expect(layers[0]).toBe("LayerBG");
  });

  it("speaks the language NEO is written in", () => {
    const { tools, masks } = labelsFor("ja");

    expect(tools.solid).toBe("鉛筆");
    expect(tools.brush).toBe("水彩");
    expect(tools.eraser).toBe("消しペン");
    expect(masks[1]).toBe("マスク");
  });

  it("speaks the two languages NEO never learned", () => {
    expect(labelsFor("ko").tools.solid).toBe("연필");
    expect(labelsFor("zh").tools.solid).toBe("铅笔");
    expect(labelsFor("ko").layers[0]).toBe("배경");
    expect(labelsFor("zh").masks[1]).toBe("蒙版");
  });

  it("names every tool it offers, in every locale the site has", () => {
    const offered = NEO_TIPS.flatMap((tip) => tip.tools);
    for (const locale of ["en", "ja", "ko", "zh"]) {
      const { tools, masks, layers } = labelsFor(locale);
      for (const tool of offered) {
        expect(tools[tool], `${tool} in ${locale}`).toBeTruthy();
        // An untranslated message falls back to its id, which is not a label.
        expect(tools[tool]).not.toContain("neo.tool.");
      }
      for (const label of [...masks, ...layers]) {
        expect(label).toBeTruthy();
        expect(label).not.toContain("neo.");
      }
    }
  });

  it("lets a host have the last word", () => {
    setupI18n("en");
    const { tools, layers } = resolvePainterLabels(i18n, {
      tools: { pan: "Move" },
      layers: { 0: "Under" },
    });

    expect(tools.pan).toBe("Move");
    expect(layers[0]).toBe("Under");
    // Everything it did not mention is still the painter's.
    expect(tools.solid).toBe("Solid");
    expect(layers[1]).toBe("LayerFG");
  });

  it("has a message for every tool the toolbox can show", () => {
    for (const tool of NEO_TIPS.flatMap((tip) => tip.tools)) {
      expect(LABELLED_TOOLS).toContain(tool);
    }
  });
});
