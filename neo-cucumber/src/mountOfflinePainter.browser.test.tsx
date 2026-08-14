import { describe, expect, it } from "vitest";
import { act } from "react";
import { mount } from "./public";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("public painter lifecycle", () => {
  it("rejects invalid dimensions with a stable error code", () => {
    const element = document.createElement("div");
    expect(() =>
      mount(element, {
        width: 0,
        height: 100,
        mode: { kind: "standard" },
        controls: { kind: "none" },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-options" }));
  });

  it("exports artifacts through a framework-neutral handle", async () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    let painter!: ReturnType<typeof mount>;
    act(() => {
      painter = mount(element, {
        width: 100,
        height: 100,
        mode: { kind: "standard" },
        controls: { kind: "none" },
      });
    });
    await act(async () => {
      await painter.ready;
    });
    expect(element.querySelector("canvas")).not.toBeNull();
    expect(element.textContent).not.toContain("Save Drawing");

    let png!: Blob;
    let replay!: Blob;
    let saved!: Awaited<ReturnType<typeof painter.save>>;
    await act(async () => {
      png = await painter.exportPng();
      replay = await painter.exportReplay();
      saved = await painter.save();
    });

    expect(png.type).toBe("image/png");
    expect(new TextDecoder().decode(await replay.slice(0, 4).arrayBuffer())).toBe("NEO ");
    expect(saved.width).toBe(100);
    expect(saved.height).toBe(100);
    expect(saved.png.type).toBe("image/png");
    expect(saved.replay.size).toBeGreaterThan(12);

    act(() => {
      painter.unmount();
      painter.unmount();
    });
    await expect(painter.exportPng()).rejects.toMatchObject({ code: "unmounted" });
  });

  it("loads a continuation image through the public handle", async () => {
    const source = document.createElement("canvas");
    source.width = 100;
    source.height = 100;
    const context = source.getContext("2d")!;
    context.fillStyle = "#317842";
    context.fillRect(0, 0, 100, 100);
    const blob = await new Promise<Blob>((resolve) => source.toBlob((value) => resolve(value!)));

    const element = document.createElement("div");
    document.body.appendChild(element);
    let painter!: ReturnType<typeof mount>;
    act(() => {
      painter = mount(element, {
        width: 100,
        height: 100,
        mode: { kind: "standard" },
        controls: { kind: "none" },
      });
    });
    await act(async () => {
      await painter.ready;
    });
    let replay!: Blob;
    await act(async () => {
      await painter.loadImage(blob);
      replay = await painter.exportReplay();
    });
    expect(replay.size).toBeGreaterThan(12);
    act(() => painter.unmount());
  });
});
