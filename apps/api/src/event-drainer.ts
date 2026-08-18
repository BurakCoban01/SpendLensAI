type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export type EventDrainerConfig = {
  apiBaseUrl: string;
  drainerId: string;
  intervalMs: number;
  limit: number;
  includeFailed: boolean;
  auth:
    | { mode: "token"; accessToken: string }
    | { mode: "login"; tenantSlug: string; email: string; password: string };
};

type DrainResponse = {
  attempted: number;
  published: number;
  failed: number;
  dlqPublished: number;
  events: Array<{ id: string; topic: string; state: string; failureReason: string | null; dlqTopic: string | null }>;
};

export function loadEventDrainerConfig(env: NodeJS.ProcessEnv = process.env): EventDrainerConfig {
  const accessToken = env.EVENT_DRAINER_ACCESS_TOKEN?.trim();
  const login = {
    tenantSlug: env.EVENT_DRAINER_TENANT_SLUG?.trim(),
    email: env.EVENT_DRAINER_EMAIL?.trim(),
    password: env.EVENT_DRAINER_PASSWORD
  };
  const auth = accessToken
    ? ({ mode: "token", accessToken } as const)
    : login.tenantSlug && login.email && login.password
      ? ({ mode: "login", tenantSlug: login.tenantSlug, email: login.email, password: login.password } as const)
      : null;
  if (!auth) throw new Error("EVENT_DRAINER_AUTH_NOT_CONFIGURED");

  return {
    apiBaseUrl: trimTrailingSlash(env.EVENT_DRAINER_API_BASE_URL?.trim() || "http://localhost:4000"),
    drainerId: normalizeRuntimeId(env.EVENT_DRAINER_ID?.trim() || "local-event-drainer"),
    intervalMs: parsePositiveInt(env.EVENT_DRAINER_INTERVAL_MS, 5000, 500, 300_000),
    limit: parsePositiveInt(env.EVENT_DRAINER_LIMIT, 25, 1, 100),
    includeFailed: parseBoolean(env.EVENT_DRAINER_INCLUDE_FAILED, false),
    auth
  };
}

export async function authenticateEventDrainer(config: EventDrainerConfig, fetcher: FetchLike = fetch): Promise<string> {
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
  if (!response.ok) throw new Error(`EVENT_DRAINER_LOGIN_FAILED:${response.status}:${await safeText(response)}`);
  const body = (await response.json()) as { tokens?: { accessToken?: string } };
  if (!body.tokens?.accessToken) throw new Error("EVENT_DRAINER_LOGIN_TOKEN_MISSING");
  return body.tokens.accessToken;
}

export async function runEventDrainerCycle(
  config: EventDrainerConfig,
  accessToken: string,
  fetcher: FetchLike = fetch
): Promise<DrainResponse & { empty: boolean }> {
  const response = await fetcher(`${config.apiBaseUrl}/admin/events/drain`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-correlation-id": `${config.drainerId}:${Date.now()}`
    },
    body: JSON.stringify({
      limit: config.limit,
      includeFailed: config.includeFailed
    })
  });
  if (response.status === 401) throw new Error("EVENT_DRAINER_AUTH_EXPIRED");
  if (!response.ok) throw new Error(`EVENT_DRAINER_DRAIN_FAILED:${response.status}:${await safeText(response)}`);
  const result = (await response.json()) as DrainResponse;
  return { ...result, empty: result.attempted === 0 };
}

async function main(): Promise<void> {
  const config = loadEventDrainerConfig();
  let stopped = false;
  let accessToken = await authenticateEventDrainer(config);
  process.on("SIGINT", () => {
    stopped = true;
  });
  process.on("SIGTERM", () => {
    stopped = true;
  });

  console.log(
    JSON.stringify({
      level: "info",
      msg: "event_drainer_started",
      drainerId: config.drainerId,
      intervalMs: config.intervalMs,
      limit: config.limit,
      includeFailed: config.includeFailed
    })
  );

  while (!stopped) {
    try {
      const result = await runEventDrainerCycle(config, accessToken);
      console.log(JSON.stringify({ level: "info", msg: "event_drainer_cycle_completed", ...result }));
    } catch (error) {
      if (error instanceof Error && error.message === "EVENT_DRAINER_AUTH_EXPIRED" && config.auth.mode === "login") {
        accessToken = await authenticateEventDrainer(config);
      } else {
        console.error(
          JSON.stringify({
            level: "error",
            msg: "event_drainer_cycle_failed",
            error: error instanceof Error ? error.message : "UNKNOWN_EVENT_DRAINER_ERROR"
          })
        );
      }
    }
    await sleep(config.intervalMs);
  }
}

function normalizeRuntimeId(value: string): string {
  if (!/^[a-zA-Z0-9._:-]{2,120}$/.test(value)) throw new Error("INVALID_EVENT_DRAINER_RUNTIME_ID");
  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
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

if (require.main === module) {
  void main();
}
