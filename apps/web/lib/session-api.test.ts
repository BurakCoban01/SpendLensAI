import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest, authHeaders, type AuthResponse } from "./api";
import { clearSession, readSession, saveSession, shouldRefreshSession } from "./session";

const baseSession: AuthResponse = {
  tenant: { id: "tenant_1", name: "Tenant", slug: "tenant" },
  user: { id: "user_1", email: "user@example.com", displayName: "User" },
  roles: ["owner"],
  permissions: ["documents.read"],
  tokens: { accessToken: "access-old", refreshToken: "refresh-old", expiresInSeconds: 900 }
};

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

describe("web session refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T10:00:00.000Z"));
    Object.defineProperty(globalThis, "localStorage", {
      value: new MemoryStorage(),
      configurable: true
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearSession();
  });

  it("stores an access-token expiry timestamp with the session", () => {
    saveSession(baseSession);

    const stored = readSession();

    expect(stored?.tokenExpiresAt).toBe(Date.now() + 900_000);
    expect(shouldRefreshSession(stored!, Date.now() + 839_000)).toBe(false);
    expect(shouldRefreshSession(stored!, Date.now() + 840_000)).toBe(true);
  });

  it("refreshes before an authenticated request when the token is near expiry", async () => {
    saveSession({ ...baseSession, tokens: { ...baseSession.tokens, expiresInSeconds: 10 } });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) {
        return Response.json({
          tokens: { accessToken: "access-new", refreshToken: "refresh-new", expiresInSeconds: 900 }
        });
      }
      expect(init?.headers).toBeInstanceOf(Headers);
      expect((init?.headers as Headers).get("authorization")).toBe("Bearer access-new");
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest<{ ok: boolean }>("/documents", { headers: authHeaders("access-old") })).resolves.toEqual({ ok: true });
    await expect(apiRequest<{ ok: boolean }>("/workspaces", { headers: authHeaders("access-new") })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readSession()?.tokens.accessToken).toBe("access-new");
    expect(readSession()?.tokenExpiresAt).toBe(Date.now() + 900_000);
  });

  it("retries once with a refreshed token after a 401", async () => {
    saveSession(baseSession);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "INVALID_TOKEN" } }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          tokens: { accessToken: "access-new", refreshToken: "refresh-new", expiresInSeconds: 900 }
        })
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest<{ ok: boolean }>("/auth/me", { headers: authHeaders("access-old") })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retriedHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Headers;
    expect(retriedHeaders.get("authorization")).toBe("Bearer access-new");
  });
});
