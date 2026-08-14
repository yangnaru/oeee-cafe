import { useCallback, useEffect, useRef } from "react";

const cursorColor = (username: string): string => {
  let hash = 5381;
  for (const character of username) {
    hash = ((hash << 5) + hash) + character.charCodeAt(0);
  }
  return `hsl(${Math.abs(hash % 360)}, 75%, 35%)`;
};

/**
 * Remote cursors live inside neo-cucumber's transformed canvas container.
 * Their logical drawing coordinates therefore inherit zoom, pan and flip
 * without duplicating the painter's view-transform calculations here.
 */
export const useRemoteCursors = (
  painterRootRef: React.RefObject<HTMLDivElement | null>,
  localSessionIdRef: React.RefObject<number | null>,
) => {
  const cursorsRef = useRef(new Map<string, HTMLDivElement>());
  const removalTimersRef = useRef(new Map<string, number>());

  const removeCursor = useCallback((userId: string) => {
    const timer = removalTimersRef.current.get(userId);
    if (timer !== undefined) window.clearTimeout(timer);
    removalTimersRef.current.delete(userId);
    cursorsRef.current.get(userId)?.remove();
    cursorsRef.current.delete(userId);
  }, []);

  const hideCursor = useCallback((userId: string) => {
    const cursor = cursorsRef.current.get(userId);
    if (!cursor) return;
    const previousTimer = removalTimersRef.current.get(userId);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    cursor.style.opacity = "0";
    removalTimersRef.current.set(userId, window.setTimeout(() => removeCursor(userId), 300));
  }, [removeCursor]);

  const createOrUpdateCursor = useCallback((
    userId: string, x: number, y: number, username: string,
  ) => {
    if (userId === String(localSessionIdRef.current)) return;
    const container = painterRootRef.current?.querySelector<HTMLElement>(".canvas-container");
    if (!container) return;

    const previousTimer = removalTimersRef.current.get(userId);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    removalTimersRef.current.delete(userId);

    let cursor = cursorsRef.current.get(userId);
    if (!cursor) {
      const color = cursorColor(username);
      cursor = document.createElement("div");
      cursor.className = "pointer-events-none absolute z-30 transition-opacity duration-300";
      cursor.setAttribute("aria-hidden", "true");
      cursor.innerHTML =
        `<span data-cursor-label></span>` +
        `<span data-cursor-crosshair style="position:absolute;left:-8px;top:-8px;width:16px;height:16px;color:${color}">` +
        `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">` +
        `<path d="M8 1v5M8 10v5M1 8h5M10 8h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
        `<circle cx="8" cy="8" r="1.5" fill="currentColor"/></svg></span>`;
      const label = cursor.querySelector<HTMLElement>("[data-cursor-label]")!;
      label.textContent = username;
      label.style.cssText = `position:absolute;left:50%;top:-30px;transform:translateX(-50%);` +
        `white-space:nowrap;padding:1px 4px;border:1px solid ${color};border-radius:3px;` +
        `background:rgba(255,255,255,.92);color:${color};font:700 10px sans-serif;`;
      container.appendChild(cursor);
      cursorsRef.current.set(userId, cursor);
    }

    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    cursor.style.opacity = "1";
  }, [localSessionIdRef, painterRootRef]);

  const clearCursors = useCallback(() => {
    for (const timer of removalTimersRef.current.values()) window.clearTimeout(timer);
    for (const cursor of cursorsRef.current.values()) cursor.remove();
    removalTimersRef.current.clear();
    cursorsRef.current.clear();
  }, []);

  useEffect(() => clearCursors, [clearCursors]);

  return { createOrUpdateCursor, hideCursor, removeCursor, clearCursors };
};
