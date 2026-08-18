import { createHash } from "node:crypto";
import type { ExpenseStatus } from "@prisma/client";
import {
  CurrencyCodeSchema,
  detectExpenseAnomalies,
  isStandardExpenseDocument,
  normalizeCategoryConfidence,
  predictExpenseCategory,
  type CategoryPrediction,
  type ExtractedReceiptFields,
  type ExpenseAnomaly,
  type ExpenseCategoryKey
} from "@spendlens/shared";
import { parse as parseCsv } from "csv-parse/sync";
import type { AuditRepository } from "../audit/types";
import type { AuthPrincipal } from "../auth/types";
import type { CacheService } from "../cache/service";
import type { DocumentRepository } from "../documents/types";
import type { EventService } from "../events/service";
import type { ExtractionRepository } from "../extraction/types";
import type { ReviewRepository } from "../review/types";
import type { ApprovalSlaItem, ExpensePolicyEvaluation, ExpenseRepository, StoredExpense, StoredExpensePolicy } from "./types";

export class ExpenseError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400,
    public readonly issues: Array<{ code: string; severity: string; message: string }> = []
  ) {
    super(code);
  }
}

export class ExpenseService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly extractions: ExtractionRepository,
    private readonly expenses: ExpenseRepository,
    private readonly events?: EventService,
    private readonly cache?: CacheService,
    private readonly audit?: AuditRepository,
    private readonly reviews?: ReviewRepository
  ) {}

  async createManual(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    title: string;
    description?: string | null;
    currency: string;
    amountMinor: string;
    taxMinor?: string | null;
    occurredAt: string;
    merchantName?: string | null;
    paymentMethodName?: string | null;
    reimbursable?: boolean;
    businessExpense?: boolean;
    projectCode?: string | null;
    costCenter?: string | null;
    correlationId?: string | null;
  }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    const currency = CurrencyCodeSchema.parse(input.currency);
    const created = await this.expenses.create({
      tenantId: input.principal.tenantId,
      workspaceId: input.workspaceId,
      title: input.title.trim(),
      description: input.description ?? null,
      currency,
      amountMinor: parseMinor(input.amountMinor),
      taxMinor: input.taxMinor ? parseMinor(input.taxMinor) : 0n,
      occurredAt: parseDate(input.occurredAt),
      merchantName: input.merchantName ?? null,
      paymentMethodName: input.paymentMethodName ?? null,
      reimbursable: input.reimbursable ?? false,
      businessExpense: input.businessExpense ?? false,
      projectCode: input.projectCode ?? null,
      costCenter: input.costCenter ?? null,
      createdById: input.principal.userId
    });
    await this.recordExpenseCreatedAudit(input.principal, created.expense, "manual", input.correlationId ?? null);
    await this.publishExpenseEvent(input.principal, "expense.created", created.expense.id, {
      workspaceId: created.expense.workspaceId,
      status: created.expense.status,
      amountMinor: created.expense.amountMinor.toString(),
      currency: created.expense.currency,
      source: "manual"
    });
    return created;
  }

  async createFromLatestExtraction(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    forceNonExpenseDocument?: boolean;
    correlationId?: string | null;
  }) {
    const document = await this.documents.findById(input.principal.tenantId, input.documentFileId);
    if (!document || document.deletedAt) throw new ExpenseError("DOCUMENT_NOT_FOUND", 404);
    const extraction = await this.extractions.findLatestByDocument(input.principal.tenantId, document.id);
    if (!extraction) throw new ExpenseError("EXTRACTION_NOT_FOUND", 404);
    if (!extraction.extracted.total) throw new ExpenseError("EXTRACTION_TOTAL_REQUIRED", 422);
    if (extraction.extracted.documentType === "unknown_document") {
      throw new ExpenseError("UNSUPPORTED_DOCUMENT_TYPE_FOR_EXPENSE", 422);
    }
    if (!isStandardExpenseDocument(extraction.extracted.documentType) && !input.forceNonExpenseDocument) {
      throw new ExpenseError("NON_EXPENSE_DOCUMENT_REQUIRES_CONFIRMATION", 422);
    }
    const existingExpense = (await this.expenses.list({ tenantId: input.principal.tenantId, workspaceId: document.workspaceId })).find(
      (expense) => expense.documentId === document.id
    );
    if (existingExpense) throw new ExpenseError("DUPLICATE_EXPENSE_FOR_DOCUMENT", 409);
    const hasCriticalIssue = extraction.extracted.validationIssues.some((issue) => issue.severity === "critical");
    if (hasCriticalIssue) {
      throw new ExpenseError("EXTRACTION_REQUIRES_REVIEW", 422, extraction.extracted.validationIssues);
    }
    if (isStandardExpenseDocument(extraction.extracted.documentType) && !extraction.extracted.date) {
      throw new ExpenseError("EXTRACTION_DATE_REVIEW_REQUIRED", 422, extraction.extracted.validationIssues);
    }
    const occurredAt = extraction.extracted.date ? parseDate(extraction.extracted.date) : new Date();
    const reviewReasonCodes = extractionReviewReasonCodes(extraction.extracted);
    const status: ExpenseStatus = reviewReasonCodes.length ? "NEEDS_REVIEW" : "EXTRACTED";
    const created = await this.expenses.create({
      tenantId: input.principal.tenantId,
      workspaceId: document.workspaceId,
      documentId: document.id,
      status,
      title: extraction.extracted.merchantName ?? "Extracted expense",
      currency: extraction.extracted.currency,
      amountMinor: extraction.extracted.total.amountMinor,
      taxMinor: extraction.extracted.taxTotal?.amountMinor ?? 0n,
      occurredAt,
      merchantName: extraction.extracted.merchantName,
      paymentMethodName: extraction.extracted.paymentMethod,
      createdById: input.principal.userId,
      lineItems: extraction.extracted.lineItems.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unitPriceMinor: item.unitPrice?.amountMinor ?? item.total.amountMinor,
        totalMinor: item.total.amountMinor
      }))
    });
    if (status === "NEEDS_REVIEW" && this.reviews) {
      const reviewTask = await this.reviews.createReviewTask({
        tenantId: input.principal.tenantId,
        documentFileId: document.id,
        reasonCodes: reviewReasonCodes,
        dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        actorUserId: input.principal.userId
      });
      await this.audit
        ?.create({
          tenantId: input.principal.tenantId,
          actorUserId: input.principal.userId,
          action: "review.task.created",
          resourceType: "OCRReviewTask",
          resourceId: reviewTask.id,
          metadata: {
            documentFileId: document.id,
            workspaceId: document.workspaceId,
            status: reviewTask.status,
            reasonCodes: reviewReasonCodes,
            source: "expense_quality_gate"
          },
          correlationId: input.correlationId ?? null
        })
        .catch(() => undefined);
    }
    await this.recordExpenseCreatedAudit(input.principal, created.expense, "extraction", input.correlationId ?? null, {
      documentId: document.id,
      lineItemCount: created.lineItems.length,
      reviewRequired: reviewReasonCodes.length > 0,
      reviewReasonCodes
    });
    await this.publishExpenseEvent(input.principal, "expense.created", created.expense.id, {
      workspaceId: created.expense.workspaceId,
      documentId: document.id,
      status: created.expense.status,
      amountMinor: created.expense.amountMinor.toString(),
      currency: created.expense.currency,
      source: "extraction"
    });
    return created;
  }

  async list(principal: AuthPrincipal, workspaceId?: string) {
    return this.expenses.list({ tenantId: principal.tenantId, ...(workspaceId ? { workspaceId } : {}) });
  }

  async listPage(input: {
    principal: AuthPrincipal;
    workspaceId?: string;
    limit: number;
    cursor?: string;
    status?: ExpenseStatus;
    search?: string;
  }) {
    return this.expenses.listPage({
      tenantId: input.principal.tenantId,
      limit: input.limit,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.search ? { search: input.search } : {})
    });
  }

  async listApprovalSla(input: { principal: AuthPrincipal; workspaceId: string }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    const version = await this.readWorkspaceDashboardCacheVersion(input.principal.tenantId, input.workspaceId);
    const minuteBucket = approvalSlaMinuteBucket(new Date());
    const cacheKey = dashboardApprovalSlaCacheKey(input.principal.tenantId, input.workspaceId, version, minuteBucket);
    const cached = await this.readCachedApprovalSla(cacheKey);
    if (cached) return { items: cached };
    const items = await this.expenses.listApprovalSla({ tenantId: input.principal.tenantId, workspaceId: input.workspaceId });
    await this.rememberApprovalSla(cacheKey, items);
    return {
      items
    };
  }

  async importCsv(input: { principal: AuthPrincipal; workspaceId: string; csvText: string; source?: string | null; correlationId?: string | null }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    const parsed = parseExpenseCsv(input.csvText);
    const source = input.source?.trim() || "expense_csv_upload";
    if (parsed.errors.length > 0) {
      const importBatch = await this.expenses.createImportBatch({
        tenantId: input.principal.tenantId,
        workspaceId: input.workspaceId,
        source,
        status: "FAILED",
        createdById: input.principal.userId,
        stats: {
          totalRows: parsed.totalRows,
          importedRows: 0,
          failedRows: parsed.errors.length,
          errors: parsed.errors
        }
      });
      await this.audit?.create({
        tenantId: input.principal.tenantId,
        actorUserId: input.principal.userId,
        action: "expense.import_batch.created",
        resourceType: "ImportBatch",
        resourceId: importBatch.id,
        metadata: {
          workspaceId: input.workspaceId,
          status: importBatch.status,
          sourcePresent: source.length > 0,
          totalRows: parsed.totalRows,
          importedRows: 0,
          failedRows: parsed.errors.length
        },
        correlationId: input.correlationId ?? null
      });
      return { importBatch, expenses: [], errors: parsed.errors };
    }

    const createdExpenses = [];
    for (const row of parsed.rows) {
      const created = await this.expenses.create({
        tenantId: input.principal.tenantId,
        workspaceId: input.workspaceId,
        title: row.title,
        description: row.description,
        currency: row.currency,
        amountMinor: row.amountMinor,
        taxMinor: row.taxMinor,
        occurredAt: row.occurredAt,
        merchantName: row.merchantName,
        paymentMethodName: row.paymentMethodName,
        reimbursable: row.reimbursable,
        businessExpense: row.businessExpense,
        projectCode: row.projectCode,
        costCenter: row.costCenter,
        createdById: input.principal.userId
      });
      await this.recordExpenseCreatedAudit(input.principal, created.expense, "csv_import", input.correlationId ?? null);
      await this.publishExpenseEvent(input.principal, "expense.created", created.expense.id, {
        workspaceId: created.expense.workspaceId,
        status: created.expense.status,
        amountMinor: created.expense.amountMinor.toString(),
        currency: created.expense.currency,
        source: "csv_import"
      });
      createdExpenses.push(created.expense);
    }
    const importBatch = await this.expenses.createImportBatch({
      tenantId: input.principal.tenantId,
      workspaceId: input.workspaceId,
      source,
      status: "SUCCEEDED",
      createdById: input.principal.userId,
      stats: {
        totalRows: parsed.totalRows,
        importedRows: createdExpenses.length,
        failedRows: 0,
        expenseIds: createdExpenses.map((expense) => expense.id)
      }
    });
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.import_batch.created",
      resourceType: "ImportBatch",
      resourceId: importBatch.id,
      metadata: {
        workspaceId: input.workspaceId,
        status: importBatch.status,
        sourcePresent: source.length > 0,
        totalRows: parsed.totalRows,
        importedRows: createdExpenses.length,
        failedRows: 0,
        expenseCount: createdExpenses.length
      },
      correlationId: input.correlationId ?? null
    });
    return { importBatch, expenses: createdExpenses, errors: [] };
  }

  async listImportBatches(input: { principal: AuthPrincipal; workspaceId: string }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    return { importBatches: await this.expenses.listImportBatches({ tenantId: input.principal.tenantId, workspaceId: input.workspaceId }) };
  }

  async listSubscriptions(input: { principal: AuthPrincipal; workspaceId: string }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    return { subscriptions: await this.expenses.listSubscriptions({ tenantId: input.principal.tenantId, workspaceId: input.workspaceId }) };
  }

  async detectSubscriptions(input: { principal: AuthPrincipal; workspaceId: string; correlationId?: string | null }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    const expenses = await this.expenses.list({ tenantId: input.principal.tenantId, workspaceId: input.workspaceId });
    const candidates = detectRecurringCandidates(expenses);
    const subscriptions = [];
    for (const candidate of candidates) {
      const subscription = await this.expenses.upsertSubscription({
        tenantId: input.principal.tenantId,
        workspaceId: input.workspaceId,
        merchantId: candidate.latest.merchantId,
        name: candidate.name,
        amountMinor: candidate.latest.amountMinor,
        currency: candidate.latest.currency,
        cadence: candidate.cadence,
        nextDueAt: candidate.nextDueAt,
        detectedFromExpenseId: candidate.latest.id,
        actorUserId: input.principal.userId
      });
      await this.audit?.create({
        tenantId: input.principal.tenantId,
        actorUserId: input.principal.userId,
        action: "expense.subscription_detected",
        resourceType: "Subscription",
        resourceId: subscription.id,
        metadata: {
          workspaceId: input.workspaceId,
          detectedFromExpenseId: candidate.latest.id,
          cadence: subscription.cadence,
          amountMinor: subscription.amountMinor.toString(),
          currency: subscription.currency,
          nextDueAtPresent: candidate.nextDueAt !== null,
          merchantLinked: subscription.merchantId !== null
        },
        correlationId: input.correlationId ?? null
      });
      await this.publishExpenseEvent(input.principal, "expense.updated", candidate.latest.id, {
        workspaceId: input.workspaceId,
        lifecycleAction: "subscription_detected",
        subscriptionId: subscription.id,
        cadence: subscription.cadence,
        amountMinor: subscription.amountMinor.toString(),
        currency: subscription.currency
      });
      subscriptions.push(subscription);
    }
    return {
      subscriptions: await this.expenses.listSubscriptions({ tenantId: input.principal.tenantId, workspaceId: input.workspaceId }),
      detectedCount: subscriptions.length,
      analyzedExpenseCount: expenses.length
    };
  }

  async listRecurring(input: { principal: AuthPrincipal; workspaceId: string }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    return { recurringExpenses: await this.expenses.listRecurring({ tenantId: input.principal.tenantId, workspaceId: input.workspaceId }) };
  }

  async createReimbursementClaim(input: { principal: AuthPrincipal; workspaceId: string; expenseIds: string[]; correlationId?: string | null }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    const expenseIds = [...new Set(input.expenseIds.map((expenseId) => expenseId.trim()).filter(Boolean))];
    if (expenseIds.length === 0 || expenseIds.length > 100) throw new ExpenseError("INVALID_REIMBURSEMENT_EXPENSE_COUNT", 400);
    if (expenseIds.length !== input.expenseIds.length) throw new ExpenseError("DUPLICATE_REIMBURSEMENT_EXPENSE", 409);

    const expenses = [];
    for (const expenseId of expenseIds) {
      const expense = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId });
      if (!expense || expense.workspaceId !== input.workspaceId) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
      if (!expense.reimbursable) throw new ExpenseError("EXPENSE_NOT_REIMBURSABLE", 422);
      if (expense.amountMinor <= 0n) throw new ExpenseError("REIMBURSEMENT_AMOUNT_INVALID", 422);
      if (["REJECTED", "REIMBURSED", "ARCHIVED"].includes(expense.status)) throw new ExpenseError("EXPENSE_STATUS_NOT_REIMBURSABLE", 409);
      expenses.push(expense);
    }
    const currencies = new Set(expenses.map((expense) => expense.currency));
    if (currencies.size > 1) throw new ExpenseError("REIMBURSEMENT_CURRENCY_MISMATCH", 422);

    const existingClaims = await this.expenses.listReimbursementClaims({ tenantId: input.principal.tenantId, workspaceId: input.workspaceId });
    const alreadyClaimed = existingClaims
      .filter(({ claim }) => claim.status !== "REJECTED")
      .flatMap(({ items }) => items.map((item) => item.expenseId));
    if (expenseIds.some((expenseId) => alreadyClaimed.includes(expenseId))) throw new ExpenseError("EXPENSE_ALREADY_CLAIMED", 409);

    const created = await this.expenses.createReimbursementClaim({
      tenantId: input.principal.tenantId,
      workspaceId: input.workspaceId,
      claimantId: input.principal.userId,
      expenseIds,
      actorUserId: input.principal.userId
    });
    if (!created) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.reimbursement_submitted",
      resourceType: "ReimbursementClaim",
      resourceId: created.claim.id,
      metadata: {
        workspaceId: created.claim.workspaceId,
        status: created.claim.status,
        expenseCount: created.items.length,
        totalMinor: created.claim.totalMinor.toString(),
        currency: created.claim.currency
      },
      correlationId: input.correlationId ?? null
    });
    for (const expense of created.expenses) {
      await this.publishExpenseEvent(input.principal, "expense.updated", expense.id, {
        workspaceId: expense.workspaceId,
        status: expense.status,
        lifecycleAction: "reimbursement_submitted",
        reimbursementClaimId: created.claim.id,
        amountMinor: expense.amountMinor.toString(),
        currency: expense.currency
      });
    }
    return { reimbursementClaim: created.claim, items: created.items, expenses: created.expenses };
  }

  async listReimbursementClaims(input: { principal: AuthPrincipal; workspaceId: string }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    return {
      reimbursementClaims: await this.expenses.listReimbursementClaims({
        tenantId: input.principal.tenantId,
        workspaceId: input.workspaceId
      })
    };
  }

  async approveReimbursementClaim(input: { principal: AuthPrincipal; claimId: string; reason?: string | null; correlationId?: string | null }) {
    return this.transitionReimbursementClaim(input.principal, input.claimId, "APPROVED", input.reason ?? null, input.correlationId ?? null);
  }

  async rejectReimbursementClaim(input: { principal: AuthPrincipal; claimId: string; reason?: string | null; correlationId?: string | null }) {
    return this.transitionReimbursementClaim(input.principal, input.claimId, "REJECTED", input.reason ?? null, input.correlationId ?? null);
  }

  async markReimbursementPaid(input: { principal: AuthPrincipal; claimId: string; reason?: string | null; correlationId?: string | null }) {
    return this.transitionReimbursementClaim(input.principal, input.claimId, "REIMBURSED", input.reason ?? null, input.correlationId ?? null);
  }

  async createExpensePolicy(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    name: string;
    ruleType: string;
    severity: "warning" | "block";
    config: unknown;
    correlationId?: string | null;
  }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    const policy = await this.expenses.createExpensePolicy({
      tenantId: input.principal.tenantId,
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      ruleType: normalizePolicyRuleType(input.ruleType),
      config: normalizePolicyConfig(input.ruleType, input.config),
      severity: input.severity,
      actorUserId: input.principal.userId
    });
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.policy.created",
      resourceType: "ExpensePolicy",
      resourceId: policy.id,
      metadata: {
        workspaceId: policy.workspaceId,
        ruleType: policy.ruleType,
        severity: policy.severity,
        active: policy.active,
        configPresent: policy.config !== null && policy.config !== undefined
      },
      correlationId: input.correlationId ?? null
    });
    await this.publishExpenseEvent(input.principal, "expense.updated", policy.id, {
      workspaceId: policy.workspaceId,
      lifecycleAction: "policy_created",
      policyId: policy.id,
      ruleType: policy.ruleType,
      severity: policy.severity
    });
    return { expensePolicy: policy };
  }

  async listExpensePolicies(input: { principal: AuthPrincipal; workspaceId: string }) {
    if (!(await this.documents.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new ExpenseError("WORKSPACE_NOT_FOUND", 404);
    }
    return {
      expensePolicies: await this.expenses.listExpensePolicies({
        tenantId: input.principal.tenantId,
        workspaceId: input.workspaceId
      })
    };
  }

  async archiveExpensePolicy(input: { principal: AuthPrincipal; policyId: string; correlationId?: string | null }) {
    const policy = await this.expenses.archiveExpensePolicy({
      tenantId: input.principal.tenantId,
      policyId: input.policyId,
      actorUserId: input.principal.userId
    });
    if (!policy) throw new ExpenseError("EXPENSE_POLICY_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.policy.archived",
      resourceType: "ExpensePolicy",
      resourceId: policy.id,
      metadata: {
        workspaceId: policy.workspaceId,
        ruleType: policy.ruleType,
        severity: policy.severity,
        active: policy.active
      },
      correlationId: input.correlationId ?? null
    });
    await this.publishExpenseEvent(input.principal, "expense.updated", policy.id, {
      workspaceId: policy.workspaceId,
      lifecycleAction: "policy_archived",
      policyId: policy.id,
      ruleType: policy.ruleType
    });
    return { expensePolicy: policy };
  }

  async evaluateExpensePolicy(input: { principal: AuthPrincipal; expenseId: string }) {
    const expense = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (!expense) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    return {
      evaluation: await this.evaluateExpensePolicyForStored(input.principal.tenantId, expense)
    };
  }

  async createRecurring(input: {
    principal: AuthPrincipal;
    expenseId: string;
    cadence: "weekly" | "monthly";
    nextDueAt: string;
    correlationId?: string | null;
  }) {
    const rule = await this.expenses.createRecurringFromExpense({
      tenantId: input.principal.tenantId,
      expenseId: input.expenseId,
      actorUserId: input.principal.userId,
      cadence: input.cadence,
      nextDueAt: parseDate(input.nextDueAt)
    });
    if (!rule) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.recurring_created",
      resourceType: "RecurringExpense",
      resourceId: rule.id,
      metadata: {
        workspaceId: rule.workspaceId,
        sourceExpenseId: input.expenseId,
        cadence: rule.cadence,
        amountMinor: rule.amountMinor.toString(),
        currency: rule.currency,
        nextDueAtPresent: rule.nextDueAt !== null,
        merchantLinked: rule.merchantId !== null
      },
      correlationId: input.correlationId ?? null
    });
    await this.publishExpenseEvent(input.principal, "expense.updated", input.expenseId, {
      workspaceId: rule.workspaceId,
      lifecycleAction: "recurring_created",
      recurringExpenseId: rule.id,
      cadence: rule.cadence,
      nextDueAt: rule.nextDueAt.toISOString()
    });
    return { recurringExpense: rule };
  }

  async generateRecurring(input: { principal: AuthPrincipal; recurringExpenseId: string; correlationId?: string | null }) {
    const rule = await this.expenses.findRecurringById({
      tenantId: input.principal.tenantId,
      recurringExpenseId: input.recurringExpenseId
    });
    if (!rule) throw new ExpenseError("RECURRING_EXPENSE_NOT_FOUND", 404);
    const generated = await this.expenses.create({
      tenantId: input.principal.tenantId,
      workspaceId: rule.workspaceId,
      title: `Recurring: ${rule.merchantName ?? "expense"}`,
      currency: CurrencyCodeSchema.parse(rule.currency),
      amountMinor: rule.amountMinor,
      taxMinor: 0n,
      occurredAt: rule.nextDueAt,
      status: "DRAFT",
      merchantName: rule.merchantName,
      createdById: input.principal.userId
    });
    await this.recordExpenseCreatedAudit(input.principal, generated.expense, "recurring", input.correlationId ?? null, {
      recurringExpenseId: rule.id,
      merchantLinked: rule.merchantId !== null
    });
    const nextDueAt = addCadence(rule.nextDueAt, rule.cadence);
    const recurringExpense = await this.expenses.advanceRecurring({
      tenantId: input.principal.tenantId,
      recurringExpenseId: rule.id,
      actorUserId: input.principal.userId,
      generatedExpenseId: generated.expense.id,
      nextDueAt
    });
    if (!recurringExpense) throw new ExpenseError("RECURRING_EXPENSE_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.recurring_generated",
      resourceType: "Expense",
      resourceId: generated.expense.id,
      metadata: {
        workspaceId: generated.expense.workspaceId,
        recurringExpenseId: rule.id,
        generatedExpenseId: generated.expense.id,
        cadence: rule.cadence,
        amountMinor: generated.expense.amountMinor.toString(),
        currency: generated.expense.currency,
        previousNextDueAtPresent: rule.nextDueAt !== null,
        nextDueAtPresent: recurringExpense.nextDueAt !== null,
        merchantLinked: rule.merchantId !== null
      },
      correlationId: input.correlationId ?? null
    });
    await this.publishExpenseEvent(input.principal, "expense.created", generated.expense.id, {
      workspaceId: generated.expense.workspaceId,
      status: generated.expense.status,
      amountMinor: generated.expense.amountMinor.toString(),
      currency: generated.expense.currency,
      source: "recurring",
      recurringExpenseId: rule.id
    });
    return { expense: generated.expense, recurringExpense };
  }

  async listComments(input: { principal: AuthPrincipal; expenseId: string }) {
    const existing = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (!existing) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    return { comments: await this.expenses.listComments({ tenantId: input.principal.tenantId, expenseId: input.expenseId }) };
  }

  async listAttachments(input: { principal: AuthPrincipal; expenseId: string }) {
    const existing = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (!existing) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    const metadata = await this.expenses.listAttachments({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    const documentIds = new Set(metadata.map((attachment) => attachment.documentFileId));
    if (existing.documentId) documentIds.add(existing.documentId);
    const documents = await Promise.all([...documentIds].map((documentId) => this.documents.findById(input.principal.tenantId, documentId)));
    const attachments = documents.filter(
      (document): document is NonNullable<(typeof documents)[number]> => document !== null && document.deletedAt === null
    );
    return { attachments, attachmentMetadata: metadata };
  }

  async attachDocument(input: {
    principal: AuthPrincipal;
    expenseId: string;
    documentFileId: string;
    label?: string | null;
    note?: string | null;
    primary?: boolean;
    correlationId?: string | null;
  }) {
    const existing = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (!existing) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    if (existing.status === "ARCHIVED") throw new ExpenseError("EXPENSE_ARCHIVED", 409);
    const document = await this.documents.findById(input.principal.tenantId, input.documentFileId);
    if (!document || document.deletedAt) throw new ExpenseError("DOCUMENT_NOT_FOUND", 404);
    if (document.workspaceId !== existing.workspaceId) throw new ExpenseError("DOCUMENT_WORKSPACE_MISMATCH", 409);
    const result = await this.expenses.attachDocument({
      tenantId: input.principal.tenantId,
      expenseId: input.expenseId,
      documentFileId: document.id,
      actorUserId: input.principal.userId,
      label: normalizeNullableText(input.label, 80),
      note: normalizeNullableText(input.note, 500),
      ...(input.primary !== undefined ? { primary: input.primary } : {})
    });
    if (!result) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.attachment.attached",
      resourceType: "Expense",
      resourceId: result.expense.id,
      metadata: {
        workspaceId: result.expense.workspaceId,
        status: result.expense.status,
        previousDocumentId: existing.documentId,
        documentFileId: document.id,
        attachmentId: result.attachment.id,
        labelPresent: result.attachment.label !== null && result.attachment.label.trim().length > 0,
        notePresent: result.attachment.note !== null && result.attachment.note.trim().length > 0,
        primary: input.primary === true || !existing.documentId
      },
      correlationId: input.correlationId ?? null
    });
    await this.publishExpenseEvent(input.principal, "expense.updated", result.expense.id, {
      workspaceId: result.expense.workspaceId,
      status: result.expense.status,
      lifecycleAction: "attachment_attached",
      documentFileId: document.id,
      attachmentId: result.attachment.id,
      label: result.attachment.label
    });
    return { expense: result.expense, attachment: document, attachmentMetadata: result.attachment };
  }

  async detachDocument(input: { principal: AuthPrincipal; expenseId: string; documentFileId: string; correlationId?: string | null }) {
    const existing = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (!existing) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    if (existing.status === "ARCHIVED") throw new ExpenseError("EXPENSE_ARCHIVED", 409);
    const existingAttachments = await this.expenses.listAttachments({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (existing.documentId !== input.documentFileId && !existingAttachments.some((attachment) => attachment.documentFileId === input.documentFileId)) {
      throw new ExpenseError("EXPENSE_ATTACHMENT_NOT_FOUND", 404);
    }
    const document = await this.documents.findById(input.principal.tenantId, input.documentFileId);
    const result = await this.expenses.detachDocument({
      tenantId: input.principal.tenantId,
      expenseId: input.expenseId,
      documentFileId: input.documentFileId,
      actorUserId: input.principal.userId
    });
    if (!result) throw new ExpenseError("EXPENSE_ATTACHMENT_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.attachment.detached",
      resourceType: "Expense",
      resourceId: result.expense.id,
      metadata: {
        workspaceId: result.expense.workspaceId,
        status: result.expense.status,
        previousDocumentId: existing.documentId,
        documentFileId: input.documentFileId,
        attachmentId: result.attachment.id,
        nextPrimaryDocumentId: result.expense.documentId,
        detachedAtPresent: result.attachment.detachedAt !== null
      },
      correlationId: input.correlationId ?? null
    });
    await this.publishExpenseEvent(input.principal, "expense.updated", result.expense.id, {
      workspaceId: result.expense.workspaceId,
      status: result.expense.status,
      lifecycleAction: "attachment_detached",
      documentFileId: input.documentFileId,
      attachmentId: result.attachment.id
    });
    return { expense: result.expense, attachment: document && !document.deletedAt ? document : null, attachmentMetadata: result.attachment };
  }

  async addComment(input: { principal: AuthPrincipal; expenseId: string; body: string; correlationId?: string | null }) {
    const existing = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (!existing) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    if (existing.status === "ARCHIVED") throw new ExpenseError("EXPENSE_ARCHIVED", 409);
    const body = input.body.trim();
    const comment = await this.expenses.addComment({
      tenantId: input.principal.tenantId,
      expenseId: input.expenseId,
      actorUserId: input.principal.userId,
      body
    });
    if (!comment) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.comment.created",
      resourceType: "Expense",
      resourceId: input.expenseId,
      metadata: {
        workspaceId: existing.workspaceId,
        status: existing.status,
        commentId: comment.id,
        bodyPresent: body.length > 0,
        bodyLength: body.length
      },
      correlationId: input.correlationId ?? null
    });
    await this.publishExpenseEvent(input.principal, "expense.updated", input.expenseId, {
      workspaceId: existing.workspaceId,
      status: existing.status,
      lifecycleAction: "comment_created",
      commentId: comment.id
    });
    return { comment };
  }

  async update(input: {
    principal: AuthPrincipal;
    expenseId: string;
    title?: string;
    description?: string | null;
    amountMinor?: string;
    taxMinor?: string | null;
    occurredAt?: string;
    merchantName?: string | null;
    paymentMethodName?: string | null;
    reimbursable?: boolean;
    businessExpense?: boolean;
    projectCode?: string | null;
    costCenter?: string | null;
    correlationId?: string | null;
  }) {
    const existing = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (!existing) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    if (existing.status === "ARCHIVED") throw new ExpenseError("EXPENSE_ARCHIVED", 409);
    const changedFields = [
      ...(input.title !== undefined ? ["title"] : []),
      ...(input.description !== undefined ? ["description"] : []),
      ...(input.amountMinor !== undefined ? ["amountMinor"] : []),
      ...(input.taxMinor !== undefined ? ["taxMinor"] : []),
      ...(input.occurredAt !== undefined ? ["occurredAt"] : []),
      ...(input.merchantName !== undefined ? ["merchantName"] : []),
      ...(input.paymentMethodName !== undefined ? ["paymentMethodName"] : []),
      ...(input.reimbursable !== undefined ? ["reimbursable"] : []),
      ...(input.businessExpense !== undefined ? ["businessExpense"] : []),
      ...(input.projectCode !== undefined ? ["projectCode"] : []),
      ...(input.costCenter !== undefined ? ["costCenter"] : [])
    ];
    const updated = await this.expenses.update({
      tenantId: input.principal.tenantId,
      expenseId: input.expenseId,
      actorUserId: input.principal.userId,
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.amountMinor !== undefined ? { amountMinor: parseMinor(input.amountMinor) } : {}),
      ...(input.taxMinor !== undefined ? { taxMinor: input.taxMinor ? parseMinor(input.taxMinor) : 0n } : {}),
      ...(input.occurredAt !== undefined ? { occurredAt: parseDate(input.occurredAt) } : {}),
      ...(input.merchantName !== undefined ? { merchantName: input.merchantName } : {}),
      ...(input.paymentMethodName !== undefined ? { paymentMethodName: input.paymentMethodName } : {}),
      ...(input.reimbursable !== undefined ? { reimbursable: input.reimbursable } : {}),
      ...(input.businessExpense !== undefined ? { businessExpense: input.businessExpense } : {}),
      ...(input.projectCode !== undefined ? { projectCode: input.projectCode } : {}),
      ...(input.costCenter !== undefined ? { costCenter: input.costCenter } : {})
    });
    if (!updated) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.updated",
      resourceType: "Expense",
      resourceId: updated.id,
      metadata: {
        workspaceId: updated.workspaceId,
        previousStatus: existing.status,
        status: updated.status,
        changedFields,
        changedFieldCount: changedFields.length
      },
      correlationId: input.correlationId ?? null
    });
    await this.publishExpenseEvent(input.principal, "expense.updated", updated.id, {
      workspaceId: updated.workspaceId,
      status: updated.status,
      amountMinor: updated.amountMinor.toString(),
      currency: updated.currency
    });
    return { expense: updated };
  }

  async split(input: {
    principal: AuthPrincipal;
    expenseId: string;
    correlationId?: string | null;
    allocations: Array<{
      title: string;
      amountMinor: string;
      taxMinor?: string | null;
      projectCode?: string | null;
      costCenter?: string | null;
      businessExpense?: boolean;
      reimbursable?: boolean;
    }>;
  }) {
    const existing = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (!existing) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    if (existing.status === "ARCHIVED") throw new ExpenseError("EXPENSE_ARCHIVED", 409);
    if (input.allocations.length < 2) throw new ExpenseError("EXPENSE_SPLIT_REQUIRES_TWO_ALLOCATIONS", 400);

    const parsed = input.allocations.map((allocation) => ({
      ...allocation,
      title: allocation.title.trim(),
      amountMinor: parseMinor(allocation.amountMinor),
      taxMinor: allocation.taxMinor ? parseMinor(allocation.taxMinor) : 0n
    }));
    const amountTotal = parsed.reduce((total, allocation) => total + allocation.amountMinor, 0n);
    const taxTotal = parsed.reduce((total, allocation) => total + allocation.taxMinor, 0n);
    if (amountTotal !== existing.amountMinor) throw new ExpenseError("EXPENSE_SPLIT_AMOUNT_MISMATCH", 422);
    if (taxTotal !== existing.taxMinor) throw new ExpenseError("EXPENSE_SPLIT_TAX_MISMATCH", 422);

    const splitGroup = existing.duplicateGroup ?? existing.id;
    const children = [];
    for (const allocation of parsed) {
      const created = await this.expenses.create({
        tenantId: input.principal.tenantId,
        workspaceId: existing.workspaceId,
        title: allocation.title,
        description: existing.description,
        currency: CurrencyCodeSchema.parse(existing.currency),
        amountMinor: allocation.amountMinor,
        taxMinor: allocation.taxMinor,
        occurredAt: existing.occurredAt,
        status: "DRAFT",
        documentId: existing.documentId,
        merchantName: existing.merchantName,
        paymentMethodName: existing.paymentMethodName,
        reimbursable: allocation.reimbursable ?? existing.reimbursable,
        businessExpense: allocation.businessExpense ?? existing.businessExpense,
        projectCode: allocation.projectCode ?? existing.projectCode,
        costCenter: allocation.costCenter ?? existing.costCenter,
        duplicateGroup: splitGroup,
        createdById: input.principal.userId
      });
      await this.recordExpenseCreatedAudit(input.principal, created.expense, "split", input.correlationId ?? null, {
        sourceExpenseId: existing.id,
        splitGroup
      });
      await this.publishExpenseEvent(input.principal, "expense.created", created.expense.id, {
        workspaceId: created.expense.workspaceId,
        status: created.expense.status,
        amountMinor: created.expense.amountMinor.toString(),
        currency: created.expense.currency,
        source: "split",
        sourceExpenseId: existing.id,
        splitGroup
      });
      children.push(created.expense);
    }

    const archived = await this.expenses.archive({
      tenantId: input.principal.tenantId,
      expenseId: existing.id,
      actorUserId: input.principal.userId,
      reason: `Split into ${children.length} expenses`
    });
    if (!archived) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.archived",
      resourceType: "Expense",
      resourceId: archived.id,
      metadata: {
        workspaceId: archived.workspaceId,
        previousStatus: existing.status,
        status: archived.status,
        reasonPresent: true,
        archivedAtPresent: archived.archivedAt !== null,
        lifecycleAction: "split_archived",
        childExpenseCount: children.length
      },
      correlationId: input.correlationId ?? null
    });
    await this.publishExpenseEvent(input.principal, "expense.updated", archived.id, {
      workspaceId: archived.workspaceId,
      status: archived.status,
      previousStatus: existing.status,
      lifecycleAction: "split_archived",
      splitGroup,
      childExpenseIds: children.map((child) => child.id)
    });
    return { sourceExpense: archived, expenses: children, splitGroup };
  }

  async analyze(input: { principal: AuthPrincipal; expenseId: string; persist?: boolean; correlationId?: string | null }) {
    const expense = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (!expense) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    const peers = (await this.expenses.list({ tenantId: input.principal.tenantId, workspaceId: expense.workspaceId }))
      .filter((peer) => peer.id !== expense.id)
      .map((peer) => toCategorizationInput(peer));
    const analysisInput = toCategorizationInput(expense);
    const model = {
      name: "local-heuristic-baseline",
      version: "category-rules-v1",
      externalServicesUsed: false
    };
    const cacheKey = expenseCategoryInferenceCacheKey(
      input.principal.tenantId,
      expense.id,
      analysisFingerprint(analysisInput, peers, model.version)
    );
    const cachedAnalysis = await this.readCachedCategoryAnalysis(cacheKey);
    const analysis =
      cachedAnalysis ?? {
        prediction: predictExpenseCategory(analysisInput),
        anomalies: detectExpenseAnomalies(analysisInput, peers),
        model
      };
    if (!cachedAnalysis) await this.rememberCategoryAnalysis(cacheKey, analysis);
    const persistedPrediction =
      input.persist === false
        ? null
        : await this.expenses.saveCategoryPrediction({
            tenantId: input.principal.tenantId,
            expenseId: expense.id,
            documentFileId: expense.documentId,
            categoryKey: analysis.prediction.categoryKey,
            confidence: normalizeCategoryConfidence(analysis.prediction.confidence),
            prediction: analysis.prediction,
            anomalies: analysis.anomalies,
            model: analysis.model,
            actorUserId: input.principal.userId
          });
    if (persistedPrediction) {
      await this.audit?.create({
        tenantId: input.principal.tenantId,
        actorUserId: input.principal.userId,
        action: "expense.category_predicted",
        resourceType: "Expense",
        resourceId: expense.id,
        metadata: {
          workspaceId: expense.workspaceId,
          predictionId: persistedPrediction.id,
          categoryId: persistedPrediction.categoryId,
          categoryKey: analysis.prediction.categoryKey,
          confidence: normalizeCategoryConfidence(analysis.prediction.confidence).toFixed(4),
          modelName: analysis.model.name,
          modelVersion: analysis.model.version,
          externalServicesUsed: analysis.model.externalServicesUsed,
          anomalyCount: analysis.anomalies.length,
          cacheHit: Boolean(cachedAnalysis)
        },
        correlationId: input.correlationId ?? null
      });
    }
    return {
      expenseId: expense.id,
      prediction: analysis.prediction,
      anomalies: analysis.anomalies,
      persistedPrediction,
      model: analysis.model,
      cacheHit: Boolean(cachedAnalysis)
    };
  }

  private async readCachedCategoryAnalysis(key: string): Promise<CachedExpenseCategoryAnalysis | null> {
    try {
      const cached = await this.cache?.getHotState<CachedExpenseCategoryAnalysis>(key);
      if (!cached || !isValidCategoryAnalysis(cached)) return null;
      return cached;
    } catch {
      return null;
    }
  }

  private async rememberCategoryAnalysis(key: string, analysis: CachedExpenseCategoryAnalysis): Promise<void> {
    try {
      await this.cache?.setHotState({
        key,
        value: analysis,
        ttlSeconds: 60 * 60
      });
    } catch {
      // Model inference cache is an optimization; PostgreSQL prediction rows remain authoritative.
    }
  }

  async approve(input: { principal: AuthPrincipal; expenseId: string; reason?: string | null; correlationId?: string | null }) {
    return this.transition(input.principal, input.expenseId, "APPROVED", input.reason ?? null, input.correlationId ?? null);
  }

  async reject(input: { principal: AuthPrincipal; expenseId: string; reason?: string | null; correlationId?: string | null }) {
    return this.transition(input.principal, input.expenseId, "REJECTED", input.reason ?? null, input.correlationId ?? null);
  }

  async archive(input: { principal: AuthPrincipal; expenseId: string; reason?: string | null; correlationId?: string | null }) {
    const existing = await this.expenses.findById({ tenantId: input.principal.tenantId, expenseId: input.expenseId });
    if (!existing) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    if (existing.status === "ARCHIVED") throw new ExpenseError("EXPENSE_ARCHIVED", 409);
    const archived = await this.expenses.archive({
      tenantId: input.principal.tenantId,
      expenseId: input.expenseId,
      actorUserId: input.principal.userId,
      reason: input.reason ?? null
    });
    if (!archived) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "expense.archived",
      resourceType: "Expense",
      resourceId: archived.id,
      metadata: {
        workspaceId: archived.workspaceId,
        previousStatus: existing.status,
        status: archived.status,
        reasonPresent: input.reason !== null && input.reason !== undefined && input.reason.trim().length > 0,
        archivedAtPresent: archived.archivedAt !== null
      },
      correlationId: input.correlationId ?? null
    });
    await this.publishExpenseEvent(input.principal, "expense.updated", archived.id, {
      workspaceId: archived.workspaceId,
      status: archived.status,
      previousStatus: existing.status,
      lifecycleAction: "archived",
      reason: input.reason ?? null
    });
    return { expense: archived };
  }

  private async transition(
    principal: AuthPrincipal,
    expenseId: string,
    status: "APPROVED" | "REJECTED",
    reason: string | null,
    correlationId: string | null
  ) {
    const existing = await this.expenses.findById({ tenantId: principal.tenantId, expenseId });
    if (!existing) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    if (existing.status === "ARCHIVED") throw new ExpenseError("EXPENSE_ARCHIVED", 409);
    if (existing.status === status) throw new ExpenseError("EXPENSE_STATUS_UNCHANGED", 409);
    const policyEvaluation = status === "APPROVED" ? await this.evaluateExpensePolicyForStored(principal.tenantId, existing) : null;
    if (policyEvaluation?.violations.some((violation) => violation.severity === "block")) {
      throw new ExpenseError("EXPENSE_POLICY_BLOCKED", 422);
    }
    const result = await this.expenses.transitionStatus({
      tenantId: principal.tenantId,
      expenseId,
      status,
      actorUserId: principal.userId,
      reason,
      policyEvaluation
    });
    if (!result) throw new ExpenseError("EXPENSE_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action: status === "APPROVED" ? "expense.approved" : "expense.rejected",
      resourceType: "Expense",
      resourceId: result.expense.id,
      metadata: {
        workspaceId: result.expense.workspaceId,
        previousStatus: existing.status,
        status: result.expense.status,
        reasonPresent: reason !== null && reason.trim().length > 0,
        approvalWorkflowId: result.approvalWorkflow.id,
        slaStatus: result.approvalWorkflow.slaStatus,
        policyViolationCount: policyEvaluation?.violations.length ?? 0
      },
      correlationId
    });
    await this.publishExpenseEvent(principal, status === "APPROVED" ? "expense.approved" : "expense.rejected", result.expense.id, {
      workspaceId: result.expense.workspaceId,
      status: result.expense.status,
      reason,
      policyViolationCount: policyEvaluation?.violations.length ?? 0
    });
    return result;
  }

  private async evaluateExpensePolicyForStored(tenantId: string, expense: StoredExpense): Promise<ExpensePolicyEvaluation> {
    const policies = await this.expenses.listExpensePolicies({ tenantId, workspaceId: expense.workspaceId });
    const peers = await this.expenses.list({ tenantId, workspaceId: expense.workspaceId });
    const violations = policies.flatMap((policy) => evaluatePolicy(policy, expense, peers));
    return {
      expenseId: expense.id,
      checkedPolicyCount: policies.length,
      violations
    };
  }

  private async transitionReimbursementClaim(
    principal: AuthPrincipal,
    claimId: string,
    status: "APPROVED" | "REJECTED" | "REIMBURSED",
    reason: string | null,
    correlationId: string | null
  ) {
    const existing = await this.expenses.findReimbursementClaimById({ tenantId: principal.tenantId, claimId });
    if (!existing) throw new ExpenseError("REIMBURSEMENT_CLAIM_NOT_FOUND", 404);
    if (status === "APPROVED" && existing.claim.status !== "NEEDS_REVIEW") {
      throw new ExpenseError("REIMBURSEMENT_CLAIM_NOT_REVIEWABLE", 409);
    }
    if (status === "REJECTED" && !["NEEDS_REVIEW", "APPROVED"].includes(existing.claim.status)) {
      throw new ExpenseError("REIMBURSEMENT_CLAIM_NOT_REJECTABLE", 409);
    }
    if (status === "REIMBURSED" && existing.claim.status !== "APPROVED") {
      throw new ExpenseError("REIMBURSEMENT_CLAIM_NOT_PAYABLE", 409);
    }
    const result = await this.expenses.transitionReimbursementClaim({
      tenantId: principal.tenantId,
      claimId,
      status,
      actorUserId: principal.userId,
      reason
    });
    if (!result) throw new ExpenseError("REIMBURSEMENT_CLAIM_NOT_FOUND", 404);
    await this.audit?.create({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action: status === "REIMBURSED" ? "expense.reimbursement_paid" : "expense.reimbursement_decision",
      resourceType: "ReimbursementClaim",
      resourceId: result.claim.id,
      metadata: {
        workspaceId: result.claim.workspaceId,
        previousStatus: existing.claim.status,
        status: result.claim.status,
        reasonPresent: reason !== null && reason.trim().length > 0,
        expenseCount: result.items.length,
        reimbursedExpenseCount: status === "REIMBURSED" ? result.expenses.length : 0,
        paidAtPresent: result.claim.paidAt !== null
      },
      correlationId
    });
    const lifecycleAction =
      status === "APPROVED" ? "reimbursement_approved" : status === "REJECTED" ? "reimbursement_rejected" : "reimbursement_paid";
    for (const item of result.items) {
      const expense = result.expenses.find((candidate) => candidate.id === item.expenseId);
      await this.publishExpenseEvent(principal, "expense.updated", item.expenseId, {
        workspaceId: result.claim.workspaceId,
        status: expense?.status ?? status,
        previousClaimStatus: existing.claim.status,
        lifecycleAction,
        reimbursementClaimId: result.claim.id,
        reason
      });
    }
    return { reimbursementClaim: result.claim, items: result.items, expenses: result.expenses };
  }

  private async publishExpenseEvent(
    principal: AuthPrincipal,
    topic: "expense.created" | "expense.updated" | "expense.approved" | "expense.rejected",
    aggregateId: string,
    payload: Record<string, unknown>
  ) {
    await this.events?.publish({
      tenantId: principal.tenantId,
      topic,
      aggregateId,
      payload: {
        ...payload,
        actorUserId: principal.userId
      }
    });
    if (typeof payload.workspaceId === "string" && payload.workspaceId.length > 0) {
      await this.bumpWorkspaceDashboardCacheVersion(principal.tenantId, payload.workspaceId);
    }
  }

  private async readWorkspaceDashboardCacheVersion(tenantId: string, workspaceId: string): Promise<string> {
    try {
      const cached = await this.cache?.getHotState<{ version?: unknown }>(workspaceDashboardVersionCacheKey(tenantId, workspaceId));
      return typeof cached?.version === "string" && cached.version.length > 0 ? cached.version : "v0";
    } catch {
      return "v0";
    }
  }

  private async bumpWorkspaceDashboardCacheVersion(tenantId: string, workspaceId: string): Promise<void> {
    try {
      await this.cache?.setHotState({
        key: workspaceDashboardVersionCacheKey(tenantId, workspaceId),
        value: { version: `v${process.hrtime.bigint().toString(36)}` },
        ttlSeconds: 24 * 60 * 60
      });
    } catch {
      // Dashboard cache is an optimization; expense repositories remain authoritative.
    }
  }

  private async readCachedApprovalSla(key: string): Promise<ApprovalSlaItem[] | null> {
    try {
      const cached = await this.cache?.getHotState<CachedApprovalSlaList>(key);
      return reviveApprovalSla(cached);
    } catch {
      return null;
    }
  }

  private async rememberApprovalSla(key: string, items: ApprovalSlaItem[]): Promise<void> {
    try {
      await this.cache?.setHotState({
        key,
        value: serializeApprovalSla(items),
        ttlSeconds: 60
      });
    } catch {
      // Approval SLA cache is an optimization; approval workflow rows remain authoritative.
    }
  }

  private async recordExpenseCreatedAudit(
    principal: AuthPrincipal,
    expense: StoredExpense,
    source: "manual" | "extraction" | "csv_import" | "recurring" | "split",
    correlationId: string | null,
    metadata: Record<string, unknown> = {}
  ) {
    await this.audit?.create({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action: "expense.created",
      resourceType: "Expense",
      resourceId: expense.id,
      metadata: {
        workspaceId: expense.workspaceId,
        status: expense.status,
        amountMinor: expense.amountMinor.toString(),
        currency: expense.currency,
        source,
        documentLinked: expense.documentId !== null,
        reimbursable: expense.reimbursable,
        businessExpense: expense.businessExpense,
        duplicateGroupPresent: expense.duplicateGroup !== null,
        ...metadata
      },
      correlationId
    });
  }
}

function parseMinor(value: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new ExpenseError("INVALID_MINOR_AMOUNT", 400);
  return BigInt(value);
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ExpenseError("INVALID_DATE", 400);
  return date;
}

function addCadence(date: Date, cadence: string): Date {
  const next = new Date(date);
  if (cadence === "weekly") {
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }
  if (cadence === "monthly") {
    next.setUTCMonth(next.getUTCMonth() + 1);
    return next;
  }
  throw new ExpenseError("INVALID_RECURRING_CADENCE", 400);
}

function toCategorizationInput(expense: {
  title: string;
  merchantName: string | null;
  description: string | null;
  amountMinor: bigint;
  currency: string;
  occurredAt: Date;
  paymentMethodName: string | null;
  businessExpense: boolean;
  reimbursable: boolean;
}) {
  return {
    title: expense.title,
    merchantName: expense.merchantName,
    description: expense.description,
    amountMinor: expense.amountMinor,
    currency: expense.currency,
    occurredAt: expense.occurredAt,
    paymentMethodName: expense.paymentMethodName,
    businessExpense: expense.businessExpense,
    reimbursable: expense.reimbursable
  };
}

type CachedExpenseCategoryAnalysis = {
  prediction: CategoryPrediction;
  anomalies: ExpenseAnomaly[];
  model: { name: string; version: string; externalServicesUsed: boolean };
};

type CachedApprovalSlaList = {
  items: Array<{
    expense: CachedStoredExpense;
    workflow: CachedApprovalWorkflow;
    slaStatus: string;
    slaDueAt: string | null;
    slaBreachedAt: string | null;
    remainingMinutes: number | null;
    ageMinutes: number;
  }>;
};

type CachedStoredExpense = Omit<StoredExpense, "amountMinor" | "taxMinor" | "occurredAt" | "createdAt" | "updatedAt" | "archivedAt"> & {
  amountMinor: string;
  taxMinor: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type CachedApprovalWorkflow = {
  id: string;
  tenantId: string;
  workspaceId: string;
  targetType: string;
  targetId: string;
  state: string;
  approverId: string | null;
  policySnapshot: unknown;
  slaDueAt: string | null;
  slaBreachedAt: string | null;
  slaStatus: string;
  slaHours: number;
  createdAt: string;
  updatedAt: string;
};

export function expenseCategoryInferenceCacheKey(tenantId: string, expenseId: string, fingerprint: string): string {
  return `model-inference:${tenantId}:expense-category:${expenseId}:${fingerprint}`;
}

export function dashboardApprovalSlaCacheKey(tenantId: string, workspaceId: string, version: string, minuteBucket: string): string {
  return `dashboard:${tenantId}:approval-sla:${workspaceId}:${version}:${minuteBucket}`;
}

function workspaceDashboardVersionCacheKey(tenantId: string, workspaceId: string): string {
  return `dashboard:${tenantId}:workspace-version:${workspaceId}`;
}

function approvalSlaMinuteBucket(now: Date): string {
  return now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
}

function serializeApprovalSla(items: ApprovalSlaItem[]): CachedApprovalSlaList {
  return {
    items: items.map((item) => ({
      expense: serializeStoredExpense(item.expense),
      workflow: serializeApprovalWorkflow(item.workflow),
      slaStatus: item.slaStatus,
      slaDueAt: item.slaDueAt?.toISOString() ?? null,
      slaBreachedAt: item.slaBreachedAt?.toISOString() ?? null,
      remainingMinutes: item.remainingMinutes,
      ageMinutes: item.ageMinutes
    }))
  };
}

function reviveApprovalSla(value: CachedApprovalSlaList | null | undefined): ApprovalSlaItem[] | null {
  if (!value || !Array.isArray(value.items)) return null;
  return value.items.map((item) => ({
    expense: reviveStoredExpense(item.expense),
    workflow: reviveApprovalWorkflow(item.workflow),
    slaStatus: item.slaStatus,
    slaDueAt: item.slaDueAt ? new Date(item.slaDueAt) : null,
    slaBreachedAt: item.slaBreachedAt ? new Date(item.slaBreachedAt) : null,
    remainingMinutes: item.remainingMinutes,
    ageMinutes: item.ageMinutes
  }));
}

function serializeStoredExpense(expense: StoredExpense): CachedStoredExpense {
  return {
    ...expense,
    amountMinor: expense.amountMinor.toString(),
    taxMinor: expense.taxMinor.toString(),
    occurredAt: expense.occurredAt.toISOString(),
    createdAt: expense.createdAt.toISOString(),
    updatedAt: expense.updatedAt.toISOString(),
    archivedAt: expense.archivedAt?.toISOString() ?? null
  };
}

function reviveStoredExpense(expense: CachedStoredExpense): StoredExpense {
  return {
    ...expense,
    amountMinor: BigInt(expense.amountMinor),
    taxMinor: BigInt(expense.taxMinor),
    occurredAt: new Date(expense.occurredAt),
    createdAt: new Date(expense.createdAt),
    updatedAt: new Date(expense.updatedAt),
    archivedAt: expense.archivedAt ? new Date(expense.archivedAt) : null
  };
}

function serializeApprovalWorkflow(workflow: ApprovalSlaItem["workflow"]): CachedApprovalWorkflow {
  return {
    ...workflow,
    slaDueAt: workflow.slaDueAt?.toISOString() ?? null,
    slaBreachedAt: workflow.slaBreachedAt?.toISOString() ?? null,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString()
  };
}

function reviveApprovalWorkflow(workflow: CachedApprovalWorkflow): ApprovalSlaItem["workflow"] {
  return {
    ...workflow,
    slaDueAt: workflow.slaDueAt ? new Date(workflow.slaDueAt) : null,
    slaBreachedAt: workflow.slaBreachedAt ? new Date(workflow.slaBreachedAt) : null,
    createdAt: new Date(workflow.createdAt),
    updatedAt: new Date(workflow.updatedAt)
  };
}

function analysisFingerprint(
  expense: ReturnType<typeof toCategorizationInput>,
  peers: Array<ReturnType<typeof toCategorizationInput>>,
  modelVersion: string
): string {
  const stablePeers = [...peers].map(stableCategorizationInput).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256")
    .update(
      JSON.stringify({
        modelVersion,
        expense: stableCategorizationInput(expense),
        peers: stablePeers
      })
    )
    .digest("hex");
}

function stableCategorizationInput(input: ReturnType<typeof toCategorizationInput>) {
  return {
    title: input.title,
    merchantName: input.merchantName,
    description: input.description,
    amountMinor: input.amountMinor.toString(),
    currency: input.currency,
    occurredAt: input.occurredAt.toISOString(),
    paymentMethodName: input.paymentMethodName,
    businessExpense: input.businessExpense,
    reimbursable: input.reimbursable
  };
}

function isValidCategoryAnalysis(value: CachedExpenseCategoryAnalysis): value is CachedExpenseCategoryAnalysis {
  return (
    isValidCategoryPrediction(value.prediction) &&
    Array.isArray(value.anomalies) &&
    value.anomalies.every(isValidExpenseAnomaly) &&
    Boolean(value.model) &&
    typeof value.model.name === "string" &&
    typeof value.model.version === "string" &&
    typeof value.model.externalServicesUsed === "boolean"
  );
}

function isValidCategoryPrediction(value: CategoryPrediction): value is CategoryPrediction {
  return (
    Boolean(value) &&
    isExpenseCategoryKey(value.categoryKey) &&
    Number.isFinite(value.confidence) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === "string") &&
    Array.isArray(value.matchedKeywords) &&
    value.matchedKeywords.every((keyword) => typeof keyword === "string")
  );
}

function isExpenseCategoryKey(value: unknown): value is ExpenseCategoryKey {
  return (
    typeof value === "string" &&
    ["market", "ulasim", "yemek", "akaryakit", "konaklama", "ofis", "saglik", "egitim", "abonelik", "kargo", "vergi_harc", "diger"].includes(
      value
    )
  );
}

function isValidExpenseAnomaly(value: ExpenseAnomaly): value is ExpenseAnomaly {
  return (
    Boolean(value) &&
    typeof value.code === "string" &&
    ["info", "warning", "critical"].includes(value.severity) &&
    typeof value.message === "string" &&
    Boolean(value.evidence) &&
    typeof value.evidence === "object" &&
    !Array.isArray(value.evidence)
  );
}

type CsvImportError = { row: number; field: string; code: string };
type ParsedExpenseCsvRow = {
  title: string;
  description: string | null;
  currency: "TRY" | "USD" | "EUR" | "GBP";
  amountMinor: bigint;
  taxMinor: bigint;
  occurredAt: Date;
  merchantName: string | null;
  paymentMethodName: string | null;
  reimbursable: boolean;
  businessExpense: boolean;
  projectCode: string | null;
  costCenter: string | null;
};

function parseExpenseCsv(csvText: string): { rows: ParsedExpenseCsvRow[]; errors: CsvImportError[]; totalRows: number } {
  let records: Array<Record<string, string>>;
  try {
    records = parseCsv(csvText, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true
    }) as Array<Record<string, string>>;
  } catch {
    return { rows: [], errors: [{ row: 0, field: "csv", code: "CSV_PARSE_FAILED" }], totalRows: 0 };
  }
  if (records.length > 500) {
    return { rows: [], errors: [{ row: 0, field: "csv", code: "CSV_IMPORT_ROW_LIMIT_EXCEEDED" }], totalRows: records.length };
  }

  const rows: ParsedExpenseCsvRow[] = [];
  const errors: CsvImportError[] = [];
  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const title = readCsvField(record, "title");
    if (!title) errors.push({ row: rowNumber, field: "title", code: "TITLE_REQUIRED" });
    const occurredAtText = readCsvField(record, "occurred_at") || readCsvField(record, "date");
    const occurredAt = occurredAtText ? new Date(occurredAtText) : null;
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
      errors.push({ row: rowNumber, field: "occurred_at", code: "VALID_DATE_REQUIRED" });
    }
    const currencyText = readCsvField(record, "currency") || "TRY";
    const currencyResult = CurrencyCodeSchema.safeParse(currencyText);
    if (!currencyResult.success) errors.push({ row: rowNumber, field: "currency", code: "INVALID_CURRENCY" });

    const amountText = readCsvField(record, "amount_minor") || readCsvField(record, "amount");
    const amountMinor = amountText ? parseImportAmount(amountText, Boolean(readCsvField(record, "amount_minor"))) : null;
    if (amountMinor === null) errors.push({ row: rowNumber, field: "amount", code: "VALID_AMOUNT_REQUIRED" });
    const taxText = readCsvField(record, "tax_minor") || readCsvField(record, "tax");
    const taxMinor = taxText ? parseImportAmount(taxText, Boolean(readCsvField(record, "tax_minor"))) : 0n;
    if (taxMinor === null) errors.push({ row: rowNumber, field: "tax", code: "INVALID_TAX_AMOUNT" });

    const reimbursable = parseImportBoolean(readCsvField(record, "reimbursable"));
    if (reimbursable === null) errors.push({ row: rowNumber, field: "reimbursable", code: "INVALID_BOOLEAN" });
    const businessExpense = parseImportBoolean(readCsvField(record, "business_expense"));
    if (businessExpense === null) errors.push({ row: rowNumber, field: "business_expense", code: "INVALID_BOOLEAN" });

    if (
      !title ||
      !occurredAt ||
      Number.isNaN(occurredAt.getTime()) ||
      !currencyResult.success ||
      amountMinor === null ||
      taxMinor === null ||
      reimbursable === null ||
      businessExpense === null
    ) {
      return;
    }
    rows.push({
      title,
      description: readCsvField(record, "description") || null,
      currency: currencyResult.data,
      amountMinor,
      taxMinor,
      occurredAt,
      merchantName: readCsvField(record, "merchant") || readCsvField(record, "merchant_name") || null,
      paymentMethodName: readCsvField(record, "payment_method") || readCsvField(record, "payment_method_name") || null,
      reimbursable: reimbursable ?? false,
      businessExpense: businessExpense ?? false,
      projectCode: readCsvField(record, "project_code") || null,
      costCenter: readCsvField(record, "cost_center") || null
    });
  });
  if (errors.length > 0) return { rows: [], errors, totalRows: records.length };
  return { rows, errors, totalRows: records.length };
}

function readCsvField(record: Record<string, string>, field: string): string {
  return (record[field] ?? record[field.toUpperCase()] ?? "").trim();
}

function parseImportAmount(value: string, isMinorUnit: boolean): bigint | null {
  const normalized = value.trim();
  if (isMinorUnit) return /^-?\d+$/.test(normalized) ? BigInt(normalized) : null;
  const match = /^(?<sign>-?)(?<major>\d+)(?:[,.](?<minor>\d{1,2}))?$/.exec(normalized);
  const groups = match?.groups;
  const majorPart = groups?.major;
  if (!majorPart) return null;
  const major = BigInt(majorPart);
  const minor = BigInt((groups.minor ?? "0").padEnd(2, "0"));
  const amount = major * 100n + minor;
  return groups.sign === "-" ? -amount : amount;
}

function parseImportBoolean(value: string): boolean | null {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "evet"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "hayir"].includes(normalized)) return false;
  return null;
}

type RecurringExpenseSource = {
  id: string;
  merchantId: string | null;
  merchantName: string | null;
  title: string;
  amountMinor: bigint;
  currency: string;
  occurredAt: Date;
};

function detectRecurringCandidates(expenses: RecurringExpenseSource[]) {
  const groups = new Map<string, RecurringExpenseSource[]>();
  for (const expense of expenses) {
    if (expense.amountMinor <= 0n) continue;
    const name = recurringName(expense);
    const key = `${normalizeText(name)}:${expense.amountMinor.toString()}:${expense.currency}`;
    groups.set(key, [...(groups.get(key) ?? []), expense]);
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
      if (sorted.length < 2) return null;
      const cadence = inferCadence(sorted);
      if (!cadence) return null;
      const latest = sorted[sorted.length - 1];
      if (!latest) return null;
      const days = cadence === "weekly" ? 7 : 30;
      return {
        name: recurringName(latest),
        cadence,
        latest,
        nextDueAt: new Date(latest.occurredAt.getTime() + days * 24 * 60 * 60 * 1000)
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
}

function inferCadence(expenses: Array<{ occurredAt: Date }>): "weekly" | "monthly" | null {
  const gaps: number[] = [];
  for (let index = 1; index < expenses.length; index += 1) {
    const current = expenses[index];
    const previous = expenses[index - 1];
    if (!current || !previous) continue;
    const gapDays = Math.round((current.occurredAt.getTime() - previous.occurredAt.getTime()) / (24 * 60 * 60 * 1000));
    gaps.push(gapDays);
  }
  if (gaps.some((gap) => gap >= 5 && gap <= 10)) return "weekly";
  if (gaps.some((gap) => gap >= 25 && gap <= 45)) return "monthly";
  return null;
}

function recurringName(expense: { merchantName: string | null; title: string }): string {
  return (expense.merchantName ?? expense.title).trim();
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePolicyRuleType(ruleType: string): string {
  const normalized = ruleType.trim().toUpperCase();
  if (
    ![
      "MAX_AMOUNT_BY_CATEGORY",
      "RECEIPT_REQUIRED_ABOVE",
      "PROJECT_REQUIRED",
      "ALLOWED_CATEGORIES",
      "DUPLICATE_RECEIPT_REJECTION"
    ].includes(normalized)
  ) {
    throw new ExpenseError("EXPENSE_POLICY_RULE_UNSUPPORTED", 400);
  }
  return normalized;
}

function normalizePolicyConfig(ruleType: string, config: unknown): Record<string, unknown> {
  const normalizedRuleType = normalizePolicyRuleType(ruleType);
  const value = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  if (normalizedRuleType === "MAX_AMOUNT_BY_CATEGORY") {
    return {
      maxAmountMinor: parsePolicyMinor(value.maxAmountMinor),
      categoryId: typeof value.categoryId === "string" && value.categoryId.trim() ? value.categoryId.trim() : null
    };
  }
  if (normalizedRuleType === "RECEIPT_REQUIRED_ABOVE") {
    return { thresholdMinor: parsePolicyMinor(value.thresholdMinor) };
  }
  if (normalizedRuleType === "PROJECT_REQUIRED") {
    return { onlyBusiness: value.onlyBusiness !== false };
  }
  if (normalizedRuleType === "ALLOWED_CATEGORIES") {
    const categoryIds = Array.isArray(value.categoryIds)
      ? value.categoryIds.filter((categoryId): categoryId is string => typeof categoryId === "string" && Boolean(categoryId.trim())).map((categoryId) => categoryId.trim())
      : [];
    if (!categoryIds.length) throw new ExpenseError("EXPENSE_POLICY_CATEGORIES_REQUIRED", 400);
    return { categoryIds };
  }
  return {};
}

function parsePolicyMinor(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new ExpenseError("INVALID_POLICY_MINOR_AMOUNT", 400);
  return value;
}

function normalizeNullableText(value: string | null | undefined, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function extractionReviewReasonCodes(extracted: ExtractedReceiptFields): string[] {
  const reasons = new Set<string>(
    extracted.validationIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.code)
  );
  const requiredFields = ["merchantName", "date", "total"];
  for (const fieldName of requiredFields) {
    const evidence = extracted.fieldEvidence.find((field) => field.fieldName === fieldName);
    if (evidence && evidence.confidence < 0.55) reasons.add(`LOW_FIELD_CONFIDENCE_${fieldName.toUpperCase()}`);
  }
  if (extracted.documentTypeConfidence < 0.6) reasons.add("LOW_DOCUMENT_TYPE_CONFIDENCE");
  return [...reasons];
}

function evaluatePolicy(
  policy: StoredExpensePolicy,
  expense: StoredExpense,
  peers: StoredExpense[]
): ExpensePolicyEvaluation["violations"] {
  const config = policy.config && typeof policy.config === "object" ? (policy.config as Record<string, unknown>) : {};
  const severity = policy.severity === "block" ? "block" : "warning";
  if (policy.ruleType === "MAX_AMOUNT_BY_CATEGORY") {
    const maxAmountMinor = typeof config.maxAmountMinor === "string" ? BigInt(config.maxAmountMinor) : null;
    const categoryId = typeof config.categoryId === "string" ? config.categoryId : null;
    if (maxAmountMinor !== null && (!categoryId || expense.categoryId === categoryId) && expense.amountMinor > maxAmountMinor) {
      return [
        policyViolation(policy, severity, "MAX_AMOUNT_EXCEEDED", "Expense exceeds configured maximum amount.", {
          amountMinor: expense.amountMinor.toString(),
          maxAmountMinor: maxAmountMinor.toString(),
          categoryId
        })
      ];
    }
  }
  if (policy.ruleType === "RECEIPT_REQUIRED_ABOVE") {
    const thresholdMinor = typeof config.thresholdMinor === "string" ? BigInt(config.thresholdMinor) : null;
    if (thresholdMinor !== null && expense.amountMinor >= thresholdMinor && !expense.documentId) {
      return [
        policyViolation(policy, severity, "RECEIPT_REQUIRED", "Expense requires a receipt attachment above the configured threshold.", {
          amountMinor: expense.amountMinor.toString(),
          thresholdMinor: thresholdMinor.toString(),
          hasDocument: false
        })
      ];
    }
  }
  if (policy.ruleType === "PROJECT_REQUIRED") {
    const onlyBusiness = config.onlyBusiness !== false;
    if ((!onlyBusiness || expense.businessExpense) && !expense.projectCode) {
      return [
        policyViolation(policy, severity, "PROJECT_REQUIRED", "Expense requires a project code.", {
          businessExpense: expense.businessExpense,
          projectCode: null
        })
      ];
    }
  }
  if (policy.ruleType === "ALLOWED_CATEGORIES") {
    const categoryIds = Array.isArray(config.categoryIds) ? config.categoryIds.filter((categoryId): categoryId is string => typeof categoryId === "string") : [];
    if (categoryIds.length && (!expense.categoryId || !categoryIds.includes(expense.categoryId))) {
      return [
        policyViolation(policy, severity, "CATEGORY_NOT_ALLOWED", "Expense category is outside the allowed category list.", {
          categoryId: expense.categoryId,
          allowedCount: categoryIds.length
        })
      ];
    }
  }
  if (policy.ruleType === "DUPLICATE_RECEIPT_REJECTION" && expense.documentId) {
    const duplicate = peers.find((peer) => peer.id !== expense.id && peer.documentId === expense.documentId);
    if (duplicate) {
      return [
        policyViolation(policy, severity, "DUPLICATE_RECEIPT", "Another active expense uses the same receipt document.", {
          documentId: expense.documentId,
          duplicateExpenseId: duplicate.id
        })
      ];
    }
  }
  return [];
}

function policyViolation(
  policy: StoredExpensePolicy,
  severity: "warning" | "block",
  code: string,
  message: string,
  evidence: Record<string, string | number | boolean | null>
): ExpensePolicyEvaluation["violations"][number] {
  return {
    policyId: policy.id,
    policyName: policy.name,
    ruleType: policy.ruleType,
    severity,
    code,
    message,
    evidence
  };
}
