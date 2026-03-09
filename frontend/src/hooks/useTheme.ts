import { useEffect, useSyncExternalStore } from "react";
import { api } from "../lib/api";

type Theme = "dark" | "light" | "system";
type ResolvedTheme = "dark" | "light";

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function applyTheme(resolved: ResolvedTheme) {
  if (resolved === "light") {
    document.documentElement.classList.add("light");
  } else {
    document.documentElement.classList.remove("light");
  }
}

function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? getSystemTheme() : theme;
}

// ─── Singleton store (no duplicate API calls) ───

let currentTheme: Theme =
  (localStorage.getItem("azuki-theme") as Theme) || "system";
let currentResolved: ResolvedTheme = resolveTheme(currentTheme);
let snapshot = { theme: currentTheme, resolvedTheme: currentResolved };
const listeners = new Set<() => void>();
let serverSynced = false;

function updateSnapshot() {
  snapshot = { theme: currentTheme, resolvedTheme: currentResolved };
}

function notify() {
  updateSnapshot();
  for (const l of listeners) l();
}

function getSnapshot() {
  return snapshot;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Sync with server once
if (!serverSynced) {
  serverSynced = true;
  api
    .getPreferences()
    .then((prefs) => {
      const t = prefs.theme as Theme;
      if (t && ["dark", "light", "system"].includes(t) && t !== currentTheme) {
        currentTheme = t;
        localStorage.setItem("azuki-theme", t);
        currentResolved = resolveTheme(t);
        applyTheme(currentResolved);
        notify();
      }
    })
    .catch(() => {});
}

// OS theme change listener for system mode
window
  .matchMedia("(prefers-color-scheme: light)")
  .addEventListener("change", () => {
    if (currentTheme === "system") {
      currentResolved = getSystemTheme();
      applyTheme(currentResolved);
      notify();
    }
  });

export function useTheme() {
  const { theme, resolvedTheme } = useSyncExternalStore(subscribe, getSnapshot);

  // Apply on mount (in case SSR mismatch)
  useEffect(() => {
    applyTheme(currentResolved);
  }, []);

  const setTheme = (value: string) => {
    const t = value as Theme;
    currentTheme = t;
    localStorage.setItem("azuki-theme", t);
    currentResolved = resolveTheme(t);
    applyTheme(currentResolved);
    notify();
    api.updatePreferences({ theme: t }).catch(() => {});
  };

  return { theme, resolvedTheme, setTheme };
}
