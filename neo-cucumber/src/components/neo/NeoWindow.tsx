import React, { useEffect, useRef, useState } from "react";
import {
  NEO_PANEL,
  NEO_RESIZE_GRIP,
  NEO_RESIZE_HANDLE,
  NEO_TITLEBAR_DOT,
  NEO_TITLEBAR_HANDLE,
} from "./neoClasses";
import {
  attachWindowDrag,
  attachWindowResize,
  clampWindowPosition,
  windowBounds,
} from "../../utils/windowDrag";

interface NeoWindowProps {
  /** Where it opens. It is draggable afterwards, so this is a starting point. */
  initialPosition: { x: number; y: number };
  /** Extra classes for the frame, e.g. a width or a z-index. */
  className?: string;
  /** Sits in the title bar, right of the drag dots. */
  title?: React.ReactNode;
  /** Enables a visible bottom-right resize handle for larger panels. */
  resizable?: boolean;
  /** Explicit opening size for resizable windows. */
  initialSize?: { width: number; height: number };
  /** Keeps tall floating controls reachable in a small viewport. */
  constrainToViewport?: boolean;
  /** Keeps a window below the chrome a host draws above the painter. */
  minimumY?: number;
  children: React.ReactNode;
}

/**
 * A draggable window in NEO's chrome.
 *
 * NEO docks its toolbox to the canvas and never moves it, so this frame is
 * ours rather than a reproduction -- our painter has to sit inside a page it
 * does not own, and everything that would be docked in NEO has to float here.
 * It is one component because the toolbox and the chat had grown two copies of
 * the same drag handling, and only one of them had been fixed.
 */
export function NeoWindow({
  initialPosition,
  className = "",
  title,
  resizable = false,
  initialSize,
  constrainToViewport = false,
  minimumY = 0,
  children,
}: NeoWindowProps) {
  const initialWidth = initialSize?.width;
  const initialHeight = initialSize?.height;
  const [position, setPosition] = useState(initialPosition);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    initialWidth !== undefined && initialHeight !== undefined
      ? { width: initialWidth, height: initialHeight }
      : null
  );
  const frameRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);

  // Both gestures are the package's, so the host's panels move and size
  // exactly the way the painter's own windows do.
  useEffect(() => {
    const frame = frameRef.current;
    const handle = handleRef.current;
    if (!frame || !handle) return;
    return attachWindowDrag(frame, handle, { minimumY, onPosition: setPosition });
  }, [minimumY]);

  useEffect(() => {
    const frame = frameRef.current;
    const corner = resizeRef.current;
    if (!frame || !corner) return;
    return attachWindowResize(frame, corner, {
      minimum: { width: 180, height: 140 },
      onSize: setSize,
    });
  }, [resizable]);

  /**
   * A window that fits on screen never hangs off the bottom of it.
   *
   * Opening positions are chosen before the window exists, so they are chosen
   * without its height -- a panel opened level with the drawing may run past
   * the fold. Measuring once at mount is not enough either: NEO's tips paint
   * their artwork into canvases after the frame is laid out, and the column
   * grew by fourteen pixels afterwards, which was exactly how far off the
   * screen it ended up. So the height is watched rather than sampled.
   *
   * This never fights a drag, because dragging is already clamped inside the
   * window -- the only thing it corrects is growth. A window too tall to fit at
   * all is left alone: being able to push that one past an edge is the whole
   * point of it.
   */
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const settle = () => {
      const rect = frame.getBoundingClientRect();
      const bounds = windowBounds();
      if (rect.height > bounds.height - minimumY) return;
      setPosition((prev) =>
        prev.y + rect.height <= bounds.height
          ? prev
          : { ...prev, y: Math.max(minimumY, bounds.height - rect.height) },
      );
    };
    settle();
    const observer = new ResizeObserver(settle);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [minimumY]);

  // A changed opening position is an explicit re-anchor.
  useEffect(() => {
    setPosition({ x: initialPosition.x, y: initialPosition.y });
  }, [initialPosition.x, initialPosition.y]);

  useEffect(() => {
    if (initialWidth !== undefined && initialHeight !== undefined) {
      setSize({ width: initialWidth, height: initialHeight });
    }
  }, [initialWidth, initialHeight]);

  // Keep the whole frame reachable when the viewport shrinks under it. The
  // visual viewport is watched as well as the window because the two do not
  // always change together: a mobile browser sliding its URL bar back in, or
  // an on-screen keyboard opening, shrinks what is on screen without
  // necessarily resizing the window around it.
  useEffect(() => {
    const onResize = () => {
      const frame = frameRef.current;
      if (!frame) return;
      setPosition((prev) => clampWindowPosition(prev, frame, minimumY));
    };
    const visual = window.visualViewport;
    window.addEventListener("resize", onResize);
    visual?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      visual?.removeEventListener("resize", onResize);
    };
  }, [minimumY]);

  return (
    <div
      ref={frameRef}
      className={`${NEO_PANEL} fixed flex flex-col shadow-lg ${
        resizable ? "min-h-[140px] min-w-[180px] overflow-hidden" : ""
      } ${constrainToViewport ? "overflow-y-auto" : ""} ${
        className
      }`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        ...(size && { width: `${size.width}px`, height: `${size.height}px` }),
        ...(constrainToViewport && {
          // `dvh` rather than `vh`: `vh` on mobile Safari counts the strip
          // behind the URL bar, which is exactly the height that is not there.
          maxHeight: `calc(100dvh - ${position.y + 12}px)`,
        }),
      }}
    >
      <div ref={handleRef} className={NEO_TITLEBAR_HANDLE}>
        <span className={NEO_TITLEBAR_DOT} />
        <span className={NEO_TITLEBAR_DOT} />
        <span className={NEO_TITLEBAR_DOT} />
        {title && (
          <span className="ml-[4px] truncate text-[11px] leading-none">
            {title}
          </span>
        )}
      </div>
      {children}
      {resizable && (
        <div ref={resizeRef} aria-hidden="true" className={NEO_RESIZE_HANDLE}>
          <span className={NEO_RESIZE_GRIP} />
        </div>
      )}
    </div>
  );
}
