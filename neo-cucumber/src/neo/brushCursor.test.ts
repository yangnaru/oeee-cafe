import { describe, expect, it } from "vitest";
import { hasBrushCursor } from "./brushCursor";
import { ALL_TOOLS } from "../constants/drawing";
import type { ToolId } from "./tools";

/**
 * NEO shows its circle cursor for drawing tools only. Region tools draw the
 * rectangle being dragged instead, and the rest have no brush footprint to
 * preview -- a circle over the fill bucket would promise a brush size that
 * changes nothing.
 */
describe("which tools wear NEO's brush cursor", () => {
  const WITH: ToolId[] = [
    "solid",
    "brush",
    "halftone",
    "blur",
    "dodge",
    "burn",
    "eraser",
  ];

  const WITHOUT: ToolId[] = [
    // Region tools: EffectToolBase draws the dragged rectangle instead
    "rect",
    "rectFill",
    "ellipse",
    "ellipseFill",
    "eraseRect",
    "blurRect",
    "flipH",
    "flipV",
    "turn",
    "merge",
    "copy",
    "paste",
    // No brush footprint at all
    "fill",
    "text",
    "eraseAll",
    // Ours
    "pan",
  ];

  it("shows it for every tool that lays down a brush", () => {
    for (const tool of WITH) expect(hasBrushCursor(tool)).toBe(true);
  });

  it("withholds it from the rest", () => {
    for (const tool of WITHOUT) expect(hasBrushCursor(tool)).toBe(false);
  });

  it("has an answer for every tool the painter offers", () => {
    // A tool in neither list is one nobody decided about
    const covered = new Set([...WITH, ...WITHOUT]);
    for (const tool of ALL_TOOLS) expect(covered.has(tool)).toBe(true);
  });
});
