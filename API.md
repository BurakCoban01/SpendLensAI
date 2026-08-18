# API

The API is served by `apps/api` and publishes Swagger UI at `/docs` plus the OpenAPI JSON contract at `/docs/json`. The OpenAPI contract includes local bearer/API-key security schemes, reusable error/money/validation schemas and example payloads for representative auth, expense, document reprocess and Turkish sandbox workflows.

Current endpoints:

- `GET /health/live`
- `GET /health/ready`
- `GET /admin/health`
- `POST /admin/operations/documents/:id/reprocess`
- `GET /admin/events/catalog`
- `GET /admin/events`
- `POST /admin/events/outbox`
- `POST /admin/events/drain`
- `GET /admin/events/dlq`
- `POST /admin/events/dlq/replay`
- `GET /admin/events/inbox`
- `POST /admin/events/inbox/record`
- `POST /admin/events/:id/requeue`
- `POST /admin/events/:id/mark-published`
- `POST /admin/events/:id/mark-failed`
- `GET /admin/jobs`
- `POST /admin/jobs`
- `POST /admin/jobs/:id/start`
- `POST /admin/jobs/:id/progress`
- `POST /admin/jobs/:id/complete`
- `POST /admin/jobs/:id/fail`
- `POST /admin/jobs/:id/retry`
- `POST /admin/jobs/run-next`
- `GET /admin/cache`
- `POST /admin/cache/locks/acquire`
- `POST /admin/cache/locks/release`
- `GET /admin/audit`
- `POST /admin/audit/export`
- `POST /admin/audit/retention`
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/logout-all`
- `GET /auth/me`
- `GET /auth/sessions`
- `POST /api-keys`
- `GET /api-keys`
- `DELETE /api-keys/:id`
- `GET /api-keys/automation-check`
- `GET /workspaces`
- `GET /ai/providers/status`
- `POST /ai/extraction/assist`
- `GET /documents/search`
- `POST /documents/upload`
- `GET /documents`
- `POST /documents/:id/download-url`
- `DELETE /documents/:id`
- `POST /documents/:id/ocr-runs/compare`
- `GET /documents/:id/ocr-runs`
- `POST /documents/:id/extraction`
- `GET /documents/:id/extraction`
- `POST /documents/:id/extraction/line-items`
- `POST /sandbox/turkish/parse`
- `POST /expenses`
- `GET /expenses`
- `POST /expenses/imports`
- `GET /expenses/imports`
- `PATCH /expenses/:id`
- `GET /expenses/:id/attachments`
- `POST /expenses/:id/attachments`
- `DELETE /expenses/:id/attachments/:documentFileId`
- `GET /expenses/:id/comments`
- `POST /expenses/:id/comments`
- `POST /expenses/:id/split`
- `GET /expenses/:id/ai-analysis`
- `POST /expenses/:id/ai-analysis`
- `POST /documents/:id/expense`
- `POST /expenses/:id/approve`
- `POST /expenses/:id/reject`
- `GET /approvals/sla`
- `POST /expenses/:id/archive`
- `GET /subscriptions`
- `POST /subscriptions/detect`
- `GET /recurring-expenses`
- `POST /expenses/:id/recurring`
- `POST /recurring-expenses/:id/generate`
- `POST /budgets`
- `GET /budgets`
- `GET /analytics/monthly-spend`
- `GET /analytics/finance-insights`
- `POST /reports/exports`
- `GET /reports/exports`
- `GET /models`
- `POST /models/category/smoke-train`
- `POST /models/category/full-train`
- `POST /models/custom-ocr/smoke-train`
- `POST /models/custom-ocr/full-train`
- `POST /models/custom-ocr/train-from-dataset-export`
- `POST /models/:id/promote`
- `POST /models/:id/ocr-benchmark`
- `POST /models/:id/rollback`
- `GET /notifications`
- `POST /notifications/:id/read`
- `GET /webhooks`
- `POST /webhooks`
- `DELETE /webhooks/:id`
- `POST /documents/:id/review-tasks`
- `GET /review/tasks`
- `GET /review/reviewers`
- `GET /review/workload`
- `GET /review/rebalance-suggestions`
- `POST /review/escalations/run`
- `POST /review/tasks/:id/assign`
- `POST /review/tasks/:id/complete`
- `POST /review/tasks/:id/reject`
- `POST /documents/:id/corrections`
- `GET /documents/:id/corrections`
- `POST /documents/:id/annotations`
- `GET /documents/:id/annotations`
- `GET /active-learning/suggestions`
- `GET /catalog`
- `GET /metrics`

Auth endpoints use email/password authentication, scrypt password hashes, signed access tokens, refresh token rotation and session inventory. Refresh tokens are stored by hash only.

API key endpoints are protected by `api_keys.manage`. Raw API keys are returned only once during creation; persisted records store only a prefix, hash, scopes, creator and lifecycle timestamps. Automation callers use `Authorization: ApiKey <raw-key>` plus `x-tenant-id`.

`GET /admin/health` is protected by `admin.health.read`. Public readiness remains available through `GET /health/live` and `GET /health/ready`. The admin response includes dependency checks plus an operations snapshot with tenant workspace/document/expense counts, active spend totals by currency, storage backend/object/error status, tenant storage soft-quota utilization from `TENANT_STORAGE_SOFT_LIMIT_BYTES`, the configured API rate-limit budget, the `redisRateLimit` feature flag when Redis-backed request budgets are active, local feature flags and runbook references. Repeated reads can reuse `dashboard:<tenantId>:admin-health:<fingerprint>` cache entries derived from tenant usage rows and operations configuration; PostgreSQL and object storage remain the recovery sources of truth.

`POST /admin/operations/documents/:id/reprocess` is protected by both `admin.health.read` and `admin.jobs.manage`. It validates that the document belongs to the authenticated tenant and queues selected local worker stages without relying on public exposure or external services:

```json
{
  "stages": ["preprocess", "tesseract", "custom_crnn"],
  "preprocessingProfile": "TESSERACT_OPTIMIZED",
  "language": "tur+eng",
  "checkpoint": null
}
```

The response returns the tenant document ID, workspace ID and queued `WorkerJob` rows for the selected stages. The workers still apply their normal runtime failure handling, including visible custom OCR failure when no active checkpoint is available.

Admin event endpoints expose the durable Kafka outbox foundation.

`GET /admin/events/catalog` and `GET /admin/events` are protected by `admin.events.read`. Events can be filtered by topic and state:

```text
GET /admin/events?topic=expense.created&state=pending
```

`GET /admin/events/dlq` is protected by `admin.events.read` and returns failed outbox events whose failure reason contains recorded DLQ delivery evidence. `POST /admin/events/dlq/replay` is protected by `admin.events.publish` and replays a bounded DLQ batch by optional topic and failure-reason filter. Send `{ "topic": "expense.rejected", "reasonContains": "PRODUCER_FAILED", "limit": 25, "dryRun": true }` to preview candidates without mutating rows, or set `dryRun` to `false` to move matching DLQ-backed failures back to pending. `POST /admin/events/:id/requeue` is protected by `admin.events.publish` and moves a failed event back to pending by clearing its failure reason and published timestamp.

`POST /admin/events/outbox`, `POST /admin/events/drain`, `POST /admin/events/dlq/replay`, `POST /admin/events/:id/requeue`, `POST /admin/events/:id/mark-published` and `POST /admin/events/:id/mark-failed` are protected by `admin.events.publish`. The manual outbox endpoint validates topics against the shared catalog:

```json
{
  "topic": "expense.created",
  "aggregateId": "expense-id",
  "schemaVersion": 1,
  "payload": {
    "workspaceId": "workspace-id",
    "amountMinor": "18550"
  }
}
```

`POST /admin/events/drain` attempts to publish pending outbox events through the configured Kafka producer. When `KAFKA_BROKERS` is set, the API uses the local Kafka-compatible broker list with `kafkajs`. If broker delivery fails, the service attempts to publish a failure envelope to the topic's cataloged DLQ topic and marks the event failed with the recorded reason. If no producer is configured, the endpoint returns a clear degraded-service error and leaves events durable in PostgreSQL.

```json
{
  "limit": 25,
  "includeFailed": false
}
```

The standalone event drainer runtime is `apps/api/src/event-drainer.ts`. It runs as `pnpm --filter @spendlens/api dev:event-drainer` in development or `node apps/api/dist/event-drainer.js` after build. It authenticates with `admin.events.publish`, periodically calls the same drain endpoint and can include failed events for bounded autonomous retry when `EVENT_DRAINER_INCLUDE_FAILED=true`.

Drainer runtime environment:

- `EVENT_DRAINER_API_BASE_URL`
- `EVENT_DRAINER_ID`
- `EVENT_DRAINER_INTERVAL_MS`
- `EVENT_DRAINER_LIMIT`
- `EVENT_DRAINER_INCLUDE_FAILED`
- `EVENT_DRAINER_ACCESS_TOKEN`
- `EVENT_DRAINER_TENANT_SLUG`
- `EVENT_DRAINER_EMAIL`
- `EVENT_DRAINER_PASSWORD`

`GET /admin/events/inbox` and `POST /admin/events/inbox/record` provide the operator/API-facing consumer inbox path. The inbox records one processed or failed event per `consumerName` + event ID, rejects envelopes whose tenant ID does not match the authenticated principal and can be filtered by consumer, topic and status.

```json
{
  "consumerName": "expense-projection",
  "status": "processed",
  "event": {
    "id": "event-id",
    "topic": "expense.created",
    "tenantId": "tenant-id",
    "aggregateId": "expense-id",
    "schemaVersion": 1,
    "correlationId": "correlation-id",
    "payload": {
      "workspaceId": "workspace-id"
    }
  }
}
```

The standalone Kafka consumer runtime is `apps/api/src/event-consumer.ts`. It runs as `pnpm --filter @spendlens/api dev:event-consumer` in development or `node apps/api/dist/event-consumer.js` after build. It reads envelopes from configured catalog topics, validates topic names, records idempotent processed inbox checkpoints and logs invalid messages as structured errors without payload disclosure.

Consumer runtime environment:

- `KAFKA_BROKERS`
- `EVENT_CONSUMER_CLIENT_ID`
- `EVENT_CONSUMER_GROUP_ID`
- `EVENT_CONSUMER_NAME`
- `EVENT_CONSUMER_TOPICS`

Admin job endpoints expose durable worker job state.

`GET /admin/jobs` is protected by `admin.jobs.read` and supports optional `queue`, `status` and `limit` query parameters. `POST /admin/jobs` and lifecycle transition endpoints are protected by `admin.jobs.manage`.

```json
{
  "queue": "ocr",
  "jobType": "ocr.tesseract",
  "dedupeKey": "document-id:tesseract",
  "eventTopic": "ocr.job.created",
  "aggregateId": "document-id",
  "payload": {
    "documentFileId": "document-id",
    "engine": "TESSERACT"
  }
}
```

Job lifecycle endpoints record status, progress, attempts, worker lock ID, result payload and failure reason in PostgreSQL-backed state. Lifecycle changes also mirror non-authoritative hot state to cache keys shaped as `worker-job:<tenantId>:<jobId>` with a short TTL.

`POST /admin/jobs/run-next` is protected by `admin.jobs.manage`. It runs the oldest queued job for the authenticated tenant, optionally scoped by queue:

```json
{
  "queue": "ocr",
  "workerId": "api-local-worker"
}
```

Each run-next cycle uses a short cache coordination lock shaped as `lock:worker-runner:<tenantId>:<queue-or-all>`. If another worker holds the lock, the response is `processed: false`, `job: null` and `skippedReason: WORKER_QUEUE_LOCKED`. If Redis/cache is degraded, the runner falls back to PostgreSQL state and reports degraded coordination in the response.

The local runner currently supports `document.preprocess`, `ocr.tesseract`, `ocr.custom_crnn`, `ocr.compare`, `extraction.from_text`, `model.category_smoke_train`, `model.custom_ocr_smoke_train`, `model.category_evaluate`, `model.ocr_benchmark`, `report.export`, `annotation.export_dataset`, `notification.create`, `webhook.delivery` and `cleanup.temp_files`, calling the same persisted document, model registry, report, OCR comparison, notification, webhook and structured extraction services used by the direct API routes where applicable. `document.preprocess` downloads the original object, calls the configured local OCR preprocessing service and persists processed page artifacts. When `OCR_SERVICE_URL` is configured, upload-created preprocessing jobs carry `runTesseractAfter: true`; successful preprocessing then queues a deduped `ocr.tesseract` job. `ocr.tesseract` and `ocr.custom_crnn` can reuse `ocr-result:<tenantId>:<documentFileId>:<engine-key>` cache entries to avoid repeated OCR service inference, but still store new OCR comparison and extraction evidence. `ocr.tesseract` sends the original document to the local OCR service on cache miss, stores the Tesseract output through the comparison/ensemble repository and queues `extraction.from_text` from the selected text. `ocr.custom_crnn` normally resolves the tenant's active `CUSTOM_CRNN` model version, verifies that registry models are active, artifact-backed and real-fixture validated, calls the local OCR service `POST /ocr/custom-crnn` on cache miss, persists the custom OCR candidate through comparison/ensemble storage and queues extraction from selected text only when OCR quality gates allow it. Registry-external checkpoint payloads are rejected with `CUSTOM_OCR_UNREGISTERED_CHECKPOINT_DISABLED` unless the explicit local diagnostic flag `CUSTOM_OCR_ALLOW_UNREGISTERED_CHECKPOINT=1` is set. If no active model is available, or an active registry model is smoke-only/unvalidated/failed real-fixture gates, the job fails visibly with a stored failure reason. The `model.*_smoke_train` jobs call the same `ModelService` used by `/models`, so training runs, evaluation runs, candidate model versions and model outbox events are persisted consistently. `model.category_evaluate` resolves a registered `CATEGORY_ML` artifact, runs the local category evaluation script against a generated bounded synthetic split and persists a `ModelEvaluationRun`. `model.ocr_benchmark` resolves a registered `CUSTOM_CRNN` artifact, runs the local OCR benchmark harness with bounded sample settings, persists a `ModelEvaluationRun` and records benchmark report artifact metadata. `report.export` calls the same `ReportService` used by `/reports/exports`, stores the generated artifact through object storage, persists the export job and emits `report.generated`. `annotation.export_dataset` uses the same report/export path with `dataset_export_jsonl` so annotation labels, correction history and active-learning suggestions can be exported by a queued worker. `notification.create` persists a tenant/user-scoped notification that can be listed and marked read through `/notifications`. `webhook.delivery` resolves enabled tenant webhook endpoints, invokes the configured local delivery client and emits `webhook.delivery.requested` outbox evidence with sanitized delivery metadata. `cleanup.temp_files` deletes only expired files under the configured local `artifacts/tmp` root and supports dry-run summaries. Successful manual `ocr.compare` jobs also enqueue a deduped `extraction.from_text` job from the selected OCR text. The runner returns `{ "processed": false, "job": null }` when no queued job matches.

Notification endpoints are authenticated and tenant/user scoped. `GET /notifications` returns only the caller's notifications and supports `unreadOnly` plus `limit`. `POST /notifications/:id/read` marks only a caller-owned notification as read.

AI assistance endpoints are local-first and truthful about provider state. `GET /ai/providers/status` is protected by `ai.use` and reports whether deterministic local extraction, Gemini and Z.ai are configured, disabled or blocked by raw-input policy. `POST /ai/extraction/assist` can ask a configured provider for extraction assistance, but falls back to deterministic local extraction when external LLM providers are disabled. Raw OCR/input storage remains opt-in through configuration and is reflected in the provider-status response.

`GET /documents/search` is protected by `documents.read`. It runs tenant-scoped local lexical search over persisted document metadata/OCR/extraction evidence and records a hashed query audit marker (`queryHash`) without requiring external embeddings.

Webhook endpoints are protected by `webhooks.manage`. `POST /webhooks` validates event types against the shared Kafka catalog, accepts only HTTP(S) URLs without embedded credentials, stores a hash plus encrypted signing material, and returns the raw `whsec_...` secret once at creation time. Worker delivery signs payloads with HMAC SHA-256 using `x-spendlens-signature: v1=<signature>` over the timestamp, delivery ID and canonical JSON body. `x-spendlens-signature-status` is `signed_hmac_sha256` for new endpoints with encrypted signing material; legacy hash-only endpoints are labeled `unsigned_legacy_secret_hash_only` instead of being presented as signed. `DELETE /webhooks/:id` disables the endpoint instead of deleting history. Local webhook delivery is worker-driven and should target local/private development receivers unless a user explicitly configures otherwise.

The local automatic worker runtime is protected by the same admin job permissions:

```text
GET /admin/jobs/workers
POST /admin/jobs/workers/start
POST /admin/jobs/workers/:workerId/stop
```

`POST /admin/jobs/workers/start` starts an interval worker for the authenticated tenant and can optionally scope it to a queue:

```json
{
  "queue": "ocr",
  "workerId": "api-runtime-worker",
  "intervalMs": 1000,
  "maxJobsPerTick": 5
}
```

Runtime heartbeats expose worker ID, queue scope, status, processed job count, empty polls, last job ID, last error and heartbeat timestamps. This is the local API-process runtime; dedicated worker containers, the standalone Kafka event consumer and the standalone event drainer run as separate processes (see `RUNNING.md`).

Admin cache endpoints expose Redis/in-memory hot-state operations.

`GET /admin/cache` is protected by `admin.cache.read` and supports optional `prefix` and `limit` query parameters:

```text
GET /admin/cache?prefix=worker-job:&limit=25
```

It returns cache backend health plus matching key summaries and TTL values. `POST /admin/cache/locks/acquire` and `POST /admin/cache/locks/release` are protected by `admin.cache.manage`:

```json
{
  "key": "worker-lock:ocr:document-id",
  "owner": "worker-1",
  "ttlMs": 30000
}
```

Redis is treated as a hot coordination layer only. PostgreSQL remains the source of truth for documents, expenses, jobs, events and model metadata.

Admin audit endpoints expose tenant-scoped sensitive action history.

`GET /admin/audit` is protected by `admin.audit.read` and supports optional `action`, `resourceType`, `actorUserId` and `limit` query parameters:

```text
GET /admin/audit?action=expense.approved&resourceType=Expense&limit=50
```

The response includes immutable audit rows plus action and resource summaries for the authenticated tenant. It never returns another tenant's audit rows.

`POST /admin/audit/export` is protected by `admin.audit.read` and returns a JSONL export generated from the authenticated tenant's audit rows. It accepts the same `action`, `resourceType`, `actorUserId` filters plus `limit` up to 1000, and returns `{ filename, format: "jsonl", count, content }`.

`POST /admin/audit/retention` is protected by `admin.audit.manage`. It accepts `{ "retentionDays": 365, "dryRun": true }` for a tenant-scoped preview of rows older than the cutoff. A destructive retention run must send `{ "dryRun": false, "confirm": true }`; the API deletes only matching rows for the authenticated tenant and records `audit.retention.applied` evidence when the repository supports audit writes.

`GET /workspaces` returns the authenticated tenant's active workspaces. The document upload UI uses it to avoid free-form workspace IDs.

Document endpoints are protected by `documents.upload`, `documents.read` and `documents.delete`.

`POST /documents/upload` accepts a single multipart file field named `file` and requires `workspaceId` and `kind` query parameters:

```text
POST /documents/upload?workspaceId=<workspace-id>&kind=RECEIPT
Authorization: Bearer <access-token>
Content-Type: multipart/form-data
```

Supported MIME types are JPEG, PNG, WebP, TIFF and PDF. The API verifies the binary file signature instead of trusting only the multipart content type, normalizes unsafe filenames, computes SHA-256 for duplicate detection, validates that the workspace belongs to the tenant and stores metadata in PostgreSQL. When cache is available, upload first checks a tenant-scoped `document-duplicate:<tenantId>:<sha256>` key, but still confirms the cached document through persistent storage before returning a duplicate. The production storage adapter writes original files to MinIO and returns presigned URLs through `POST /documents/:id/download-url`.

The local OCR service also accepts JPEG, PNG, WebP, TIFF and PDF input on `POST /ocr/tesseract`. Image and PDF inputs pass through the shared preprocessing pipeline. PDFs are rendered into per-page PNG artifacts with PyMuPDF, every page is preprocessed with the selected profile and the response includes `page_count`, per-page OCR/preprocessing metadata and a preprocessing manifest path.

The local OCR service accepts the same document types on `POST /ocr/custom-crnn?checkpoint=artifacts/models/.../model.pt`. It restricts checkpoint paths to the local `artifacts/models` tree, preprocesses pages with the `CUSTOM_MODEL_OPTIMIZED` profile, runs the project-owned PyTorch CRNN/CTC inference code for each page and returns aggregate text plus per-page metadata, including model version, vocabulary version, warnings, quality metrics, pages and tokens. Confidence comes from the custom inference pipeline and remains conservative enough to route weak documents to review.

`POST /preprocess` on the OCR service is the preprocess-only worker endpoint. It accepts the same local image/PDF types, renders PDFs into pages, returns per-page processed PNG artifacts as base64 and includes output dimensions, quality score and preprocessing decisions. The API uses `OCR_SERVICE_URL` for the local worker preprocessing client when configured.

`POST /documents/:id/preprocessing-artifacts` is protected by `ocr.run`. It persists worker/OCR-service preprocessing outputs for a tenant-scoped document. Each page payload includes a preprocessing profile, page number, dimensions, quality score, processed image MIME type and base64 processed image bytes. The API validates the processed image signature, stores each page artifact through the object-storage adapter, upserts `DocumentPage` rows, stores a JSON preprocessing manifest object and emits `ocr.preprocessing.completed` when the event service is configured.

Successful document upload now also enqueues a deduped `document.preprocess` worker job in the `preprocessing` queue with `ocr.job.created` event metadata. `POST /admin/jobs/run-next` can drain that job; the runner downloads the original object from storage, calls the configured OCR preprocessing client and persists the returned page artifacts through the same `DocumentPage`/object-storage path. When `OCR_SERVICE_URL` is present, that preprocessing job also requests a follow-up local `ocr.tesseract` job, which calls `POST /ocr/tesseract`, persists the Tesseract candidate through OCR comparison/ensemble storage and chains structured extraction from the selected OCR text. Custom model inference can be queued as `ocr.custom_crnn`; normal runs use the active, real-fixture-validated `CUSTOM_CRNN` model version's `artifactKey/model.pt` checkpoint. An explicit registry-external `checkpoint` payload is disabled by default and is only available for controlled local smoke diagnostics when `CUSTOM_OCR_ALLOW_UNREGISTERED_CHECKPOINT=1`.

`GET /documents/:id/pages` is protected by `documents.read`. It lists persisted `DocumentPage` rows for a tenant-scoped document and returns signed URLs for processed page artifacts when available.

`POST /documents/:id/extraction` is protected by `ocr.run`. It accepts OCR text for a tenant-scoped document, runs deterministic receipt field extraction and persists an extraction job, extracted fields and validation issues.

`GET /documents/:id/extraction` is protected by `ocr.run` or `ocr.review`. It returns the latest persisted extraction for the tenant-scoped document, including normalized extracted fields, validation issues and line items. It returns `EXTRACTION_NOT_FOUND` when the document has no persisted extraction.

`POST /documents/:id/extraction/line-items` is protected by `ocr.review`. It reads the latest persisted extraction for the tenant-scoped document, replaces the line-item set with reviewer-corrected values, recalculates validation issues and persists a new extraction snapshot. The original extraction remains auditable; `/review` uses this endpoint after saving a line-item correction/annotation so later reads show the reconciled line items.

`POST /sandbox/turkish/parse` is protected by `ocr.run`. It performs local-only sandbox parsing for synthetic Turkish UBL-style invoice XML and receipt QR/barcode payloads. It does not call GIB or any official e-Fatura/e-Arsiv service and always returns `source: "LOCAL_SANDBOX"` with `officialIntegration: false`.

```json
{
  "kind": "UBL_TR_XML",
  "content": "<Invoice>...</Invoice>"
}
```

Use `"kind": "QR_PAYLOAD"` for JSON, query-string or semicolon/pipe key-value QR payloads. Monetary outputs are JSON-safe integer minor-unit strings, for example `{ "amountMinor": "11800", "currency": "TRY" }`, and validation issues call out malformed input, missing totals/dates/merchant names, unsupported currencies and total/tax mismatches.

```json
{
  "sourceEngine": "TESSERACT",
  "text": "MAVI MARKET\nTARIH: 12.05.2026\nTOPLAM 72,05 TL"
}
```

```json
{
  "lineItems": [
    {
      "name": "EKMEK TAM BUGDAY",
      "quantity": "1",
      "total": {
        "amountMinor": "2200",
        "currency": "TRY"
      },
      "confidence": 1
    }
  ]
}
```

`POST /documents/:id/ocr-runs/compare` is protected by `ocr.run`. It accepts local OCR engine candidates, optional OCR token bounding boxes, extracts comparable fields from each successful run, computes comparison metrics and persists `OCRJob`, candidate `OCREngineRun` rows and an `ENSEMBLE` run. When the comparison selects non-empty OCR text, the API also queues a deduped `extraction.from_text` worker job for downstream structured extraction.

```json
{
  "runs": [
    {
      "engine": "TESSERACT",
      "text": "MAVI MARKET\nTARIH 12.05.2026\nTOPLAM 72,05 TL",
      "confidence": 0.86,
      "tokens": [
        {
          "text": "TOPLAM",
          "confidence": 0.91,
          "bbox": [18, 140, 76, 20],
          "pageNumber": 1
        }
      ],
      "latencyMs": 420
    },
    {
      "engine": "CUSTOM_CRNN",
      "text": "MAVI MARKET\nTARIH 12.05.2026\nTOPLAM 79,05 TL",
      "confidence": 0.61,
      "latencyMs": 180
    }
  ],
  "groundTruthText": "MAVI MARKET TARIH 12.05.2026 TOPLAM 72,05 TL"
}
```

`GET /documents/:id/ocr-runs` is protected by `documents.read` and lists persisted OCR jobs and engine runs for a tenant-scoped document.

Expense endpoints are protected by `expenses.create` and `expenses.read`.

`GET /expenses/:id/ai-analysis` is protected by `expenses.read`. It runs a non-mutating local category/anomaly preview against a persisted expense and workspace peer expenses. `POST /expenses/:id/ai-analysis` is protected by `expenses.update` and persists the same analysis as an `MLCategoryPrediction`, ensures a tenant-scoped `ExpenseCategory`, updates the expense `categoryId` and writes an `expense.category_predicted` audit log. Responses include predicted category key, confidence, matched keywords, explanation reasons, anomaly reason codes, persisted prediction metadata when saved, `cacheHit` and model metadata with `externalServicesUsed: false`. The local category/anomaly payload can be reused from `model-inference:<tenantId>:expense-category:<expenseId>:<fingerprint>` cache entries, but persisted prediction rows and audit evidence remain PostgreSQL-backed. It is assistive only and does not claim absolute classification accuracy.

Manual expense creation:

```json
{
  "workspaceId": "workspace-id",
  "title": "Manual taxi",
  "currency": "TRY",
  "amountMinor": "18550",
  "taxMinor": "0",
  "occurredAt": "2026-05-11T10:00:00.000Z",
  "merchantName": "City Taxi",
  "paymentMethodName": "Corporate card",
  "reimbursable": true
}
```

CSV expense import endpoints persist an `ImportBatch` for both successful imports and validation failures.

`POST /expenses/imports` is protected by `expenses.create`. It accepts CSV text, validates each row, creates real draft expenses when every row is valid, writes `expense.import_batch.created` audit evidence and emits `expense.created` outbox events with `source: "csv_import"`. Validation failures return `201` with a failed import batch and row-level errors so the failed attempt remains auditable. Supported headers include `title`, `description`, `merchant`/`merchant_name`, `payment_method`/`payment_method_name`, `amount_minor` or decimal `amount`, `tax_minor` or decimal `tax`, `occurred_at` or `date`, `currency`, `business_expense`, `reimbursable`, `project_code` and `cost_center`. Decimal parsing is string based; monetary values are not converted through floating point.

```json
{
  "workspaceId": "workspace-id",
  "source": "bank-export.csv",
  "csvText": "title,merchant,amount,occurred_at,currency\nMetro ride,Istanbul Metro,\"42,50\",2026-05-17T08:00:00.000Z,TRY"
}
```

`GET /expenses/imports?workspaceId=<workspace-id>` is protected by `expenses.read` and returns recent tenant-scoped import batches with source, status, stats and completion timestamps.

Expense attachment endpoints manage the current primary document attachment through the persisted `Expense.documentId` field.

`GET /expenses/:id/attachments` is protected by `expenses.read` and returns active tenant-scoped attached documents plus `attachmentMetadata` rows with label, note, actor and timestamps. `POST /expenses/:id/attachments` is protected by `expenses.update`; it accepts `documentFileId`, optional `label`, optional `note` and optional `primary`, validates that the target document belongs to the same tenant and workspace as the expense, rejects archived expenses, persists an `ExpenseAttachment` row, preserves/promotes `Expense.documentId` as the primary document and writes `expense.attachment.attached` audit evidence plus an `expense.updated` outbox event. `DELETE /expenses/:id/attachments/:documentFileId` marks the matching attachment metadata as detached, promotes the next active attachment when the primary document is removed, writes `expense.attachment.detached` audit evidence and emits `expense.updated`.

```json
{
  "documentFileId": "document-file-id"
}
```

`PATCH /expenses/:id` is protected by `expenses.update`. It updates tenant-scoped editable fields, keeps monetary values as integer minor units, writes an `expense.updated` audit row and emits an `expense.updated` outbox event.

```json
{
  "title": "Updated team lunch",
  "amountMinor": "4200",
  "taxMinor": "400",
  "occurredAt": "2026-05-13T12:30:00.000Z",
  "merchantName": "Yeni Lokanta",
  "paymentMethodName": "Corporate card",
  "projectCode": "PRJ-42",
  "costCenter": "FIN",
  "businessExpense": true,
  "reimbursable": true
}
```

`GET /expenses/:id/comments` is protected by `expenses.read` and returns tenant-scoped activity comments for a non-archived expense. `POST /expenses/:id/comments` is protected by `expenses.update`; it stores a comment in `ExpenseComment`, writes `expense.comment.created` audit evidence and emits an `expense.updated` outbox event with `lifecycleAction: "comment_created"`.

```json
{
  "body": "Reviewed receipt against card statement."
}
```

`POST /expenses/:id/split` is protected by `expenses.update`. It requires at least two balanced allocations whose integer minor-unit amount total matches the source expense, and whose tax total matches the source tax when provided. The API creates real draft child expenses, preserves document/merchant/payment context, links them with `duplicateGroup`, soft-archives the source with `lifecycleAction: "split_archived"`, writes audit evidence and emits `expense.created` events with `source: "split"`.

```json
{
  "allocations": [
    {
      "title": "Client share",
      "amountMinor": "6000",
      "taxMinor": "600",
      "projectCode": "PRJ-42",
      "businessExpense": true
    },
    {
      "title": "Internal share",
      "amountMinor": "4000",
      "taxMinor": "400",
      "costCenter": "OPS"
    }
  ]
}
```

`POST /expenses/:id/archive` is protected by `expenses.update`. It soft-archives the expense by setting `status: ARCHIVED` and `archivedAt`, removes it from active ledger lists, writes `expense.archived` audit evidence and emits `expense.updated` with `lifecycleAction: "archived"`.

```json
{
  "reason": "No longer needed"
}
```

`POST /documents/:id/expense` creates an expense from the latest persisted extraction for a tenant-scoped document. Amounts are represented as integer minor units in API payloads and responses.

Approval endpoints are protected by `expenses.approve`. They update expense status, persist an `ApprovalWorkflow` row and write audit logs. New expenses receive a pending approval workflow with a local 48-hour SLA due date; decision responses include `slaDueAt`, `slaBreachedAt`, `slaStatus` and `slaHours`.

```json
{
  "reason": "Policy checked"
}
```

`POST /expenses/:id/approve` sets status to `APPROVED`. `POST /expenses/:id/reject` sets status to `REJECTED`.

`GET /approvals/sla?workspaceId=<workspace-id>` is protected by `expenses.approve` and returns tenant/workspace-scoped SLA rows for active expenses. Pending rows are reported as `ON_TRACK`, `DUE_SOON` or `BREACHED`; decided rows keep the persisted decision outcome such as `MET_ON_TIME`, `MET_LATE`, `REJECTED_ON_TIME` or `REJECTED_LATE`.

Expense policy endpoints persist lightweight workspace policy rules for small-business approval checks.

`GET /expense-policies?workspaceId=<workspace-id>` is protected by `expenses.read`. `POST /expense-policies` and `DELETE /expense-policies/:id` are protected by `expenses.approve`. Supported rule types are `MAX_AMOUNT_BY_CATEGORY`, `RECEIPT_REQUIRED_ABOVE`, `PROJECT_REQUIRED`, `ALLOWED_CATEGORIES` and `DUPLICATE_RECEIPT_REJECTION`. Policies store a JSON config, `warning` or `block` severity and active lifecycle state. Policy creation/archive writes audit evidence and emits `expense.updated` lifecycle events.

```json
{
  "workspaceId": "workspace-id",
  "name": "Receipt above 100 TRY",
  "ruleType": "RECEIPT_REQUIRED_ABOVE",
  "severity": "block",
  "config": {
    "thresholdMinor": "10000"
  }
}
```

`GET /expenses/:id/policy-evaluation` is protected by `expenses.read` and evaluates active workspace policies against a persisted expense. `POST /expenses/:id/approve` also evaluates policies automatically; warning findings are stored in the approval workflow policy snapshot, while blocker findings return `EXPENSE_POLICY_BLOCKED`.

Reimbursement claim endpoints persist claim headers and linked expense rows.

`GET /reimbursement-claims?workspaceId=<workspace-id>` is protected by `expenses.read` and lists tenant/workspace-scoped claims with their expense links. `POST /reimbursement-claims` is protected by `expenses.create`; it validates same-workspace expenses, rejects duplicate selections, non-reimbursable expenses, non-positive amounts, mixed currencies and expenses already linked to a non-rejected claim. Successful submission creates a `ReimbursementClaim` with `NEEDS_REVIEW`, persists `ReimbursementClaimExpense` rows, writes `expense.reimbursement_submitted` audit evidence and emits `expense.updated` lifecycle events.

```json
{
  "workspaceId": "workspace-id",
  "expenseIds": ["expense-id-1", "expense-id-2"]
}
```

`POST /reimbursement-claims/:id/approve`, `POST /reimbursement-claims/:id/reject` and `POST /reimbursement-claims/:id/mark-paid` are protected by `expenses.approve`. Approval requires `NEEDS_REVIEW`, payment requires `APPROVED`, and paid claims update linked expenses to `REIMBURSED`. Each decision writes reimbursement audit evidence and emits `expense.updated` lifecycle events such as `reimbursement_approved`, `reimbursement_rejected` and `reimbursement_paid`.

Subscription endpoints are local heuristic helpers over persisted expenses.

`GET /subscriptions?workspaceId=<workspace-id>` is protected by `expenses.read` and lists active subscription records for the workspace. `POST /subscriptions/detect?workspaceId=<workspace-id>` is protected by `expenses.update`; it scans active persisted expenses, groups same merchant/title plus same integer minor amount and currency, infers weekly or monthly cadence from date gaps, upserts `Subscription` rows, writes `expense.subscription_detected` audit evidence and emits `expense.updated` events with `lifecycleAction: "subscription_detected"`.

Recurring expense endpoints persist rules and generate real draft expenses.

`GET /recurring-expenses?workspaceId=<workspace-id>` is protected by `expenses.read`. `POST /expenses/:id/recurring` is protected by `expenses.update`; it creates a `RecurringExpense` rule from an existing tenant-scoped expense, stores cadence and next due date, writes `expense.recurring_created` audit evidence and emits `expense.updated` with `lifecycleAction: "recurring_created"`.

```json
{
  "cadence": "monthly",
  "nextDueAt": "2026-06-05T09:00:00.000Z"
}
```

`POST /recurring-expenses/:id/generate` is protected by `expenses.create`; it creates the next draft expense from the rule, advances `nextDueAt`, writes `expense.recurring_generated` audit evidence and emits `expense.created` with `source: "recurring"`.

Budget endpoints use persisted expenses and integer minor units.

`POST /budgets` is protected by `budgets.manage`:

```json
{
  "workspaceId": "workspace-id",
  "name": "May operating budget",
  "currency": "TRY",
  "amountMinor": "60000",
  "alertPercent": 80,
  "month": "2026-05"
}
```

`GET /budgets?workspaceId=<workspace-id>&month=2026-05` is protected by `expenses.read`. It lists budgets with persisted `BudgetPeriod` usage, utilization percent, alert state and remaining amount. Repeated calls can reuse `dashboard:<tenantId>:budget-usage:<workspaceId>:<month>:<fingerprint>` cache entries derived from month-scoped expense and budget inputs.

`GET /analytics/monthly-spend?workspaceId=<workspace-id>&month=2026-05` is protected by `expenses.read`. It returns total, business and reimbursable spend for the requested month, plus budget usage. Repeated calls can reuse `dashboard:<tenantId>:monthly-spend:<workspaceId>:<month>:<fingerprint>` cache entries derived from the month-scoped expense and budget inputs; PostgreSQL expense, budget and budget-period rows remain authoritative.

`GET /analytics/finance-insights?workspaceId=<workspace-id>&month=2026-05` is protected by `expenses.read`. It returns a richer read model from persisted expense and budget rows: weekly spend buckets, category/merchant/payment-method breakdowns, expense-only cashflow, previous-month trend, budget alert severity, observed-day run-rate forecast, projected month-end spend, projected budget utilization, largest budget risk, deterministic recommendation codes and anomaly reason-code summaries such as high amount versus monthly average, weekend business expense and over-utilized budget. Money values remain integer minor-unit strings.

Report export endpoints are protected by `reports.export`.

`POST /reports/exports` generates a report from persisted workspace data, stores the generated file through the object-storage adapter and persists an `ExportJob`. The same report generation path can also run through a queued `report.export` worker job for local background processing and recovery.

```json
{
  "workspaceId": "workspace-id",
  "type": "monthly_expense_report_pdf",
  "month": "2026-05"
}
```

Supported report types are `expense_ledger_csv`, `category_breakdown_csv`, `merchant_spend_csv`, `monthly_expense_report_pdf`, `approval_evidence_csv`, `reimbursement_batch_csv`, `reimbursement_claim_report_pdf`, `ocr_quality_report_csv`, `model_evaluation_report_csv`, `audit_pack_csv` and `dataset_export_jsonl`. CSV output uses formula-injection protection for risky cells and keeps money values in integer minor units. The monthly PDF report is generated locally with `pdfkit`, stores a real PDF artifact, summarizes persisted expense totals and includes merchant and ledger sections for the selected month. The approval evidence CSV exports persisted `ApprovalWorkflow` SLA state, policy snapshot metadata, approver evidence and linked reimbursement claim IDs/statuses for accountant/auditor review. The reimbursement batch CSV exports approved and reimbursed claim line items from persisted `ReimbursementClaim` and `ReimbursementClaimExpense` rows for finance payout review. The reimbursement claim PDF is also generated locally with `pdfkit`, summarizes approved/reimbursed claim counts, totals and claim expense lines, and persists the PDF through the same object-storage/export-job path. The OCR quality CSV exports persisted OCR comparison job/run data, including engine status, confidence, latency, ensemble-selected engine, failure rate, CER/WER, text similarity and conflict fields. The model evaluation CSV exports persisted model registry rows, latest training run context and evaluation metrics such as accuracy, macro F1, loss, CER/WER, field accuracy and confusion matrix data. The audit pack CSV exports workspace expense rows together with related persisted audit events, correlation IDs and metadata evidence. The dataset JSONL export emits one line per persisted workspace document with image object references, SHA-256 metadata, annotation labels/payloads, OCR corrections and active-learning suggestion metadata for local model-training workflows.

`GET /reports/exports?workspaceId=<workspace-id>` lists persisted export jobs for a workspace.

Model registry endpoints are protected by model permissions.

`GET /models` is protected by `models.train`. It returns tenant-scoped model versions, training runs and evaluation runs from the persisted registry.

`POST /models/category/smoke-train` is protected by `models.train`. It runs the local category-model smoke training profile, stores the ignored local artifact paths, creates a `ModelVersion` with `CANDIDATE` status, completes the `ModelTrainingRun`, writes a matching `ModelEvaluationRun` and emits model training/evaluation outbox events.

```json
{
  "seed": 42,
  "samplesPerCategory": 12
}
```

`POST /models/category/full-train` is protected by `models.train`. It runs the same local category-model training pipeline with the larger `category-full-local` profile, bounded by `65..2048` synthetic samples per category, then registers a candidate artifact with persisted training/evaluation evidence.

```json
{
  "seed": 42,
  "samplesPerCategory": 128
}
```

`POST /models/custom-ocr/smoke-train` is protected by `models.train`. It runs the project-owned PyTorch CRNN/CTC smoke training profile, registers a `CUSTOM_CRNN` candidate model version and records the smoke loss metric honestly. In direct host development the API can run the local Python training script. In Docker Compose, `OCR_SERVICE_URL` points the API to the OCR service `POST /models/custom-ocr/smoke-train` endpoint so PyTorch training stays inside the OCR image while API, worker and OCR service share `artifacts/` and `data/generated/` paths for follow-up inference.

```json
{
  "seed": 42,
  "samples": 16,
  "epochs": 1
}
```

`POST /models/custom-ocr/full-train` is protected by `models.train`. It runs the same project-owned CRNN/CTC training pipeline with the larger `custom-ocr-full-local` profile, bounded by `65..50000` samples and `2..20` epochs, then registers a candidate `CUSTOM_CRNN` model version with persisted metrics. This profile can be slow on CPU and should be started only on local machines with enough headroom. Existing compatible local_full checkpoints can be registered without retraining by running `pnpm custom-ocr:bootstrap`.

```json
{
  "seed": 42,
  "samples": 128,
  "epochs": 5
}
```

`POST /models/custom-ocr/train-from-dataset-export` is protected by `models.train`. It validates that the selected workspace has a successful `dataset_export_jsonl` `ExportJob`, starts a bounded custom OCR smoke-training profile, persists the export job ID as `ModelTrainingRun.datasetId` and passes the dataset artifact metadata to the training runner.

```json
{
  "workspaceId": "workspace_123",
  "exportJobId": "export_123",
  "seed": 42,
  "samples": 8,
  "epochs": 1
}
```

`POST /models/:id/promote` is protected by `models.promote`. It promotes one model version to `ACTIVE` and archives any previous active version for the same engine in the tenant.

`POST /models/:id/ocr-benchmark` is protected by `models.train`. It accepts a registered `CUSTOM_CRNN` model version, runs the local OCR benchmark harness with bounded synthetic samples, persists a `ModelEvaluationRun`, records the benchmark artifact/report metadata and reports Tesseract as unavailable/skipped instead of fabricating predictions when the local binary or language pack is not available.

```json
{
  "seed": 42,
  "samples": 8,
  "split": "all",
  "skipTesseract": false
}
```

`POST /models/:id/rollback` is protected by `models.promote`. It restores an `ARCHIVED` model version to `ACTIVE`, archives the current active version for the same engine and returns the restored version plus `rolledBackFromModelVersionId`. Rollback rejects missing versions, non-archived targets and engines without a current active version. Custom OCR rollback uses the same real-fixture readiness gate as promotion, so archived smoke, synthetic-only, artifact-missing or failed-gate `CUSTOM_CRNN` versions cannot be restored to `ACTIVE`.

Review endpoints are protected by `ocr.review`; active-learning suggestion listing is protected by `annotations.manage`.

`POST /documents/:id/review-tasks` creates a tenant-scoped OCR review task:

```json
{
  "reasonCodes": ["LOW_CONFIDENCE", "AMOUNT_MISMATCH"],
  "assignedToId": null,
  "dueAt": "2026-05-20T10:00:00.000Z"
}
```

`GET /review/tasks?workspaceId=<workspace-id>&status=QUEUED&assignedToId=<user-id>` lists review tasks with their document metadata. `assignedToId` is optional and filters persisted task ownership when present.

`GET /review/reviewers` returns active tenant users whose roles include `ocr.review`. The response is used by `/review` to present assignment targets without exposing disabled users or users who cannot review OCR output.

```json
{
  "reviewers": [
    {
      "id": "user_123",
      "email": "reviewer@example.com",
      "displayName": "Queue Reviewer",
      "roles": ["REVIEWER"],
      "permissions": ["documents.read", "ocr.review", "annotations.manage", "expenses.read", "expenses.update"]
    }
  ]
}
```

`GET /review/workload?workspaceId=<workspace-id>` returns a tenant-scoped reviewer workload and SLA summary built from persisted review tasks. It includes queued/running/overdue/due-soon counts, oldest open task age, reviewer workload score and an unassigned bucket. `/review` uses it to show operational assignment pressure before task decisions.

```json
{
  "workspaceId": "workspace_123",
  "reviewers": [
    {
      "reviewer": { "id": "user_123", "email": "reviewer@example.com", "displayName": "Queue Reviewer" },
      "queued": 4,
      "running": 1,
      "completed": 12,
      "rejected": 1,
      "overdue": 2,
      "dueSoon": 1,
      "oldestQueuedAgeMinutes": 180,
      "workloadScore": 10
    }
  ],
  "unassigned": { "queued": 3, "running": 0, "overdue": 1, "dueSoon": 1, "oldestQueuedAgeMinutes": 95, "workloadScore": 6 },
  "totals": { "reviewers": 2, "queued": 7, "running": 1, "overdue": 3, "dueSoon": 2 }
}
```

`GET /review/rebalance-suggestions?workspaceId=<workspace-id>` returns deterministic SLA/rebalancing suggestions computed from persisted review tasks, due dates and reviewer workload scores. Suggestions do not mutate state by themselves; `/review` can apply a single suggestion through `POST /review/tasks/:id/assign`, preserving normal authorization and `review.task.assigned` audit evidence.

```json
{
  "workspaceId": "workspace_123",
  "suggestions": [
    {
      "action": "ASSIGN",
      "reasonCode": "SLA_OVERDUE_UNASSIGNED",
      "priority": 1060,
      "currentAssigneeId": null,
      "targetReviewer": { "id": "user_123", "email": "reviewer@example.com", "displayName": "Queue Reviewer" },
      "targetWorkloadScore": 1,
      "currentAssigneeWorkloadScore": null,
      "ageMinutes": 95,
      "dueInMinutes": null,
      "overdueMinutes": 60
    }
  ]
}
```

`POST /review/escalations/run` is protected by `ocr.review` and `users.manage`. It turns the current SLA suggestions into a bounded escalation plan and can either dry-run the plan or apply it. Applying an escalation updates the persisted review task assignment, appends `SLA_ESCALATED` plus the specific suggestion reason code to `reasonCodes`, and writes `review.task.escalated` audit evidence.

```json
{
  "workspaceId": "workspace_123",
  "dryRun": false,
  "maxActions": 8
}
```

The response contains `planned` actions and, when `dryRun` is false, `applied` actions with the updated task rows.

`POST /review/tasks/:id/assign` assigns a queued task to the authenticated reviewer when the body is empty, assigns to an eligible reviewer when the caller also has `users.manage`, or clears assignment when `assignedToId` is `null`. The endpoint writes `review.task.assigned` audit evidence and rejects disabled, missing or non-review-capable users.

```json
{
  "assignedToId": null
}
```

`POST /review/tasks/:id/complete` marks a task as succeeded. `POST /review/tasks/:id/reject` marks the task as failed and writes the reviewer rejection reason to the audit log metadata.

```json
{
  "rejectionReason": "Totals still conflict after correction."
}
```

`POST /documents/:id/corrections` records a human correction, optionally creates an annotation row and always creates a `HUMAN_CORRECTION` active-learning suggestion:

```json
{
  "fieldName": "total",
  "beforeValue": "7905",
  "afterValue": "7205",
  "createAnnotation": true,
  "annotationLabel": "corrected_total"
}
```

`GET /documents/:id/corrections` returns correction history for a tenant-scoped document.

`POST /documents/:id/annotations` is protected by `annotations.manage`. It stores direct document annotations such as corrected OCR bounding boxes, multi-token OCR spans and multi-page token groups, then writes `annotation.created` audit evidence. `GET /documents/:id/annotations` returns direct annotations for the selected tenant-scoped document.

```json
{
  "label": "ocr_bbox_total",
  "payload": {
    "type": "ocr_bbox_annotation",
    "engine": "TESSERACT",
    "text": "TOPLAM",
    "pageNumber": 1,
    "bbox": [18, 140, 76, 20],
    "confidence": 0.91
  }
}
```

Multi-token annotations keep each selected token's engine, page and bbox so dataset exports can preserve page-local evidence:

```json
{
  "label": "ocr_multi_page_total_context",
  "payload": {
    "type": "ocr_multi_token_annotation",
    "engine": "TESSERACT",
    "text": "ARA TOPLAM KDV TOPLAM",
    "pageNumbers": [1, 2],
    "bbox": null,
    "confidence": 0.83,
    "tokens": [
      { "engine": "TESSERACT", "text": "ARA", "pageNumber": 1, "bbox": [16, 118, 34, 18], "confidence": 0.88 },
      { "engine": "TESSERACT", "text": "TOPLAM", "pageNumber": 1, "bbox": [54, 118, 68, 18], "confidence": 0.86 },
      { "engine": "TESSERACT", "text": "KDV", "pageNumber": 2, "bbox": [18, 44, 42, 18], "confidence": 0.79 },
      { "engine": "TESSERACT", "text": "TOPLAM", "pageNumber": 2, "bbox": [64, 44, 72, 18], "confidence": 0.8 }
    ]
  }
}
```

`GET /active-learning/suggestions?workspaceId=<workspace-id>` returns suggestions for model training prioritization.

The `/review` workspace also integrates model-training dataset export through the reports API. `POST /reports/exports` with `type: "dataset_export_jsonl"` creates a persisted `ExportJob`, stores an object-storage JSONL artifact and returns a short-lived signed URL containing document references, annotations, correction history and active-learning metadata for the selected workspace. From the same review surface, the latest dataset export can be handed to `POST /models/custom-ocr/train-from-dataset-export` so the resulting `ModelTrainingRun` keeps the export job as dataset evidence.

`GET /metrics` returns Prometheus text metrics for local observability:

- `spendlens_api_info`
- `spendlens_process_uptime_seconds`
- `spendlens_process_resident_memory_bytes`
- `spendlens_process_heap_used_bytes`
- `spendlens_http_requests_total`
- `spendlens_http_request_duration_seconds`
- `spendlens_event_outbox_events`
- `spendlens_event_outbox_topic_events`
- `spendlens_event_inbox_events`
- `spendlens_event_inbox_topic_events`
- `spendlens_kafka_consumer_lag`
- `spendlens_kafka_consumer_committed_offset`
- `spendlens_kafka_topic_high_watermark`
- `spendlens_worker_jobs`
- `spendlens_worker_queue_jobs`
- `spendlens_worker_failed_jobs`
- `spendlens_cache_connected`
- `spendlens_cache_worker_hot_state_keys`
- `spendlens_cache_operation_errors_total`
- `spendlens_storage_connected`
- `spendlens_storage_objects`
- `spendlens_storage_operation_errors_total`
- `spendlens_ocr_engine_runs`
- `spendlens_ocr_engine_confidence_average`
- `spendlens_ocr_engine_latency_ms_average`
- `spendlens_review_tasks`
- `spendlens_review_corrections`
- `spendlens_review_annotations`
- `spendlens_review_active_learning_suggestions`
- `spendlens_review_correction_rate`

HTTP metrics use bounded labels for method, registered route and status code. Event, worker, cache, storage, OCR and review metrics aggregate across tenants and intentionally avoid tenant labels. Outbox metrics expose state/topic backlog for local Kafka delivery visibility, inbox metrics expose consumer checkpoint status by topic, Kafka lag metrics expose configured consumer group/topic/partition lag when `KAFKA_BROKERS` and `KAFKA_LAG_CONSUMER_GROUPS` are configured, worker metrics expose durable job status by queue and failed job counts by queue plus last processing worker, cache metrics expose backend connectivity, non-authoritative worker hot-state key count and Redis operation error counters, storage metrics expose object-storage connectivity, memory-backend object count where available and MinIO operation error counters, OCR metrics expose engine run count/confidence/latency, and review metrics expose task/correction/annotation/active-learning aggregate counts.

This document describes only endpoints that are implemented and available in the running API.
