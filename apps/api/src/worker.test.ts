import { describe, expect, it } from "vitest";
import {
  authenticateDedicatedWorker,
  authenticateDedicatedWorkerWithRetry,
  loadDedicatedWorkerConfig,
  runDedicatedWorkerCycle
} from "./worker";

describe("dedicated worker entrypoint", () => {
  it("loads token-based worker config with bounded polling settings", () => {
    const config = loadDedicatedWorkerConfig({
      WORKER_ACCESS_TOKEN: "token",
      WORKER_API_BASE_URL: "http://api:4000/",
      WORKER_ID: "worker-1",
      WORKER_QUEUE: "ocr",
      WORKER_INTERVAL_MS: "5",
      WORKER_MAX_JOBS_PER_TICK: "50"
    } as NodeJS.ProcessEnv);

    expect(config).toMatchObject({
      apiBaseUrl: "http://api:4000",
      workerId: "worker-1",
      queue: "ocr",
      intervalMs: 100,
      maxJobsPerTick: 25,
      auth: { mode: "token", accessToken: "token" }
    });
  });

  it("logs in with worker credentials when no bearer token is supplied", async () => {
    const config = loadDedicatedWorkerConfig({
      WORKER_API_BASE_URL: "http://api:4000",
      WORKER_TENANT_SLUG: "ops",
      WORKER_EMAIL: "worker@example.com",
      WORKER_PASSWORD: "very-secure-password"
    } as NodeJS.ProcessEnv);
    const calls: Array<{ url: string; body: unknown }> = [];

    const token = await authenticateDedicatedWorker(config, async (url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return jsonResponse(200, { tokens: { accessToken: "access-token" } });
    });

    expect(token).toBe("access-token");
    expect(calls[0]).toMatchObject({
      url: "http://api:4000/auth/login",
      body: {
        tenantSlug: "ops",
        email: "worker@example.com",
        password: "very-secure-password"
      }
    });
  });

  it("uses local demo credentials for the dedicated dev worker when auth is not configured", () => {
    const config = loadDedicatedWorkerConfig({
      WORKER_API_BASE_URL: "http://localhost:18621",
      WORKER_ID: "local-dev-worker",
      NODE_ENV: "development"
    } as NodeJS.ProcessEnv);

    expect(config).toMatchObject({
      apiBaseUrl: "http://localhost:18621",
      workerId: "local-dev-worker",
      auth: {
        mode: "login",
        tenantSlug: "demo",
        email: "demo.owner@spendlens.local",
        password: "SpendLensDemo!2026"
      }
    });
  });

  it("retries transient startup connection failures before authenticating", async () => {
    const config = loadDedicatedWorkerConfig({
      WORKER_API_BASE_URL: "http://api:4000",
      WORKER_TENANT_SLUG: "ops",
      WORKER_EMAIL: "worker@example.com",
      WORKER_PASSWORD: "very-secure-password"
    } as NodeJS.ProcessEnv);
    let calls = 0;
    const delays: number[] = [];

    const token = await authenticateDedicatedWorkerWithRetry(
      config,
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("fetch failed");
        return jsonResponse(200, { tokens: { accessToken: "access-token" } });
      },
      { attempts: 3, delayMs: 50, sleepFn: async (ms) => void delays.push(ms) }
    );

    expect(token).toBe("access-token");
    expect(calls).toBe(3);
    expect(delays).toEqual([50, 50]);
  });

  it("does not use local demo credentials in production without explicit worker auth", () => {
    expect(() =>
      loadDedicatedWorkerConfig({
        NODE_ENV: "production",
        WORKER_API_BASE_URL: "http://api:4000"
      } as NodeJS.ProcessEnv)
    ).toThrow("WORKER_AUTH_NOT_CONFIGURED");
  });

  it("drains run-next jobs until the queue is empty", async () => {
    const config = loadDedicatedWorkerConfig({
      WORKER_ACCESS_TOKEN: "token",
      WORKER_API_BASE_URL: "http://api:4000",
      WORKER_ID: "worker-2",
      WORKER_MAX_JOBS_PER_TICK: "5"
    } as NodeJS.ProcessEnv);
    const calls: unknown[] = [
      { processed: true, job: { id: "job_1", queue: "ocr", jobType: "ocr.compare", status: "SUCCEEDED" } },
      { processed: true, job: { id: "job_2", queue: "extraction", jobType: "extraction.from_text", status: "SUCCEEDED" } },
      { processed: false, job: null }
    ];

    const result = await runDedicatedWorkerCycle(config, "access-token", async (_url, init) => {
      expect(init?.headers?.authorization).toBe("Bearer access-token");
      return jsonResponse(200, calls.shift());
    });

    expect(result).toEqual({ processedJobs: 2, empty: true, lastJobId: "job_2" });
  });
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}
