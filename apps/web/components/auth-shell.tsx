"use client";

import Link from "next/link";
import { useLocale } from "../lib/locale";

const copy = {
  tr: "Yerel, güvenli ve çalışma alanına özel ortam",
  en: "Local, secure and workspace-scoped environment"
} as const;

export function AuthShell({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const { locale } = useLocale();

  return (
    <main className="grid min-h-screen bg-[var(--app-bg)] text-[var(--text-primary)] md:grid-cols-[0.9fr_1.1fr]">
      <section className="flex min-h-[30svh] flex-col justify-between bg-[var(--sidebar-bg)] px-6 py-8 text-[var(--sidebar-text)] md:min-h-screen md:px-10">
        <Link href={`/?lang=${locale}`} className="text-sm font-semibold text-[var(--sidebar-muted)]">
          SpendLens AI
        </Link>
        <div className="max-w-xl">
          <h1 className="text-4xl font-semibold leading-tight md:text-6xl">{title}</h1>
          <p className="mt-5 text-base leading-7 text-[var(--sidebar-muted)]">{subtitle}</p>
        </div>
        <p className="text-xs font-semibold text-[var(--sidebar-muted)]">{copy[locale]}</p>
      </section>
      <section className="flex items-center px-6 py-10 md:px-12">
        <div className="product-surface w-full max-w-md p-5 sm:p-7">{children}</div>
      </section>
    </main>
  );
}
