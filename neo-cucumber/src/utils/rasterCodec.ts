/**
 * A fill's coverage for the wire, compressed with what the browser already has.
 *
 * DEFLATE, which measured six times smaller than PNG on the rasters a flood
 * actually makes -- PNG filters each scanline and browser encoders tune for
 * speed, where DEFLATE's window eats the long repeats a filled region is made
 * of. A mask of set bits is more of the same, only more so.
 *
 * Not zstd, which would be smaller again by perhaps a fifth: `CompressionStream`
 * offers gzip and deflate and nothing else, so zstd means carrying a compressor
 * into every page load to save a few hundred bytes on a message that already
 * fits in two kilobytes.
 */

async function through(bytes: Uint8Array, stream: TransformStream): Promise<Uint8Array> {
  const piped = new Blob([bytes.slice().buffer as ArrayBuffer])
    .stream()
    .pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** Compresses a coverage mask for transport. */
export function deflateCoverage(coverage: Uint8Array): Promise<Uint8Array> {
  return through(coverage, new CompressionStream("deflate"));
}

/**
 * Restores raw RGBA, refusing anything that is not the size it claims -- a
 * short buffer would otherwise be blitted as a band of transparent pixels
 * across somebody's drawing.
 */
export async function inflateCoverage(
  compressed: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const bytes = await through(compressed, new DecompressionStream("deflate"));
  const expected = Math.ceil((width * height) / 8);
  if (bytes.length !== expected) {
    throw new Error(
      `Coverage is ${bytes.length} bytes; ${width}x${height} needs ${expected}`,
    );
  }
  return bytes;
}
