import React, { useCallback, useEffect, useRef, useState } from "react";
import { NEO_PANEL, NEO_TITLEBAR } from "./neoClasses";

interface NeoWindowProps {
  /** Where it opens. It is draggable afterwards, so this is a starting point. */
  initialPosition: { x: number; y: number };
  /** Extra classes for the frame, e.g. a width or a z-index. */
  className?: string;
  /** Sits in the title bar, right of the drag dots. */
  title?: React.ReactNode;
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
  children,
}: NeoWindowProps) {
  const [position, setPosition] = useState(initialPosition);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);

  /**
   * One pointer gesture rather than a mouse pair and a touch pair. Pointer
   * capture keeps the window following even when the cursor outruns it, which
   * is what a document-level mousemove listener would otherwise work around.
   */
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const offset = dragOffset.current;
    if (!offset) return;
    setPosition({
      x: Math.max(0, Math.min(e.clientX - offset.x, window.innerWidth - 24)),
      y: Math.max(0, Math.min(e.clientY - offset.y, window.innerHeight - 24)),
    });
  }, []);

  const endDrag = useCallback(() => {
    dragOffset.current = null;
  }, []);

  // Keep it reachable when the window shrinks under it
  useEffect(() => {
    const onResize = () =>
      setPosition((prev) => ({
        x: Math.max(0, Math.min(prev.x, window.innerWidth - 24)),
        y: Math.max(0, Math.min(prev.y, window.innerHeight - 24)),
      }));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div
      ref={frameRef}
      className={`${NEO_PANEL} fixed flex flex-col shadow-lg ${className}`}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      <div
        className={`${NEO_TITLEBAR} flex touch-none items-center gap-[3px] cursor-grab active:cursor-grabbing`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="ml-[3px] h-[3px] w-[3px] rounded-full bg-white/70" />
        <span className="h-[3px] w-[3px] rounded-full bg-white/70" />
        <span className="h-[3px] w-[3px] rounded-full bg-white/70" />
        {title && (
          <span className="ml-[4px] truncate text-[11px] leading-none">
            {title}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
