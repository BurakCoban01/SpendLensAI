type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export type DedicatedWorkerConfig = {
  apiBaseUrl: string;
  workerId: string;
  queue: string | null;
  intervalMs: number;
  maxJobsPerTick: number;
  auth:
    | { mode: "token"; accessToken: string }
    | { mode: "login"; tenantSlug: string; email: string; password: string };
};

type RunNextResponse = {
  processed: boolean;
  job: { id: string; queue: string; jobType: string; status: string } | null;
};

export function loadDedicatedWorkerConfig(env: NodeJS.ProcessEnv = process.env): DedicatedWorkerConfig {
  const accessToken = env.WORKER_ACCESS_TOKEN?.trim();
  const login = {
    tenantSlug: env.WORKER_TENANT_SLUG?.trim(),
    email: env.WORKER_EMAIL?.trim(),
    password: env.WORKER_PASSWORD
  };
  const hasPartialLogin = Boolean(login.tenantSlug || login.email || login.password);
  const localDemoAuth =
    !accessToken && !hasPartialLogin && shouldUseLocalDemoWorkerAuth(env)
      ? ({
          mode: "login",
          tenantSlug: "demo",
          email: "demo.owner@spendlens.local",
          password: "SpendLensDemo!2026"
        } as const)
      : null;
  const auth = accessToken
    ? ({ mode: "token", accessToken } as const)
    : login.tenantSlug && login.email && login.password
      ? ({ mode: "login", tenantSlug: login.tenantSlug, email: login.email, password: login.password } as const)
      : localDemoAuth;
  if (!auth) throw new Error("WORKER_AUTH_NOT_CONFIGURED");

  return {
    apiBaseUrl: trimTrailingSlash(env.WORKER_API_BASE_URL?.trim() || "http://localhost:4000"),
    workerId: normalizeWorkerId(env.WORKER_ID?.trim() || "dedicated-local-worker"),
    queue: env.WORKER_QUEUE?.trim() || null,
    intervalMs: parsePositiveInt(env.WORKER_INTERVAL_MS, 1000, 100, 60_000),
    maxJobsPerTick: parsePositiveInt(env.WORKER_MAX_JOBS_PER_TICK, 5, 1, 25),
    auth
  };
}

function shouldUseLocalDemoWorkerAuth(env: NodeJS.ProcessEnv): boolean {
  if (env.WORKER_DEMO_FALLBACK === "0") return false;
  if (env.NODE_ENV === "production") return false;
  if (env.CI === "true") return false;
  return true;
}

export async function authenticateDedicatedWorker(config: DedicatedWorkerConfig, fetcher: FetchLike = fetch): Promise<string> {
  if (config.auth.mode === "token") return config.auth.accessToken;
  const response = await fetcher(`${config.apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantSlug: config.auth.tenantSlug,
      email: config.auth.email,
      password: config.auth.password
    })
  });
  if (!response.ok) throw new Error(`WORKER_LOGIN_FAILED:${response.status}:${await safeText(response)}`);
  const body = (await response.json()) as { tokens?: { accessToken?: string } };
  if (!body.tokens?.accessToken) throw new Error("WORKER_LOGIN_TOKEN_MISSING");
  return body.tokens.accessToken;
}

export async function authenticateDedicatedWorkerWithRetry(
  config: DedicatedWorkerConfig,
  fetcher: FetchLike = fetch,
  options: { attempts?: number; delayMs?: number; sleepFn?: (ms: number) => Promise<void> } = {}
): Promise<string> {
  const attempts = Math.max(1, Math.min(options.attempts ?? 30, 120));
  const delayMs = Math.max(50, Math.min(options.delayMs ?? 1000, 30_000));
  const sleepFn = options.sleepFn ?? sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await authenticateDedicatedWorker(config, fetcher);
    } catch (error) {
      lastError = error;
      if (isPermanentAuthenticationError(error) || attempt === attempts) throw error;
      console.error(
        JSON.stringify({
          level: "warn",
          msg: "worker_authentication_retry",
          attempt,
          attempts,
          error: error instanceof Error ? error.message : "UNKNOWN_WORKER_AUTH_ERROR"
        })
      );
      await sleepFn(delayMs);
    }
  }
  throw lastError;
}

export async function runDedicatedWorkerCycle(
  config: DedicatedWorkerConfig,
  accessToken: string,
  fetcher: FetchLike = fetch
): Promise<{ processedJobs: number; empty: boolean; lastJobId: string | null }> {
  let processedJobs = 0;
  let lastJobId: string | null = null;
  for (let index = 0; index < config.maxJobsPerTick; index += 1) {
    const response = await fetcher(`${config.apiBaseUrl}/admin/jobs/run-next`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "x-correlation-id": `${config.workerId}:${Date.now()}`
      },
      body: JSON.stringify({
        workerId: config.workerId,
        ...(config.queue ? { queue: config.queue } : {})
      })
    });
    if (response.status === 401) throw new Error("WORKER_AUTH_EXPIRED");
    if (!response.ok) throw new Error(`WORKER_RUN_NEXT_FAILED:${response.status}:${await safeText(response)}`);
    const result = (await response.json()) as RunNextResponse;
    if (!result.processed) return { processedJobs, empty: true, lastJobId };
    processedJobs += 1;
    lastJobId = result.job?.id ?? lastJobId;
  }
  return { processedJobs, empty: false, lastJobId };
}

async function main(): Promise<void> {
  const config = loadDedicatedWorkerConfig();
  let stopped = false;
  let accessToken = await authenticateDedicatedWorkerWithRetry(config);
  process.on("SIGINT", () => {
    stopped = true;
  });
  process.on("SIGTERM", () => {
    stopped = true;
  });

  console.log(
    JSON.stringify({
      level: "info",
      msg: "dedicated_worker_started",
      workerId: config.workerId,
      queue: config.queue,
      intervalMs: config.intervalMs,
      maxJobsPerTick: config.maxJobsPerTick
    })
  );

  while (!stopped) {
    try {
      const result = await runDedicatedWorkerCycle(config, accessToken);
      console.log(JSON.stringify({ level: "info", msg: "worker_cycle_completed", ...result }));
    } catch (error) {
      if (error instanceof Error && error.message === "WORKER_AUTH_EXPIRED" && config.auth.mode === "login") {
        accessToken = await authenticateDedicatedWorker(config);
      } else {
        console.error(
          JSON.stringify({
            level: "error",
            msg: "worker_cycle_failed",
            error: error instanceof Error ? error.message : "UNKNOWN_WORKER_ERROR"
          })
        );
      }
    }
    await sleep(config.intervalMs);
  }
}

function normalizeWorkerId(value: string): string {
  if (!/^[a-zA-Z0-9._:-]{2,120}$/.test(value)) throw new Error("INVALID_WORKER_ID");
  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function safeText(response: FetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPermanentAuthenticationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const match = /^WORKER_LOGIN_FAILED:(\d{3}):/.exec(error.message);
  if (!match) return error.message === "WORKER_LOGIN_TOKEN_MISSING";
  const status = Number(match[1]);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

if (require.main === module) {
  void main();
}
