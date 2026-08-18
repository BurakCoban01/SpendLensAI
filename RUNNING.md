# Running

## Normal Restart After Setup

```bash
pnpm dev
```

Use this path after dependencies are installed, `.env` exists and Docker Desktop/Engine is running. `pnpm dev` first checks web/API port ownership, then starts and waits for PostgreSQL, Redis, Redpanda, MinIO and the local OCR service. It syncs the PostgreSQL schema, runs the Custom OCR bootstrap safety gate, and finally starts the API on `http://localhost:18621` plus the web app on `http://localhost:18620`. The separate `pnpm dev:ocr` command remains available when only the dependency/OCR layer should be started.

Bootstrap does not train a model and it no longer registers a checkpoint merely because it exists. It resolves the `.env` `CUSTOM_OCR_DEFAULT_CHECKPOINT`, then requires a recognizable smoke result and real-fixture validation metadata. The real-fixture report must match the recognizer checkpoint, numeric helper, character helper and current Custom OCR implementation SHA-256 fingerprints. When no current matching report exists, startup runs one bounded real-fixture benchmark; it never substitutes synthetic evidence or starts a long training run. Unsafe candidates remain unavailable/failed and the UI shows a blocked or review-required state.

`pnpm dev` and `pnpm dev:ocr` check `docker info` before Compose. If Docker Desktop is closed or its Linux container engine is not ready, they fail immediately with explicit startup guidance instead of waiting 90 seconds or exposing only a Windows named-pipe error. Once Docker is ready, `dev:ocr` waits for service health checks. The command may retry once if Docker reports a stale missing Compose network; it does not remove volumes.

For non-OCR backend/web work only, `pnpm dev:up` still starts just PostgreSQL, Redis, Redpanda and MinIO. Do not use that lighter path for receipt/invoice OCR validation.

If another local tool already owns the default local ports, edit `.env` before starting:

```dotenv
API_PORT=18631
WEB_PORT=18630
NEXT_PUBLIC_API_BASE_URL=http://localhost:18631
CORS_ALLOWED_ORIGINS=http://localhost:18630,http://127.0.0.1:18630
```

The built API start path is `pnpm --filter @spendlens/api start`.

`pnpm dev` checks the default web/API ports before starting. If `18620` or `18621` is published by this project's Docker Compose `web`/`api` services, it identifies those services and explicitly warns not to terminate the Docker-owned PID. The containerized app is already usable in that state. To switch to local hot reload while preserving PostgreSQL, Redis, Redpanda, MinIO and OCR, run:

```bash
docker compose --profile app stop web worker event-consumer api
pnpm dev
```

For non-Docker listeners, it reports the owning PID and inspection commands. You can inspect either state without starting the app:

```bash
pnpm dev:ports
```

On Windows, confirm the process is an old SpendLensAI web/API server before stopping it:

```powershell
Get-NetTCPConnection -LocalPort 18620,18621 -State Listen | Select-Object LocalPort,OwningProcess
Stop-Process -Id <PID> -Confirm
```

If the listener is unrelated, override `WEB_PORT`, `API_PORT`, `NEXT_PUBLIC_API_BASE_URL` and `CORS_ALLOWED_ORIGINS` together in `.env`.

## Dedicated Local Worker

The dedicated worker process drains durable worker jobs through the same admin job runner used by the UI.

For development, configure either `WORKER_ACCESS_TOKEN` or `WORKER_TENANT_SLUG`, `WORKER_EMAIL` and `WORKER_PASSWORD` in `.env`. The worker user must have `admin.jobs.manage`.

```bash
pnpm --filter @spendlens/api dev:worker
```

After a build:

```bash
pnpm --filter @spendlens/api build
pnpm --filter @spendlens/api start:worker
```

With Docker Compose:

```bash
docker compose --profile app --profile worker up worker
```

The Compose app profile sets `OCR_SERVICE_URL=http://ocr-service:8000` for API and worker containers, and bind-mounts `./artifacts` plus `./data/generated` into API, worker and OCR service containers. Custom OCR quick/full training can run through the OCR service in Docker or fall back to the local runner when the service route is unavailable. Resulting `local-artifacts` model paths are visible to later `ocr.custom_crnn` inference jobs only after promotion/bootstrap gates pass. For an existing local_full checkpoint, `pnpm custom-ocr:bootstrap --all-tenants` verifies smoke snippets and real-fixture evidence; if the gate fails it marks matching active local models as `FAILED` with `promotionBlockedReason` instead of leaving unsafe models active.

Normal `ocr.custom_crnn` jobs must resolve an active, real-fixture-validated registry model. Registry-external checkpoint payloads are disabled by default. `CUSTOM_OCR_ALLOW_UNREGISTERED_CHECKPOINT=1` is reserved for controlled local smoke diagnostics and must not be enabled in normal application or production-like runs.

The worker polls `POST /admin/jobs/run-next`, so it uses the existing tenant isolation, RBAC and job-state transitions. Redis-backed processor coordination beyond current locks and hot state is still tracked as pending work.

## Kafka Event Consumer

The standalone event consumer records idempotent inbox checkpoints from Kafka-compatible broker messages.

```bash
pnpm --filter @spendlens/api dev:event-consumer
```

After a build:

```bash
pnpm --filter @spendlens/api build
pnpm --filter @spendlens/api start:event-consumer
```

With Docker Compose:

```bash
docker compose --profile app --profile worker up event-consumer
```

Configure `KAFKA_BROKERS` and optionally `EVENT_CONSUMER_CLIENT_ID`, `EVENT_CONSUMER_GROUP_ID`, `EVENT_CONSUMER_NAME` and `EVENT_CONSUMER_TOPICS`. The consumer validates catalog topics, records one inbox row per consumer/event pair and logs malformed messages without exposing event payloads.

## Event Outbox Drainer

The event drainer periodically publishes durable outbox rows through the protected admin drain endpoint. Configure either `EVENT_DRAINER_ACCESS_TOKEN` or `EVENT_DRAINER_TENANT_SLUG`, `EVENT_DRAINER_EMAIL` and `EVENT_DRAINER_PASSWORD`; the account must have `admin.events.publish`.

The drainer is intentionally outside the normal `app` and `worker` profiles because it cannot authenticate with empty credentials. After configuring one authentication mode, start it explicitly with `docker compose --profile drainer up -d event-drainer`. Normal local startup does not create a permanently failed drainer container.

```bash
pnpm --filter @spendlens/api dev:event-drainer
```

After a build:

```bash
pnpm --filter @spendlens/api build
pnpm --filter @spendlens/api start:event-drainer
```

With Docker Compose:

```bash
docker compose --profile drainer up -d event-drainer
```

`EVENT_DRAINER_LIMIT` bounds each cycle. `EVENT_DRAINER_INCLUDE_FAILED=false` drains only pending rows; set it to `true` when intentionally retrying failed/DLQ-backed rows.

## E2E Smoke Mode

```bash
pnpm test:e2e
```

The E2E runner starts the API on port `4100` with `SPENDLENS_USE_MEMORY_ADAPTERS=true` and the web app on port `3000`. This is only for deterministic browser validation; it does not replace PostgreSQL, MinIO, Redis or Kafka integration checks.

For an opt-in Docker-backed browser smoke test:

```bash
pnpm test:e2e:docker
```

This command starts PostgreSQL, Redis, Redpanda and MinIO with Docker Compose, applies migrations, starts the API on `4101` with `SPENDLENS_USE_MEMORY_ADAPTERS=false`, starts the web app on `3001` and verifies registration, protected admin health dependency flags, PostgreSQL-backed document persistence and MinIO signed URL generation.

For the focused large-file acceptance path, run the resumable upload spec with real Docker adapters:

```powershell
$env:SPENDLENS_E2E_MEMORY_ADAPTERS="false"; $env:SPENDLENS_E2E_API_PORT="4110"; $env:SPENDLENS_E2E_WEB_PORT="3010"; $env:SPENDLENS_E2E_WEB_BASE_URL="http://127.0.0.1:3010"; pnpm exec playwright test e2e/resumable-upload.spec.ts
```

This uses PostgreSQL and MinIO instead of memory adapters and verifies a logged-in user can upload a 21 MB PNG through CRC32 chunks, pause/resume safely, complete SHA-256 verification and see the composed document in the UI.

For final OCR acceptance:

```bash
pnpm test:ocr-acceptance
```

This starts the OCR Docker dependency path, applies migrations, runs the real browser OCR flow and must not be skipped when OCR service is unavailable.

For Custom OCR acceptance, run:

```bash
SPENDLENS_CUSTOM_OCR_ACCEPTANCE=1 pnpm exec playwright test e2e/custom-ocr-active-flow.spec.ts
```

This test passes only when Custom OCR either produces expected real-fixture snippets or is explicitly blocked because no safe active model is registered. A non-empty garbage Custom OCR result is not an acceptable success state.

## Stop Services

```bash
pnpm dev:down
```

This stops the normal dependency services and the optional `app` / `worker` profile containers such as `ocr-service`, then removes orphan containers. If Docker reports that the project network is still in use, inspect the remaining container with `docker compose --profile app --profile worker ps` before stopping it.

## Reset Local State

This deletes local containers and volumes.

```bash
pnpm reset:local
```

Then repeat `SETUP.md`.
