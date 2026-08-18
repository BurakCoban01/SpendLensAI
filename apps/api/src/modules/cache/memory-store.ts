import type { CacheHealth, CacheKeySummary, CacheLockInput, CacheSetInput, CacheStore } from "./types";

type Entry = {
  value: Record<string, unknown>;
  expiresAt: number | null;
};

type LockEntry = {
  owner: string;
  expiresAt: number;
};

export class InMemoryCacheStore implements CacheStore {
  readonly backend = "memory" as const;
  private readonly entries = new Map<string, Entry>();
  private readonly locks = new Map<string, LockEntry>();

  async getJson<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry || isExpired(entry.expiresAt)) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async setJson(input: CacheSetInput): Promise<void> {
    this.entries.set(input.key, {
      value: input.value,
      expiresAt: input.ttlSeconds ? Date.now() + input.ttlSeconds * 1000 : null
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async listKeys(prefix: string, limit = 50): Promise<CacheKeySummary[]> {
    const now = Date.now();
    return [...this.entries.entries()]
      .filter(([key, entry]) => {
        if (isExpired(entry.expiresAt, now)) {
          this.entries.delete(key);
          return false;
        }
        return key.startsWith(prefix);
      })
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([key, entry]) => ({
        key,
        ttlSeconds: entry.expiresAt ? Math.max(0, Math.ceil((entry.expiresAt - now) / 1000)) : null
      }));
  }

  async acquireLock(input: CacheLockInput): Promise<boolean> {
    const existing = this.locks.get(input.key);
    if (existing && !isExpired(existing.expiresAt)) return false;
    this.locks.set(input.key, { owner: input.owner, expiresAt: Date.now() + input.ttlMs });
    return true;
  }

  async releaseLock(input: { key: string; owner: string }): Promise<boolean> {
    const existing = this.locks.get(input.key);
    if (!existing || existing.owner !== input.owner) return false;
    this.locks.delete(input.key);
    return true;
  }

  async health(): Promise<CacheHealth> {
    return { backend: this.backend, connected: true };
  }

  async operationErrorCounts() {
    return [];
  }

  async close(): Promise<void> {
    this.entries.clear();
    this.locks.clear();
  }
}

function isExpired(expiresAt: number | null, now = Date.now()): boolean {
  return expiresAt !== null && expiresAt <= now;
}
