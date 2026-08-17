import { describe, expect, it } from "vitest";
import {
  AFTER_DRAWING_STATE,
  DRAWING_STATE_AT,
  FRAME_ARGS_AT,
  FREEHAND_PAIRS_AT,
  isFrameVerb,
  readBezier,
  readDrawingState,
  readFill,
  readFloodFill,
  readFreeHand,
  readLine,
  readPaste,
  readRect,
  readRestore,
  readText,
} from "./pchFrames";

/** pushCurrent's nine slots, with values that are distinguishable. */
const STATE = [11, 22, 33, 44, 55, 66, 77, 88, 99];

describe("the .pch frame layouts", () => {
  /**
   * The eighteen verbs NEO's `push` ever writes into a file. Its
   * `ActionManager` has more methods -- `freeHandFast` and `freeHandMove` are
   * strategies that both record under `freeHand`, and `dummy` is where an
   * unrecognised verb is routed -- but these are the ones a file can contain.
   */
  it("knows every verb a file can contain, and nothing else", () => {
    expect(Object.keys(FRAME_ARGS_AT).sort()).toEqual(
      [
        "bezier", "blurRect", "clearCanvas", "copy", "eraseAll", "eraseRect",
        "eraseRect2", "fill", "flipH", "flipV", "floodFill", "freeHand",
        "line", "merge", "paste", "restore", "text", "turn",
      ].sort()
    );
    expect(isFrameVerb("freeHand")).toBe(true);
    expect(isFrameVerb("freeHandFast")).toBe(false);
    expect(isFrameVerb("dummy")).toBe(false);
    expect(isFrameVerb(7)).toBe(false);
  });

  /**
   * The whole hazard in one assertion: the same field lives at slot 2 in one
   * verb and slot 11 in another, depending on whether the verb wrote the
   * drawing state ahead of it.
   */
  it("puts a rectangle where its verb says, not where the last verb did", () => {
    const plain = ["blurRect", 1, 5, 6, 7, 8];
    const stateful = ["eraseRect2", 1, ...STATE, 5, 6, 7, 8];

    expect(FRAME_ARGS_AT.blurRect).toBe(DRAWING_STATE_AT);
    expect(FRAME_ARGS_AT.eraseRect2).toBe(AFTER_DRAWING_STATE);
    expect(readRect(plain, "blurRect")).toEqual({
      layer: 1, x: 5, y: 6, width: 7, height: 8,
    });
    expect(readRect(stateful, "eraseRect2")).toEqual({
      layer: 1, x: 5, y: 6, width: 7, height: 8,
    });
  });

  it("reads the drawing state pushCurrent wrote", () => {
    expect(readDrawingState(["freeHand", 0, ...STATE])).toEqual({
      color: [11, 22, 33, 44],
      mask: [55, 66, 77],
      width: 88,
      maskType: 99,
    });
  });

  it("reads a stroke's line type, start and trailing pairs", () => {
    const frame = ["freeHand", 1, ...STATE, 3, 10, 20, 10, 20, 30, 40];
    expect(readFreeHand(frame)).toEqual({
      layer: 1, lineType: 3, firstX: 10, firstY: 20, pairsAt: FREEHAND_PAIRS_AT,
    });
    expect(frame.slice(FREEHAND_PAIRS_AT)).toEqual([10, 20, 30, 40]);
  });

  it("reads a line, treating a null endpoint as its start", () => {
    expect(readLine(["line", 0, ...STATE, 2, 1, 2, 3, 4])).toMatchObject({
      lineType: 2, x0: 1, y0: 2, x1: 3, y1: 4,
    });
    // Frames in the archive do carry nulls; NEO's arithmetic reads them as the
    // start point rather than as zero.
    expect(readLine(["line", 0, ...STATE, 2, 1, 2, null, null])).toMatchObject({
      x1: 1, y1: 2,
    });
  });

  it("reads a bezier's four control points in NEO's order", () => {
    const frame = ["bezier", 0, ...STATE, 1, 1, 2, 3, 4, 5, 6, 7, 8];
    expect(readBezier(frame).points).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("reads fill's shape mask after its rectangle", () => {
    expect(readFill(["fill", 1, ...STATE, 4, 5, 6, 7, 2])).toEqual({
      layer: 1, x: 4, y: 5, width: 6, height: 7, toolType: 2,
    });
  });

  it("reads paste's offset after its rectangle", () => {
    expect(readPaste(["paste", 0, 4, 5, 6, 7, 8, 9])).toEqual({
      layer: 0, x: 4, y: 5, width: 6, height: 7, dx: 8, dy: 9,
    });
  });

  it("reads flood fill's seed and packed colour", () => {
    expect(readFloodFill(["floodFill", 0, 3, 4, 0xff00ff00])).toEqual({
      layer: 0, x: 3, y: 4, color: 0xff00ff00,
    });
  });

  it("reads text, whose alpha is a fraction and colour is red-low", () => {
    const frame = ["text", 1, 8, 30, 0x0000ff, 0.5, "Ag", "16px", "Arial"];
    expect(readText(frame)).toEqual({
      layer: 1, x: 8, y: 30, color: 0x0000ff, alpha: 0.5,
      text: "Ag", fontSize: "16px", fontFamily: "Arial",
    });
  });

  /** restore has no layer: its two images sit where a layer would. */
  it("reads restore's two images, background first", () => {
    expect(readRestore(["restore", "data:bg", "data:fg"])).toEqual({
      background: "data:bg",
      foreground: "data:fg",
    });
  });
});
