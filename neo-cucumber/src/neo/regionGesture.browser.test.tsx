import { describe, expect, it } from "vitest";
import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useOfflineDrawing } from "../hooks/useOfflineDrawing";
import type { DrawingState } from "../types/collaboration";
import { drawRegionPreview } from "./regionPreview";
import type { RegionRect } from "./regionDrag";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const W = 60;
const H = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mounts the real offline stack with a region tool selected. */
async function mountWithTool(tool: string) {
  const previews: (RegionRect | null)[] = [];
  const captured: { api: ReturnType<typeof useOfflineDrawing> | null } = { api: null };

  const state: DrawingState = {
    brushSize: 4, opacity: 255, color: "#1e2864",
    brushType: tool as DrawingState["brushType"],
    layerType: "background", zoomLevel: 100,
    fgVisible: true, bgVisible: true, isFlippedHorizontal: false,
  };

  function Harness() {
    const appRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const api = useOfflineDrawing(canvasRef, appRef, state, undefined, 100, W, H,
      undefined, undefined, (r: RegionRect | null) => previews.push(r));
    useEffect(() => { captured.api = api; });
    return (
      <div id="app" ref={appRef}>
        <canvas id="canvas" ref={canvasRef} width={W} height={H}
          style={{ width: `${W}px`, height: `${H}px`, display: "block" }} />
      </div>
    );
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
  for (let i = 0; i < 50 && !captured.api?.drawingEngine; i++) {
    await act(async () => { await sleep(10); root.render(<Harness />); });
  }
  if (!captured.api?.drawingEngine) throw new Error("engine never initialised");

  const canvas = container.querySelector("#canvas") as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const send = async (type: string, x: number, y: number) => {
    await act(async () => {
      canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, pointerType: "mouse", button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: rect.left + x, clientY: rect.top + y,
        bubbles: true, cancelable: true,
      }));
    });
  };

  return { api: captured.api, previews, send, canvas };
}

describe("dragging out a region tool", () => {
  it("previews while dragging and applies on release", async () => {
    const { api, previews, send } = await mountWithTool("rectFill");
    const layer = api.drawingEngine!.layers.background;
    expect(layer[(20 * W + 20) * 4 + 3]).toBe(0);

    await send("pointerdown", 10, 8);
    await act(async () => { await sleep(20); });
    await send("pointermove", 34, 26);
    await act(async () => { await sleep(20); });
    await send("pointerup", 34, 26);

    // Grew while dragging, then cleared on release
    expect(previews.length).toBeGreaterThan(1);
    expect(previews[0]).toEqual({ x: 10, y: 8, width: 1, height: 1 });
    expect(previews.at(-1)).toBeNull();

    // A pixel inside the dragged rectangle is now painted
    expect(layer[(20 * W + 20) * 4 + 3]).toBeGreaterThan(0);
    // and one outside it is not
    expect(layer[(2 * W + 50) * 4 + 3]).toBe(0);
  });

  it("records the region as its own replay frame", async () => {
    const { api, send } = await mountWithTool("eraseRect");
    await send("pointerdown", 6, 6);
    await act(async () => { await sleep(20); });
    await send("pointermove", 20, 18);
    await send("pointerup", 20, 18);

    const bytes = new Uint8Array(await api.getReplayBlob().arrayBuffer());
    const { decodePCH } = await import("./NeoReplay");
    const decoded = decodePCH(bytes)!;
    const frame = decoded.items.at(-1)!;
    expect(frame[0]).toBe("eraseRect2");
    // pushCurrent occupies 2..10, so geometry starts at 11
    expect(frame.slice(11, 15)).toEqual([6, 6, 15, 13]);
  });

  it("leaves the canvas alone when the drag is cancelled", async () => {
    const { api, previews, send, canvas } = await mountWithTool("rectFill");
    const layer = api.drawingEngine!.layers.background;

    await send("pointerdown", 10, 8);
    await act(async () => { await sleep(20); });
    await send("pointermove", 30, 24);
    await act(async () => {
      // This harness's canvas, not whichever one another test left in the DOM
      canvas.dispatchEvent(
        new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })
      );
    });

    expect(previews.at(-1)).toBeNull();
    expect(layer.some((v) => v !== 0)).toBe(false);
  });
});

describe("the preview overlay", () => {
  it("draws an outline that survives whatever is underneath", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 40; canvas.height = 20;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    // Half white, half black: a fixed colour would vanish on one of them
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 20, 20);
    ctx.fillStyle = "#000000"; ctx.fillRect(20, 0, 20, 20);
    const before = new Uint8ClampedArray(ctx.getImageData(0, 0, 40, 20).data);

    drawRegionPreview(ctx, { x: 2, y: 2, width: 36, height: 16 });
    const after = ctx.getImageData(0, 0, 40, 20).data;

    let changedOnWhite = 0, changedOnBlack = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (before[i] === after[i] && before[i + 1] === after[i + 1]) continue;
      const x = (i / 4) % 40;
      if (x < 20) changedOnWhite++; else changedOnBlack++;
    }
    expect(changedOnWhite).toBeGreaterThan(0);
    expect(changedOnBlack).toBeGreaterThan(0);
  });

  it("clears when there is no rectangle", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 20; canvas.height = 20;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    drawRegionPreview(ctx, { x: 2, y: 2, width: 10, height: 10 });
    drawRegionPreview(ctx, null);
    const px = ctx.getImageData(0, 0, 20, 20).data;
    expect(px.some((v) => v !== 0)).toBe(false);
  });
});

describe("eraseAll, which acts on the press itself", () => {
  it("clears the layer and records it", async () => {
    // Draw something first, so there is anything to clear
    const drawing = await mountWithTool("rectFill");
    await drawing.send("pointerdown", 6, 6);
    await act(async () => { await sleep(20); });
    await drawing.send("pointermove", 40, 30);
    await drawing.send("pointerup", 40, 30);
    const layer = drawing.api.drawingEngine!.layers.background;
    expect(layer.some((v) => v !== 0)).toBe(true);

    // Selecting eraseAll and clicking wipes it, with no drag involved
    const { api, previews, send } = await mountWithTool("eraseAll");
    const target = api.drawingEngine!.layers.background;
    target.fill(200);

    await send("pointerdown", 12, 12);
    await send("pointerup", 12, 12);

    expect(target.every((v) => v === 0)).toBe(true);
    // No rubber band: it is not a region tool
    expect(previews).toEqual([]);

    const bytes = new Uint8Array(await api.getReplayBlob().arrayBuffer());
    const { decodePCH } = await import("./NeoReplay");
    const frame = decodePCH(bytes)!.items.at(-1)!;
    expect(frame).toEqual(["eraseAll", 0]);
  });
});
