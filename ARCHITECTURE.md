# Architecture

SpendLens AI is a local-first monorepo:

- `apps/api`: Fastify REST API, OpenAPI, auth/tenant/RBAC modules over time.
- `apps/web`: Next.js App Router UI.
- `packages/shared`: shared domain constants, money handling, RBAC, OCR and file safety utilities.
- `packages/db`: Prisma schema, migrations and seed scripts.
- `services/ocr`: Python FastAPI service, preprocessing, Tesseract engine and custom CRNN model code.
- `scripts`: repeatable local commands.
- `k8s`: local-cluster Kubernetes manifests.

PostgreSQL is the source of truth. Redis is hot state/cache only. Redpanda carries Kafka-compatible events. MinIO stores uploaded documents and generated artifacts.

Monetary values are represented as integer minor units in application code and `BigInt` database fields.
