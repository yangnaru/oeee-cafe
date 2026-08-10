import { describe, expect, it } from "vitest";
import { LINETYPE, MASKTYPE, NeoPainter, TOOLTYPE } from "./NeoPainter";
import {
  createCanonicalPainter,
  describeDifference,
  firstPixelDifference,
  readPixels,
} from "../test/neoHarness";

const W = 48;
const H = 48;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * Paints identical starting content into both implementations, runs `op`
 * against each, and compares both layers.
 */
function compare(
  op: (p: { painter: Any; ctxOf: (l: number) => CanvasRenderingContext2D }) => void
) {
  const ours = new NeoPainter(W, H);
  const cp = createCanonicalPainter(W, H);

  const seed = (
    setState: (c: [number, number, number, number], w: number) => void,
    line: (l: number, x0: number, y0: number, x1: number, y1: number, t: number) => void,
    clearPrev: () => void
  ) => {
    setState([200, 60, 40, 255], 14);
    line(0, 4, 12, 44, 20, LINETYPE.PEN);
    clearPrev();
    setState([40, 90, 200, 200], 10);
    line(1, 6, 36, 42, 8, LINETYPE.PEN);
    clearPrev();
    setState([20, 20, 20, 180], 6);
    line(0, 24, 4, 24, 44, LINETYPE.PEN);
    clearPrev();
  };

  seed(
    (c, w) => {
      ours._currentColor = [...c];
      ours._currentWidth = w;
    },
    (l, x0, y0, x1, y1, t) => ours.drawLine(ours.canvasCtx[l], x0, y0, x1, y1, t),
    () => {
      ours.prevLine = null;
    }
  );
  seed(
    (c, w) => {
      cp.painter._currentColor = [...c];
      cp.painter._currentWidth = w;
    },
    (l, x0, y0, x1, y1, t) => cp.painter.drawLine(cp.contexts[l], x0, y0, x1, y1, t),
    () => {
      cp.painter.prevLine = null;
    }
  );

  op({ painter: ours, ctxOf: (l) => ours.canvasCtx[l] });
  op({ painter: cp.painter, ctxOf: (l) => cp.contexts[l] });

  for (const layer of [0, 1]) {
    const a = readPixels(ours.canvasCtx[layer], W, H);
    const b = readPixels(cp.contexts[layer], W, H);
    expect(
      firstPixelDifference(a, b),
      `layer ${layer}: ${describeDifference(a, b, W)}`
    ).toBe(-1);
  }
}

describe("NeoPainter region operations vs canonical NEO", () => {
  it("eraseRect matches at several alphas", () => {
    for (const alpha of [255, 200, 128, 40, 1]) {
      compare(({ painter }) => {
        painter._currentColor = [0, 0, 0, alpha];
        painter._currentMaskType = MASKTYPE.NONE;
        painter.eraseRect(0, 6, 6, 30, 26);
      });
    }
  });

  it("eraseRect matches under a mask", () => {
    compare(({ painter }) => {
      painter._currentColor = [0, 0, 0, 255];
      painter._currentMaskType = MASKTYPE.NORMAL;
      painter._currentMask = [200, 60, 40];
      painter.eraseRect(0, 4, 4, 36, 36);
    });
  });

  it("flipH and flipV match", () => {
    compare(({ painter }) => painter.flipH(0, 4, 4, 30, 22));
    compare(({ painter }) => painter.flipV(0, 4, 4, 30, 22));
    compare(({ painter }) => painter.flipH(1, 0, 0, W, H));
    compare(({ painter }) => painter.flipV(1, 5, 7, 21, 17));
  });

  it("merge matches into either layer", () => {
    compare(({ painter }) => painter.merge(0, 0, 0, W, H));
    compare(({ painter }) => painter.merge(1, 0, 0, W, H));
    compare(({ painter }) => painter.merge(0, 8, 8, 20, 20));
  });

  it("blurRect matches at several alphas", () => {
    for (const alpha of [255, 160, 60, 12]) {
      compare(({ painter }) => {
        painter._currentColor = [0, 0, 0, alpha];
        painter.blurRect(0, 4, 4, 32, 30);
      });
    }
  });

  it("copy then paste matches, including an offset paste", () => {
    compare(({ painter }) => {
      painter.copy(0, 6, 6, 18, 14);
      painter.paste(0, 6, 6, 18, 14, 10, 12);
    });
    compare(({ painter }) => {
      painter.copy(1, 0, 0, 24, 24);
      painter.paste(0, 0, 0, 24, 24, 0, 0);
    });
  });

  it("turn matches, reproducing its top-row smear", () => {
    compare(({ painter }) => painter.turn(0, 4, 4, 20, 20));
    compare(({ painter }) => painter.turn(1, 0, 0, 16, 24));
  });

  it("doFloodFill matches", () => {
    compare(({ painter }) => painter.doFloodFill(0, 1, 1, 0xff2266aa));
    compare(({ painter }) => painter.doFloodFill(1, 24, 24, 0xff11ff11));
  });

  it("doFill matches for every shape mask", () => {
    for (const type of [
      TOOLTYPE.RECT,
      TOOLTYPE.RECTFILL,
      TOOLTYPE.ELLIPSE,
      TOOLTYPE.ELLIPSEFILL,
    ]) {
      for (const alpha of [255, 128, 30]) {
        compare(({ painter }) => {
          painter._currentColor = [30, 200, 90, alpha];
          painter._currentWidth = 3;
          painter._currentMaskType = MASKTYPE.NONE;
          painter.doFill(0, 6, 6, 30, 24, type);
        });
      }
    }
  });

  it("doFill matches under each mask type", () => {
    for (const maskType of [
      MASKTYPE.NORMAL,
      MASKTYPE.REVERSE,
      MASKTYPE.ADD,
      MASKTYPE.SUB,
    ]) {
      compare(({ painter }) => {
        painter._currentColor = [30, 200, 90, 255];
        painter._currentWidth = 3;
        painter._currentMaskType = maskType;
        painter._currentMask = [200, 60, 40];
        painter.doFill(0, 4, 4, 32, 28, TOOLTYPE.RECTFILL);
      });
    }
  });

  it("eraseAll and clearCanvas match", () => {
    // eraseAll lives on NEO's ActionManager, which clears the layer inline, so
    // compare our wrapper against that clearRect directly.
    for (const layer of [0, 1]) {
      compare(({ painter, ctxOf }) => {
        if (painter instanceof NeoPainter) {
          painter.eraseAll(layer);
        } else {
          ctxOf(layer).clearRect(0, 0, W, H);
        }
      });
    }
    compare(({ painter, ctxOf }) => {
      if (painter instanceof NeoPainter) {
        painter.clearCanvas();
      } else {
        ctxOf(0).clearRect(0, 0, W, H);
        ctxOf(1).clearRect(0, 0, W, H);
      }
    });
  });
});
