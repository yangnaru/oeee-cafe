import { describe, expect, it } from "vitest";
import {
  TILE_SIZE,
  restoreLayer,
  retainedBytes,
  snapshotLayer,
  type LayerSnapshot,
} from "./layerSnapshots";

/** A canvas that is not a whole number of tiles in either direction. */
const WIDTH = TILE_SIZE * 3 + 17;
const HEIGHT = TILE_SIZE * 2 + 5;

function blank(): Uint8ClampedArray {
  return new Uint8ClampedArray(WIDTH * HEIGHT * 4);
}

function noise(seed: number): Uint8ClampedArray {
  const layer = blank();
  let state = seed;
  for (let i = 0; i < layer.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    layer[i] = state & 0xff;
  }
  return layer;
}

/** Paints one opaque pixel, which is the smallest thing a stroke can do. */
function dot(layer: Uint8ClampedArray, x: number, y: number, value: number) {
  const at = (y * WIDTH + x) * 4;
  layer[at] = value;
  layer[at + 1] = value;
  layer[at + 2] = value;
  layer[at + 3] = 255;
}

function take(
  layer: Uint8ClampedArray,
  previous: LayerSnapshot | null = null
): LayerSnapshot {
  return snapshotLayer(layer, WIDTH, HEIGHT, previous);
}

describe("tiled layer snapshots", () => {
  it("reconstructs the exact layer it was taken from", () => {
    const layer = noise(7);
    const snapshot = take(layer);
    const into = blank();
    restoreLayer(snapshot, into);
    expect(into).toEqual(layer);
  });

  /**
   * The edge tiles are narrower and shorter than the rest. Getting their
   * strides wrong is the kind of mistake that reconstructs most of a canvas
   * correctly and smears the right-hand column.
   */
  it("reconstructs a canvas that is not a whole number of tiles", () => {
    const layer = noise(11);
    const into = blank();
    restoreLayer(take(layer), into);
    expect(into).toEqual(layer);
    expect(WIDTH % TILE_SIZE).not.toBe(0);
    expect(HEIGHT % TILE_SIZE).not.toBe(0);
  });

  it("shares every tile when nothing changed", () => {
    const layer = noise(3);
    const first = take(layer);
    const second = take(layer, first);
    expect(second.tiles).toHaveLength(first.tiles.length);
    for (let i = 0; i < first.tiles.length; i++) {
      expect(second.tiles[i]).toBe(first.tiles[i]);
    }
    // The second snapshot cost nothing beyond the first.
    expect(retainedBytes([first, second])).toBe(retainedBytes([first]));
  });

  /** The point of the exercise: a stroke pays for the tiles it touched. */
  it("copies only the tiles a change touched", () => {
    const layer = noise(5);
    const first = take(layer);
    dot(layer, 3, 3, 200);
    const second = take(layer, first);

    const copied = second.tiles.filter(
      (tile, index) => tile !== first.tiles[index]
    );
    expect(copied).toHaveLength(1);
    expect(second.tiles[0]).not.toBe(first.tiles[0]);

    // One tile, where the scheme this replaces copied the whole layer.
    const growth = retainedBytes([first, second]) - retainedBytes([first]);
    expect(growth).toBe(TILE_SIZE * TILE_SIZE * 4);
    expect(growth).toBeLessThan(WIDTH * HEIGHT * 4);
  });

  it("copies both tiles a change straddling their boundary touched", () => {
    const layer = noise(13);
    const first = take(layer);
    dot(layer, TILE_SIZE - 1, 3, 90);
    dot(layer, TILE_SIZE, 3, 90);
    const second = take(layer, first);
    const copied = second.tiles.filter(
      (tile, index) => tile !== first.tiles[index]
    );
    expect(copied).toHaveLength(2);
  });

  /**
   * A shared tile is one object in two snapshots. Restoring an older snapshot
   * must not be able to write through it into a newer one.
   */
  it("keeps an older snapshot restorable after later ones are taken", () => {
    const layer = noise(17);
    const before = layer.slice();
    const first = take(layer);
    dot(layer, 5, 5, 42);
    dot(layer, WIDTH - 1, HEIGHT - 1, 42);
    const second = take(layer, first);

    const into = blank();
    restoreLayer(second, into);
    expect(into).toEqual(layer);

    restoreLayer(first, into);
    expect(into).toEqual(before);

    // And the newer snapshot still describes what it did before the restore.
    const again = blank();
    restoreLayer(second, again);
    expect(again).toEqual(layer);
  });

  it("copies everything when the previous snapshot is a different size", () => {
    const layer = noise(23);
    const smaller = snapshotLayer(
      new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4),
      TILE_SIZE,
      TILE_SIZE,
      null
    );
    const snapshot = take(layer, smaller);
    const into = blank();
    restoreLayer(snapshot, into);
    expect(into).toEqual(layer);
    for (const tile of snapshot.tiles) {
      expect(smaller.tiles).not.toContain(tile);
    }
  });

  /**
   * What the whole scheme is for, stated as a number: thirty strokes on a
   * canvas hold far less than thirty canvases.
   */
  it("holds a stroke-shaped undo stack in a fraction of the layers it spans", () => {
    const layer = blank();
    const snapshots: LayerSnapshot[] = [take(layer)];
    for (let i = 0; i < 30; i++) {
      dot(layer, i * 2, i, 255);
      snapshots.push(take(layer, snapshots[snapshots.length - 1]));
    }
    const flat = snapshots.length * WIDTH * HEIGHT * 4;
    expect(retainedBytes(snapshots)).toBeLessThan(flat / 4);
  });
});
