import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  encodeBezier,
  encodeEraseAll,
  encodeLine,
  encodeRegion,
  encodeText,
  MSG_TYPE,
  REGION_TOOL,
} from "./binaryProtocol";
import type { RegionTool } from "../neo/tools";

const ID = 3;
const COLOR = { r: 12, g: 200, b: 255, a: 128 };

/**
 * Every field has to survive the trip. A message whose buffer is a byte short
 * still encodes without complaint -- the last field just lands outside it and
 * reads back as zero -- so these assert the values rather than the lengths.
 */
describe("the tool messages", () => {
  it("round-trips a region tool with its rectangle", () => {
    const bytes = encodeRegion(
      ID, "foreground", "blurRect",
      { x: 5, y: 7, width: 40, height: 22 }, COLOR, 9
    );
    const msg = decodeMessage(bytes);
    expect(msg).toEqual({
      type: "region",
      userId: ID,
      layer: "foreground",
      tool: "blurRect",
      rect: { x: 5, y: 7, width: 40, height: 22 },
      color: COLOR,
      brushSize: 9,
    });
  });

  it("round-trips every region tool, so no code is unreachable", () => {
    const tools: RegionTool[] = [
      "eraseRect", "blurRect", "merge", "flipH", "flipV", "turn",
      "rect", "rectFill", "ellipse", "ellipseFill", "copy", "paste",
    ];
    for (const tool of tools) {
      const bytes = encodeRegion(
        ID, "background", tool, { x: 1, y: 2, width: 3, height: 4 }, COLOR, 1
      );
      const msg = decodeMessage(bytes);
      expect(msg && "tool" in msg && msg.tool).toBe(tool);
    }
    // and the table is the full set, so a new tool cannot be silently missed
    expect(Object.keys(REGION_TOOL)).toHaveLength(tools.length);
  });

  it("drops a region tool code it does not know rather than guessing", () => {
    const bytes = encodeRegion(
      ID, "background", "rect", { x: 0, y: 0, width: 1, height: 1 }, COLOR, 1
    );
    // A code from some future client
    new Uint8Array(bytes)[3] = 200;
    expect(decodeMessage(bytes)).toBeNull();
  });

  it("round-trips a line, including negative coordinates", () => {
    const bytes = encodeLine(
      ID, "background", 4, "eraser", COLOR, { x: -30, y: 8 }, { x: 200, y: -5 }
    );
    expect(decodeMessage(bytes)).toEqual({
      type: "line",
      userId: ID,
      layer: "background",
      brushSize: 4,
      brushType: "eraser",
      color: COLOR,
      from: { x: -30, y: 8 },
      to: { x: 200, y: -5 },
    });
  });

  it("round-trips a bezier's four points in NEO's order", () => {
    const points = [10, 20, 30, 40, 50, 60, 70, 80];
    const bytes = encodeBezier(ID, "foreground", 6, "brush", COLOR, points);
    const msg = decodeMessage(bytes);
    expect(msg).toEqual({
      type: "bezier",
      userId: ID,
      layer: "foreground",
      brushSize: 6,
      brushType: "brush",
      color: COLOR,
      points,
    });
  });

  it("round-trips eraseAll", () => {
    expect(decodeMessage(encodeEraseAll(ID, "foreground"))).toEqual({
      type: "eraseAll",
      userId: ID,
      layer: "foreground",
    });
  });

  it("round-trips text, including multi-byte characters", () => {
    const text = "손글씨 🎨 tegaki";
    const bytes = encodeText(ID, "background", 40, 12, text, COLOR, 14);
    expect(decodeMessage(bytes)).toEqual({
      type: "text",
      userId: ID,
      layer: "background",
      x: 40,
      y: 12,
      text,
      color: COLOR,
      brushSize: 14,
    });
    // The length prefix counts UTF-8 bytes, not characters
    expect(new Uint8Array(bytes).length).toBe(14 + new TextEncoder().encode(text).length);
  });

  it("rejects a truncated message instead of reading past the end", () => {
    const full = encodeText(ID, "background", 1, 2, "hello", COLOR, 3);
    for (const len of [0, 1, 5, 13, full.byteLength - 1]) {
      expect(decodeMessage(full.slice(0, len))).toBeNull();
    }
  });

  it("keeps the new codes clear of the existing ones", () => {
    const codes = Object.values(MSG_TYPE);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
