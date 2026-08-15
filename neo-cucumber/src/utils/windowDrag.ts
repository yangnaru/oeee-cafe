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
  /**
   * When the window may be dragged by its background as well as by its handle.
   *
   * `"coarse-pointer"`, the default, is the case this exists for. `"never"` is
   * for a frame that scrolls: there is only one one-finger gesture, and a panel
   * tall enough to need scrolling has already spent it -- such a window is
   * dragged by its handle, which is why the handle grows on these pointers.
   * `"always"` ignores the pointer type, which is how the behaviour is tested
   * in a browser that reports a mouse.
   */
  dragFromBody?: "coarse-pointer" | "always" | "never";
}

/**
 * Marks a region a drag must never start from.
 *
 * On a touch screen the whole panel is a handle (see below), which is wrong
 * for anything that scrolls, holds selectable text, or runs a gesture of its
 * own without being a control the selector below already recognises. Put this
 * attribute on such a region and pointers landing in it are left alone.
 */
export const WINDOW_DRAG_IGNORE_ATTRIBUTE = "data-no-window-drag";

/**
 * What counts as a control rather than as panel background.
 *
 * `[role="slider"]` is not decoration: NEO's colour channels and its size bar
 * are divs carrying their own pointer capture, and that role is how they are
 * already described to a screen reader. Matching on it means those widgets
 * need no marking of their own to keep working.
 */
const CONTROL_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "a[href]",
  '[role="button"]',
  '[role="slider"]',
  "[contenteditable]",
  `[${WINDOW_DRAG_IGNORE_ATTRIBUTE}]`,
].join(",");

/**
 * How far a touch has to travel off the panel's background before it is a
 * drag and not a mis-tap between two buttons.
 */
const BODY_DRAG_SLOP = 4;

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
 *
 * On a coarse pointer the frame's own background drags it too, controls and
 * ignored regions excepted. A title bar wide enough to hit with a fingertip
 * would be taller than some of the widgets underneath it, and the panels this
 * moves are 52px wide -- so on a touch screen the panel is the handle, and the
 * bar above it is the affordance saying so. It stays handle-only on a mouse,
 * where the bar is an easy target and a drag across a panel is how you select
 * the text on it.
 */
export function attachWindowDrag(
  frame: HTMLElement,
  handle: HTMLElement,
  options: WindowDragOptions,
): () => void {
  let offset: WindowPosition | null = null;
  let origin: WindowPosition | null = null;
  /** False while a body drag is still inside the slop radius. */
  let moving = false;

  const begin = (
    event: PointerEvent,
    capture: HTMLElement,
    immediate: boolean,
  ) => {
    const rect = frame.getBoundingClientRect();
    offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    origin = { x: event.clientX, y: event.clientY };
    moving = immediate;
    capture.setPointerCapture(event.pointerId);
    if (immediate) event.preventDefault();
  };

  const onHandlePointerDown = (event: PointerEvent) => {
    begin(event, handle, true);
  };

  const onFramePointerDown = (event: PointerEvent) => {
    // The handle is inside the frame, so its own press bubbles through here
    // having already started a drag.
    if (offset) return;
    const policy = options.dragFromBody ?? "coarse-pointer";
    if (policy === "never") return;
    if (
      policy === "coarse-pointer" &&
      !window.matchMedia("(pointer: coarse)").matches
    ) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(CONTROL_SELECTOR)) return;
    begin(event, frame, false);
  };

  // Both cases are served from the frame: a captured pointer is dispatched to
  // whichever element took the capture and still bubbles up to this one.
  const onPointerMove = (event: PointerEvent) => {
    if (!offset || !origin) return;
    if (!moving) {
      if (
        Math.abs(event.clientX - origin.x) < BODY_DRAG_SLOP &&
        Math.abs(event.clientY - origin.y) < BODY_DRAG_SLOP
      ) {
        return;
      }
      moving = true;
    }
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
    origin = null;
    moving = false;
  };

  handle.addEventListener("pointerdown", onHandlePointerDown);
  frame.addEventListener("pointerdown", onFramePointerDown);
  frame.addEventListener("pointermove", onPointerMove);
  frame.addEventListener("pointerup", endDrag);
  frame.addEventListener("pointercancel", endDrag);

  return () => {
    handle.removeEventListener("pointerdown", onHandlePointerDown);
    frame.removeEventListener("pointerdown", onFramePointerDown);
    frame.removeEventListener("pointermove", onPointerMove);
    frame.removeEventListener("pointerup", endDrag);
    frame.removeEventListener("pointercancel", endDrag);
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
