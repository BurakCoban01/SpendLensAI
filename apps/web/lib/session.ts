"use client";

import type { AuthResponse } from "./api";

const SESSION_KEY = "spendlens.auth";
const TOKEN_REFRESH_SKEW_MS = 60_000;

export type StoredAuthSession = AuthResponse & {
  tokenExpiresAt: number;
};

export function saveSession(session: AuthResponse): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(withFreshTokenExpiry(session)));
}

export function readSession(): StoredAuthSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthResponse & { tokenExpiresAt?: number };
    const normalized = withTokenExpiry(parsed);
    if (parsed.tokenExpiresAt !== normalized.tokenExpiresAt) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(normalized));
    }
    return normalized;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function shouldRefreshSession(session: StoredAuthSession, now = Date.now()): boolean {
  return session.tokenExpiresAt - now <= TOKEN_REFRESH_SKEW_MS;
}

function withTokenExpiry(session: AuthResponse & { tokenExpiresAt?: number }): StoredAuthSession {
  const expiresInSeconds = Number.isFinite(session.tokens.expiresInSeconds) ? session.tokens.expiresInSeconds : 1;
  const tokenExpiresAt =
    typeof session.tokenExpiresAt === "number" && Number.isFinite(session.tokenExpiresAt)
      ? session.tokenExpiresAt
      : Date.now() + Math.max(expiresInSeconds, 1) * 1000;
  return { ...session, tokenExpiresAt };
}

function withFreshTokenExpiry(session: AuthResponse): StoredAuthSession {
  const expiresInSeconds = Number.isFinite(session.tokens.expiresInSeconds) ? session.tokens.expiresInSeconds : 1;
  return {
    ...session,
    tokenExpiresAt: Date.now() + Math.max(expiresInSeconds, 1) * 1000
  };
}
