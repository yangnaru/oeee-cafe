import { afterEach, describe, expect, it, vi } from "vitest";
import { claimPreview, encodePreview, refreshSessionPreview } from "./preview";

/**
 * The lobby's picture of a live canvas, from the side that can actually draw
 * one.
 *
 * Real Chromium rather than a stub: what this code produces is an encoded
 * image, and whether it is the size and format the server will accept is a
 * question only a real encoder can answer. The server checks both and rejects
 * an upload that gets either wrong -- see
 * src/web/handlers/collaborate/preview.rs.
 */

const SESSION = "00000000-0000-0000-0000-000000000009";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A drawing to scale down: noisy enough that the encoder cannot trivially
 * flatten it, so a size assertion means something. */
async function sourceCanvas(width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  for (let index = 0; index < 400; index++) {
    context.fillStyle = `hsl(${(index * 37) % 360} 90% 50%)`;
    context.fillRect((index * 53) % width, (index * 31) % height, 24, 18);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("no blob"))),
      "image/png",
    ),
  );
}

async function sizeOf(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

describe("encoding a preview", () => {
  /**
   * The size the server asked for, exactly. It rejects anything else, because
   * an expected size is the only thing that separates a preview from an image
   * chosen to be expensive to decode.
   */
  it("produces an image at the size the claim asked for", async () => {
    const preview = await encodePreview(
      await sourceCanvas(1024, 768),
      400,
      300,
      256 * 1024,
    );
    expect(preview).not.toBeNull();
    expect(await sizeOf(preview!)).toEqual({ width: 400, height: 300 });
  });

  /** Both formats the server accepts; which one a browser gives back is its
   * choice, not ours, so the type has to be read off the blob. */
  it("labels the blob with the format the browser actually encoded", async () => {
    const preview = await encodePreview(
      await sourceCanvas(300, 300),
      300,
      300,
      256 * 1024,
    );
    expect(preview).not.toBeNull();
    expect(["image/webp", "image/png"]).toContain(preview!.type);
  });

  /**
   * A budget nothing can fit in ends the attempt rather than uploading
   * something the server will refuse.
   */
  it("gives up rather than returning an oversized preview", async () => {
    expect(
      await encodePreview(await sourceCanvas(1024, 768), 400, 300, 64),
    ).toBeNull();
  });

  /** A canvas this small encodes well under any sane budget, which is what
   * makes the previous test about the budget and not about the encoder. */
  it("stays well inside the budget the server allows", async () => {
    const preview = await encodePreview(
      await sourceCanvas(1024, 768),
      400,
      300,
      256 * 1024,
    );
    expect(preview!.size).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("claiming a window", () => {
  it("reads the token and target size the server hands back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            token: "a-token",
            width: 400,
            height: 300,
            max_bytes: 262144,
          }),
          { status: 200 },
        ),
      ),
    );
    expect(await claimPreview(SESSION)).toEqual({
      token: "a-token",
      width: 400,
      height: 300,
      maxBytes: 262144,
    });
  });

  /**
   * A refused claim is the ordinary answer -- somebody else is refreshing this
   * room, or the last refresh is still recent -- and has to read as "not now"
   * rather than as a failure.
   */
  it("treats a refused claim as nothing to do", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 409 })),
    );
    expect(await claimPreview(SESSION)).toBeNull();
  });

  /** A response that is not the shape agreed on is not a claim, whatever its
   * status: acting on it would upload against a token that does not exist. */
  it("rejects a response missing the fields it needs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ token: "a-token" }), { status: 200 }),
      ),
    );
    expect(await claimPreview(SESSION)).toBeNull();
  });
});

describe("refreshing a session preview", () => {
  it("uploads the encoded canvas against the token it claimed", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        if (url.endsWith("/claim")) {
          return new Response(
            JSON.stringify({
              token: "a-token",
              width: 400,
              height: 300,
              max_bytes: 262144,
            }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 204 });
      }),
    );

    const uploaded = await refreshSessionPreview(SESSION, () =>
      sourceCanvas(1024, 768),
    );

    expect(uploaded).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toBe(`/collaborate/${SESSION}/preview`);
    expect(requests[1].init.method).toBe("PUT");
    const headers = requests[1].init.headers as Record<string, string>;
    expect(headers["X-Preview-Token"]).toBe("a-token");
    // The declared type has to be what was encoded; the server rejects an
    // upload whose header and bytes disagree.
    const body = requests[1].init.body as Blob;
    expect(headers["Content-Type"]).toBe(body.type);
    expect(await sizeOf(body)).toEqual({ width: 400, height: 300 });
  });

  /**
   * Losing the claim must cost nothing but the claim itself. Rendering and
   * encoding is the expensive half, and every client in a room that is not
   * uploading would otherwise pay it on every tick.
   */
  it("does not render the canvas when the window is somebody else's", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 409 })),
    );
    const render = vi.fn(() => sourceCanvas(300, 300));

    expect(await refreshSessionPreview(SESSION, render)).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });

  /**
   * The window can close while the canvas is being encoded, and the server
   * says so by refusing the upload. It is not this client's preview any more.
   */
  it("reports an upload the server refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/claim")
          ? new Response(
              JSON.stringify({
                token: "a-token",
                width: 300,
                height: 300,
                max_bytes: 262144,
              }),
              { status: 200 },
            )
          : new Response("", { status: 409 }),
      ),
    );
    expect(await refreshSessionPreview(SESSION, () => sourceCanvas(300, 300))).toBe(
      false,
    );
  });
});
