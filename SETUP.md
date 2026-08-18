# Setup

## Prerequisites

- Node.js 20+
- pnpm 10+
- Docker Desktop or Docker Engine
- Python 3.12 for the OCR service scripts. Docker uses Python 3.12 because PyTorch wheels are stable there.

## First-Time Local Setup

1. Copy environment defaults:

   ```bash
   cp .env.example .env
   ```

2. Install JavaScript dependencies:

   ```bash
   pnpm install
   ```

3. Generate Prisma client:

   ```bash
   pnpm db:generate
   ```

4. Start base dependencies:

   ```bash
   pnpm dev:ocr
   ```

   Defaults use PostgreSQL `15433`, Redis `16380`, Kafka `19092`, MinIO API `19002`, MinIO console `19003` and OCR service `18622`. `pnpm dev:ocr` is required for UI OCR flows; `pnpm dev:up` starts only the non-OCR dependencies for lighter backend/web work. The local app uses web `18620` and API `18621`. Override the matching `*_PORT` values in `.env` if needed.

   `pnpm dev:ocr` first verifies that the Docker engine is available, then waits until Docker health checks report the services ready. If Docker Desktop is closed, the command exits immediately with a clear instruction instead of waiting for PostgreSQL.

5. Apply database migrations and seed synthetic demo data:

   ```bash
   pnpm db:migrate
   pnpm db:seed
   ```

   The seed creates a fully synthetic local demo tenant:

   - Tenant slug: `demo`
   - Workspace: `Demo Workspace`
   - Login email: `demo.owner@spendlens.local`
   - Login password: `SpendLensDemo!2026`

   These credentials are only for local development and portfolio/demo validation. Do not reuse them in any deployed or shared environment.

   To generate synthetic receipt/invoice images for upload and OCR testing:

   ```bash
   python -m services.ocr.custom_model.dataset --profile tiny --output-dir data/generated/custom-ocr-documents
   ```

   `pnpm dev` also performs this dependency/OCR startup automatically, waits for the local PostgreSQL TCP port, and runs a safe `prisma db push --skip-generate` preflight so an existing local development database volume is repaired before the API starts. Set `SPENDLENS_SKIP_DEV_DB_SYNC=true` only when managing the schema manually.

6. Start apps:

   ```bash
   pnpm dev
   ```

   If this reports that ports `18620` or `18621` are already in use, inspect the owners with:

   ```bash
   pnpm dev:ports
   ```

   If the ports belong to this project's Docker `web`/`api` services, do not terminate the reported Docker PID. Use the exact Compose stop command printed by `pnpm dev:ports`; it preserves dependency volumes and OCR. Stop a PID only for a confirmed non-Docker old development process, or change `WEB_PORT`, `API_PORT`, `NEXT_PUBLIC_API_BASE_URL` and `CORS_ALLOWED_ORIGINS` together in `.env`.

## Full App Stack

After dependencies install and `.env` exists:

```bash
docker compose --profile app up --build
```

The app profile wires API and worker containers to `http://ocr-service:8000` and mounts `./artifacts` plus `./data/generated` into the API, worker and OCR service. This keeps custom OCR smoke-training artifacts local while making the same `model.pt` files available to `ocr.custom_crnn` inference jobs.

No public deployment is required or expected.
