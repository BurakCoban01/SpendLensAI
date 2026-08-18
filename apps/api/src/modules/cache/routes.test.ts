import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { InMemoryCacheStore } from "./memory-store";

describe("cache admin routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let cacheStore: InMemoryCacheStore;

  beforeAll(async () => {
    cacheStore = new InMemoryCacheStore();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      cacheStore
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Cache Tenant",
        tenantSlug: "cache",
        workspaceName: "Cache",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    accessToken = register.json().tokens.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires authentication before exposing cache state", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/cache" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("MISSING_BEARER_TOKEN");
  });

  it("lists hot-state keys and supports owner-scoped locks", async () => {
    await cacheStore.setJson({
      key: "worker-job:tenant_1:job_1",
      ttlSeconds: 60,
      value: { status: "RUNNING", progress: 25 }
    });

    const status = await app.inject({
      method: "GET",
      url: "/admin/cache?prefix=worker-job:",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().health).toMatchObject({ backend: "memory", connected: true });
    expect(status.json().keys[0].key).toBe("worker-job:tenant_1:job_1");

    const acquired = await app.inject({
      method: "POST",
      url: "/admin/cache/locks/acquire",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { key: "ocr:job_1", ttlMs: 10000 }
    });
    expect(acquired.statusCode).toBe(200);
    expect(acquired.json().acquired).toBe(true);

    const duplicate = await app.inject({
      method: "POST",
      url: "/admin/cache/locks/acquire",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { key: "ocr:job_1", ttlMs: 10000 }
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().acquired).toBe(false);

    const released = await app.inject({
      method: "POST",
      url: "/admin/cache/locks/release",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { key: "ocr:job_1" }
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().released).toBe(true);

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?resourceType=CacheLock",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const logs = audit.json().logs;
    expect(logs.map((log: { action: string }) => log.action)).toEqual(
      expect.arrayContaining(["cache.lock.acquire", "cache.lock.release"])
    );
    expect(logs[0].metadata).toMatchObject({
      keyNamespace: "lock:ocr",
      ownerScoped: true
    });
    expect(typeof logs[0].metadata.keyHash).toBe("string");
    const serializedAudit = JSON.stringify(audit.json());
    expect(serializedAudit).not.toContain("ocr:job_1");
    expect(serializedAudit).not.toContain("lock:ocr:job_1");
    expect(serializedAudit).not.toContain("progress");
  });
});
