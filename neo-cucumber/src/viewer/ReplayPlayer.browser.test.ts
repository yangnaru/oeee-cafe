import { describe, expect, it } from "vitest";
import { ReplayPlayer } from "./ReplayPlayer";
import { NeoReplay } from "../neo/NeoReplay";
import { describeDifference, firstPixelDifference } from "../test/neoHarness";

const W = 64;
const H = 64;

const header = (x: number, y: number, size = 4, r = 0, g = 0, b = 0) => [
  "freeHand", 0, r, g, b, 255, 0, 0, 0, size, 0, 1, x, y, x, y,
];

const items = [
  ["floodFill", 0, 0, 0, (255 << 24) | (0xd6 << 16) | (0xe0 << 8) | 0xf0],
  [...header(8, 8), 20, 18, 34, 30, 50, 46],
  [...header(50, 10, 8, 128, 0, 0), 30, 30, 12, 52],
  [...header(32, 32, 1), 33, 33],
];

function displayContext() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  return ctx;
}

const pixels = (ctx: CanvasRenderingContext2D) =>
  new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data);

/** Flattens a NeoReplay's two layers the way the player composites them. */
function compositeOf(replay: NeoReplay) {
  const ctx = displayContext();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(replay.painter.canvas[0], 0, 0);
  ctx.drawImage(replay.painter.canvas[1], 0, 0);
  return pixels(ctx);
}

describe("ReplayPlayer", () => {
  it("counts one step per stroke segment", () => {
    // A stroke's steps are (length - 14) / 2: the opening dot, recorded as a
    // duplicated point at slots 14/15, plus one per move. Matches the loop in
    // NEO's freeHandFast.
    expect(NeoReplay.stepsFor(items[0])).toBe(1);
    expect(NeoReplay.stepsFor(items[1])).toBe(4);
    expect(NeoReplay.stepsFor(items[2])).toBe(3);
    expect(NeoReplay.stepsFor(items[3])).toBe(2);

    const player = new ReplayPlayer(items, W, H, displayContext(), () => {});
    expect(player.total).toBe(10);
  });

  it("ends on exactly the image the bulk path produces", async () => {
    const ctx = displayContext();
    const player = new ReplayPlayer(items, W, H, ctx, () => {});
    await player.skipToEnd();

    const reference = new NeoReplay(W, H);
    await reference.playAll(items);

    const stepped = pixels(ctx);
    const bulk = compositeOf(reference);
    expect(
      firstPixelDifference(stepped, bulk),
      describeDifference(stepped, bulk, W)
    ).toBe(-1);
  });

  it("seeking backwards then forwards lands on the same image", async () => {
    const ctx = displayContext();
    const player = new ReplayPlayer(items, W, H, ctx, () => {});

    await player.seekTo(player.total);
    const atEnd = pixels(ctx);

    await player.seekTo(2);
    await player.seekTo(player.total);
    expect(
      firstPixelDifference(pixels(ctx), atEnd),
      describeDifference(pixels(ctx), atEnd, W)
    ).toBe(-1);
  });

  it("rewinds to a blank canvas", async () => {
    const ctx = displayContext();
    const player = new ReplayPlayer(items, W, H, ctx, () => {});
    await player.seekTo(player.total);
    await player.rewind();

    const blank = displayContext();
    blank.fillStyle = "#ffffff";
    blank.fillRect(0, 0, W, H);

    expect(firstPixelDifference(pixels(ctx), pixels(blank))).toBe(-1);
    expect(player.getState().position).toBe(0);
  });

  it("reports progress and stops at the end", async () => {
    const states: number[] = [];
    const player = new ReplayPlayer(items, W, H, displayContext(), (s) =>
      states.push(s.position)
    );

    await player.seekTo(3);
    expect(player.getState().position).toBe(3);
    expect(player.getState().finished).toBe(false);

    await player.seekTo(999);
    expect(player.getState().position).toBe(player.total);
    expect(player.getState().finished).toBe(true);
    expect(states.length).toBeGreaterThan(0);
  });

  it("drops restore frames so the strokes are what plays", () => {
    const withRestore = [...items, ["restore", "data:image/png;base64,A", "data:image/png;base64,B"]];
    const player = new ReplayPlayer(withRestore, W, H, displayContext(), () => {});
    expect(player.total).toBe(10);
  });

  it("plays to completion on its own", async () => {
    const ctx = displayContext();
    let finished = false;
    const player = new ReplayPlayer(items, W, H, ctx, (s) => {
      if (s.finished && !s.playing) finished = true;
    });
    player.setSpeed(0);
    player.play();

    const deadline = Date.now() + 5000;
    while (!finished && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(finished).toBe(true);
    expect(player.getState().position).toBe(player.total);
    player.dispose();
  });
});
