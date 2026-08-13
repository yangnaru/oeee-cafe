import { describe, expect, it } from "vitest";
import { artworkToOverlay, screenToArtwork } from "./canvasTransform";

describe("canvas coordinate transforms", () => {
  const artwork = { width: 300, height: 200 };

  it.each([
    ["100%", { left: 20, top: 30, width: 300, height: 200 }, { x: 95, y: 80 }],
    ["200%", { left: -130, top: -70, width: 600, height: 400 }, { x: 20, y: 30 }],
    ["50%", { left: 95, top: 80, width: 150, height: 100 }, { x: 132.5, y: 105 }],
    ["panned", { left: 173, top: -41, width: 450, height: 300 }, { x: 285.5, y: 34 }],
  ])("maps %s screen bounds to the same artwork point", (_name, bounds, point) => {
    expect(
      screenToArtwork(point, bounds, artwork.width, artwork.height)
    ).toEqual({ x: 75, y: 50 });
  });

  it("mirrors the artwork x axis after undoing screen zoom and pan", () => {
    expect(
      screenToArtwork(
        { x: 95, y: 80 },
        { left: 20, top: 30, width: 300, height: 200 },
        artwork.width,
        artwork.height,
        true
      )
    ).toEqual({ x: 224, y: 50 });
  });

  it("maps artwork points to screen-resolution overlays", () => {
    expect(artworkToOverlay({ x: 75, y: 50 }, 1.5)).toEqual({
      x: 112.5,
      y: 75,
    });
  });

  it("returns the origin for a hidden or unmeasurable canvas", () => {
    expect(
      screenToArtwork(
        { x: 50, y: 50 },
        { left: 0, top: 0, width: 0, height: 0 },
        artwork.width,
        artwork.height
      )
    ).toEqual({ x: 0, y: 0 });
  });
});
