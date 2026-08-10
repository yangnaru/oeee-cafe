import { describe, expect, it } from "vitest";
import { NeoReplay, decodePCH } from "./NeoReplay";
import {
  createCanonicalPainter,
  describeDifference,
  firstPixelDifference,
  readPixels,
  replayWithNeo,
} from "../test/neoHarness";

/**
 * The pixel-perfect reproduction test: real .pch files from production,
 * replayed through both canonical NEO and the TypeScript port, compared as
 * whole layers.
 *
 * The files are real drawings, so they are not committed. Run
 * `src/test/fetch-corpus.sh` to populate src/test/corpus/ from the public
 * bucket; without it this suite reports that it was skipped rather than
 * passing silently.
 */
const files = import.meta.glob("../test/corpus/*.pch", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));

async function loadBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

describe("production replay corpus", () => {
  if (entries.length === 0) {
    it.skip("no corpus present - run src/test/fetch-corpus.sh", () => {});
    return;
  }

  it(`has a corpus to check (${entries.length} files)`, () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  // Files the archive cannot render at all, kept out of the mismatch count and
  // reported on their own. Both are data faults, not rasterisation faults.
  const undecodable: string[] = [];
  const neoCannotReplay: string[] = [];

  /** Replays one file through both implementations; returns a mismatch, or null. */
  async function checkFile(path: string, url: string): Promise<string | null> {
    const name = path.split("/").pop() ?? path;
    const bytes = await loadBytes(url);
    const decoded = decodePCH(bytes);
    if (!decoded) {
      undecodable.push(name);
      return null;
    }

    const { width, height } = decoded;

    // Drop restore frames on both sides. They carry the finished drawing as a
    // PNG, so applying them would overwrite the replayed strokes and make the
    // comparison pass regardless of how the strokes rendered.
    const items = decoded.items.filter((item) => item[0] !== "restore");

    // Canonical NEO. Both sides consume the same fixPCH output. A damaged
    // frame makes NEO itself throw -- those files are unplayable in the live
    // viewer today, so there is nothing to compare against.
    const cp = createCanonicalPainter(width, height);
    try {
      replayWithNeo(cp, items);
    } catch {
      neoCannotReplay.push(name);
      return null;
    }

    // The TypeScript port
    const replay = new NeoReplay(width, height);
    await replay.playAll(items);

    for (const layer of [0, 1]) {
      const ours = replay.getLayerPixels(layer);
      const neo = readPixels(cp.contexts[layer], width, height);
      if (firstPixelDifference(ours, neo) !== -1) {
        return (
          `${name} layer ${layer} (${width}x${height}, ${items.length} frames): ` +
          describeDifference(ours, neo, width)
        );
      }
    }
    return null;
  }

  // Batched so a full-archive sweep does not emit thousands of cases or hold
  // thousands of canvases live. Every mismatch in a batch is reported, not
  // just the first.
  const BATCH = 25;
  for (let start = 0; start < entries.length; start += BATCH) {
    const batch = entries.slice(start, start + BATCH);
    const last = Math.min(start + BATCH, entries.length);

    it(`reproduces files ${start + 1}-${last} exactly`, async () => {
      const problems: string[] = [];
      for (const [path, url] of batch) {
        problems.push(...[await checkFile(path, url)].filter((p) => p !== null));
      }
      expect(problems, problems.join("\n")).toEqual([]);
    }, 120_000);
  }

  // Runs after the batches above. These are archive faults rather than port
  // faults, so they are surfaced explicitly instead of failing the sweep.
  it("reports files the archive itself cannot replay", () => {
    if (undecodable.length > 0) {
      console.warn(`undecodable (${undecodable.length}):`, undecodable.join(", "));
    }
    if (neoCannotReplay.length > 0) {
      console.warn(
        `damaged frames, NEO throws on these too (${neoCannotReplay.length}):`,
        neoCannotReplay.join(", ")
      );
    }
    // Exact, so a new unplayable file fails the sweep instead of hiding. The
    // one remaining is a zero-byte upload with nothing to recover; the
    // concatenated-frame file was repaired in the bucket, so NEO plays it now.
    expect(neoCannotReplay).toEqual([]);
    expect(undecodable).toEqual([
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.pch",
    ]);
  });
});
