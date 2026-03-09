import { useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { locales, type Locale, type Translations } from "../locales";

// ─── Validation ───

const VALID_LOCALES: ReadonlySet<string> = new Set(["ko", "en"]);

function isValidLocale(v: unknown): v is Locale {
  return typeof v === "string" && VALID_LOCALES.has(v);
}

// ─── Singleton store (mirrors useTheme pattern) ───

let currentLocale: Locale = (() => {
  const stored = localStorage.getItem("azuki-locale");
  return isValidLocale(stored) ? stored : "ko";
})();
let snapshot: Locale = currentLocale;
const listeners = new Set<() => void>();
let serverSynced = false;

function notify() {
  snapshot = currentLocale;
  for (const l of listeners) l();
}

function getSnapshot(): Locale {
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
      if (isValidLocale(prefs.locale) && prefs.locale !== currentLocale) {
        currentLocale = prefs.locale;
        localStorage.setItem("azuki-locale", prefs.locale);
        notify();
      }
    })
    .catch(() => {});
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function setLocale(locale: Locale): void {
  if (!isValidLocale(locale)) return;
  currentLocale = locale;
  localStorage.setItem("azuki-locale", locale);
  notify();
  api.updatePreferences({ locale }).catch(() => {});
}

export function t(): Translations {
  return locales[currentLocale];
}
