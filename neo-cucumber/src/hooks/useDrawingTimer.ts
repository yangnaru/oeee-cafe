import { useCallback, useEffect, useRef, useState } from "react";

// Alarm durations offered in the two-tone toolbox, in minutes. 0 means off.
export const TIMER_DURATIONS_MINUTES = [0, 10, 15, 30, 45, 60];

interface UseDrawingTimerOptions {
  onExpire: () => void;
}

/**
 * Countdown alarm for drawing sessions, mirroring Tegaki's タイマー menu.
 *
 * Purely a UI affordance: it never touches the canvas or the action recorder,
 * so it has no bearing on what gets recorded into the replay.
 */
export const useDrawingTimer = ({ onExpire }: UseDrawingTimerOptions) => {
  const [durationMinutes, setDurationMinutes] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState(0);

  // Keep the latest callback without restarting the interval on every render
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  const startTimer = useCallback((minutes: number) => {
    setDurationMinutes(minutes);
    setRemainingSeconds(minutes * 60);
  }, []);

  const stopTimer = useCallback(() => {
    setDurationMinutes(0);
    setRemainingSeconds(0);
  }, []);

  useEffect(() => {
    if (durationMinutes === 0) return;

    const interval = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          setDurationMinutes(0);
          onExpireRef.current();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [durationMinutes]);

  return {
    durationMinutes,
    remainingSeconds,
    isRunning: durationMinutes > 0,
    startTimer,
    stopTimer,
  };
};
