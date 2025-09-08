import { useCallback, useRef } from "react";
import { getUserBackgroundColor } from "../utils/userColors";

interface UseCursorParams {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  userIdRef: React.RefObject<string | null>;
}

export const useCursor = ({ canvasContainerRef, userIdRef }: UseCursorParams) => {
  // Track active drawing cursors for remote users
  const activeCursorsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  // Function to create or update cursor icon for a remote user
  const createOrUpdateCursor = useCallback(
    (userId: string, x: number, y: number, username: string) => {
      if (!canvasContainerRef.current || userId === userIdRef.current) {
        return; // Don't show cursor for local user
      }

      const container = canvasContainerRef.current;
      let cursorElement = activeCursorsRef.current.get(userId);

      if (!cursorElement) {
        // Create new cursor element container
        cursorElement = document.createElement("div");
        cursorElement.className =
          "absolute pointer-events-none z-[2000] flex flex-col items-center";
        cursorElement.style.transition = "opacity 0.3s ease-out";
        cursorElement.style.opacity = "1";

        // Create username label
        const userLabel = document.createElement("div");
        userLabel.className =
          "text-xs font-bold px-2 py-1 rounded mb-1 whitespace-nowrap";
        userLabel.textContent = username;
        const userBackgroundColor = getUserBackgroundColor(username);
        userLabel.style.color = userBackgroundColor;
        userLabel.style.backgroundColor = "rgba(255, 255, 255, 0.9)";
        userLabel.style.border = `1px solid ${userBackgroundColor}`;
        userLabel.style.fontSize = "10px";
        userLabel.setAttribute("data-username-element", "true"); // Mark this as the username element
        cursorElement.appendChild(userLabel);

        // Create icon element
        const iconElement = document.createElement("div");
        iconElement.className = "flex items-center justify-center";
        iconElement.style.width = "24px";
        iconElement.style.height = "24px";
        iconElement.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24"><path fill="${getUserBackgroundColor(
          username
        )}" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5s-1.12 2.5-2.5 2.5z"/></svg>`;
        cursorElement.appendChild(iconElement);

        container.appendChild(cursorElement);
        activeCursorsRef.current.set(userId, cursorElement);
      }

      // Position the cursor (convert canvas coordinates to screen coordinates)
      // Read transform from the first canvas element since transforms are applied to canvases
      const firstCanvas = container.querySelector('canvas');
      const canvasStyle = firstCanvas ? window.getComputedStyle(firstCanvas) : null;

      // Get zoom level and pan offset from transform
      let scale = 1;
      let panX = 0;
      let panY = 0;

      if (canvasStyle?.transform && canvasStyle.transform !== "none") {
        const matrix = new DOMMatrix(canvasStyle.transform);
        scale = matrix.a; // Get scale from transform matrix
        panX = matrix.e; // Get X translation
        panY = matrix.f; // Get Y translation
      }

      // Position cursor at the drawing coordinate, accounting for zoom and pan
      const screenX = x * scale + panX;
      const screenY = y * scale + panY;

      // Get the actual size of the cursor element to center it properly
      const cursorRect = cursorElement.getBoundingClientRect();
      const cursorWidth = cursorRect.width || 24; // Fallback to 24px if not measured yet

      // Position the cursor so the pin point of the location icon is exactly at the drawing coordinates
      // The location icon has its pin point at approximately 75% down from the top of the icon
      // Username label is ~16px height (10px font + 6px padding), icon is 24px height
      const usernameLabelHeight = 16; // More accurate measurement
      const iconHeight = 24;
      const pinPointOffset = iconHeight * 1.3; // Pin point is at ~75% down from top of icon

      const totalOffsetY = usernameLabelHeight + pinPointOffset;
      cursorElement.style.left = `${screenX - cursorWidth / 2}px`; // Center horizontally
      cursorElement.style.top = `${screenY - totalOffsetY}px`; // Position so the pin point is at the drawing coordinates
      cursorElement.style.opacity = "1";

      // Update username label if we have a different/better username
      const userLabel = cursorElement.querySelector(
        '[data-username-element="true"]'
      ) as HTMLElement;
      if (userLabel && userLabel.textContent !== username) {
        userLabel.textContent = username;
        userLabel.style.color = getUserBackgroundColor(username);
        userLabel.style.border = `1px solid ${getUserBackgroundColor(
          username
        )}`;

        // Also update the icon color
        const svgPath = cursorElement.querySelector(
          "svg path"
        ) as SVGPathElement;
        if (svgPath) {
          svgPath.setAttribute("fill", getUserBackgroundColor(username));
        }
      }

      // Clear any existing fadeout timeouts
      const fadeoutDelayId = cursorElement.dataset.fadeoutDelayId;
      const removeTimeoutId = cursorElement.dataset.removeTimeoutId;
      const oldTimeoutId = cursorElement.dataset.timeoutId; // Legacy timeout
      
      if (fadeoutDelayId) {
        clearTimeout(parseInt(fadeoutDelayId));
        delete cursorElement.dataset.fadeoutDelayId;
      }
      if (removeTimeoutId) {
        clearTimeout(parseInt(removeTimeoutId));
        delete cursorElement.dataset.removeTimeoutId;
      }
      if (oldTimeoutId) {
        clearTimeout(parseInt(oldTimeoutId));
        delete cursorElement.dataset.timeoutId;
      }
    },
    [canvasContainerRef, userIdRef]
  );

  // Function to hide cursor with fadeout effect
  const hideCursor = useCallback((userId: string) => {
    const cursorElement = activeCursorsRef.current.get(userId);
    if (cursorElement && cursorElement.style.opacity !== "0") {
      // Clear any existing fadeout timeouts
      const existingFadeoutDelayId = cursorElement.dataset.fadeoutDelayId;
      const existingRemoveTimeoutId = cursorElement.dataset.removeTimeoutId;
      const existingLegacyTimeoutId = cursorElement.dataset.timeoutId;
      
      if (existingFadeoutDelayId) {
        clearTimeout(parseInt(existingFadeoutDelayId));
        delete cursorElement.dataset.fadeoutDelayId;
      }
      if (existingRemoveTimeoutId) {
        clearTimeout(parseInt(existingRemoveTimeoutId));
        delete cursorElement.dataset.removeTimeoutId;
      }
      if (existingLegacyTimeoutId) {
        clearTimeout(parseInt(existingLegacyTimeoutId));
        delete cursorElement.dataset.timeoutId;
      }

      // Add delay before starting fadeout
      const fadeoutDelayId = setTimeout(() => {
        cursorElement.style.opacity = "0";

        // Remove element after fadeout completes
        const removeTimeoutId = setTimeout(() => {
          if (cursorElement.parentNode) {
            cursorElement.parentNode.removeChild(cursorElement);
          }
          activeCursorsRef.current.delete(userId);
        }, 300); // Match CSS transition duration

        cursorElement.dataset.removeTimeoutId = removeTimeoutId.toString();
      }, 1000); // 1 second delay before fadeout starts

      cursorElement.dataset.fadeoutDelayId = fadeoutDelayId.toString();
    }
  }, []);

  return {
    createOrUpdateCursor,
    hideCursor,
    activeCursorsRef,
  };
};