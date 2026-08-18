"use client";

import Link from "next/link";
import { useEffect } from "react";
import { clearSession } from "../lib/session";

export function SessionRecoveryActions({ locale }: { locale: "tr" | "en" }) {
  const query = `?lang=${encodeURIComponent(locale)}`;

  useEffect(() => {
    clearSession();
  }, []);

  return (
    <div className="mt-6 flex flex-wrap gap-3">
      <Link className="inline-flex h-10 items-center bg-ink px-4 text-sm font-semibold text-paper" href={`/login${query}`}>
        {locale === "tr" ? "Giriş yap" : "Sign in"}
      </Link>
      <Link className="inline-flex h-10 items-center border border-black/15 px-4 text-sm font-semibold text-ink hover:border-signal hover:text-signal" href={`/register${query}`}>
        {locale === "tr" ? "Kayıt ol" : "Register"}
      </Link>
    </div>
  );
}
