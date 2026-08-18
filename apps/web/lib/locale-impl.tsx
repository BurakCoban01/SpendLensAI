"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Locale = "tr" | "en";

const STORAGE_KEY = "spendlens-locale";
const LOCALE_EVENT = "spendlens-locale-change";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function isLocale(value: string | null | undefined): value is Locale {
  return value === "tr" || value === "en";
}

export function readStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function readCookieLocale(): Locale | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)spendlens-locale=(tr|en)(?:;|$)/);
  return match?.[1] === "tr" || match?.[1] === "en" ? match[1] : null;
}

export function readQueryLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("lang");
  return isLocale(value) ? value : null;
}

export function resolveBrowserLocale(): Locale {
  if (typeof window === "undefined") return "tr";
  return window.navigator.language.toLowerCase().startsWith("en") ? "en" : "tr";
}

export function resolveInitialLocale(): Locale {
  return readQueryLocale() ?? readCookieLocale() ?? readStoredLocale() ?? resolveBrowserLocale();
}

export function localeLabel(locale: Locale): string {
  return locale === "tr" ? "Türkçe" : "English";
}

function applyLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
}

function persistLocale(locale: Locale) {
  if (typeof window !== "undefined") {
    const url = new URL(window.location.href);
    url.searchParams.set("lang", locale);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    document.cookie = `spendlens-locale=${locale}; path=/; max-age=31536000; samesite=lax`;
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {}
  }
}

function dispatchLocaleChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(LOCALE_EVENT));
}

export function setLocale(next: Locale) {
  persistLocale(next);
  applyLocale(next);
  dispatchLocaleChange();
}

export function LocaleProvider({
  initialLocale,
  children
}: {
  initialLocale: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    const sync = () => {
      const next = resolveInitialLocale();
      applyLocale(next);
      setLocaleState(next);
    };

    sync();

    window.addEventListener("popstate", sync);
    window.addEventListener("storage", sync);
    window.addEventListener(LOCALE_EVENT, sync);

    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("storage", sync);
      window.removeEventListener(LOCALE_EVENT, sync);
    };
  }, []);

  const updateLocale = useCallback((next: Locale) => {
    setLocale(next);
    setLocaleState(next);
  }, []);

  return <LocaleContext.Provider value={{ locale, setLocale: updateLocale }}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);
  const [fallbackLocale, setFallbackLocale] = useState<Locale>(() => resolveInitialLocale());
  const updateLocale = useCallback((next: Locale) => {
    setLocale(next);
    setFallbackLocale(next);
  }, []);

  useEffect(() => {
    if (context) return;

    const sync = () => {
      const next = resolveInitialLocale();
      applyLocale(next);
      setFallbackLocale(next);
    };

    sync();

    window.addEventListener("popstate", sync);
    window.addEventListener("storage", sync);
    window.addEventListener(LOCALE_EVENT, sync);

    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("storage", sync);
      window.removeEventListener(LOCALE_EVENT, sync);
    };
  }, [context]);

  if (context) return context;

  return { locale: fallbackLocale, setLocale: updateLocale };
}
