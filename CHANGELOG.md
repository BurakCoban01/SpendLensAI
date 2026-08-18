# Changelog

All notable changes to SpendLens AI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-18

Initial public release. Local-first expense intelligence platform with OCR, human review, expense workflows and operations consoles.

### Added

#### Platform & infrastructure

- pnpm/Turborepo monorepo with strict TypeScript across all packages.
- Fastify REST API with OpenAPI docs, validation, rate limiting, security headers and CORS allow-listing.
- Next.js App Router web application with Turkish primary locale, English locale support and light/dark themes.
- Prisma/PostgreSQL persistence with in-memory adapters for deterministic tests.
- Docker Compose local stack: PostgreSQL, Redis, Redpanda-compatible Kafka, MinIO and the OCR service.
- Kubernetes local-cluster manifests and a CI workflow (lint, typecheck, tests, build, Python compile).

#### Auth, tenants & security

- Email/password registration, login, refresh-token rotation, session inventory and logout-all.
- Multi-tenant workspaces with RBAC and API-key automation.
- Central audit log with tenant-scoped filtering, JSONL export and retention controls.
- Secret-safe audit records (no tokens, signed URLs, object keys or payload content copied).

#### Documents, OCR & extraction

- Document upload with binary signature validation, SHA-256 duplicate detection, signed URLs and soft deletion.
- Resumable chunked upload with CRC32 verification and final SHA-256 integrity check.
- Preprocessing profiles with page artifacts and quality decisions.
- Tesseract OCR integration with explicit failure handling.
- Project-owned, trainable CRNN/CTC Custom OCR engine with Turkish finance vocabulary (experimental; activation requires passing real-fixture benchmark evidence).
- OCR comparison, ensemble provenance, confidence, conflicts and token bounding boxes.
- Structured Turkish receipt/invoice extraction with field and line-item reconciliation.
- Human review: tasks, assignment, corrections, bounding-box annotations, active-learning suggestions and dataset export.

#### Expenses & finance workflows

- Manual and extraction-derived expenses, CSV import, attachments, comments, splits, recurring rules and subscription detection.
- Reimbursement claims with approve/reject/mark-paid transitions.
- Approval workflows with 48-hour SLA tracking and policy warnings/blocks.
- Budgets, monthly analytics, finance insights and deterministic local category/anomaly prediction.
- CSV, JSONL and PDF report exports persisted through object storage.

#### Models & operations

- Model registry with smoke/full local training profiles, promotion/rollback and benchmark dashboard.
- Durable worker job system with queue, retry, progress, heartbeat and chained OCR/extraction/report processing.
- Durable outbox/inbox event foundation with Kafka-compatible broker support.
- Redis cache abstraction: rate limiting, job hot state, locks and inference/analytics caches.
- Admin consoles for health, events, jobs, cache and audit.
- Prometheus metrics endpoint with bounded labels, alert rules and a provisioned Grafana dashboard.
- Structured JSON logs with request and correlation IDs.
