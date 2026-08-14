import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  decodePainterOperation,
  encodeFill,
  encodePainterOperation,
  encodeStroke,
  MASK_BYTES,
  NO_WIRE_MASK,
  encodeBezier,
  encodeEraseAll,
  encodeLine,
  encodeRegion,
  encodeText,
  MSG_TYPE,
  REGION_TOOL,
} from "./binaryProtocol";
import type { PainterRegionTool as RegionTool } from "neo-cucumber";
import type { PainterOperation } from "neo-cucumber";

const ID = 3;
const COLOR = { r: 12, g: 200, b: 255, a: 128 };

describe("the public painter operation adapter", () => {
  it("keeps the oeee wire protocol on the consumer side", () => {
    const operation: PainterOperation = {
      kind: "line",
      layer: "foreground",
      brushSize: 7,
      brush: "halftone",
      color: COLOR,
      from: { x: 2, y: 3 },
      to: { x: 18, y: 19 },
      mask: { type: 2, r: 4, g: 5, b: 6 },
    };
    expect(decodePainterOperation(decodeMessage(encodePainterOperation(ID, operation))!))
      .toEqual(operation);
  });
});

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
      mask: NO_WIRE_MASK,
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
      mask: NO_WIRE_MASK,
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
      mask: NO_WIRE_MASK,
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
      mask: NO_WIRE_MASK,
    });
    // The length prefix counts UTF-8 bytes, not characters
    expect(new Uint8Array(bytes).length).toBe(
      14 + new TextEncoder().encode(text).length + MASK_BYTES
    );
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

  /**
   * Every message that carries drawing state carries a mask, always. A
   * receiver that lost one would draw different pixels from the sender, so
   * these pin that it survives the trip and that a message too short to hold
   * one is rejected rather than read past.
   */
  describe("the mask", () => {
    const MASK = { type: 2, r: 18, g: 52, b: 86 };

    it("travels on every message that carries drawing state", () => {
      const cases = [
        encodeStroke(ID, "foreground", 4, "solid", 1, 2, 3, 255, [{ x: 1, y: 2 }], MASK),
        encodeFill(ID, "foreground", 1, 2, 3, 4, 5, 255, MASK),
        encodeRegion(ID, "foreground", "blurRect", { x: 1, y: 2, width: 3, height: 4 }, COLOR, 5, MASK),
        encodeLine(ID, "foreground", 4, "solid", COLOR, { x: 1, y: 2 }, { x: 3, y: 4 }, MASK),
        encodeBezier(ID, "foreground", 4, "solid", COLOR, [1, 2, 3, 4, 5, 6, 7, 8], MASK),
        encodeText(ID, "foreground", 1, 2, "hi", COLOR, 3, MASK),
      ];
      for (const bytes of cases) {
        expect(decodeMessage(bytes)).toMatchObject({ mask: MASK });
      }
    });

    it("reads as none when the sender was not masking", () => {
      const bytes = encodeStroke(ID, "foreground", 4, "solid", 1, 2, 3, 255, [
        { x: 1, y: 2 },
      ]);
      expect(decodeMessage(bytes)).toMatchObject({ mask: NO_WIRE_MASK });
    });

    it("is found past a variable-length payload, not at a guessed offset", () => {
      const text = encodeText(ID, "foreground", 1, 2, "x".repeat(300), COLOR, 3, MASK);
      expect(decodeMessage(text)).toMatchObject({ mask: MASK });

      const points = Array.from({ length: 200 }, (_, i) => ({ x: i, y: i }));
      const stroke = encodeStroke(ID, "foreground", 4, "solid", 1, 2, 3, 255, points, MASK);
      expect(decodeMessage(stroke)).toMatchObject({ mask: MASK, points });
    });

    it("rejects a message whose mask was cut off", () => {
      const full = encodeStroke(ID, "foreground", 4, "solid", 1, 2, 3, 255, [
        { x: 1, y: 2 },
      ]);
      // One byte short of a complete mask is not a maskless message
      expect(decodeMessage(full.slice(0, full.byteLength - 1))).toBeNull();
      expect(decodeMessage(full.slice(0, full.byteLength - MASK_BYTES))).toBeNull();
    });
  });
});
