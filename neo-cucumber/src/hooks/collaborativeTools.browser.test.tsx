import { describe, expect, it } from "vitest";
import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useDrawing } from "./useDrawing";
import type { DrawingState } from "../types/collaboration";
import { decodeMessage } from "../utils/binaryProtocol";
import type { RegionRect } from "../neo/regionDrag";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const W = 60;
const H = 40;
const ID = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mounts the collaborative stack with a fake socket, so a test can read what
 * actually went out. The tools apply nothing locally here -- in a session the
 * canvas is painted by the history from the confirmed message -- so what
 * matters is that a message is sent at all, and that it says the right thing.
 */
async function mountShared(tool: string, extra: Partial<DrawingState> = {}) {
  const sent: ArrayBuffer[] = [];
  const regionPreviews: (RegionRect | null)[] = [];
  const bezierPreviews: (number[] | null)[] = [];
  const textPlacements: { x: number; y: number }[] = [];
  const captured: { api: ReturnType<typeof useDrawing> | null } = { api: null };

  const state: DrawingState = {
    brushSize: 4, opacity: 255, color: "#1e2864",
    brushType: tool as DrawingState["brushType"],
    layerType: "background", zoomLevel: 100,
    fgVisible: true, bgVisible: true, isFlippedHorizontal: false,
    ...extra,
  };

  function Harness() {
    const appRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef({
      readyState: 1,
      send: (data: ArrayBuffer) => sent.push(data),
    } as unknown as WebSocket);
    const localIdRef = useRef<number | null>(ID);
    const historyRef = useRef(null);

    const api = useDrawing(
      canvasRef, appRef, state, undefined, 100, W, H,
      wsRef, localIdRef, undefined, false, "connected",
      containerRef, historyRef,
      (r: RegionRect | null) => regionPreviews.push(r),
      undefined,
      (p: number[] | null) => bezierPreviews.push(p),
      (x: number, y: number) => textPlacements.push({ x, y })
    );
    useEffect(() => { captured.api = api; });
    return (
      <div id="app" ref={appRef}>
        <div ref={containerRef}>
          <canvas
            id="canvas" ref={canvasRef} width={W} height={H}
            style={{ width: `${W}px`, height: `${H}px`, display: "block" }}
          />
        </div>
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

  /** Everything that went out, decoded. */
  const messages = () => sent.map((b) => decodeMessage(b)).filter(Boolean);

  return {
    api: captured.api!, send, messages,
    regionPreviews, bezierPreviews, textPlacements, canvas,
  };
}

describe("tools in a shared session", () => {
  it("sends a region tool with the rectangle that was dragged", async () => {
    const { send, messages, regionPreviews } = await mountShared("rectFill");

    await send("pointerdown", 10, 8);
    await act(async () => { await sleep(20); });
    await send("pointermove", 34, 26);
    await act(async () => { await sleep(20); });
    await send("pointerup", 34, 26);

    // The rubber band tracked the drag and then cleared
    expect(regionPreviews.length).toBeGreaterThan(1);
    expect(regionPreviews.at(-1)).toBeNull();

    const region = messages().find((m) => m!.type === "region");
    expect(region).toMatchObject({
      type: "region",
      userId: ID,
      tool: "rectFill",
      layer: "background",
      rect: { x: 10, y: 8, width: 25, height: 19 },
    });
    // and it is delimited as an undoable operation
    expect(messages().some((m) => m!.type === "undoPoint")).toBe(true);
  });

  it("sends a straight line, drawn new -> previous as NEO draws it", async () => {
    const { send, messages } = await mountShared("solid", { drawType: "line" });

    await send("pointerdown", 8, 8);
    await act(async () => { await sleep(20); });
    await send("pointermove", 40, 30);
    await send("pointerup", 40, 30);

    expect(messages().find((m) => m!.type === "line")).toMatchObject({
      type: "line",
      userId: ID,
      brushSize: 4,
      from: { x: 8, y: 8 },
      to: { x: 40, y: 30 },
    });
  });

  it("sends a bezier only once the third release commits it", async () => {
    const { send, messages, bezierPreviews } = await mountShared(
      "solid", { drawType: "bezier" }
    );

    await send("pointerdown", 8, 30);
    await act(async () => { await sleep(20); });
    await send("pointermove", 50, 30);
    await send("pointerup", 50, 30);
    expect(messages().some((m) => m!.type === "bezier")).toBe(false);

    await send("pointerdown", 16, 6);
    await send("pointerup", 16, 6);
    expect(messages().some((m) => m!.type === "bezier")).toBe(false);

    await send("pointerdown", 42, 6);
    await send("pointerup", 42, 6);

    expect(messages().find((m) => m!.type === "bezier")).toMatchObject({
      type: "bezier",
      userId: ID,
      points: [8, 30, 16, 6, 42, 6, 50, 30],
    });
    // The curve previewed while it was being built, then cleared
    expect(bezierPreviews.length).toBeGreaterThan(1);
    expect(bezierPreviews.at(-1)).toBeNull();
  });

  it("sends a cleared layer", async () => {
    const { send, messages } = await mountShared("eraseAll");
    await send("pointerdown", 20, 20);
    await send("pointerup", 20, 20);

    expect(messages().find((m) => m!.type === "eraseAll")).toMatchObject({
      type: "eraseAll",
      userId: ID,
      layer: "background",
    });
  });

  it("opens a text box on click and sends what was typed", async () => {
    const { api, send, messages, textPlacements } = await mountShared("text");

    await send("pointerdown", 12, 24);
    await send("pointerup", 12, 24);
    // The click asks the app for an editor rather than drawing anything
    expect(textPlacements).toEqual([{ x: 12, y: 24 }]);
    expect(messages().some((m) => m!.type === "text")).toBe(false);

    await act(async () => {
      api.sendText(12, 24, "안녕", { r: 30, g: 40, b: 100, a: 255 }, 4, "background");
    });

    expect(messages().find((m) => m!.type === "text")).toMatchObject({
      type: "text",
      userId: ID,
      x: 12,
      y: 24,
      text: "안녕",
      brushSize: 4,
    });
  });

  it("says nothing when the text box is committed empty", async () => {
    const { api, messages } = await mountShared("text");
    await act(async () => {
      api.sendText(4, 4, "", { r: 0, g: 0, b: 0, a: 255 }, 4, "background");
    });
    expect(messages().some((m) => m!.type === "text")).toBe(false);
  });
});
