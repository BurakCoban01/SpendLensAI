# Expense Domain

The Prisma schema includes tenants, workspaces, documents, OCR jobs, extracted fields, expenses, line items, budgets, approval workflows, reimbursement claims, reports and audit logs.

Expense amounts use integer minor units. Tax and KDV fields are configurable product data, not legal advice or official tax compliance.

## Structured Extraction Foundation

The shared extraction module converts OCR text into deterministic receipt fields before expense creation. Current extracted fields include merchant, receipt number, date, time, currency, subtotal, discount, KDV/tax total, total, payment method, masked card last four digits and line items.

Validation issues are emitted for missing critical fields, future dates, low OCR confidence and amount reconciliation mismatches. The API endpoint `POST /documents/:id/extraction` persists extraction jobs, fields and validation issues for tenant-scoped documents.

Pending work: connect extraction to OCR workers automatically, expose review/correction UI and create expenses from approved extraction output.

## Expense Creation Foundation

The API now supports manual expense creation and expense creation from the latest document extraction. All amounts use integer minor units as strings at the API boundary and `BigInt` in service/repository logic.

Implemented endpoints:

- `POST /expenses`
- `GET /expenses`
- `POST /expenses/imports`
- `GET /expenses/imports`
- `GET /expenses/:id/attachments`
- `POST /expenses/:id/attachments`
- `DELETE /expenses/:id/attachments/:documentFileId`
- `GET /expenses/:id/ai-analysis`
- `POST /expenses/:id/ai-analysis`
- `POST /documents/:id/expense`
- `POST /expenses/:id/approve`
- `POST /expenses/:id/reject`
- `GET /approvals/sla`
- `GET /expense-policies`
- `POST /expense-policies`
- `DELETE /expense-policies/:id`
- `GET /expenses/:id/policy-evaluation`
- `GET /reimbursement-claims`
- `POST /reimbursement-claims`
- `POST /reimbursement-claims/:id/approve`
- `POST /reimbursement-claims/:id/reject`
- `POST /reimbursement-claims/:id/mark-paid`

Current persistence covers `Expense`, `ExpenseLineItem`, `Merchant`, optional `PaymentMethod`, `ExpenseCategory`, `ImportBatch`, `ExpensePolicy`, `ApprovalWorkflow`, `ReimbursementClaim`, `ReimbursementClaimExpense`, `MLCategoryPrediction` and `AuditLog`. The extracted expense path maps merchant, date, total, KDV/tax, payment method and line items from the latest persisted extraction.

The `/expenses` frontend page provides a first workspace ledger, manual-entry flow, CSV import panel and primary document attachment controls. It converts user-entered decimal amounts to integer minor units before calling `POST /expenses`, sends pasted CSV to `POST /expenses/imports`, lists persisted workspace expenses and shows status, source, merchant, AI category state, business/reimbursable flags, import batch history, document attachment state and workspace totals.

The attachment foundation manages one primary document per expense through the persisted `Expense.documentId` field. Attach/detach operations validate tenant and workspace scope, reject archived expenses, write audit evidence and emit `expense.updated` lifecycle events.

The AI analysis foundation exposes `GET /expenses/:id/ai-analysis` for non-mutating previews and `POST /expenses/:id/ai-analysis` for persisted runs. It runs a local deterministic category/anomaly baseline over the persisted expense plus workspace peer expenses and returns category confidence, matched keywords, explanation reasons, anomaly reason codes and saved prediction metadata when persisted. Persisted runs create an `MLCategoryPrediction`, ensure the tenant category row exists, update the expense `categoryId` and write an `expense.category_predicted` audit log. It does not use external AI services and does not present predictions as absolute truth.

The approval foundation creates a pending `ApprovalWorkflow` row when an expense is created, tracks a local 48-hour approval SLA due date, updates expense status to `APPROVED` or `REJECTED`, records on-time/late SLA outcome on decision and writes `expense.approved` or `expense.rejected` audit events. The `/approvals` frontend page exposes a workspace approval queue with reason input, decision actions and SLA status/due-date visibility. `GET /approvals/sla` returns the same tenant/workspace-scoped SLA view for operations and tests.

The policy foundation persists active workspace expense policies for maximum amount, receipt threshold, project-required, allowed-category and duplicate-receipt checks. `GET /expenses/:id/policy-evaluation` returns warning/blocker findings from real persisted expenses and active policies. Expense approval runs the same evaluator automatically: blocker findings reject approval with `EXPENSE_POLICY_BLOCKED`, while warning findings are stored in the approval workflow policy snapshot. The `/expenses` page includes policy creation/listing/archive controls plus row-level evaluation results.

The reimbursement foundation creates tenant/workspace-scoped claims from reimbursable expenses, validates positive same-currency integer minor-unit totals, prevents duplicate active claims, persists linked claim items, supports approve/reject/mark-paid decisions and updates linked expenses to `REIMBURSED` when paid. The `/expenses` page now includes a reimbursement panel for selecting eligible expenses, submitting a claim and running manager/finance actions. Approved and reimbursed claim lines can be exported through the `reimbursement_batch_csv` report type for finance payout review, and summarized as a locally generated `reimbursement_claim_report_pdf` artifact. Full multi-attachment metadata and richer trainable category-model automation are still pending.

## Budget And Monthly Analytics Foundation

The API supports persisted workspace budgets and monthly budget periods:

- `POST /budgets`
- `GET /budgets`
- `GET /analytics/monthly-spend`

Budget amounts use integer minor units. The budget service calculates monthly spend from persisted expenses, upserts a `BudgetPeriod` for the requested month and returns utilization, remaining amount and alert state. Monthly analytics currently returns total spend, business spend, reimbursable spend, expense count and budget usage.

The `/budgets` frontend page provides the first budget and analytics workspace. It includes workspace/month controls, budget creation, monthly total/business/reimbursable KPIs, budget utilization bars, remaining amount and alert status.

Pending work: category breakdown charts, richer budget alerts, recurring/subscription views, cashflow, savings targets, trend comparisons and anomaly analytics.

## Report Export Foundation

The API supports first CSV exports generated from persisted workspace expenses:

- `POST /reports/exports`
- `GET /reports/exports`

Current report types are expense ledger CSV, category breakdown CSV, merchant spend CSV, reimbursement batch CSV, reimbursement claim PDF, OCR quality CSV, model evaluation CSV, audit pack CSV, dataset JSONL and monthly expense report PDF. Generated files are written through the MinIO-compatible storage adapter, and each generation stores an `ExportJob` row. CSV cells are sanitized against spreadsheet formula injection, PDF summaries are generated locally from persisted expenses and reimbursement claims, reimbursement batches are generated from persisted claim rows, OCR quality reports are generated from persisted OCR comparison jobs/runs, model evaluation reports are generated from persisted model registry/evaluation rows, audit packs are generated from persisted expenses and audit logs, dataset JSONL manifests are generated from persisted documents, annotations, corrections and active-learning suggestions, and monetary values remain integer minor units.

The `/reports` frontend page provides workspace/month/type controls, export generation, signed URL display and export job history.

Pending work: none for the current report/export foundation.
