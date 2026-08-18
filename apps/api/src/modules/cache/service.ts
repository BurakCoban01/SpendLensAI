import { createHash } from "node:crypto";
import type { AuditRepository } from "../audit/types";
import type { AuthPrincipal } from "../auth/types";
import type { CacheStore } from "./types";

export class CacheError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class CacheService {
  constructor(
    private readonly store: CacheStore,
    private readonly audit?: AuditRepository
  ) {}

  async status(prefix = "worker-job:", limit = 50) {
    return {
      health: await this.store.health(),
      keys: await this.store.listKeys(prefix, limit)
    };
  }

  async metrics() {
    const health = await this.store.health();
    let workerHotStateKeys = 0;
    try {
      workerHotStateKeys = (await this.store.listKeys("worker-job:", 1000)).length;
    } catch {
      workerHotStateKeys = 0;
    }
    return {
      health,
      workerHotStateKeys,
      operationErrors: await this.store.operationErrorCounts()
    };
  }

  async setHotState(input: { key: string; value: Record<string, unknown>; ttlSeconds?: number }) {
    await this.store.setJson({
      key: normalizeKey(input.key),
      value: input.value,
      ...(input.ttlSeconds ? { ttlSeconds: input.ttlSeconds } : {})
    });
  }

  async getHotState<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    return this.store.getJson<T>(normalizeKey(key));
  }

  async acquireLock(input: { principal: AuthPrincipal; key: string; ttlMs: number }) {
    const key = lockKey(input.key);
    const owner = `${input.principal.tenantId}:${input.principal.userId}`;
    const acquired = await this.store.acquireLock({ key, owner, ttlMs: input.ttlMs });
    await this.auditLockAdmin(input.principal, "cache.lock.acquire", key, {
      ttlMs: input.ttlMs,
      acquired
    });
    return { key, owner, acquired };
  }

  async releaseLock(input: { principal: AuthPrincipal; key: string }) {
    const key = lockKey(input.key);
    const owner = `${input.principal.tenantId}:${input.principal.userId}`;
    const released = await this.store.releaseLock({ key, owner });
    await this.auditLockAdmin(input.principal, "cache.lock.release", key, {
      released
    });
    return { key, owner, released };
  }

  async acquireSystemLock(input: { key: string; owner: string; ttlMs: number }) {
    const key = lockKey(input.key);
    const owner = normalizeOwner(input.owner);
    return {
      key,
      owner,
      acquired: await this.store.acquireLock({ key, owner, ttlMs: input.ttlMs })
    };
  }

  async releaseSystemLock(input: { key: string; owner: string }) {
    const key = lockKey(input.key);
    const owner = normalizeOwner(input.owner);
    return {
      key,
      owner,
      released: await this.store.releaseLock({ key, owner })
    };
  }

  private async auditLockAdmin(
    principal: AuthPrincipal,
    action: string,
    normalizedLockKey: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      const keyHash = hashCacheKey(normalizedLockKey);
      await this.audit?.create({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action,
        resourceType: "CacheLock",
        resourceId: keyHash,
        metadata: {
          keyHash,
          keyNamespace: cacheKeyNamespace(normalizedLockKey),
          keyLength: normalizedLockKey.length,
          ownerScoped: true,
          ...metadata
        },
        correlationId: principal.sessionId
      });
    } catch {
      // Cache lock state remains authoritative; audit failures should not break admin recovery operations.
    }
  }
}

export function workerJobCacheKey(tenantId: string, jobId: string): string {
  return `worker-job:${tenantId}:${jobId}`;
}

function lockKey(key: string): string {
  return `lock:${normalizeKey(key)}`;
}

function normalizeKey(key: string): string {
  const normalized = key.trim();
  if (!/^[a-zA-Z0-9:._/-]{2,240}$/.test(normalized)) throw new CacheError("INVALID_CACHE_KEY", 400);
  return normalized;
}

function normalizeOwner(owner: string): string {
  const normalized = owner.trim();
  if (!/^[a-zA-Z0-9:._/-]{2,240}$/.test(normalized)) throw new CacheError("INVALID_CACHE_LOCK_OWNER", 400);
  return normalized;
}

function hashCacheKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function cacheKeyNamespace(key: string): string {
  return key.split(":").slice(0, 2).join(":");
}
