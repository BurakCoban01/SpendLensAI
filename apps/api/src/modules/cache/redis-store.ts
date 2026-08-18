import Redis from "ioredis";
import type { CacheHealth, CacheKeySummary, CacheLockInput, CacheSetInput, CacheStore } from "./types";

export class RedisCacheStore implements CacheStore {
  readonly backend = "redis" as const;
  private readonly client: Redis;
  private readonly operationErrors = new Map<string, number>();

  constructor(url: string) {
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    });
  }

  async getJson<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    return this.trackOperation("get", async () => {
      await this.ensureConnected();
      const value = await this.client.get(key);
      return value ? (JSON.parse(value) as T) : null;
    });
  }

  async setJson(input: CacheSetInput): Promise<void> {
    await this.trackOperation("set", async () => {
      await this.ensureConnected();
      const value = JSON.stringify(input.value);
      if (input.ttlSeconds) {
        await this.client.set(input.key, value, "EX", input.ttlSeconds);
        return;
      }
      await this.client.set(input.key, value);
    });
  }

  async delete(key: string): Promise<void> {
    await this.trackOperation("delete", async () => {
      await this.ensureConnected();
      await this.client.del(key);
    });
  }

  async listKeys(prefix: string, limit = 50): Promise<CacheKeySummary[]> {
    return this.trackOperation("list_keys", async () => {
      await this.ensureConnected();
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [nextCursor, batch] = await this.client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", "50");
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== "0" && keys.length < limit);
      return Promise.all(
        keys
          .sort()
          .slice(0, limit)
          .map(async (key) => {
            const ttl = await this.client.ttl(key);
            return { key, ttlSeconds: ttl >= 0 ? ttl : null };
          })
      );
    });
  }

  async acquireLock(input: CacheLockInput): Promise<boolean> {
    return this.trackOperation("acquire_lock", async () => {
      await this.ensureConnected();
      const result = await this.client.set(input.key, input.owner, "PX", input.ttlMs, "NX");
      return result === "OK";
    });
  }

  async releaseLock(input: { key: string; owner: string }): Promise<boolean> {
    return this.trackOperation("release_lock", async () => {
      await this.ensureConnected();
      const script = [
        "if redis.call('get', KEYS[1]) == ARGV[1] then",
        "  return redis.call('del', KEYS[1])",
        "else",
        "  return 0",
        "end"
      ].join("\n");
      const result = await this.client.eval(script, 1, input.key, input.owner);
      return result === 1;
    });
  }

  async health(): Promise<CacheHealth> {
    try {
      if (this.client.status === "wait") await this.client.connect();
      const pong = await this.client.ping();
      return { backend: this.backend, connected: pong === "PONG" };
    } catch (error) {
      this.recordOperationError("health");
      return { backend: this.backend, connected: false, detail: error instanceof Error ? error.message : "REDIS_UNAVAILABLE" };
    }
  }

  async operationErrorCounts() {
    return [...this.operationErrors.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([operation, count]) => ({ operation, count }));
  }

  async close(): Promise<void> {
    this.client.disconnect();
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === "wait") await this.client.connect();
  }

  private async trackOperation<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.recordOperationError(operation);
      throw error;
    }
  }

  private recordOperationError(operation: string): void {
    this.operationErrors.set(operation, (this.operationErrors.get(operation) ?? 0) + 1);
  }
}
