# @spendlens/db — Prisma Database Package

Prisma schema, migrations and seed scripts for the SpendLens AI persistence model.

## Contents

- `prisma/schema.prisma` — full domain model (users, tenants, workspaces, documents, OCR runs, extraction, review, expenses, budgets, reports, models, jobs, events, audit, webhooks, notifications)
- `prisma/seed.ts` — synthetic demo tenant seed (`pnpm db:seed`)

## Usage

```bash
pnpm db:generate        # generate Prisma client
pnpm db:migrate         # apply migrations
pnpm db:migrate:dev     # create a new migration in development
pnpm db:seed            # seed the demo tenant
```

## Conventions

- Monetary values are stored as `BigInt` integer minor units. Application code must never use floating point for money.
- The schema is the source of truth for persistence; `SPENDLENS_USE_MEMORY_ADAPTERS=true` in the API selects deterministic in-memory repositories for tests.
- Database and application config live in `.env` (`DATABASE_URL`, `POSTGRES_*`).
