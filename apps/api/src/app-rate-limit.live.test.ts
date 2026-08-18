import Redis from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const runLive = process.env.SPENDLENS_LIVE_SECURITY_TESTS === "1" || process.env.SPENDLENS_LIVE_REDIS_TESTS === "1";
const describeLive = runLive ? describe : describe.skip;
const redisUrl = process.env.REDIS_URL || "redis://localhost:16380";

describeLive("api app live Redis rate limiting", () => {
  const redisClients: Redis[] = [];

  afterEach(async () => {
    await Promise.all(redisClients.splice(0).map((client) => client.quit().catch(() => client.disconnect())));
  });

  it("enforces request budgets through the real Redis-backed rate-limit store", async () => {
    const redis = createRedisClient();
    const requesterIp = "192.0.2.44";
    const rateLimitKey = `spendlens-rate-limit-${requesterIp}`;
    await redis.connect();
    await redis.del(rateLimitKey);

    const app = await buildApp({
      rateLimitRedisClient: redis,
      config: {
        SPENDLENS_USE_MEMORY_ADAPTERS: true,
        RATE_LIMIT_MAX: 2,
        RATE_LIMIT_TIME_WINDOW: "1 minute"
      }
    });

    try {
      const request = () =>
        app.inject({
          method: "GET",
          url: "/health/live",
          remoteAddress: requesterIp
        });

      const first = await request();
      const second = await request();
      const third = await request();

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(third.statusCode).toBe(429);
      expect(third.headers["x-ratelimit-limit"]).toBe("2");
      expect(third.headers["retry-after"]).toBeDefined();

      const ttl = await redis.ttl(rateLimitKey);
      const exists = await redis.exists(rateLimitKey);
      expect(exists).toBe(1);
      expect(ttl).toBeGreaterThan(0);
    } finally {
      await app.close();
      await redis.del(rateLimitKey);
    }
  });

  function createRedisClient(): Redis {
    const client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    });
    redisClients.push(client);
    return client;
  }
});
