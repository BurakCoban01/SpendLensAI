# Testing

## Verified 2026-07-06

- Numeric touching-glyph regression: 1/1 passed.
- Full Python OCR discovery: 102/102 passed.
- `pnpm lint`: 5/5 tasks passed.
- `pnpm typecheck`: 5/5 tasks passed.
- `pnpm test`: shared 25, web 3, API 175 passed; 9 live-integration tests skipped by their explicit environment guards.
- `pnpm test:custom-ocr`: 73/73 passed.
- `pnpm test:ocr-acceptance`: 1/1 authenticated browser upload/OCR/extraction flow passed.
- `pnpm test:full-browser-acceptance`: 5/5 authenticated browser flows passed.
- `pnpm test:e2e`: 18 passed; 7 OCR-dependent tests skipped in the generic environment and covered by the two OCR-specific commands above.
- `pnpm security:audit`: secret scan and authorization audit passed; 138 routes checked.

## Automated Gates

```bash
pnpm install
pnpm db:generate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:e2e:docker
$env:SPENDLENS_E2E_MEMORY_ADAPTERS="false"; $env:SPENDLENS_E2E_API_PORT="4110"; $env:SPENDLENS_E2E_WEB_PORT="3010"; $env:SPENDLENS_E2E_WEB_BASE_URL="http://127.0.0.1:3010"; pnpm exec playwright test e2e/resumable-upload.spec.ts
pnpm test:ocr-acceptance
SPENDLENS_CUSTOM_OCR_ACCEPTANCE=1 pnpm exec playwright test e2e/custom-ocr-active-flow.spec.ts
python -m services.ocr.custom_model.dataset_adapters --dataset-root data/datasets --fixture-root data/demo-fixtures --output data/generated/custom-ocr-dataset-inventory.json
python -m services.ocr.benchmarks.ocr_benchmark --dataset-mode real_fixtures --data-dir data/demo-fixtures --output-dir artifacts/benchmarks/custom-ocr-real-fixtures --checkpoint artifacts/models/crnn-length-aware/model.pt --skip-tesseract
python -m services.ocr.custom_model.train_crnn --profile tiny --data-dir data/generated/ocr-fixture-mix-smoke --artifact-dir artifacts/models/custom-crnn-fixture-mix-smoke --samples 24 --epochs 1 --batch-size 4 --dataset-mode document_lines --progress-interval-batches 2
python -m compileall services
python -m unittest discover services/ocr/tests
```

## Current Tests

- shared money parsing and integer arithmetic
- filename normalization
- CSV formula injection protection
- Kafka event catalog typing and durable DLQ metadata
- API Kafka event consumer entrypoint tests for broker/topic config parsing, producer-envelope parsing, unknown-topic rejection and idempotent inbox recording
- API event drainer entrypoint tests for bounded drain config, service-account login, drain request shape and empty-cycle reporting
- RBAC permission checks
- OCR confidence aggregation
- API liveness and catalog smoke tests
- API metrics smoke tests for Prometheus process gauges, HTTP request counters, latency histogram buckets, tenant-safe event outbox/inbox gauges, Kafka lag gauges through an injected provider, degraded Kafka lag fallback, worker job/failure gauges, cache health/error gauges, object-storage health/error gauges, OCR engine quality gauges and review correction gauges
- built API start smoke check for `pnpm --filter @spendlens/api start` on a free local port with `/metrics` verification
- API HTTP security tests for Helmet security headers, configured local CORS allow-listing, untrusted CORS origin suppression, process-local rate-limit 429 behavior and Redis-backed rate-limit store enforcement through an injected client
- API OpenAPI contract test for `/docs/json`, reusable security/example components and source-route-to-OpenAPI operation coverage
- Kubernetes manifest render smoke with `kubectl kustomize k8s`
- auth registration/login route tests
- refresh token rotation and old-token reuse rejection
- session inventory and logout-all revocation behavior
- same-email cross-tenant isolation at service level
- server-side permission guard smoke test
- API key creation without raw key leakage in list responses
- API key automation authentication by scope
- API key revocation rejection
- document upload service tests for supported MIME validation, file signature mismatch rejection, SHA-256 duplicate detection, safe filename normalization and tenant-scoped workspace checks
- document upload service tests for cache-backed duplicate quick checks that still confirm repository state before returning a duplicate
- document route tests for multipart upload, resumable chunk upload sessions, CRC32 mismatch retry, pause/resume/cancel/status, final SHA-256 validation, unsafe final MIME spoof rejection, RBAC/missing-token rejection, signed download URL generation, preprocessing page artifact persistence, manifest object storage, `DocumentPage` listing, soft deletion and post-delete access denial
- authenticated workspace listing assertion in auth route tests
- web typecheck/build coverage for `/documents/upload` and dashboard navigation into document intake
- OCR preprocessing/API unit tests with synthetic receipt/PDF fixtures for artifact creation, profile decisions, blur/quality scoring, PDF page splitting, per-page manifest output, `/preprocess` base64 page artifact output, `/ocr/tesseract` PDF response metadata, `/ocr/custom-crnn` checkpoint/profile behavior, missing-checkpoint failure and unsupported profile/document-type errors
- Tesseract engine unit tests for missing binary degradation, missing language failure, timeout/error surfaces and TSV token/confidence normalization without requiring a host Tesseract install
- custom OCR model tests for Turkish vocab round-trip, deterministic line and document-level synthetic dataset splits, receipt/invoice variants with field/line/bounding-box ground truth, tiny/demo/benchmark generation and clean support, CRNN forward shape, finite CTC loss and training collate contract
- category model tests for deterministic synthetic expense dataset generation, local scikit-learn training, saved artifact/metrics, evaluation report, deterministic multi-seed benchmark regression reports and inference confidence without external services
- API model route tests for local category/custom OCR smoke and bounded full-profile training registration, custom OCR training from persisted dataset export jobs with `ModelTrainingRun.datasetId`, direct custom OCR benchmark persistence, persisted `ModelVersion`, `ModelTrainingRun`, `ModelEvaluationRun`, engine-isolated promotion state, archived-version rollback and model training/evaluation outbox events
- API model runner tests for Docker-oriented OCR-service custom OCR smoke training delegation, payload shape, artifact response validation and clear invalid-response failure
- OCR benchmark tests for CER/WER helpers and honest unavailable-engine reporting without mock predictions
- OCR benchmark smoke command producing `benchmark-report.json` and `predictions.jsonl` against a tiny synthetic dataset
- CPU smoke-training command for custom OCR model artifact and metrics generation in a temporary directory
- category model smoke commands for `scripts\train-category-smoke.cmd`, `scripts\evaluate-category-model.cmd` and `pnpm category:benchmark`, writing ignored local artifacts, confusion-matrix metrics and aggregate benchmark reports
- shared structured extraction tests for Turkish receipt happy path and risky OCR validation issues
- shared OCR ensemble tests for field provenance, exact-match fusion, conflict detection and CER/WER metrics
- API extraction route tests for tenant-scoped document extraction persistence, latest extraction reads, review-protected line-item reconciliation snapshots and missing-document rejection
- API expense route tests for manual expense creation/listing, CSV expense imports with `ImportBatch` success/failure records, primary document attach/detach with audit/outbox evidence, editable expense updates with audit/outbox emission, persisted comments with audit/outbox evidence, balanced expense split child creation/source archive behavior, reimbursement claim submission/approval/rejection/paid transitions with audit/outbox evidence, persisted expense policy creation/list/archive, policy evaluation and approval blocker/warning behavior, local subscription detection with persisted `Subscription` records, recurring rule creation/generation with audit/outbox evidence, soft archive lifecycle with active-list removal, extracted expense creation and missing-workspace rejection
- API expense AI-analysis route tests for non-mutating preview, local category prediction, anomaly reason codes, `model-inference:<tenantId>:expense-category:<expenseId>:<fingerprint>` cache reuse, persisted `MLCategoryPrediction` metadata, expense `categoryId` update, audit log action and missing-expense rejection
- API budget analytics route tests for `dashboard:<tenantId>:budget-usage:<workspaceId>:<month>:<fingerprint>` and `dashboard:<tenantId>:monthly-spend:<workspaceId>:<month>:<fingerprint>` cache reuse while preserving persisted budget usage and monthly spend response data
- API expense approval tests for approve/reject transitions, pending approval SLA rows, persisted on-time SLA decision payloads, audit log actions and missing-expense rejection
- API event route tests for protected catalog access, outbox creation, tenant-scoped listing, failed/published transitions, unknown-topic rejection, pending outbox drain through the event producer, DLQ fallback when producer delivery fails, dedicated DLQ listing, failed-event requeue, idempotent inbox record dedupe and cross-tenant inbox envelope rejection
- API expense tests asserting automatic outbox topics for `expense.created`, `expense.approved` and `expense.rejected`
- API worker job route tests for protected listing, enqueue, dedupe, start, progress, fail, retry, complete, backlog listing and optional outbox event emission
- API cache route tests for protected cache status, key listing, lock acquire rejection while held and owner-scoped lock release
- API worker job route tests assert cache hot-state mirroring after lifecycle transitions while PostgreSQL remains the durable source of truth
- API worker runner route tests enqueue real `ocr.compare` jobs, run them through `POST /admin/jobs/run-next`, assert deduped chained `extraction.from_text` job creation, run the chained extraction job and assert persisted job results plus empty-queue behavior
- API worker runner route tests assert queue coordination locks skip `run-next` without starting the job when another worker owns the lock
- API worker runner route tests assert document upload automatically queues `document.preprocess`, then drain the preprocessing queue through `POST /admin/jobs/run-next`, persist processed page artifacts, write a preprocessing manifest and expose signed `DocumentPage` reads
- API worker runner route tests assert configured preprocessing can chain into a real `ocr.tesseract` worker call, persist the Tesseract run through OCR comparison/ensemble storage, then reuse the OCR result cache on a repeated Tesseract job without recalling the OCR client and drain the chained `extraction.from_text` job with parsed merchant/amount results
- API worker runner route tests assert `ocr.custom_crnn` fails clearly when no active model exists, rejects registry-external checkpoint payloads by default, permits them only under the explicit local diagnostic flag, resolves the active real-fixture-validated `CUSTOM_CRNN` model artifact to `model.pt`, calls the injected custom OCR client, persists the custom run through OCR comparison/ensemble storage, reuses the OCR result cache on a repeated custom OCR job without recalling the OCR client and drains the chained `extraction.from_text` job with parsed merchant/amount results
- API worker runner route tests assert `model.category_smoke_train` and `model.custom_ocr_smoke_train` jobs run through the same persisted model service as direct model APIs, create model versions, training runs, evaluation runs and model training/evaluation outbox events
- API worker runner route tests assert `model.category_evaluate` jobs resolve a registered `CATEGORY_ML` artifact, call the category evaluation runner with bounded sample settings, persist a `ModelEvaluationRun` and return evaluation artifact/report metadata
- API worker runner route tests assert `model.ocr_benchmark` jobs resolve a registered `CUSTOM_CRNN` artifact, call the OCR benchmark runner with bounded sample settings, persist a `ModelEvaluationRun` and return benchmark artifact/report metadata
- API worker runner route tests assert `report.export` jobs run through the same persisted report service as direct report APIs, create object-storage CSV artifacts, persist export jobs and emit `report.generated`
- API worker runner route tests assert `annotation.export_dataset` jobs export persisted documents, annotation labels/payloads, correction history and active-learning suggestions through object-storage JSONL artifacts
- API worker runner route tests assert `notification.create` and `webhook.delivery` jobs persist user notifications, expose read-state APIs, create hashed-secret webhook endpoints, invoke an injected delivery client and emit `webhook.delivery.requested` outbox evidence without external network calls
- API worker runner route tests assert `cleanup.temp_files` jobs scan only the configured local artifacts tmp root, support dry-run summaries, delete stale files and preserve fresh files
- API worker runtime route tests start a local automatic worker, assert heartbeat visibility, verify it drains queued OCR comparison plus chained extraction jobs, confirm `/admin/health` reads worker heartbeat state and stop the runtime worker
- API dedicated worker entrypoint tests cover token/login configuration, bounded polling settings and repeated `run-next` drain cycles until the queue is empty
- API audit route tests for protected audit access, tenant-scoped log listing, action/resource summaries and action/resource filters
- API OCR comparison route tests for persisted candidate runs, OCR token bounding-box persistence, ensemble provenance, conflict fields, deduped extraction job chaining, list retrieval and missing-document rejection
- web typecheck/lint coverage for `/documents/ocr` workspace/document selection, original signed document preview, processed page artifact preview, Tesseract/custom text input, persisted comparison submission, latest ensemble metrics, conflict fields and run history rendering
- API budget route tests for budget creation, persisted monthly budget period spend, monthly analytics totals and missing-workspace rejection
- API report route tests for monthly merchant CSV export generation, approval evidence CSV export generation from persisted approval workflows/SLA/policy/reimbursement context, reimbursement batch CSV export generation from approved claims, reimbursement claim PDF generation from approved/paid claims, OCR quality CSV export generation from persisted OCR comparison runs, model evaluation CSV export generation from persisted model registry metrics, audit pack CSV export generation from persisted expenses and audit logs, dataset JSONL export generation from persisted documents/annotations/corrections/active-learning suggestions, monthly expense PDF generation, object-storage persistence, persisted export job listing, missing-workspace rejection and CSV formula-injection protection
- API app/admin health tests for public liveness, protected `/admin/health`, unauthorized rejection, authorized dependency status responses, operations snapshot values from real uploaded documents plus persisted expenses and `dashboard:<tenantId>:admin-health:<fingerprint>` cache reuse without repeated storage metrics calls
- API review route tests for review task creation/listing, eligible reviewer listing, managed reviewer assignment, ineligible assignee rejection, self-assignment/unassignment, assigned-task filtering, workload/SLA summaries for assigned and unassigned queued tasks, deterministic SLA rebalancing suggestions plus persisted assignment from a suggested move, dry-run and applied SLA escalation automation with persisted assignment/reason-code/audit evidence, approval/rejection, correction persistence, correction-created annotation rows, direct bounding-box annotation creation/listing, multi-token and multi-page OCR annotation payload persistence, active-learning suggestions and missing-document rejection
- web typecheck/lint coverage for `/expenses` manual entry, CSV import panel and import batch history, primary document attachment controls, inline edit form, activity comments, reimbursement claim submission/decision panel, expense policy creation/list/archive and row-level evaluation UI, subscription detection, recurring rule creation/generation UI, split action, archive action, merchant/payment capture, workspace ledger UI and AI analysis result rendering
- web typecheck/expanded lint coverage for `/approvals` workspace queue, reason input, approve/reject actions, SLA due/status rendering, decided-expense rendering and approval evidence CSV export controls
- web typecheck/lint coverage for `/budgets` budget creation, month/workspace controls, monthly KPI rendering and utilization bars
- web typecheck/lint coverage for `/reports` workspace/month/type controls, CSV/PDF/reimbursement-batch/reimbursement-claim-PDF/dataset-JSONL report type selection, report export action, signed URL display and export history rendering
- web typecheck coverage for `/models` category/custom OCR smoke and full-profile training controls, custom OCR benchmark dashboard/action, persisted version comparison table, model registry rows, training/evaluation history, metric bars, confusion matrix rendering, permission-denied state, promotion action and archived-version rollback action
- web typecheck/expanded lint coverage for `/admin/health` dependency rows, permission-denied state and refresh action
- web typecheck/expanded lint coverage for `/admin/events` backlog counts, topic/state filters, denied state, event rows, permission-aware outbox drain action/result state, DLQ inspection/requeue controls and consumer inbox rows with consumer/status filters
- web typecheck/expanded lint coverage for `/admin/jobs` queue/status filters, backlog counts, enqueue form, progress rows, denied state, retry action, local `Run next` worker trigger and automatic worker heartbeat controls
- web typecheck/expanded lint coverage for `/admin/cache` cache health, prefix filtering, key TTL rows, lock probe form and denied state
- web typecheck/expanded lint coverage for `/admin/audit` action/resource/actor filters, summary columns, denied state and audit rows
- web typecheck/expanded lint coverage for `/review` workspace/document selection, selected document metadata/signed access, persisted OCR comparison review rendering from `GET /documents/:id/ocr-runs`, persisted OCR token bounding-box overlay rendering, interactive image-backed bounding-box editor with drag/resize plus numeric fallback fields, persisted annotation history rendering, persisted extraction execution and latest extraction rendering, line-item correction forms that persist correction/annotation payloads and reconciled extraction snapshots, review task creation, reviewer roster loading, workload/SLA panel rendering from `GET /review/workload`, SLA rebalancing suggestion rendering from `GET /review/rebalance-suggestions` with suggested assignment actions, dataset JSONL training export action through `POST /reports/exports`, dataset-export-to-custom-OCR training action through `POST /models/custom-ocr/train-from-dataset-export`, export/training history rendering, manager reviewer assignment controls, reviewer self-assignment/unassignment controls, OCR approval/rejection actions, correction entry, correction-history rendering and active-learning suggestion rendering
- Playwright E2E smoke test for register -> dashboard -> permission-aware document/API-key actions -> document upload -> persisted OCR comparison -> review document workspace -> persisted structured extraction -> review task creation -> correction history -> active-learning suggestion -> expense policy creation/evaluation -> manual expense creation -> approval SLA queue visibility -> primary document attachment -> expense edit -> subscription detection -> recurring rule creation -> persisted AI expense analysis -> persisted expense comment -> expense archive -> expense split into child ledger rows -> CSV expense import -> reimbursement claim submit/approve/mark-paid -> monthly PDF report export -> reimbursement batch CSV export -> reimbursement claim PDF export -> OCR quality CSV export -> model evaluation CSV export -> audit pack CSV export -> dataset JSONL export -> model smoke training -> model promotion using API memory adapters and real browser automation
- Playwright mobile/a11y smoke test for register -> dashboard -> document intake -> settings session inventory on a 390px viewport, asserting core workflow links remain reachable, pages do not horizontally overflow and visible interactive controls have accessible names
- Playwright Docker-backed smoke test with API memory adapters disabled, Docker Compose PostgreSQL/Redis/Redpanda/MinIO, migration apply, admin health dependency flags, PostgreSQL-backed document persistence and MinIO signed URL generation
- Playwright Docker-backed resumable upload smoke for a logged-in user uploading a 21 MB PNG through CRC32 chunks, pause/resume, final SHA-256 completion, PostgreSQL metadata and MinIO object composition
- Real OCR acceptance command with Docker Compose OCR service for uploaded Turkish JPEG, WebP, mislabeled WebP `.jpg`, PDF invoice, raw OCR text, extraction and expense creation
- Custom OCR active-flow Playwright coverage now accepts only two safe states: a real-fixture Custom OCR result with expected snippets, or an explicit blocked/no-active-model state. It must not pass merely because arbitrary Custom OCR text is non-empty.
- `pnpm custom-ocr:bootstrap` is a safety gate, not just a registry writer. It rejects smoke, synthetic-only, missing-artifact or failed-real-fixture candidates; a model is activated only when real-fixture benchmark evidence matches the exact recognizer, numeric helper, character helper and implementation fingerprints. See [MODEL_EVALUATION.md](MODEL_EVALUATION.md) for the current gate status.
- `document_lines` CRNN training can mix project fixture `expectedOcrTextSnippets` as rendered line samples. The tiny fixture-mix smoke command above is expected to write `projectFixtureTrainingSamples` in `metrics.json`; that proves the local snippets entered the training manifest, not that real-document OCR quality passed.
- Portfolio screenshot capture smoke with `pnpm portfolio:screenshots`

## Coverage Model

The active matrix covers unit, ML/OCR, integration, E2E, accessibility, failure, performance-regression, security and local live-smoke gates.
