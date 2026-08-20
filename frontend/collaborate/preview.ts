/**
 * Uploading what the shared canvas looks like, for the lobby to show.
 *
 * The server cannot draw -- room state is a log of drawing operations, and the
 * only thing that turns those into pixels is the painter running here. So the
 * lobby's picture of a live session comes from a participant's browser, which
 * has the canvas composited already.
 *
 * Every client in the room could do this and only one needs to, so the server
 * hands out a window: whoever asks first inside one gets a token, everybody
 * else is told no and does nothing. Asking is a small request; rendering and
 * encoding is not, which is the whole reason the two are separate steps.
 *
 * See src/web/handlers/collaborate/preview.rs for the other half.
 */

/** What the server will accept for the window it just opened. */
export type PreviewClaim = {
  token: string;
  /**
   * The size to scale to. It comes from the server rather than being computed
   * here, so there is one formula rather than two that have to agree: an
   * upload of the wrong size is rejected, and a browser that worked it out
   * differently would simply stop being able to upload.
   */
  width: number;
  height: number;
  maxBytes: number;
};

/**
 * Quality steps for the encoder, tried in order until one fits.
 *
 * A preview that is too large is not stored, so giving up at the first
 * oversized encode would mean no picture at all for a canvas that happens to
 * compress badly -- exactly the busy, interesting ones.
 */
const PREVIEW_QUALITY_STEPS = [0.8, 0.6, 0.4];

const canvasToBlob = (
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Asks to be the one who uploads this room's next preview.
 *
 * Null means somebody else is doing it or the last one is still recent, which
 * is the answer to "should I render", not an error worth reporting.
 */
export async function claimPreview(
  sessionId: string,
): Promise<PreviewClaim | null> {
  const response = await fetch(`/collaborate/${sessionId}/preview/claim`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) return null;
  const claim: unknown = await response.json();
  if (typeof claim !== "object" || claim === null) return null;
  const { token, width, height, max_bytes: maxBytes } = claim as Record<
    string,
    unknown
  >;
  if (
    typeof token !== "string" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof maxBytes !== "number"
  ) {
    return null;
  }
  return { token, width, height, maxBytes };
}

/**
 * Scales a full-size canvas export down to a preview and encodes it.
 *
 * WEBP is what is asked for. A browser whose encoder does not know it returns
 * a PNG from the same call without saying so, which the server also accepts --
 * so the type of what comes back is read off the blob rather than assumed.
 * Null when nothing small enough could be produced.
 */
export async function encodePreview(
  source: Blob,
  width: number,
  height: number,
  maxBytes: number,
): Promise<Blob | null> {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    // Opaque white underneath, matching the export this came from, so a lossy
    // encode cannot invent colour in pixels nobody drew and the preview shows
    // the same background the painter does.
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);

    for (const quality of PREVIEW_QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, "image/webp", quality);
      if (!blob) return null;
      if (blob.size <= maxBytes) return blob;
      // PNG ignored the quality we asked for, so asking again more cheaply
      // would produce the same bytes.
      if (blob.type !== "image/webp") return null;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

/**
 * One attempt at refreshing this room's preview: claim, render, upload.
 *
 * `renderCanvas` is only called after a window has been won, which is what
 * keeps the cost of losing down to one small request.
 *
 * Returns whether a preview was actually stored. False covers every ordinary
 * way this ends -- somebody else has the window, the canvas would not encode
 * small enough, the window expired while rendering -- none of which is worth
 * interrupting anyone's drawing over.
 */
export async function refreshSessionPreview(
  sessionId: string,
  renderCanvas: () => Promise<Blob>,
): Promise<boolean> {
  const claim = await claimPreview(sessionId);
  if (!claim) return false;

  const preview = await encodePreview(
    await renderCanvas(),
    claim.width,
    claim.height,
    claim.maxBytes,
  );
  if (!preview) return false;

  const response = await fetch(`/collaborate/${sessionId}/preview`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": preview.type,
      "X-Preview-Token": claim.token,
    },
    body: preview,
  });
  return response.ok;
}
