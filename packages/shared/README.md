# @spendlens/shared — Shared TypeScript Utilities

Shared domain utilities used by the API and web app. Strict TypeScript, no framework dependencies.

## Modules (`src/`)

| File | Responsibility |
| --- | --- |
| `money.ts` | Integer minor-unit money parsing/arithmetic — no floating point |
| `roles.ts` | RBAC permission model |
| `ocr.ts` | OCR constants and helpers |
| `ensemble.ts` | OCR comparison/ensemble logic (provenance, confidence, conflicts) |
| `extraction.ts` | Deterministic field extraction and reconciliation |
| `ocr-normalization.ts` | OCR text normalization (raw text is always preserved upstream) |
| `categorization.ts` | Expense category/anomaly constants and reason codes |
| `events.ts` | Typed event catalog |
| `csv.ts` | CSV builder with formula-injection protection |
| `files.ts` | Filename normalization and file-type safety |
| `turkish-sandbox.ts` | Turkish receipt/invoice sandbox parsing helpers |

## Usage

```bash
pnpm --filter @spendlens/shared build       # tsc → dist/
pnpm --filter @spendlens/shared test        # Vitest
pnpm --filter @spendlens/shared typecheck
```

## Conventions

- No floating-point money anywhere; amounts cross process boundaries as integer minor units.
- Domain constants (document kinds, OCR engines, event types, permission names) live here so API and web never drift apart.
