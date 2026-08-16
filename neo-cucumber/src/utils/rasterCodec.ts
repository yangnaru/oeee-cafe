/**
 * Raw pixels for the wire, compressed with what the browser already has.
 *
 * DEFLATE over the raw RGBA rather than PNG, which is the counterintuitive
 * one: measured on the rasters a flood fill actually produces, PNG came out
 * six times larger on a flat fill and twice on a ragged-edged one. PNG filters
 * each scanline and browser encoders tune for speed; DEFLATE's window simply
 * eats the long repeats that a filled region is made of.
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

/** Compresses raw RGBA for transport. */
export function deflateRaster(pixels: Uint8ClampedArray): Promise<Uint8Array> {
  return through(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    new CompressionStream("deflate"));
}

/**
 * Restores raw RGBA, refusing anything that is not the size it claims -- a
 * short buffer would otherwise be blitted as a band of transparent pixels
 * across somebody's drawing.
 */
export async function inflateRaster(
  compressed: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8ClampedArray> {
  const bytes = await through(compressed, new DecompressionStream("deflate"));
  const expected = width * height * 4;
  if (bytes.length !== expected) {
    throw new Error(
      `Raster is ${bytes.length} bytes; ${width}x${height} needs ${expected}`,
    );
  }
  return new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, expected);
}
