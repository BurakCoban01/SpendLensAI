# Database

`packages/db/prisma/schema.prisma` defines the persistence model. It includes all requested core domain entity names plus outbox support. Expense workflow persistence also includes local `ExpensePolicy` rules for workspace approval checks and `ApprovalWorkflow` SLA fields for local 48-hour approval due tracking.

Run:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

Monetary amounts use `BigInt` minor units or decimal quantities. Application code must not use floating point for money.
