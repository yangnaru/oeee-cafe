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

  it("accepts a 1024×768 canvas", async () => {
    const element = document.createElement("div");
    let painter!: ReturnType<typeof mount>;
    act(() => {
      painter = mount(element, {
        width: 1024,
        height: 768,
        mode: { kind: "standard" },
        controls: { kind: "none" },
      });
    });
    await act(async () => painter.ready);
    act(() => painter.unmount());
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

    act(() => {
      painter.setInteractionEnabled(false);
      painter.undo();
      painter.redo();
      painter.setInteractionEnabled(true);
    });

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
    expect(() => painter.undo()).toThrow(expect.objectContaining({ code: "unmounted" }));
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

  it("emits framework-neutral operations for controlled hosts", async () => {
    const operations: import("./operations").LocalPainterOperation[] = [];
    let pointerUps = 0;
    const element = document.createElement("div");
    document.body.appendChild(element);
    let painter!: ReturnType<typeof mount>;
    act(() => {
      painter = mount(element, {
        width: 100,
        height: 100,
        mode: { kind: "standard" },
        controls: { kind: "none" },
        synchronization: {
          actorId: "alice",
          onOperation: (operation) => operations.push(operation),
          onPointerUp: () => { pointerUps += 1; },
        },
      });
    });
    await act(async () => painter.ready);

    const canvas = element.querySelector("#canvas") as HTMLCanvasElement;
    const send = async (type: string, x: number, y: number) => {
      await act(async () => {
        canvas.dispatchEvent(new PointerEvent(type, {
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
          bubbles: true,
        }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    await send("pointerdown", 10, 12);
    await send("pointermove", 30, 32);
    expect(operations.map((entry) => entry.operation.kind)).toEqual([
      "undo-boundary",
      "stroke",
      "stroke",
    ]);
    expect(pointerUps).toBe(0);
    await send("pointerup", 30, 32);

    expect(operations.map((entry) => entry.operation.kind)).toEqual([
      "undo-boundary",
      "stroke",
      "stroke",
    ]);
    expect(pointerUps).toBe(1);
    expect(operations[0].actorId).toBe("alice");
    expect(operations[0].id).not.toBe(operations[1].id);
    expect(operations[1].operation).toMatchObject({
      kind: "stroke",
      layer: "background",
    });
    act(() => painter.unmount());
  });

  it("stamps local operations with the identity the server assigned", async () => {
    // The mount-time actorId is a placeholder: a collaborative host only
    // learns which actor the canonical stream will call it once the server
    // says so. If the fork kept the placeholder, one person would hold two
    // identities -- and stroke continuation, which is keyed by actor, would
    // join an unrelated stroke to the next one.
    const operations: import("./operations").LocalPainterOperation[] = [];
    const element = document.createElement("div");
    document.body.appendChild(element);
    let painter!: ReturnType<typeof mount>;
    act(() => {
      painter = mount(element, {
        width: 100,
        height: 100,
        mode: { kind: "standard" },
        controls: { kind: "none" },
        synchronization: {
          actorId: "placeholder-uuid",
          onOperation: (operation) => operations.push(operation),
        },
      });
    });
    await act(async () => painter.ready);
    act(() => painter.setLocalActorId("7"));

    const canvas = element.querySelector("#canvas") as HTMLCanvasElement;
    const gesture = [
      ["pointerdown", 10, 12],
      ["pointermove", 30, 32],
      ["pointerup", 30, 32],
    ] as const;
    for (const [type, x, y] of gesture) {
      await act(async () => {
        canvas.dispatchEvent(new PointerEvent(type, {
          pointerId: 1, pointerType: "mouse", button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x, clientY: y, bubbles: true,
        }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((entry) => entry.actorId === "7")).toBe(true);
    expect(operations.every((entry) => entry.id.startsWith("7:"))).toBe(true);

    expect(() => painter.setLocalActorId("")).toThrow(/non-empty/);
    act(() => painter.unmount());
  });

  it("applies canonical operations and round-trips public checkpoints", async () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    let painter!: ReturnType<typeof mount>;
    act(() => {
      painter = mount(element, {
        width: 24,
        height: 16,
        mode: { kind: "standard" },
        controls: { kind: "none" },
        synchronization: { actorId: "alice", onOperation: () => {} },
      });
    });
    await act(async () => painter.ready);

    await act(async () => {
      await painter.applyCanonicalOperation({
        id: "bob:1",
        actorId: "bob",
        sequence: 1,
        operation: {
          kind: "fill",
          layer: "background",
          at: { x: 2, y: 2 },
          color: { r: 49, g: 120, b: 66, a: 255 },
          mask: { type: 0, r: 0, g: 0, b: 0 },
        },
      });
    });
    const checkpoint = await painter.exportCheckpoint(1);
    expect(checkpoint).toMatchObject({ sequence: 1, width: 24, height: 16 });
    expect(checkpoint.background.type).toBe("image/png");
    const archiveBeforeReset = await painter.exportSessionArchive();
    expect(archiveBeforeReset.operations.map((entry) => entry.id)).toEqual(["bob:1"]);
    await painter.compactCanonicalHistory(1);
    const compactedArchive = await painter.exportSessionArchive();
    expect(compactedArchive.operations).toEqual([]);
    expect(compactedArchive.checkpoint).toMatchObject({ sequence: 1, width: 24, height: 16 });
    expect(painter.isSynchronizationSettled()).toBe(true);

    await act(async () => {
      await painter.applyCanonicalOperation({
        id: "bob:2",
        actorId: "bob",
        sequence: 2,
        operation: { kind: "clear-layer", layer: "background" },
      });
      await painter.applyCheckpoint(checkpoint);
    });
    const archive = await painter.exportSessionArchive();
    expect(archive).toMatchObject({
      format: "neo-cucumber-session",
      version: 1,
      checkpoint: { sequence: 1 },
      operations: [],
    });

    const png = await painter.exportPng();
    const bitmap = await createImageBitmap(png);
    const sample = document.createElement("canvas");
    sample.width = bitmap.width;
    sample.height = bitmap.height;
    const context = sample.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    expect([...context.getImageData(2, 2, 1, 1).data]).toEqual([49, 120, 66, 255]);
    bitmap.close();
    act(() => painter.unmount());
  });
});
