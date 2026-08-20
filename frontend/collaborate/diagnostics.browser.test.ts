import { afterEach, describe, expect, it, vi } from "vitest";
import type { PainterHandle } from "neo-cucumber";
import { reportDiagnostics } from "./diagnostics";

/**
 * A report is filed from paths that are already going wrong, so the one thing
 * it must never do is make them worse.
 */

const SESSION = "c9b8321d-9ae7-4872-959f-4ec6b3881197";

const context = {
  reason: "checkpoint-not-applied",
  localId: 3,
  appliedSequence: 0,
  expectedSequence: 1,
  lastSeq: 3506,
  catchingUp: true,
  settled: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function painterWith(trace: unknown[]): PainterHandle {
  return { synchronizationTrace: () => trace } as unknown as PainterHandle;
}

describe("filing a synchronization report", () => {
  it("sends the position this client believed it was at", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        return new Response(null, { status: 204 });
      }),
    );

    reportDiagnostics(SESSION, painterWith([{ at: 1, source: "canonical", op: "stroke" }]), context);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0].url).toBe(`/collaborate/${SESSION}/diagnostics`);
    expect(sent[0].init.method).toBe("POST");
    // The most valuable report is from a tab that is closing, and a plain
    // fetch is cancelled when it does.
    expect(sent[0].init.keepalive).toBe(true);

    const body = JSON.parse(sent[0].init.body as string);
    expect(body.reason).toBe("checkpoint-not-applied");
    expect(body.appliedSequence).toBe(0);
    expect(body.lastSeq).toBe(3506);
    expect(body.trace).toHaveLength(1);
  });

  /** A painter mid-unmount has no trace to give; the positions are still
   * worth having, and they are the part nothing else can see. */
  it("still reports when the trace cannot be read", async () => {
    const sent: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(init);
        return new Response(null, { status: 204 });
      }),
    );
    const broken = {
      synchronizationTrace: () => {
        throw new Error("unmounted");
      },
    } as unknown as PainterHandle;

    expect(() => reportDiagnostics(SESSION, broken, context)).not.toThrow();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const body = JSON.parse(sent[0].body as string);
    expect(body.trace).toEqual([]);
    expect(body.appliedSequence).toBe(0);
  });

  /** A rejected request must not surface as an unhandled rejection on a page
   * that is already showing the user an error. */
  it("swallows a refused request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(() => reportDiagnostics(SESSION, painterWith([]), context)).not.toThrow();
    // Give the rejection a turn to become unhandled, if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
