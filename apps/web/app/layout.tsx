import type { Metadata } from "next";
import { cookies } from "next/headers";
import Script from "next/script";
import "./globals.css";
import { LocaleToggle } from "../components/locale-toggle";
import { ThemeToggle } from "../components/theme-toggle";
import { LocaleProvider, type Locale } from "../lib/locale";

function readThemeCookie(): "light" | "dark" {
  const value = cookies().get("spendlens-theme")?.value;
  return value === "dark" ? "dark" : "light";
}

function readLocaleCookie(): Locale {
  const value = cookies().get("spendlens-locale")?.value;
  return value === "en" ? "en" : "tr";
}

export const metadata: Metadata = {
  title: "SpendLens AI",
  description: "Yerel çalışan OCR ve gider yönetimi platformu",
  icons: {
    icon: "/icon.svg"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const initialTheme = readThemeCookie();
  const initialLocale = readLocaleCookie();

  return (
    <html lang={initialLocale} data-locale={initialLocale} data-theme={initialTheme} suppressHydrationWarning>
      <head>
        <Script id="theme-init" strategy="beforeInteractive">{`(() => { try { const search = new URLSearchParams(window.location.search); const query = search.get("theme"); const key = "spendlens-theme"; const stored = localStorage.getItem(key); const theme = query === "light" || query === "dark" ? query : (stored === "light" || stored === "dark" ? stored : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")); document.documentElement.dataset.theme = theme; } catch (_) {} })();`}</Script>
        <Script id="locale-init" strategy="beforeInteractive">{`(() => { try { const search = new URLSearchParams(window.location.search); const query = search.get("lang"); const key = "spendlens-locale"; const stored = localStorage.getItem(key); const locale = query === "tr" || query === "en" ? query : (stored === "tr" || stored === "en" ? stored : (window.navigator.language.toLowerCase().startsWith("en") ? "en" : "tr")); document.documentElement.lang = locale; document.documentElement.dataset.locale = locale; } catch (_) {} })();`}</Script>
      </head>
      <body>
        <LocaleProvider initialLocale={initialLocale}>
          <ThemeToggle initialTheme={initialTheme} />
          <LocaleToggle />
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
