import { describe, expect, it } from "vitest";
import { authenticateEventDrainer, loadEventDrainerConfig, runEventDrainerCycle } from "./event-drainer";

describe("event drainer entrypoint", () => {
  it("loads token-based config with bounded drain settings", () => {
    const config = loadEventDrainerConfig({
      EVENT_DRAINER_ACCESS_TOKEN: "token",
      EVENT_DRAINER_API_BASE_URL: "http://api:4000/",
      EVENT_DRAINER_ID: "drainer-1",
      EVENT_DRAINER_INTERVAL_MS: "5",
      EVENT_DRAINER_LIMIT: "500",
      EVENT_DRAINER_INCLUDE_FAILED: "true"
    } as NodeJS.ProcessEnv);

    expect(config).toMatchObject({
      apiBaseUrl: "http://api:4000",
      drainerId: "drainer-1",
      intervalMs: 500,
      limit: 100,
      includeFailed: true,
      auth: { mode: "token", accessToken: "token" }
    });
  });

  it("logs in with drainer credentials when no bearer token is supplied", async () => {
    const config = loadEventDrainerConfig({
      EVENT_DRAINER_API_BASE_URL: "http://api:4000",
      EVENT_DRAINER_TENANT_SLUG: "ops",
      EVENT_DRAINER_EMAIL: "events@example.com",
      EVENT_DRAINER_PASSWORD: "very-secure-password"
    } as NodeJS.ProcessEnv);
    const calls: Array<{ url: string; body: unknown }> = [];

    const token = await authenticateEventDrainer(config, async (url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return jsonResponse(200, { tokens: { accessToken: "access-token" } });
    });

    expect(token).toBe("access-token");
    expect(calls[0]).toMatchObject({
      url: "http://api:4000/auth/login",
      body: {
        tenantSlug: "ops",
        email: "events@example.com",
        password: "very-secure-password"
      }
    });
  });

  it("drains outbox events through the admin event drain endpoint", async () => {
    const config = loadEventDrainerConfig({
      EVENT_DRAINER_ACCESS_TOKEN: "token",
      EVENT_DRAINER_API_BASE_URL: "http://api:4000",
      EVENT_DRAINER_ID: "drainer-2",
      EVENT_DRAINER_LIMIT: "3",
      EVENT_DRAINER_INCLUDE_FAILED: "true"
    } as NodeJS.ProcessEnv);

    const result = await runEventDrainerCycle(config, "access-token", async (url, init) => {
      expect(url).toBe("http://api:4000/admin/events/drain");
      expect(init?.headers?.authorization).toBe("Bearer access-token");
      expect(init?.headers?.["x-correlation-id"]).toMatch(/^drainer-2:/);
      expect(init?.body ? JSON.parse(init.body) : null).toEqual({ limit: 3, includeFailed: true });
      return jsonResponse(200, {
        attempted: 2,
        published: 1,
        failed: 1,
        dlqPublished: 1,
        events: [
          { id: "event_1", topic: "expense.created", state: "published", failureReason: null, dlqTopic: null },
          {
            id: "event_2",
            topic: "expense.updated",
            state: "failed",
            failureReason: "DLQ:expense.updated.dlq:producer failed",
            dlqTopic: "expense.updated.dlq"
          }
        ]
      });
    });

    expect(result).toMatchObject({ attempted: 2, published: 1, failed: 1, dlqPublished: 1, empty: false });
  });

  it("reports an empty cycle when no events are attempted", async () => {
    const config = loadEventDrainerConfig({
      EVENT_DRAINER_ACCESS_TOKEN: "token",
      EVENT_DRAINER_API_BASE_URL: "http://api:4000"
    } as NodeJS.ProcessEnv);

    const result = await runEventDrainerCycle(config, "access-token", async () =>
      jsonResponse(200, { attempted: 0, published: 0, failed: 0, dlqPublished: 0, events: [] })
    );

    expect(result.empty).toBe(true);
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
