import { describe, expect, it } from "vitest";
import { DrawingEngine } from "./DrawingEngine";
import { deflateRaster, inflateRaster } from "./utils/rasterCodec";

describe("a fill carried as the pixels it covered", () => {
  it("crops to the region it actually filled", () => {
    const engine = new DrawingEngine(64, 48);
    engine.setLocalOwner("1");
    const layer = engine.layersFor("1").background;

    // A box to flood inside, so the fill cannot reach the whole layer.
    for (let y = 10; y < 30; y++) {
      for (const x of [10, 29]) layer[(y * 64 + x) * 4 + 3] = 255;
    }
    for (let x = 10; x <= 29; x++) {
      for (const y of [10, 29]) layer[(y * 64 + x) * 4 + 3] = 255;
    }

    const region = engine.floodFillCapturingRegion(layer, 20, 20, 200, 100, 50, 255);
    expect(region).not.toBeNull();
    // Inside the box, nowhere near the 64x48 layer.
    expect(region!.width).toBeLessThan(64);
    expect(region!.height).toBeLessThan(48);
    expect(region!.x).toBeGreaterThanOrEqual(10);
    expect(region!.y).toBeGreaterThanOrEqual(10);
  });

  it("round-trips through the wire codec", async () => {
    const pixels = new Uint8ClampedArray(8 * 4 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 200; pixels[i + 1] = 100; pixels[i + 2] = 50; pixels[i + 3] = 255;
    }
    const compressed = await deflateRaster(pixels);
    // A flat rectangle is exactly what a fill is, and it should be tiny.
    expect(compressed.length).toBeLessThan(pixels.length);
    const restored = await inflateRaster(compressed, 8, 4);
    expect(Array.from(restored)).toEqual(Array.from(pixels));
  });

  it("refuses a payload that is not the size it claims", async () => {
    const compressed = await deflateRaster(new Uint8ClampedArray(4 * 4));
    await expect(inflateRaster(compressed, 8, 4)).rejects.toThrow(/needs/);
  });

  it("puts the pixels back exactly where they came from", async () => {
    const engine = new DrawingEngine(32, 24);
    engine.setLocalOwner("1");
    const source = engine.layersFor("1").background;
    const region = { x: 5, y: 6, width: 4, height: 3 };
    const pixels = new Uint8ClampedArray(region.width * region.height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 10; pixels[i + 1] = 20; pixels[i + 2] = 30; pixels[i + 3] = 255;
    }

    engine.putImage(source, region.x, region.y, region.width, region.height, pixels);

    const at = (x: number, y: number) => source[(y * 32 + x) * 4 + 3];
    expect(at(5, 6)).toBe(255);
    expect(at(8, 8)).toBe(255);
    // and nowhere else
    expect(at(4, 6)).toBe(0);
    expect(at(9, 6)).toBe(0);
    expect(at(5, 9)).toBe(0);
  });
});
