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

const W = 4;
const H = 4;
const SIZE = W * H * 4;

const layer = (fill: number) => {
  const a = new Uint8ClampedArray(SIZE);
  a.fill(fill);
  return a;
};

/** Saves at the canvas size every test here uses. */
function save(
  history: History,
  fg: Uint8ClampedArray,
  bg: Uint8ClampedArray,
  isDrawingAction: boolean,
  isContentSnapshot = false
) {
  history.saveState(fg, bg, W, H, isDrawingAction, isContentSnapshot);
}

/** Reads a saved state back out through the only door there is. */
function restored(history: History, state: NonNullable<ReturnType<History["undo"]>>) {
  const fg = new Uint8ClampedArray(SIZE);
  const bg = new Uint8ClampedArray(SIZE);
  history.restoreInto(state, fg, bg);
  return { fg, bg };
}

describe("useCanvasHistory", () => {
  it("records one entry per save, including saves that change nothing", () => {
    const history = mountHistory();
    const blank = layer(0);

    save(history, blank, blank, false);
    expect(history.getHistoryInfo().historyLength).toBe(1);

    // A stroke that produced no pixel change still has to take a slot: the
    // action recorder emits a frame for it, and NEO registers an undo step
    // unconditionally. Skipping it here would drift the two apart.
    save(history, blank, blank, true);
    expect(history.getHistoryInfo().historyLength).toBe(2);
    expect(history.getHistoryInfo().currentIndex).toBe(1);

    save(history, layer(9), blank, true);
    expect(history.getHistoryInfo().historyLength).toBe(3);
    expect(history.getHistoryInfo().currentIndex).toBe(2);
  });

  it("keeps the index in step with the number of saves through undo and redo", () => {
    const history = mountHistory();
    save(history, layer(0), layer(0), false);
    save(history, layer(1), layer(0), true);
    save(history, layer(2), layer(0), true);
    save(history, layer(3), layer(0), true);

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
    save(history, layer(0), layer(0), false);
    save(history, layer(7), layer(3), true);
    save(history, layer(9), layer(9), true);

    const state = history.undo();
    expect(state).not.toBeNull();
    const { fg, bg } = restored(history, state!);
    expect(Array.from(fg.slice(0, 4))).toEqual([7, 7, 7, 7]);
    expect(Array.from(bg.slice(0, 4))).toEqual([3, 3, 3, 3]);
  });

  /**
   * The entries hold tiles, and a tile a stroke did not touch is the same
   * buffer in every entry that spans it. Undoing has to hand back what was
   * saved regardless -- a shared tile is not a stale one.
   */
  it("holds unchanged layers without paying for them twice", () => {
    const history = mountHistory();
    const bg = layer(2);
    save(history, layer(0), bg, false);
    const afterFirst = history.getHistoryInfo().retainedBytes;

    // Only the foreground moves; the background is the same pixels each time.
    save(history, layer(1), bg, true);
    save(history, layer(4), bg, true);

    const info = history.getHistoryInfo();
    expect(info.historyLength).toBe(3);
    // Three entries of two layers each would be six layers stored flat.
    expect(info.retainedBytes).toBeLessThan(afterFirst * 3);

    history.undo();
    const state = history.undo();
    const { fg, bg: restoredBg } = restored(history, state!);
    expect(Array.from(fg.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(restoredBg.slice(0, 4))).toEqual([2, 2, 2, 2]);
  });

  it("cannot undo past the initial entry", () => {
    const history = mountHistory();
    save(history, layer(0), layer(0), false);
    save(history, layer(1), layer(0), true);

    expect(history.undo()).not.toBeNull();
    expect(history.getHistoryInfo().currentIndex).toBe(0);
    expect(history.canUndo()).toBe(false);
    expect(history.undo()).toBeNull();
  });

  it("discards the redo branch when a new state is saved after an undo", () => {
    const history = mountHistory();
    save(history, layer(0), layer(0), false);
    save(history, layer(1), layer(0), true);
    save(history, layer(2), layer(0), true);

    history.undo();
    expect(history.canRedo()).toBe(true);

    save(history, layer(5), layer(0), true);
    expect(history.canRedo()).toBe(false);
    expect(history.getHistoryInfo().historyLength).toBe(3);
    expect(history.getHistoryInfo().currentIndex).toBe(2);
  });

  /**
   * A save after an undo shares against the entry it follows, which is the one
   * at the current index -- not the last one in the list, which is about to be
   * discarded. Sharing against the wrong entry would keep a tile from a branch
   * that no longer exists.
   */
  it("restores correctly after saving over a redo branch", () => {
    const history = mountHistory();
    save(history, layer(0), layer(0), false);
    save(history, layer(1), layer(0), true);
    save(history, layer(2), layer(0), true);

    history.undo();
    save(history, layer(5), layer(0), true);

    const state = history.undo();
    expect(Array.from(restored(history, state!).fg.slice(0, 4))).toEqual([
      1, 1, 1, 1,
    ]);
    history.redo();
    const forward = history.redo();
    expect(forward).toBeNull();
  });

  it("drops the oldest entries past the size cap", () => {
    const history = mountHistory(3);
    for (let i = 0; i < 5; i++) {
      save(history, layer(i), layer(0), true);
    }
    expect(history.getHistoryInfo().historyLength).toBe(3);
    expect(history.getHistoryInfo().currentIndex).toBe(2);
  });
});
