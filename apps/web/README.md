# @spendlens/web — Next.js Web Application

The SpendLens AI user interface: Next.js App Router, Turkish primary locale with English support, light/dark themes and a shared `AppShell` layout.

## Routes (`app/`)

| Route | Page |
| --- | --- |
| `/` | Landing |
| `/register` · `/login` | Auth |
| `/dashboard` | Workspace dashboard (KPIs, monthly spend) |
| `/documents` | Document intake, upload, OCR comparison |
| `/review` | Review queue: corrections, annotations, extraction |
| `/expenses` | Expense ledger, imports, reimbursements, recurring |
| `/approvals` | Approval queue with SLA visibility |
| `/budgets` | Budgets and finance insights |
| `/reports` | Report exports |
| `/models` | Model registry and benchmark dashboard |
| `/settings` | AI/automation and webhook settings |
| `/admin/*` | Operations consoles: health, events, jobs, cache, audit |

## Key Conventions

- **Language:** Turkish is the primary locale (`?lang=tr` default), English (`?lang=en`) is supported; `locale-toggle.tsx` switches.
- **Theme:** Light/dark via `theme-toggle.tsx`.
- **Layout:** Shared `AppShell` (sidebar + navigation) preserved across pages; role-aware navigation driven by RBAC.
- **Data:** Page components use client components under `components/` (e.g. `expenses-client.tsx`); the API is consumed through `NEXT_PUBLIC_API_BASE_URL`.
- **Responsive:** Mobile, tablet, desktop and wide-desktop breakpoints; admin surfaces keep dense but bounded layouts.

## Development

```bash
pnpm --filter @spendlens/web dev          # via scripts/next-web.mjs (port 18620)
pnpm --filter @spendlens/web lint
pnpm --filter @spendlens/web typecheck
pnpm --filter @spendlens/web build       # next build
pnpm --filter @spendlens/web start       # next start
```

Run the full stack with `pnpm dev` from the repository root. See [USER_GUIDE.md](../../USER_GUIDE.md) for the user-facing manual.
