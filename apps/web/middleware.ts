import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const lang = request.nextUrl.searchParams.get("lang");
  const theme = request.nextUrl.searchParams.get("theme");

  if (lang === "tr" || lang === "en") {
    response.cookies.set("spendlens-locale", lang, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  }

  if (theme === "light" || theme === "dark") {
    response.cookies.set("spendlens-theme", theme, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"]
};
