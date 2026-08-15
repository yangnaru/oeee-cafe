/**
 * Dragging a floating window.
 *
 * NEO docks its toolbox to the canvas and never moves it, so every window
 * this codebase floats is ours rather than a reproduction -- and the host's
 * panels float beside the painter's own. The gesture lives here, in one
 * framework-neutral function, because the last time two things in this
 * repository each had their own drag handling only one of them ever got
 * fixed.
 *
 * It reports positions rather than applying them: a React window keeps its
 * position in state, a host panel may write it straight to `style`, and the
 * one thing neither of them should have to reimplement is the arithmetic.
 */

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowDragOptions {
  /** Called with the frame's new viewport position during a drag. */
  onPosition(position: WindowPosition): void;
  /** Keeps a window below persistent application chrome. */
  minimumY?: number;
}

/**
 * The area a window has to stay reachable inside.
 *
 * `window.innerHeight` counts the strip underneath mobile Safari's URL bar, so
 * clamping a window against it can park the thing just below the fold with no
 * way left to grab it. `visualViewport` reports what is actually on screen.
 */
function viewportBounds(): { width: number; height: number } {
  const visual = window.visualViewport;
  return {
    width: visual?.width ?? window.innerWidth,
    height: visual?.height ?? window.innerHeight,
  };
}

/**
 * Make `handle` drag `frame`, and return the function that undoes it.
 *
 * One pointer gesture rather than a mouse pair and a touch pair. Pointer
 * capture keeps the window following even when the cursor outruns it, which
 * is what a document-level listener would otherwise work around. Positions
 * are clamped so a window cannot be dragged out of reach.
 */
export function attachWindowDrag(
  frame: HTMLElement,
  handle: HTMLElement,
  options: WindowDragOptions,
): () => void {
  let offset: WindowPosition | null = null;

  const onPointerDown = (event: PointerEvent) => {
    const rect = frame.getBoundingClientRect();
    offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!offset) return;
    const rect = frame.getBoundingClientRect();
    const bounds = viewportBounds();
    options.onPosition({
      x: Math.max(0, Math.min(event.clientX - offset.x, bounds.width - rect.width)),
      y: Math.max(
        options.minimumY ?? 0,
        Math.min(event.clientY - offset.y, bounds.height - rect.height),
      ),
    });
  };

  const endDrag = () => {
    offset = null;
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  return () => {
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", endDrag);
    handle.removeEventListener("pointercancel", endDrag);
  };
}

/**
 * Keep a window reachable when the viewport shrinks under it. Returns the
 * position it should sit at, which is the one it already has when it is
 * reachable where it stands.
 */
export function clampWindowPosition(
  position: WindowPosition,
  frame: HTMLElement,
  minimumY = 0,
): WindowPosition {
  const rect = frame.getBoundingClientRect();
  const bounds = viewportBounds();
  return {
    x: Math.max(0, Math.min(position.x, bounds.width - rect.width)),
    y: Math.max(minimumY, Math.min(position.y, bounds.height - rect.height)),
  };
}
