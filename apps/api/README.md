# @spendlens/api — Fastify REST API

The SpendLens AI backend: a modular Fastify API with OpenAPI documentation, tenant isolation, RBAC, durable workers and operations endpoints.

## Endpoints

- OpenAPI docs (Swagger UI): `http://localhost:18621/docs`
- Health: `GET /health/live`, `GET /health/ready`
- Metrics (Prometheus text format): `GET /metrics`

## Modules (`src/modules`)

| Module | Responsibility |
| --- | --- |
| `auth` | Registration, login, refresh rotation, sessions, API keys |
| `workspaces` | Tenant-scoped workspaces |
| `documents` | Upload (incl. resumable chunks), duplicate detection, signed URLs, pages, preprocessing artifacts |
| `ocr-comparison` | Tesseract/Custom OCR runs, ensemble metrics, token boxes, conflicts |
| `extraction` | Structured field extraction and line-item reconciliation |
| `review` | Review tasks, corrections, annotations, active-learning suggestions |
| `expenses` | Expenses, imports, attachments, comments, splits, recurring, subscriptions, reimbursements, approvals, policies |
| `budgets` | Budgets, monthly spend, finance insights |
| `reports` | CSV/JSONL/PDF export jobs persisted to object storage |
| `models` | Model registry, training/evaluation runs, promotion/rollback |
| `jobs` | Durable worker job registry and runner |
| `events` | Outbox/inbox event catalog, drain/publish, Kafka lag |
| `cache` | Cache health, keys, locks |
| `audit` | Central tenant-scoped audit log, export, retention |
| `notifications` | User-scoped notifications |
| `webhooks` | Webhook endpoints and delivery |
| `ai` | Deterministic local category/anomaly analysis |
| `metrics` | Prometheus metrics registry |
| `security` | Security headers, CORS, rate limiting |
| `turkish-sandbox` | Turkish receipt/invoice sandbox parsing |

## Processes

- `main.ts` — API server (default port `18621`)
- `worker.ts` — dedicated worker polling `POST /admin/jobs/run-next`
- `event-consumer.ts` — Kafka-compatible consumer recording idempotent inbox checkpoints
- `event-drainer.ts` — periodically drains the outbox through the admin drain endpoint

## Development

```bash
pnpm --filter @spendlens/api dev          # watch mode
pnpm --filter @spendlens/api lint        # eslint
pnpm --filter @spendlens/api typecheck   # TypeScript
pnpm --filter @spendlens/api test        # Vitest suite
pnpm --filter @spendlens/api build       # tsc build → dist/
pnpm --filter @spendlens/api start       # run built server
```

See [API.md](../../API.md) for the full endpoint reference and [RUNNING.md](../../RUNNING.md) for the worker/consumer/drainer runbooks.
