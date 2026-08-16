import { expect, it } from "vitest";
import { act } from "react";
import { mount } from "./public";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const litPixels = (host: HTMLElement, w: number, h: number) =>
  Array.from(host.querySelectorAll("canvas")).reduce((total, canvas) => {
    const data = canvas.getContext("2d")!.getImageData(0, 0, w, h).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) lit += 1;
    return total + lit;
  }, 0);

/**
 * A canonical operation has to reach the screen on its own.
 *
 * Every participant's pair is re-keyed when the server names them, and the
 * repaint that follows a write looks the region up by owner. A write filed
 * under the name the pair had before the rename is a write nothing repaints:
 * the pixels are in the buffer and not on the canvas, and they stay that way
 * until something unrelated forces a full redraw -- another participant
 * arriving, or the local user touching the canvas. That is invisible in a
 * session where you are always drawing, and very visible in one where you are
 * watching, or catching up after a rejoin.
 */
it("paints a canonical stroke aimed at the local participant's own layers", async () => {
  const element = document.createElement("div");
  document.body.appendChild(element);
  let painter!: ReturnType<typeof mount>;
  act(() => {
    painter = mount(element, {
      width: 64, height: 48,
      mode: { kind: "standard" },
      controls: { kind: "none" },
      // Mounted under a placeholder, then named by the server, exactly as a
      // collaborative client is.
      synchronization: { actorId: "placeholder", onOperation: () => {} },
    });
  });
  await act(async () => painter.ready);
  act(() => painter.setLocalActorId("2"));

  expect(litPixels(element, 64, 48)).toBe(0);

  // Somebody else draws on our layers.
  await act(async () => {
    await painter.applyCanonicalOperation({
      id: "a:1", actorId: "1", sequence: 1, operation: { kind: "undo-boundary" },
    });
    await painter.applyCanonicalOperation({
      id: "a:2", actorId: "1", sequence: 2,
      operation: {
        kind: "stroke", targetActorId: "2", layer: "background",
        brushSize: 1, brush: "solid",
        color: { r: 0, g: 0, b: 0, a: 255 },
        points: [{ x: 16, y: 24 }, { x: 48, y: 24 }],
        mask: { type: 0, r: 0, g: 0, b: 0 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  expect(litPixels(element, 64, 48)).toBeGreaterThan(0);
  act(() => painter.unmount());
});
