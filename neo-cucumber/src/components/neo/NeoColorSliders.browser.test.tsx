import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { NeoColorSliders } from "./NeoColorSliders";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("NEO ARGB sliders with a pen", () => {
  it("keeps dragging after the pen leaves the toolbox", async () => {
    const values: Array<{ color: string; alpha: number }> = [];

    function Harness() {
      const [color, setColor] = useState("#646464");
      const [alpha, setAlpha] = useState(100);
      return (
        <NeoColorSliders
          color={color}
          alpha={alpha}
          onChange={(nextColor, nextAlpha) => {
            values.push({ color: nextColor, alpha: nextAlpha });
            setColor(nextColor);
            setAlpha(nextAlpha);
          }}
        />
      );
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));

    const slider = host.querySelector('[role="slider"][aria-label="R"]') as HTMLElement;
    const rect = slider.getBoundingClientRect();
    expect(getComputedStyle(slider).touchAction).toBe("none");
    // Synthetic PointerEvents are not registered in Chromium's native active
    // pointer table; capture itself is exercised by real hardware/browser
    // behavior, while this test drives React's continuation path explicitly.
    slider.setPointerCapture = () => {};

    await act(async () => {
      slider.dispatchEvent(new PointerEvent("pointerdown", {
        pointerId: 41,
        pointerType: "pen",
        button: 0,
        buttons: 1,
        clientX: rect.left + 20,
        clientY: rect.top + 5,
        bubbles: true,
      }));
      slider.dispatchEvent(new PointerEvent("pointermove", {
        pointerId: 41,
        pointerType: "pen",
        buttons: 1,
        clientX: rect.right + 400,
        clientY: rect.top + 5,
        bubbles: true,
      }));
      slider.dispatchEvent(new PointerEvent("pointerup", {
        pointerId: 41,
        pointerType: "pen",
        button: 0,
        clientX: rect.right + 400,
        clientY: rect.top + 5,
        bubbles: true,
      }));
    });

    expect(values.at(-1)?.color).toBe("#ff6464");
    await act(async () => root.unmount());
    host.remove();
  });
});
