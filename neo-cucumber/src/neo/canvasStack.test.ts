import { describe, expect, it } from "vitest";
import { CANVAS_Z_INDEX } from "./canvasStack";

describe("canvas stacking order", () => {
  it("keeps NEO's previews and cursor above both artwork layers", () => {
    expect(CANVAS_Z_INDEX.preview).toBeGreaterThan(CANVAS_Z_INDEX.background);
    expect(CANVAS_Z_INDEX.preview).toBeGreaterThan(CANVAS_Z_INDEX.foreground);
    expect(CANVAS_Z_INDEX.cursor).toBeGreaterThan(CANVAS_Z_INDEX.preview);
  });
});
