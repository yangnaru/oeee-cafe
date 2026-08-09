import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useCanvasHistory } from "./useCanvasHistory";

type History = ReturnType<typeof useCanvasHistory>;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Renders the hook in the real browser and hands its API back. The undo
 * bookkeeping is what we are testing, so nothing needs to be on screen.
 */
function mountHistory(maxSize?: number): History {
  const captured: { api: History | null } = { api: null };
  function Probe() {
    captured.api = useCanvasHistory(maxSize);
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(<Probe />);
  });

  if (!captured.api) throw new Error("hook did not render");
  return captured.api;
}

const SIZE = 4 * 4 * 4; // 4x4 RGBA

const layer = (fill: number) => {
  const a = new Uint8ClampedArray(SIZE);
  a.fill(fill);
  return a;
};

describe("useCanvasHistory", () => {
  it("records one entry per save, including saves that change nothing", () => {
    const history = mountHistory();
    const blank = layer(0);

    history.saveState(blank, blank, "both", false);
    expect(history.getHistoryInfo().historyLength).toBe(1);

    // A stroke that produced no pixel change still has to take a slot: the
    // action recorder emits a frame for it, and NEO registers an undo step
    // unconditionally. Skipping it here would drift the two apart.
    history.saveState(blank, blank, "both", true);
    expect(history.getHistoryInfo().historyLength).toBe(2);
    expect(history.getHistoryInfo().currentIndex).toBe(1);

    history.saveState(layer(9), blank, "both", true);
    expect(history.getHistoryInfo().historyLength).toBe(3);
    expect(history.getHistoryInfo().currentIndex).toBe(2);
  });

  it("keeps the index in step with the number of saves through undo and redo", () => {
    const history = mountHistory();
    history.saveState(layer(0), layer(0), "both", false);
    history.saveState(layer(1), layer(0), "both", true);
    history.saveState(layer(2), layer(0), "both", true);
    history.saveState(layer(3), layer(0), "both", true);

    expect(history.getHistoryInfo().currentIndex).toBe(3);

    history.undo();
    expect(history.getHistoryInfo().currentIndex).toBe(2);
    history.undo();
    expect(history.getHistoryInfo().currentIndex).toBe(1);
    history.redo();
    expect(history.getHistoryInfo().currentIndex).toBe(2);
  });

  it("restores the exact layers that were saved, without swapping them", () => {
    const history = mountHistory();
    const fg = layer(0);
    const bg = layer(0);
    history.saveState(fg, bg, "both", false);

    const filledForeground = layer(7);
    const filledBackground = layer(3);
    history.saveState(filledForeground, filledBackground, "both", true);
    history.saveState(layer(9), layer(9), "both", true);

    const restored = history.undo();
    expect(restored).not.toBeNull();
    expect(Array.from(restored!.foreground.slice(0, 4))).toEqual([7, 7, 7, 7]);
    expect(Array.from(restored!.background.slice(0, 4))).toEqual([3, 3, 3, 3]);
  });

  it("cannot undo past the initial entry", () => {
    const history = mountHistory();
    history.saveState(layer(0), layer(0), "both", false);
    history.saveState(layer(1), layer(0), "both", true);

    expect(history.undo()).not.toBeNull();
    expect(history.getHistoryInfo().currentIndex).toBe(0);
    expect(history.canUndo()).toBe(false);
    expect(history.undo()).toBeNull();
  });

  it("discards the redo branch when a new state is saved after an undo", () => {
    const history = mountHistory();
    history.saveState(layer(0), layer(0), "both", false);
    history.saveState(layer(1), layer(0), "both", true);
    history.saveState(layer(2), layer(0), "both", true);

    history.undo();
    expect(history.canRedo()).toBe(true);

    history.saveState(layer(5), layer(0), "both", true);
    expect(history.canRedo()).toBe(false);
    expect(history.getHistoryInfo().historyLength).toBe(3);
    expect(history.getHistoryInfo().currentIndex).toBe(2);
  });

  it("drops the oldest entries past the size cap", () => {
    const history = mountHistory(3);
    for (let i = 0; i < 5; i++) {
      history.saveState(layer(i), layer(0), "both", true);
    }
    expect(history.getHistoryInfo().historyLength).toBe(3);
    expect(history.getHistoryInfo().currentIndex).toBe(2);
  });

  it("ignores remote snapshots", () => {
    const history = mountHistory();
    history.saveState(layer(0), layer(0), "both", false);
    history.saveState(layer(1), layer(0), "both", true, false, true);
    expect(history.getHistoryInfo().historyLength).toBe(1);
  });
});
