"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocale } from "../lib/locale";

type Theme = "light" | "dark";

const STORAGE_KEY = "spendlens-theme";

type ThemeToggleProps = {
  initialTheme: Theme;
};

export function ThemeToggle({ initialTheme }: ThemeToggleProps) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [ready, setReady] = useState(false);
  const { locale } = useLocale();

  useEffect(() => {
    const next = readQueryTheme() ?? readCookieTheme() ?? readStoredTheme() ?? resolveSystemTheme();
    applyTheme(next);
    setTheme(next);
    setReady(true);
  }, []);

  const label = useMemo(() => {
    if (locale === "en") {
      return theme === "dark" ? "Dark theme enabled" : "Light theme enabled";
    }
    return theme === "dark" ? "Koyu tema etkin" : "Açık tema etkin";
  }, [locale, theme]);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    persistTheme(next);
    applyTheme(next);
    setTheme(next);
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={theme === "dark"}
      onClick={toggleTheme}
      className="fixed right-[68px] top-3 z-50 inline-grid h-11 w-11 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-sm backdrop-blur transition hover:border-[var(--primary)] hover:text-[var(--primary)] md:top-5"
      title={label}
    >
      {theme === "dark" ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
      <span className="sr-only">{ready ? label : locale === "en" ? "Theme" : "Tema"}</span>
    </button>
  );
}

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {}
  return null;
}

function readCookieTheme(): Theme | null {
  const match = document.cookie.match(/(?:^|;\s*)spendlens-theme=(light|dark)(?:;|$)/);
  return match?.[1] === "light" || match?.[1] === "dark" ? match[1] : null;
}

function readQueryTheme(): Theme | null {
  const query = new URLSearchParams(window.location.search);
  const value = query.get("theme")?.toLowerCase();
  if (value === "light" || value === "dark") return value;
  return null;
}

function resolveSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function persistTheme(theme: Theme) {
  const url = new URL(window.location.href);
  url.searchParams.set("theme", theme);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  document.cookie = `spendlens-theme=${theme}; path=/; max-age=31536000; samesite=lax`;

  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {}
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}
