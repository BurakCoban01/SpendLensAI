# Redis And Caching

Redis is the hot-state and coordination layer. PostgreSQL and MinIO remain the recovery sources of truth for durable business data, documents, jobs, events, model metadata and generated artifacts.

## Current Foundation

Implemented modules:

- `apps/api/src/modules/cache`
- `RedisCacheStore` using `ioredis`
- `InMemoryCacheStore` for deterministic tests and local fallback when `REDIS_URL` is absent
- `CacheService` for key normalization, JSON hot state, cache status and lock operations
- system lock helpers for worker/runtime coordination without tying ownership to an end-user session
- protected admin routes under `/admin/cache`
- `/admin/cache` frontend operations page

Permissions:

- `admin.cache.read` can inspect backend health and key summaries.
- `admin.cache.manage` can test lock acquire/release behavior.

Current endpoints:

- `GET /admin/cache?prefix=worker-job:&limit=50`
- `POST /admin/cache/locks/acquire`
- `POST /admin/cache/locks/release`

Worker job lifecycle updates mirror safe hot state into keys shaped as:

```text
worker-job:<tenantId>:<jobId>
```

The mirrored payload includes job status, progress, attempts, max attempts, failure reason, worker lock ID and update time. Cache writes are best effort; failure to write hot state does not roll back the PostgreSQL job transition.

Worker `run-next` coordination uses queue-scoped locks shaped as:

```text
lock:worker-runner:<tenantId>:<queue-or-all>
```

The runner takes this lock before scanning queued jobs. If another worker owns the lock, `POST /admin/jobs/run-next` returns `processed: false`, `job: null` and `skippedReason: WORKER_QUEUE_LOCKED`. If Redis/cache is unavailable, the runner falls back to PostgreSQL job state and marks coordination as degraded instead of dropping work.

Document upload duplicate quick checks use cache keys shaped as:

```text
document-duplicate:<tenantId>:<sha256>
```

This key stores the canonical document ID for a previously uploaded file hash. Upload still confirms the cached document through the repository before returning a duplicate response, and falls back to the persistent SHA-256 lookup if the cache is missing, stale or unavailable.

Global API rate limiting uses Redis when `REDIS_URL` is configured and memory adapters are disabled. The limiter stores counters with the namespace:

```text
spendlens-rate-limit-
```

Rate limiting is configured with `RATE_LIMIT_MAX` and `RATE_LIMIT_TIME_WINDOW`. Redis-backed rate limiting is best-effort with `skipOnError` enabled, so a temporary Redis outage does not block local core flows; admin health exposes the `redisRateLimit` feature flag so operators can see whether distributed request budgets are active.

OCR worker result caching uses keys shaped as:

```text
ocr-result:<tenantId>:<documentFileId>:<engine-key>
```

The engine key stores a short hash of OCR runtime settings such as Tesseract language or custom CRNN checkpoint path. A cache hit skips the expensive OCR service call, then still persists a fresh OCR comparison row and chained extraction job through PostgreSQL-backed services. Cache misses and cache errors fall back to normal OCR execution.

Expense category/anomaly model inference caching uses keys shaped as:

```text
model-inference:<tenantId>:expense-category:<expenseId>:<fingerprint>
```

The fingerprint is derived from the analyzed expense, workspace peer expense context and local model version. `GET /expenses/:id/ai-analysis` can populate this cache without mutating durable state; `POST /expenses/:id/ai-analysis` can reuse the cached prediction/anomaly payload while still writing a new `MLCategoryPrediction`, updating `Expense.categoryId` and recording audit evidence in PostgreSQL. Cache misses and cache errors fall back to local deterministic inference.

Dashboard analytics and operations caching uses keys shaped as:

```text
dashboard:<tenantId>:monthly-spend:<workspaceId>:<month>:<fingerprint>
dashboard:<tenantId>:budget-usage:<workspaceId>:<month>:<fingerprint>
dashboard:<tenantId>:admin-health:<fingerprint>
```

The fingerprint is derived from the month-scoped expenses and workspace budgets used by `GET /analytics/monthly-spend` and `GET /budgets`. Cache values are stored in JSON-safe string form for monetary and date fields, then restored to domain types before the route serializes the response. Cache hits avoid recomputing monthly spend or budget usage; cache misses still upsert authoritative `BudgetPeriod` rows from PostgreSQL expense data.

The admin health operations fingerprint is derived from tenant workspace, document and expense rows plus local operations configuration. Cache hits avoid repeated object-storage metrics calls and operations snapshot reconstruction for repeated `GET /admin/health` reads; cache misses still calculate the snapshot from PostgreSQL repositories and object-storage health.

## Locks

Redis locks use `SET key owner PX ttl NX` and owner-checked Lua release. The in-memory adapter implements the same owner and TTL semantics for route tests.

Example lock payload:

```json
{
  "key": "worker-lock:ocr:document-id",
  "owner": "worker-1",
  "ttlMs": 30000
}
```

## Degraded Mode

If `REDIS_URL` is not configured, the API uses the in-memory adapter. This keeps local tests and development usable, but in-memory cache state is process-local and not suitable for multi-process worker coordination.

If Redis is configured but unavailable, `/admin/cache` reports a disconnected backend. Durable user flows must continue to rely on PostgreSQL/MinIO state and should surface degraded coordination where Redis-backed behavior is required.

## Pending Integrations

- live Redis verification through Docker Compose once the local Docker runtime is healthy
- broader model inference caches beyond expense category analysis
- broader dashboard caches beyond the implemented monthly spend, budget usage and admin-health operations reads
- recovery tests proving Redis loss does not lose documents, expenses, OCR results or model metadata
