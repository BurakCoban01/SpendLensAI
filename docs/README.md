# Documentation

This index maps the SpendLens AI documentation. Start with the [root README](../README.md), then follow the area you need.

## Product

| Document | What it covers |
| --- | --- |
| [README](../README.md) | Overview, features, architecture, quick start |
| [USER_GUIDE.md](../USER_GUIDE.md) | User-facing manual (Turkish/English UI flows) |
| [CHANGELOG.md](../CHANGELOG.md) | Release history |

## Run & Operate

| Document | What it covers |
| --- | --- |
| [SETUP.md](../SETUP.md) | First-time local setup |
| [RUNNING.md](../RUNNING.md) | Restarts, workers, consumers, E2E modes, reset |
| [FAILURE_RECOVERY.md](../FAILURE_RECOVERY.md) | Behavior when a dependency is down |
| [RUNBOOKS](runbooks/dependency-degraded.md) | Operational runbooks |
| [KUBERNETES.md](../KUBERNETES.md) | Kubernetes local-cluster deployment |

## Architecture & Data

| Document | What it covers |
| --- | --- |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | System overview |
| [API.md](../API.md) | Full REST API reference |
| [DATABASE.md](../DATABASE.md) | Persistence model and conventions |
| [EXPENSE_DOMAIN.md](../EXPENSE_DOMAIN.md) | Expense workflow domain |
| [KAFKA_EVENTS.md](../KAFKA_EVENTS.md) | Event catalog and outbox/inbox |
| [REDIS_AND_CACHING.md](../REDIS_AND_CACHING.md) | Cache keys, locks and degraded mode |
| [STORAGE_AND_MINIO.md](../STORAGE_AND_MINIO.md) | Object storage |
| [WORKERS_AND_JOBS.md](../WORKERS_AND_JOBS.md) | Worker job registry and processors |
| [OBSERVABILITY.md](../OBSERVABILITY.md) | Metrics, alerts, Grafana |
| [PERFORMANCE.md](../PERFORMANCE.md) | Performance guidance and benchmarks |
| [ADR](adr/0001-local-first-open-source-stack.md) | Architecture decision records |

## OCR & ML

| Document | What it covers |
| --- | --- |
| [OCR_PIPELINE.md](../OCR_PIPELINE.md) | End-to-end OCR flow |
| [TESSERACT_ENGINE.md](../TESSERACT_ENGINE.md) | Tesseract integration |
| [CUSTOM_OCR_MODEL.md](../CUSTOM_OCR_MODEL.md) | Custom OCR architecture and status |
| [CUSTOM_OCR_DEVELOPMENT_GUIDE.md](../CUSTOM_OCR_DEVELOPMENT_GUIDE.md) | Step-by-step Custom OCR dev guide (Turkish) |
| [MODEL_EVALUATION.md](../MODEL_EVALUATION.md) | Evaluation metrics and honest gate status |
| [DATASET_AND_ANNOTATION.md](../DATASET_AND_ANNOTATION.md) | Data generation, datasets, annotations |
| [AI_CATEGORIZATION.md](../AI_CATEGORIZATION.md) | Local category/anomaly model |
| [TURKISH_RECEIPT_INVOICE_SANDBOX.md](../TURKISH_RECEIPT_INVOICE_SANDBOX.md) | Turkish receipt/invoice sandbox scope |

## Quality & Security

| Document | What it covers |
| --- | --- |
| [TESTING.md](../TESTING.md) | Test strategy and commands |
| [SECURITY.md](../SECURITY.md) | Security model and hardening |
| [PRIVACY.md](../PRIVACY.md) | Local-first privacy rules |

## Component READMEs

| Component | README |
| --- | --- |
| API | [apps/api/README.md](../apps/api/README.md) |
| Web | [apps/web/README.md](../apps/web/README.md) |
| OCR service | [services/ocr/README.md](../services/ocr/README.md) |
| Database package | [packages/db/README.md](../packages/db/README.md) |
| Shared package | [packages/shared/README.md](../packages/shared/README.md) |

## Screenshots

Product screenshots live in [screenshots/](screenshots/). Regenerate them from the running app with `pnpm portfolio:screenshots`.
