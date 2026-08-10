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

  for (const [path, url] of entries) {
    const name = path.split("/").pop() ?? path;

    it(`reproduces ${name.slice(0, 12)} exactly`, async () => {
      const bytes = await loadBytes(url);
      const decoded = decodePCH(bytes);
      expect(decoded, `${name} failed to decode`).not.toBeNull();
      if (!decoded) return;

      const { width, height } = decoded;

      // Drop restore frames on both sides. They carry the finished drawing as
      // a PNG, so applying them would overwrite the replayed strokes and make
      // the comparison pass regardless of how the strokes rendered.
      const items = decoded.items.filter((item) => item[0] !== "restore");

      // Canonical NEO. Both sides consume the same fixPCH output.
      const cp = createCanonicalPainter(width, height);
      replayWithNeo(cp, items);

      // The TypeScript port
      const replay = new NeoReplay(width, height);
      await replay.playAll(items);

      for (const layer of [0, 1]) {
        const ours = replay.getLayerPixels(layer);
        const neo = readPixels(cp.contexts[layer], width, height);
        expect(
          firstPixelDifference(ours, neo),
          `${name} layer ${layer} (${width}x${height}, ${items.length} frames): ` +
            describeDifference(ours, neo, width)
        ).toBe(-1);
      }
    });
  }
});
