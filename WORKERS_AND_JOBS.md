# Workers And Jobs

SpendLens AI uses PostgreSQL as the durable source of truth for worker job state. Redis hot state and Kafka event consumption are separate operational layers; neither may be required to recover durable job state.

The current foundation is `WorkerJob` in `packages/db/prisma/schema.prisma` and `apps/api/src/modules/jobs`.

Tracked fields:

- queue
- job type
- dedupe key
- status
- progress
- attempts and max attempts
- payload
- result
- failure reason
- worker lock ID
- correlation ID
- lifecycle timestamps

Protected endpoints:

- `GET /admin/jobs`
- `POST /admin/jobs`
- `POST /admin/jobs/:id/start`
- `POST /admin/jobs/:id/progress`
- `POST /admin/jobs/:id/complete`
- `POST /admin/jobs/:id/fail`
- `POST /admin/jobs/:id/retry`
- `POST /admin/jobs/run-next`
- `GET /admin/jobs/workers`
- `POST /admin/jobs/workers/start`
- `POST /admin/jobs/workers/:workerId/stop`

`/admin/jobs` shows queue filters, status filters, backlog counts, progress bars, retry actions and a local `Run next` worker action. Job creation can optionally emit a catalog-backed outbox event such as `ocr.job.created`.

The current local worker runner is intentionally small and deterministic. `POST /admin/jobs/run-next` first takes a non-authoritative cache lock for the tenant and queue, claims the oldest queued job for the authenticated tenant, starts it, records progress, dispatches a supported processor and stores either a result payload or a failure reason. If another worker already holds the queue coordination lock, the endpoint returns `processed: false` with `skippedReason: WORKER_QUEUE_LOCKED` and leaves queued jobs untouched. If Redis/cache is degraded, the runner logs the coordination as degraded and falls back to PostgreSQL job state so work can continue. Supported processor job types:

- `document.preprocess`: validates a payload with `documentFileId` and preprocessing profile, downloads the original object through the document storage adapter, calls the configured OCR preprocessing client and persists returned page artifacts/manifests. When the payload requests Tesseract chaining and an OCR service client is configured, it queues a deduped `ocr.tesseract` job.
- `ocr.tesseract`: validates a payload with `documentFileId` and language, reuses a tenant/document/language-scoped OCR result cache entry when available, otherwise sends the original document to the configured local OCR service, persists the Tesseract result through OCR comparison/ensemble storage and queues a deduped `extraction.from_text` job when selected OCR text is available.
- `ocr.custom_crnn`: validates a payload with `documentFileId` plus optional `modelVersionId` or `checkpoint`, resolves the tenant's active `CUSTOM_CRNN` model artifact when no checkpoint is supplied, reuses a tenant/document/checkpoint-scoped OCR result cache entry when available, otherwise sends the original document to the configured local OCR service `/ocr/custom-crnn` endpoint, persists the custom OCR result through OCR comparison/ensemble storage and queues `extraction.from_text` when selected text is available. Missing active models or invalid local artifact paths fail the job with explicit failure reasons.
- `ocr.compare`: validates a payload with `documentFileId`, OCR candidate runs and optional ground truth, then calls the persisted OCR comparison service and queues a deduped `extraction.from_text` job when selected OCR text is available.
- `extraction.from_text`: validates a payload with `documentFileId`, OCR text and optional source engine, then calls the persisted structured extraction service.
- `model.category_smoke_train`: validates a smoke-training payload, calls the same model service used by `POST /models/category/smoke-train`, persists `ModelTrainingRun`, `ModelVersion` and `ModelEvaluationRun` records, and stores model training/evaluation event outbox rows.
- `model.custom_ocr_smoke_train`: validates a custom OCR smoke-training payload, calls the same model service used by `POST /models/custom-ocr/smoke-train`, persists the custom OCR candidate model registry records and stores model training/evaluation event outbox rows. When `OCR_SERVICE_URL` is configured, the underlying runner delegates PyTorch training to the OCR service.
- `model.category_evaluate`: validates a category-model evaluation payload, resolves the registered `CATEGORY_ML` artifact, runs the local category evaluation script against a bounded generated synthetic split, persists a `ModelEvaluationRun` and stores model evaluation outbox rows.
- `model.ocr_benchmark`: validates a custom OCR benchmark payload, resolves the registered `CUSTOM_CRNN` model artifact, runs the local OCR benchmark harness through the model service, persists a `ModelEvaluationRun` with the benchmark metrics and stores model evaluation outbox rows. The default worker payload skips Tesseract so it remains usable on hosts without the Tesseract CLI; Docker/local benchmark profiles can enable Tesseract when available.
- `report.export`: validates a workspace-scoped report payload, calls the same report service used by `POST /reports/exports`, writes the generated CSV/PDF/JSONL artifact through object storage, persists an `ExportJob` and emits the catalog-backed `report.generated` event.
- `annotation.export_dataset`: validates a workspace-scoped annotation export payload and calls the persisted report/export service with `dataset_export_jsonl`, producing a JSONL artifact with document image references, annotation labels/payloads, corrections and active-learning suggestions.
- `notification.create`: validates a tenant/user-scoped notification payload, persists a `Notification` row through the notification service and makes it visible through `/notifications`.
- `webhook.delivery`: validates a webhook delivery payload, resolves enabled tenant webhook endpoints for the requested catalog event or a specific endpoint ID, calls the configured delivery client and emits `webhook.delivery.requested` outbox evidence with sanitized delivery metadata.
- `cleanup.temp_files`: validates a maintenance payload with optional `subdir`, `maxAgeMs` and `dryRun`, then deletes only expired regular files under the configured local `artifacts/tmp` root. The processor rejects paths that resolve outside that root and can dry-run before deletion.

This runner is useful for local development, API tests and admin-driven recovery.

The API process also has a local automatic worker runtime for development and controlled local operations. `POST /admin/jobs/workers/start` starts an interval-based worker for the authenticated tenant. It repeatedly calls the same runner outside the original admin request, records heartbeat state and can drain more than one queued job per tick. `GET /admin/jobs/workers` returns worker ID, queue scope, status, processed job count, empty poll count, last job ID, last error and heartbeat timestamps. `POST /admin/jobs/workers/:workerId/stop` stops a tenant-owned runtime worker. `/admin/health` reports worker status from these heartbeats.

A dedicated worker process also exists at `apps/api/src/worker.ts`. It runs as `pnpm --filter @spendlens/api dev:worker` in development or `node apps/api/dist/worker.js` after build. The process authenticates with either `WORKER_ACCESS_TOKEN` or `WORKER_TENANT_SLUG`/`WORKER_EMAIL`/`WORKER_PASSWORD`, then repeatedly calls `POST /admin/jobs/run-next`. Docker Compose includes a `worker` service using the API image with `command: ["node", "apps/api/dist/worker.js"]`, and Kubernetes includes `k8s/worker.yaml` for a separate local-cluster worker Deployment.

A standalone Kafka event consumer process exists at `apps/api/src/event-consumer.ts`. It runs as `pnpm --filter @spendlens/api dev:event-consumer` in development or `node apps/api/dist/event-consumer.js` after build. The process subscribes to catalog topics from `KAFKA_BROKERS`, validates event envelopes, records idempotent processed inbox checkpoints and logs invalid broker messages without exposing payload contents. Docker Compose includes an `event-consumer` service, and Kubernetes includes `k8s/event-consumer.yaml` for a separate local-cluster event consumer Deployment.

A standalone event outbox drainer process exists at `apps/api/src/event-drainer.ts`. It runs as `pnpm --filter @spendlens/api dev:event-drainer` in development or `node apps/api/dist/event-drainer.js` after build. The process authenticates with `admin.events.publish`, periodically calls `POST /admin/events/drain`, drains pending outbox rows and can optionally include failed rows for bounded autonomous retry. Docker Compose includes an `event-drainer` service, and Kubernetes includes `k8s/event-drainer.yaml` for a separate local-cluster drainer Deployment.

Lifecycle changes mirror non-authoritative hot state into the cache layer under:

```text
worker-job:<tenantId>:<jobId>
```

The cached payload is intended for fast operational reads and progress displays. It contains status, progress, attempts, max attempts, failure reason, worker lock ID and update time. Cache write failures are tolerated because PostgreSQL remains the recovery source of truth.

Run-next coordination uses cache locks shaped as:

```text
lock:worker-runner:<tenantId>:<queue-or-all>
```

These locks reduce duplicate queue scans across API-runtime workers, dedicated worker containers and manual admin-triggered runs. They are bounded by a short TTL and are released after each cycle. Redis loss does not make durable job state unrecoverable.

OCR result cache entries are shaped as:

```text
ocr-result:<tenantId>:<documentFileId>:<engine-key>
```

They are optimization-only. A cache hit skips repeated OCR service inference but the worker still writes persisted OCR comparison and extraction evidence for the new job.

Worker process environment:

- `WORKER_API_BASE_URL`
- `WORKER_ID`
- `WORKER_QUEUE`
- `WORKER_INTERVAL_MS`
- `WORKER_MAX_JOBS_PER_TICK`
- `WORKER_ACCESS_TOKEN`
- `WORKER_TENANT_SLUG`
- `WORKER_EMAIL`
- `WORKER_PASSWORD`

Kafka event consumer environment:

- `KAFKA_BROKERS`
- `EVENT_CONSUMER_CLIENT_ID`
- `EVENT_CONSUMER_GROUP_ID`
- `EVENT_CONSUMER_NAME`
- `EVENT_CONSUMER_TOPICS`

Event drainer environment:

- `EVENT_DRAINER_API_BASE_URL`
- `EVENT_DRAINER_ID`
- `EVENT_DRAINER_INTERVAL_MS`
- `EVENT_DRAINER_LIMIT`
- `EVENT_DRAINER_INCLUDE_FAILED`
- `EVENT_DRAINER_ACCESS_TOKEN`
- `EVENT_DRAINER_TENANT_SLUG`
- `EVENT_DRAINER_EMAIL`
- `EVENT_DRAINER_PASSWORD`

Pending work:

- live Redis-backed coordination verification in the local stack
- live Kafka/Redpanda consumer validation in the local stack
- richer DLQ replay policies beyond bounded failed-event retry
