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
        // Create container for both elements
        cursorElement = document.createElement("div");
        cursorElement.className = "absolute pointer-events-none z-[2000]";
        cursorElement.style.transition = "opacity 0.3s ease-out";
        cursorElement.style.opacity = "1";

        // Create username label (positioned separately)
        const userLabel = document.createElement("div");
        userLabel.className = "absolute text-xs font-bold px-2 py-1 rounded whitespace-nowrap";
        userLabel.textContent = username;
        const userBackgroundColor = getUserBackgroundColor(username);
        userLabel.style.color = userBackgroundColor;
        userLabel.style.backgroundColor = "rgba(255, 255, 255, 0.9)";
        userLabel.style.border = `1px solid ${userBackgroundColor}`;
        userLabel.style.fontSize = "10px";
        userLabel.setAttribute("data-username-element", "true");
        cursorElement.appendChild(userLabel);

        // Create crosshair element (positioned separately)
        const crosshairElement = document.createElement("div");
        crosshairElement.className = "absolute flex items-center justify-center";
        crosshairElement.style.width = "16px";
        crosshairElement.style.height = "16px";
        crosshairElement.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16"><g fill="${getUserBackgroundColor(
          username
        )}"><path d="M8 1v5M8 10v5M1 8h5M10 8h5" stroke="${getUserBackgroundColor(
          username
        )}" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="8" r="1.5" fill="${getUserBackgroundColor(
          username
        )}"/></g></svg>`;
        crosshairElement.setAttribute("data-crosshair-element", "true");
        cursorElement.appendChild(crosshairElement);

        container.appendChild(cursorElement);
        activeCursorsRef.current.set(userId, cursorElement);
      }

      // Position the cursor (convert canvas coordinates to screen coordinates)
      // Read transform from the container since that's where transforms are applied
      const containerStyle = window.getComputedStyle(container);

      // Get zoom level and pan offset from transform
      let scale = 1;
      let panX = 0;
      let panY = 0;

      if (containerStyle.transform && containerStyle.transform !== "none") {
        const matrix = new DOMMatrix(containerStyle.transform);
        scale = matrix.a; // Get scale from transform matrix
        panX = matrix.e; // Get X translation
        panY = matrix.f; // Get Y translation
      }

      // Position cursor at the drawing coordinate, accounting for zoom and pan
      const screenX = x * scale + panX;
      const screenY = y * scale + panY;

      // Position the container at the screen coordinates
      cursorElement.style.left = `${screenX}px`;
      cursorElement.style.top = `${screenY}px`;

      // Position crosshair centered at (0, 0) relative to container
      const crosshairElement = cursorElement.querySelector('[data-crosshair-element="true"]') as HTMLElement;
      if (crosshairElement) {
        crosshairElement.style.left = "-8px"; // Center 16px crosshair (-16/2)
        crosshairElement.style.top = "-8px";  // Center 16px crosshair (-16/2)
      }

      // Position username above crosshair
      const userLabel = cursorElement.querySelector('[data-username-element="true"]') as HTMLElement;
      if (userLabel) {
        // Center username horizontally and place above crosshair
        userLabel.style.left = "50%";
        userLabel.style.top = "-40px"; // Float higher above the crosshair
        userLabel.style.transform = "translateX(-50%)"; // Center horizontally
      }
      cursorElement.style.opacity = "1";

      // Update username and colors if needed
      if (userLabel && userLabel.textContent !== username) {
        userLabel.textContent = username;
        const newColor = getUserBackgroundColor(username);
        userLabel.style.color = newColor;
        userLabel.style.border = `1px solid ${newColor}`;

        // Also update the crosshair color
        const svgPath = cursorElement.querySelector("svg path") as SVGPathElement;
        const svgCircle = cursorElement.querySelector("svg circle") as SVGCircleElement;
        if (svgPath) {
          svgPath.setAttribute("stroke", newColor);
        }
        if (svgCircle) {
          svgCircle.setAttribute("fill", newColor);
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