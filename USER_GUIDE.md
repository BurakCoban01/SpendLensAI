# User Guide

## Current Implemented Flows

### Create A Workspace

1. Open `http://localhost:18620/register`.
2. Enter tenant name, tenant slug, workspace name, display name, email and a password of at least 12 characters.
3. The frontend calls `POST /auth/register`, creates an owner account and stores the returned local session in browser storage.
4. You are redirected to `/dashboard`.

### Sign In

1. Open `http://localhost:18620/login`.
2. Enter tenant slug, email and password.
3. The frontend calls `POST /auth/login`.
4. A successful login opens the permission-aware dashboard.

### Permission-Aware Dashboard

The dashboard calls `GET /auth/me` and renders each module as `Allowed` or `Denied` based on server-issued permissions.

Current module gates:

- `documents.upload`
- `ocr.run`
- `ocr.review`
- `annotations.manage`
- `expenses.read`
- `reports.export`
- `api_keys.manage`
- `admin.health.read`
- `admin.cache.read`
- `admin.audit.read`

### Document Upload

Owner users can open `/documents/upload` from the dashboard.

Flow:

1. Select an active workspace from the workspace selector.
2. Choose document kind: `RECEIPT`, `INVOICE` or `OTHER`.
3. Select a JPEG, PNG, WebP, TIFF or PDF file.
4. Submit the upload. The API verifies the file signature, normalizes the filename, checks for same-tenant duplicates by SHA-256 and stores metadata.
5. Recent files are listed for the selected workspace.
6. Use `Signed URL` to request a short-lived download URL for a stored file.

Validation errors are shown directly from the API error code, including unsupported type, spoofed MIME signature, oversized file, missing workspace or missing permission.

### Expenses

Owner users can open `/expenses` from the dashboard.

Current UI flow:

1. Select an active workspace.
2. Enter title, amount, currency, tax, date and optional project/cost-center metadata.
3. Mark the expense as business and/or reimbursable where needed.
4. Submit the form. The frontend converts the decimal amount into integer minor units before calling the API.
5. Review the workspace ledger with persisted manual and OCR-created expenses.

The local API also supports:

- `POST /expenses` for manual expense creation
- `GET /expenses?workspaceId=<workspace-id>` for tenant-scoped listing
- `POST /documents/:id/expense` to create an expense from the latest extraction for a document
- `POST /expenses/:id/approve` for approval decisions
- `POST /expenses/:id/reject` for rejection decisions

Amounts are sent as integer minor units, for example `18550` for `185,50 TRY`.

### Expense Approvals

Owner users can open `/approvals` from the dashboard.

Current UI flow:

1. Select a workspace.
2. Review pending expenses with status `DRAFT`, `EXTRACTED` or `NEEDS_REVIEW`.
3. Optionally enter a decision reason.
4. Approve or reject an expense.
5. Review decided expenses in the same workspace.

Approval decisions update the expense status, persist an approval workflow record and write an audit log. The approvals page also exports an approval evidence CSV for accountant/auditor review, including SLA, policy and reimbursement context from persisted records.

### Budgets And Monthly Analytics

Owner users can open `/budgets` from the dashboard.

Current UI flow:

1. Select a workspace and month.
2. Review monthly total, business and reimbursable spend from persisted expenses.
3. Create a budget by entering name, amount, currency and alert percent.
4. Review utilization, remaining amount and alert state for each budget.

The local API also supports:

- `POST /budgets` creates a workspace budget and calculates the requested month's `BudgetPeriod`.
- `GET /budgets?workspaceId=<workspace-id>&month=2026-05` lists budget usage for a month.
- `GET /analytics/monthly-spend?workspaceId=<workspace-id>&month=2026-05` returns persisted expense totals and budget utilization.

### Reports

Owner users can open `/reports` from the dashboard.

Current UI flow:

1. Select a workspace and month.
2. Choose expense ledger, category breakdown or merchant spend CSV.
3. Generate the export. The API creates the CSV from persisted expenses, stores the file through the object-storage adapter and records an export job.
4. Open the short-lived signed URL returned for the latest export.
5. Review export job history for the selected workspace.

The local API also supports:

- `POST /reports/exports` to generate a persisted CSV export.
- `GET /reports/exports?workspaceId=<workspace-id>` to list export jobs.

CSV exports protect cells that could be interpreted as spreadsheet formulas. Monetary values remain integer minor units.

### Operations Health

Owner users can open `/admin/health` from the dashboard.

Current UI flow:

1. Open Operations from the permission-aware dashboard.
2. Review the overall dependency status and checked time.
3. Inspect component rows for API, PostgreSQL, Redis, Kafka, MinIO, Tesseract and workers.
4. Use refresh to reload the protected `GET /admin/health` response.

The admin health endpoint requires `admin.health.read`. Public liveness/readiness endpoints remain available at `/health/live` and `/health/ready`.

### Event Outbox

Owner users can open `/admin/events` from the dashboard.

Current UI flow:

1. Open Events from the permission-aware dashboard.
2. Review pending, published and failed outbox counts.
3. Filter by event topic or delivery state.
4. Inspect topic, aggregate ID, created time, catalog description and correlation ID for each event.

The event browser requires `admin.events.read`. Product flows write durable outbox events for document uploads, expense creation, expense approval/rejection and report generation. The standalone event consumer and drainer processes (see `RUNNING.md`) deliver broker messages and publish pending outbox rows; PostgreSQL outbox rows remain the durable recovery source.

### Worker Jobs

Owner users can open `/admin/jobs` from the dashboard.

Current UI flow:

1. Open Jobs from the permission-aware dashboard.
2. Review queued, running, succeeded, failed and canceled counts.
3. Filter by queue or job state.
4. Inspect job type, progress, attempts and failure reason.
5. Retry failed jobs when the account has `admin.jobs.manage`.

The job monitor requires `admin.jobs.read`. Enqueue and retry actions require `admin.jobs.manage`. The API runtime and the dedicated worker process drain queued jobs (preprocessing → OCR → extraction → reports), with Redis-backed coordination locks when Redis is available and PostgreSQL job state as the durable fallback.

### Cache Operations

Owner users can open `/admin/cache` from the dashboard.

Current UI flow:

1. Open Cache from the permission-aware dashboard.
2. Review the active cache backend, connection state and checked time.
3. Filter keys by prefix, such as `worker-job:`.
4. Inspect matching cache keys and TTL values.
5. Use the lock probe to acquire a short-lived coordination lock when the account has `admin.cache.manage`.

The cache operations page requires `admin.cache.read`. Lock acquire/release APIs require `admin.cache.manage`. Redis is used only for hot state and coordination; PostgreSQL remains the durable source of truth for jobs and business records.

### Audit Logs

Owner, Admin, Accountant and Auditor users can open `/admin/audit` from the dashboard when their role includes `admin.audit.read`.

Current UI flow:

1. Open Audit from the permission-aware dashboard.
2. Review the tenant's total audit log count.
3. Inspect action and resource summaries.
4. Filter logs by action, resource type or actor user ID.
5. Review each log's action, resource, actor, correlation ID, timestamp and metadata.

Audit log reads are tenant-scoped. The page is for operational traceability and security review, not external compliance certification.

### Review And Annotation

Owner users can open `/review` from the dashboard.

Current UI flow:

1. Select a workspace and document.
2. Check the selected document metadata, safe filename and short-lived document access link.
3. Review the document workspace panel for the selected document hash and prior correction history.
4. Paste OCR text into the structured extraction panel and run extraction for the selected document when a persisted extraction is needed.
5. Review the latest extracted merchant, date, total, tax, payment method, validation issues and line items.
6. Create a review task with comma-separated reason codes such as `LOW_CONFIDENCE`.
7. Assign queued tasks to yourself, or as an owner/admin select an eligible reviewer from the reviewer list.
8. Use the workload/SLA cards to check queued, running, overdue and due-soon review pressure before reassigning work.
9. Review SLA rebalancing suggestions and, when you have assignment management permission, apply the suggested reviewer move.
10. Use `Plan escalation` to preview bounded SLA escalation actions, or `Run escalation` to assign the suggested tasks and persist `SLA_ESCALATED` reason evidence.
11. Complete or reject queued review tasks after checking the document.
12. Record a corrected field value. The API stores the correction, creates annotation data and queues an active-learning suggestion.
13. Adjust OCR bounding-box annotations from the image-backed editor when the signed document URL is browser-renderable, or use the numeric fields when it is not.
14. Select OCR token boxes by engine and page to persist single-token, multi-token or multi-page annotation payloads for model-training datasets.
15. Export the workspace training dataset as JSONL when the corrected annotation set is ready for model training.
16. Start a bounded custom OCR smoke-training run from the latest dataset export when model training permission is available.
17. Review active-learning suggestions for the selected workspace.

The local API also supports:

- `POST /documents/:id/review-tasks`
- `POST /documents/:id/extraction`
- `GET /documents/:id/extraction`
- `GET /review/tasks?workspaceId=<workspace-id>`
- `GET /review/reviewers`
- `GET /review/workload?workspaceId=<workspace-id>`
- `GET /review/rebalance-suggestions?workspaceId=<workspace-id>`
- `POST /review/escalations/run`
- `POST /review/tasks/:id/assign`
- `POST /review/tasks/:id/complete`
- `POST /review/tasks/:id/reject`
- `POST /documents/:id/corrections`
- `GET /documents/:id/corrections`
- `POST /documents/:id/annotations`
- `GET /documents/:id/annotations`
- `GET /active-learning/suggestions?workspaceId=<workspace-id>`
- `POST /reports/exports` with `type: "dataset_export_jsonl"`
- `POST /models/custom-ocr/train-from-dataset-export`

The review workspace is implemented and usable locally. Broader live dependency coverage is available through the E2E modes documented in `RUNNING.md`.

### API Key Management

Owner users can create scoped API keys from `/dashboard`.

Rules:

- raw API key is shown only once
- list view shows only prefix and metadata
- revoked keys no longer authenticate
- automation requests use `Authorization: ApiKey <raw-key>` and `x-tenant-id`

### Settings, AI And Webhooks

Owner users can open `/settings` from the dashboard.

Current UI flow:

1. Review account, workspace and active session information.
2. Check AI provider status. External LLM providers are shown as disabled/off unless Gemini or Z.ai keys are configured.
3. Review whether raw input storage is enabled before sending OCR/extraction content to an external provider.
4. Review webhook endpoints and create a new endpoint by entering an HTTPS URL and event list.
5. Copy the one-time `whsec_...` secret shown after creation. It is not shown again.
6. Verify webhook deliveries with the HMAC SHA-256 signature headers documented in `API.md`.

Legacy webhook endpoints created before encrypted signing material are treated as unsigned legacy endpoints until rotated.

## Pending Product Flows

Some areas continue to evolve: multi-token/multi-page review canvases, deeper SLA escalation automation, long-running Kafka consumers with autonomous retries, live Redis-backed rate limiting across all routes and broader production-like integration coverage. The fastest way to verify the current behavior of any flow is to run the test matrix documented in `TESTING.md`.
