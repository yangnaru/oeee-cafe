import { useCallback, useEffect, useRef } from "react";

const HOLD_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 100;

/**
 * A normal press invokes the action once. Holding a primary pointer invokes
 * it after a short delay and then repeatedly until release or cancellation.
 */
export function usePressRepeat(action: () => void) {
  const actionRef = useRef(action);
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const repeatedRef = useRef(false);
  actionRef.current = action;

  const stop = useCallback(() => {
    if (delayRef.current !== null) clearTimeout(delayRef.current);
    if (intervalRef.current !== null) clearInterval(intervalRef.current);
    delayRef.current = null;
    intervalRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      stop();
      repeatedRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      delayRef.current = setTimeout(() => {
        repeatedRef.current = true;
        actionRef.current();
        intervalRef.current = setInterval(
          () => actionRef.current(),
          REPEAT_INTERVAL_MS
        );
      }, HOLD_DELAY_MS);
    },
    [stop]
  );

  const onClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (repeatedRef.current) {
      // The pointer's synthetic click follows pointerup. The hold has already
      // zoomed, so consuming it avoids one extra step on release.
      event.preventDefault();
      repeatedRef.current = false;
      return;
    }
    actionRef.current();
  }, []);

  return {
    onClick,
    onPointerDown,
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
  };
}
