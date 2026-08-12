import { useEffect } from "react";
import { SHORTCUTS, type ShortcutAction } from "../constants/shortcuts";

interface UsePainterShortcutsOptions {
  enabled: boolean;
  onAction: (action: ShortcutAction) => void;
}

/**
 * Don't steal keystrokes aimed at a form control -- or at the text tool's
 * editable box, where every one of these keys is something the user is
 * trying to type.
 */
const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName);
};

/**
 * Binds the shortcut table.
 *
 * Every action drives the same state the toolbar does, so a stroke started
 * from the keyboard records exactly as one started from a click. Nothing here
 * reaches the action recorder, which is what keeps replays reproducible.
 */
export const usePainterShortcuts = ({
  enabled,
  onAction,
}: UsePainterShortcutsOptions) => {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      const key = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;

      const match = SHORTCUTS.find((s) => {
        if (s.key !== key) return false;
        if (Boolean(s.ctrl) !== ctrl) return false;
        // Alt is NEO's alternate redo spelling; treat it as opt-in so an
        // unbound Alt combination falls through to the browser
        if (Boolean(s.alt) !== e.altKey) return false;
        // Shift only distinguishes letters. On most layouts "+" and "?" are
        // typed *with* shift, so demanding it be up makes them unreachable --
        // which is why NEO's own "+" zoom only works on a numpad.
        if (!/^[a-z]$/.test(s.key)) return true;
        return Boolean(s.shift) === e.shiftKey;
      });
      if (!match) return;

      e.preventDefault();
      onAction(match.action);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onAction]);
};
