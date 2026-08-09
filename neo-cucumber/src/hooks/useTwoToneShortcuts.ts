import { useEffect } from "react";
import {
  TWO_TONE_BACKGROUND_PEN_INDEX,
  TWO_TONE_FOREGROUND_PEN_INDEX,
} from "../constants/drawing";

interface UseTwoToneShortcutsOptions {
  enabled: boolean;
  onSelectPen: (index: number) => void;
  onSwapPen: () => void;
  onAdjustPenSize: (delta: number) => void;
}

// Don't steal keystrokes aimed at a form control (the timer select, buttons)
const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName);
};

/**
 * Tegaki's pen shortcuts for two-tone mode. Undo/redo are bound separately,
 * since those apply to offline drawing generally.
 *
 * Every shortcut drives existing drawing state, so strokes are recorded exactly
 * as if the equivalent toolbox control had been clicked. Nothing here reaches
 * the action recorder, which keeps replays reproducible and format-compatible.
 */
export const useTwoToneShortcuts = ({
  enabled,
  onSelectPen,
  onSwapPen,
  onAdjustPenSize,
}: UseTwoToneShortcutsOptions) => {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case "x":
        case ":":
          e.preventDefault();
          onSwapPen();
          break;
        case "p":
        case "b":
          e.preventDefault();
          onSelectPen(TWO_TONE_FOREGROUND_PEN_INDEX);
          break;
        case "e":
          e.preventDefault();
          onSelectPen(TWO_TONE_BACKGROUND_PEN_INDEX);
          break;
        case "[":
          e.preventDefault();
          onAdjustPenSize(-1);
          break;
        case "]":
          e.preventDefault();
          onAdjustPenSize(1);
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onSelectPen, onSwapPen, onAdjustPenSize]);
};
