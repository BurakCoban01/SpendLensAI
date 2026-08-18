import { randomUUID } from "node:crypto";
import { describe, expect, it, afterEach } from "vitest";
import type { AuthPrincipal } from "../auth/types";
import { JobService } from "../jobs/service";
import { CacheService, workerJobCacheKey } from "./service";
import { RedisCacheStore } from "./redis-store";

const runLive = process.env.SPENDLENS_LIVE_REDIS_KAFKA_TESTS === "1" || process.env.SPENDLENS_LIVE_REDIS_TESTS === "1";
const describeLive = runLive ? describe : describe.skip;
const redisUrl = process.env.REDIS_URL || "redis://localhost:16380";

describeLive("RedisCacheStore live integration", () => {
  const stores: RedisCacheStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it("persists worker hot state and enforces owner-scoped locks in Redis", async () => {
    const store = createStore();
    const cache = new CacheService(store);
    const namespace = randomUUID();
    const tenantId = `tenant-${namespace}`;
    const jobId = `job-${namespace}`;
    const hotStateKey = workerJobCacheKey(tenantId, jobId);
    const lockName = `worker-runner:${tenantId}:ocr`;

    try {
      await cache.setHotState({
        key: hotStateKey,
        ttlSeconds: 30,
        value: {
          jobId,
          queue: "ocr",
          jobType: "tesseract",
          status: "running",
          progress: 42
        }
      });

      await expect(cache.getHotState(hotStateKey)).resolves.toMatchObject({
        jobId,
        queue: "ocr",
        status: "running",
        progress: 42
      });
      await expect(cache.status("worker-job:", 1000)).resolves.toMatchObject({
        health: { backend: "redis", connected: true }
      });

      const ownerA = `${tenantId}:worker-a`;
      const ownerB = `${tenantId}:worker-b`;
      const first = await cache.acquireSystemLock({ key: lockName, owner: ownerA, ttlMs: 30_000 });
      const second = await cache.acquireSystemLock({ key: lockName, owner: ownerB, ttlMs: 30_000 });
      const wrongOwnerRelease = await cache.releaseSystemLock({ key: lockName, owner: ownerB });
      const correctOwnerRelease = await cache.releaseSystemLock({ key: lockName, owner: ownerA });
      const reacquired = await cache.acquireSystemLock({ key: lockName, owner: ownerB, ttlMs: 30_000 });

      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);
      expect(wrongOwnerRelease.released).toBe(false);
      expect(correctOwnerRelease.released).toBe(true);
      expect(reacquired.acquired).toBe(true);
      await cache.releaseSystemLock({ key: lockName, owner: ownerB });
    } finally {
      await store.delete(hotStateKey).catch(() => undefined);
      await store.delete(`lock:${lockName}`).catch(() => undefined);
    }
  });

  it("coordinates concurrent worker runs through a real Redis lock", async () => {
    const store = createStore();
    const cache = new CacheService(store);
    const jobService = new JobService({} as never, undefined, cache);
    const namespace = randomUUID();
    const tenantId = `tenant-${namespace}`;
    const queue = `queue-${namespace}`;
    const principal = principalFor(tenantId);
    let unblockFirst!: () => void;
    let firstRun!: ReturnType<JobService["withWorkerRunLock"]>;
    const firstEntered = new Promise<void>((resolve) => {
      firstRun = jobService.withWorkerRunLock(
        { principal, workerId: "worker-a", queue, ttlMs: 30_000 },
        async () => {
          resolve();
          await new Promise<void>((unblock) => {
            unblockFirst = unblock;
          });
          return "first";
        }
      );

      void firstRun;
    });

    try {
      await firstEntered;

      const secondRun = await jobService.withWorkerRunLock(
        { principal, workerId: "worker-b", queue, ttlMs: 30_000 },
        async () => "second"
      );

      expect(secondRun).toMatchObject({
        acquired: false,
        degraded: false,
        result: null
      });
    } finally {
      unblockFirst();
      await expect(firstRun).resolves.toMatchObject({
        acquired: true,
        degraded: false,
        result: "first"
      });
      await store.delete(`lock:worker-runner:${tenantId}:${queue}`).catch(() => undefined);
    }
  });

  function createStore(): RedisCacheStore {
    const store = new RedisCacheStore(redisUrl);
    stores.push(store);
    return store;
  }
});

function principalFor(tenantId: string): AuthPrincipal {
  return {
    tenantId,
    userId: `user-${tenantId}`,
    sessionId: `session-${tenantId}`,
    email: "redis-live@example.test",
    displayName: "Redis Live",
    roles: ["OWNER"],
    permissions: []
  };
}
