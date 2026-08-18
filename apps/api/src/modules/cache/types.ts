export type CacheBackend = "memory" | "redis";

export type CacheKeySummary = {
  key: string;
  ttlSeconds: number | null;
};

export type CacheHealth = {
  backend: CacheBackend;
  connected: boolean;
  detail?: string;
};

export type CacheOperationErrorMetric = {
  operation: string;
  count: number;
};

export type CacheSetInput = {
  key: string;
  value: Record<string, unknown>;
  ttlSeconds?: number;
};

export type CacheLockInput = {
  key: string;
  owner: string;
  ttlMs: number;
};

export type CacheStore = {
  readonly backend: CacheBackend;
  getJson<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  setJson(input: CacheSetInput): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(prefix: string, limit?: number): Promise<CacheKeySummary[]>;
  acquireLock(input: CacheLockInput): Promise<boolean>;
  releaseLock(input: { key: string; owner: string }): Promise<boolean>;
  health(): Promise<CacheHealth>;
  operationErrorCounts(): Promise<CacheOperationErrorMetric[]>;
  close?(): Promise<void>;
};
