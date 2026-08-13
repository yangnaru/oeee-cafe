import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "oeee-theme";

/** What the OS asks for, when nothing has been chosen here. */
function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    // Private mode, or storage disabled; the OS preference still works
    return null;
  }
}

/**
 * The painter's light/dark switch.
 *
 * The palette follows `prefers-color-scheme` on its own, so this exists for
 * the case that media query cannot express: wanting the painter dark on a
 * light desktop, or the reverse. A choice is written to `data-theme`, which
 * every token already honours ahead of the media query, and remembered.
 *
 * Choosing nothing leaves the attribute off entirely, so the OS keeps control
 * rather than being frozen to whatever it happened to be on first visit.
 */
export function useTheme() {
  const [override, setOverride] = useState<Theme | null>(() => storedTheme());
  const [system, setSystem] = useState<Theme>(() => systemTheme());

  // Follow the OS while no choice has been made here
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(query.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (override) root.setAttribute("data-theme", override);
    else root.removeAttribute("data-theme");
  }, [override]);

  const theme: Theme = override ?? system;

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setOverride(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not being able to remember it is not a reason to refuse the switch
    }
  }, [theme]);

  return { theme, toggle };
}
