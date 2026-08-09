import { describe, expect, it } from "vitest";
import { decompressFromUint8Array } from "lz-string";
import { ActionRecorder } from "./ActionRecorder";

// Decode a replay blob the way Neo.decodePCH does (neo/src/actions.js)
const decodeReplay = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const header = bytes.subarray(0, 12);
  return {
    magic: String.fromCharCode(...header.subarray(0, 4)),
    width: header[4] + header[5] * 0x100,
    height: header[6] + header[7] * 0x100,
    items: JSON.parse(decompressFromUint8Array(bytes.subarray(12)) as string),
  };
};

// A freeHand frame shaped like Neo's, with a tag in place of the trailing
// coordinates so strokes stay identifiable through a round trip.
const recordStroke = (recorder: ActionRecorder, tag: string) => {
  recorder.step();
  recorder.push(
    "freeHand", 0, 0, 0, 0, 255, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, tag
  );
};

const strokeTags = (items: unknown[][]) =>
  items.filter((item) => item[0] === "freeHand").map((item) => item[16]);

describe("ActionRecorder", () => {
  it("writes a PCH header Neo.decodePCH accepts", async () => {
    const recorder = new ActionRecorder();
    recordStroke(recorder, "s0");

    const { magic, width, height } = await decodeReplay(
      recorder.getReplayBlob(640, 480)
    );

    expect(magic).toBe("NEO ");
    expect(width).toBe(640);
    expect(height).toBe(480);
  });

  it("drops undone strokes and still appends the restore frame", async () => {
    const recorder = new ActionRecorder();
    for (const tag of ["s0", "s1", "s2", "s3", "s4"]) {
      recordStroke(recorder, tag);
    }

    // Undo the last two strokes, then save
    recorder.back();
    recorder.back();
    recorder.addRestoreAction("BG", "FG");

    const { items } = await decodeReplay(recorder.getReplayBlob(300, 300));

    expect(strokeTags(items)).toEqual(["s0", "s1", "s2"]);
    expect(items[items.length - 1]).toEqual(["restore", "BG", "FG"]);
  });

  it("keeps a single restore frame when saving twice", async () => {
    const recorder = new ActionRecorder();
    recordStroke(recorder, "s0");
    recorder.addRestoreAction("BG1", "FG1");
    recorder.addRestoreAction("BG2", "FG2");

    const { items } = await decodeReplay(recorder.getReplayBlob(300, 300));

    expect(items.filter((item: unknown[]) => item[0] === "restore")).toEqual([
      ["restore", "BG2", "FG2"],
    ]);
    expect(strokeTags(items)).toEqual(["s0"]);
  });

  it("redo restores an undone stroke before saving", async () => {
    const recorder = new ActionRecorder();
    recordStroke(recorder, "s0");
    recordStroke(recorder, "s1");
    recorder.back();
    recorder.forward();
    recorder.addRestoreAction("BG", "FG");

    const { items } = await decodeReplay(recorder.getReplayBlob(300, 300));

    expect(strokeTags(items)).toEqual(["s0", "s1"]);
  });

  it("counts only actions that survive undo", () => {
    const recorder = new ActionRecorder();
    recordStroke(recorder, "s0");
    recordStroke(recorder, "s1");
    recordStroke(recorder, "s2");
    expect(recorder.getActionCount()).toBe(3);

    recorder.back();
    expect(recorder.getActionCount()).toBe(2);

    // The restore frame counts too, which is why callers subtract it
    recorder.addRestoreAction("BG", "FG");
    expect(recorder.getActionCount()).toBe(3);
  });
});
