/**
 * Undo snapshots that share the parts of a layer a stroke did not touch.
 *
 * A snapshot used to be a copy of the whole layer, so an undo stack thirty
 * deep held sixty full canvases -- around 180 MB at 1024×768, most of it
 * identical to its neighbours. Drawpile solves this by making its canvas an
 * immutable tree of 64×64 tiles: a save point is a reference to a canvas
 * state, and states share every tile that did not change
 * (`drawdance/libengine/dpengine/canvas_history.c`). A stroke touches a
 * handful of tiles, so a save point costs a handful of tiles.
 *
 * This is the same idea, one layer at a time. A snapshot is an array of tile
 * buffers; taking one against the snapshot before it keeps that snapshot's
 * buffer for every tile whose bytes are unchanged.
 *
 * Sharing is decided by *comparing* the pixels rather than by trusting a dirty
 * rectangle. A rectangle that under-reports would hand back stale pixels on
 * undo -- silently, and only for the region somebody forgot to report -- which
 * is the class of bug this codebase can least afford. The comparison reads the
 * layer once and writes nothing, so even the worst case (everything changed)
 * is cheaper than the copy it replaces.
 */

/** Tile edge, in pixels. Drawpile's `DP_TILE_SIZE`. */
export const TILE_SIZE = 64;

/**
 * One layer, as tiles. Tile buffers are immutable and shared between
 * snapshots: never write into one.
 */
export interface LayerSnapshot {
  readonly width: number;
  readonly height: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly tiles: readonly Uint8ClampedArray[];
}

/** A tile's own size, which is smaller than `TILE_SIZE` at the right edge. */
function tileExtent(total: number, index: number): number {
  return Math.min(TILE_SIZE, total - index * TILE_SIZE);
}

/** A 32-bit view of an RGBA buffer, for comparing and copying whole pixels. */
function pixels(of: Uint8ClampedArray): Uint32Array {
  return new Uint32Array(of.buffer, of.byteOffset, of.length / 4);
}

function copyTile(
  source: Uint32Array,
  width: number,
  tx: number,
  ty: number,
  w: number,
  h: number
): Uint8ClampedArray {
  const tile = new Uint8ClampedArray(w * h * 4);
  const out = pixels(tile);
  for (let row = 0; row < h; row++) {
    const from = (ty * TILE_SIZE + row) * width + tx * TILE_SIZE;
    out.set(source.subarray(from, from + w), row * w);
  }
  return tile;
}

function tileMatches(
  source: Uint32Array,
  width: number,
  tx: number,
  ty: number,
  w: number,
  h: number,
  tile: Uint8ClampedArray
): boolean {
  if (tile.length !== w * h * 4) return false;
  const held = pixels(tile);
  for (let row = 0; row < h; row++) {
    const from = (ty * TILE_SIZE + row) * width + tx * TILE_SIZE;
    const to = row * w;
    for (let i = 0; i < w; i++) {
      if (source[from + i] !== held[to + i]) return false;
    }
  }
  return true;
}

/**
 * Snapshots a layer, keeping `previous`'s buffer for every tile whose pixels
 * are unchanged.
 *
 * Pass the snapshot this one follows in the undo stack. Passing null (or one
 * of a different size, which happens when a canvas is replaced) copies
 * everything, which is what the first entry needs.
 */
export function snapshotLayer(
  layer: Uint8ClampedArray,
  width: number,
  height: number,
  previous: LayerSnapshot | null
): LayerSnapshot {
  const tilesX = Math.ceil(width / TILE_SIZE);
  const tilesY = Math.ceil(height / TILE_SIZE);
  const shareable =
    previous && previous.width === width && previous.height === height
      ? previous
      : null;
  const source = pixels(layer);
  const tiles: Uint8ClampedArray[] = new Array(tilesX * tilesY);

  for (let ty = 0; ty < tilesY; ty++) {
    const h = tileExtent(height, ty);
    for (let tx = 0; tx < tilesX; tx++) {
      const w = tileExtent(width, tx);
      const index = ty * tilesX + tx;
      const held = shareable?.tiles[index];
      tiles[index] =
        held && tileMatches(source, width, tx, ty, w, h, held)
          ? held
          : copyTile(source, width, tx, ty, w, h);
    }
  }

  return { width, height, tilesX, tilesY, tiles };
}

/** Writes a snapshot back over a live layer buffer. */
export function restoreLayer(
  snapshot: LayerSnapshot,
  into: Uint8ClampedArray
): void {
  const { width, height, tilesX, tilesY, tiles } = snapshot;
  const target = pixels(into);
  for (let ty = 0; ty < tilesY; ty++) {
    const h = tileExtent(height, ty);
    for (let tx = 0; tx < tilesX; tx++) {
      const w = tileExtent(width, tx);
      const tile = pixels(tiles[ty * tilesX + tx] as Uint8ClampedArray);
      for (let row = 0; row < h; row++) {
        const to = (ty * TILE_SIZE + row) * width + tx * TILE_SIZE;
        target.set(tile.subarray(row * w, row * w + w), to);
      }
    }
  }
}

/**
 * Bytes held by these snapshots together, counting a shared tile once.
 *
 * For tests and for anything that wants to report what the undo stack costs;
 * the whole point of the scheme is that this is far below the sum of the
 * layers it can reconstruct.
 */
export function retainedBytes(snapshots: Iterable<LayerSnapshot>): number {
  const counted = new Set<Uint8ClampedArray>();
  let total = 0;
  for (const snapshot of snapshots) {
    for (const tile of snapshot.tiles) {
      if (counted.has(tile)) continue;
      counted.add(tile);
      total += tile.length;
    }
  }
  return total;
}
