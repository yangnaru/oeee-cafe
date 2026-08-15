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
 * Hold a coordinate between the two limits on its axis, whichever way round
 * they are.
 *
 * They invert when a window is bigger than the space it is in: the far limit
 * (viewport minus window) falls below the near one, and the only way to see the
 * window's bottom is to push its top off the screen. Ordering the pair rather
 * than assuming one is the minimum is what makes that possible instead of
 * pinning the window at the top with its tail out of reach.
 */
function within(value: number, a: number, b: number): number {
  return Math.min(Math.max(value, Math.min(a, b)), Math.max(a, b));
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
      x: within(event.clientX - offset.x, 0, bounds.width - rect.width),
      y: within(
        event.clientY - offset.y,
        options.minimumY ?? 0,
        bounds.height - rect.height,
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

export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowResizeOptions {
  /** Called with the frame's new size while its corner is dragged. */
  onSize(size: WindowSize): void;
  /** How small the window may be made. */
  minimum?: WindowSize;
}

/**
 * Make `handle` resize `frame` from its bottom-right corner, and return the
 * function that undoes it.
 *
 * A window is resized by an element of ours rather than by CSS `resize`, which
 * draws no grabber at all on a touch browser -- on Chrome for Android a window
 * using it simply looks unresizable. The gesture is here beside the drag for
 * the same reason the drag is here: two windows, one implementation.
 *
 * Sizes are reported rather than applied, and the anchor is the corner the
 * window is pinned by, so a resize never moves it.
 */
export function attachWindowResize(
  frame: HTMLElement,
  handle: HTMLElement,
  options: WindowResizeOptions,
): () => void {
  let origin: { left: number; top: number } | null = null;

  const onPointerDown = (event: PointerEvent) => {
    const rect = frame.getBoundingClientRect();
    origin = { left: rect.left, top: rect.top };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!origin) return;
    const bounds = viewportBounds();
    options.onSize({
      width: Math.max(
        options.minimum?.width ?? 0,
        Math.min(event.clientX - origin.left, bounds.width - origin.left),
      ),
      height: Math.max(
        options.minimum?.height ?? 0,
        Math.min(event.clientY - origin.top, bounds.height - origin.top),
      ),
    });
  };

  const endResize = () => {
    origin = null;
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", endResize);
  handle.addEventListener("pointercancel", endResize);

  return () => {
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", endResize);
    handle.removeEventListener("pointercancel", endResize);
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
    x: within(position.x, 0, bounds.width - rect.width),
    y: within(position.y, minimumY, bounds.height - rect.height),
  };
}
