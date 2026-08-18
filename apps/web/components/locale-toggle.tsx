"use client";

import { Languages } from "lucide-react";
import { useMemo } from "react";
import { localeLabel, useLocale } from "../lib/locale";

export function LocaleToggle() {
  const { locale, setLocale } = useLocale();

  const nextLocale = useMemo(() => (locale === "tr" ? "en" : "tr"), [locale]);
  const label = useMemo(() => (locale === "tr" ? `Dil: ${localeLabel(locale)}` : `Language: ${localeLabel(locale)}`), [locale]);

  function toggleLocale() {
    setLocale(nextLocale);
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={locale === "en"}
      onClick={toggleLocale}
      className="fixed right-4 top-3 z-50 inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs font-bold text-[var(--text-primary)] shadow-sm backdrop-blur transition hover:border-[var(--primary)] hover:text-[var(--primary)] md:top-5"
      title={label}
    >
      <Languages size={16} aria-hidden="true" />
      <span>{locale.toLocaleUpperCase(locale === "tr" ? "tr-TR" : "en-US")}</span>
    </button>
  );
}
