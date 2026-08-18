import { randomUUID } from "node:crypto";
import type {
  ApprovalSlaItem,
  CreateExpenseInput,
  ExpenseRepository,
  StoredApprovalWorkflow,
  StoredExpenseAttachment,
  StoredExpenseComment,
  StoredExpense,
  StoredExpenseLineItem,
  StoredExpensePolicy,
  StoredImportBatch,
  StoredMLCategoryPrediction,
  StoredReimbursementClaim,
  StoredReimbursementClaimExpense,
  StoredRecurringExpense,
  StoredSubscription
} from "./types";

export class InMemoryExpenseRepository implements ExpenseRepository {
  private expenses = new Map<string, StoredExpense>();
  private lineItems = new Map<string, StoredExpenseLineItem[]>();
  private attachments = new Map<string, StoredExpenseAttachment[]>();
  private comments = new Map<string, StoredExpenseComment[]>();
  private subscriptions = new Map<string, StoredSubscription>();
  private recurringExpenses = new Map<string, StoredRecurringExpense>();
  private importBatches = new Map<string, StoredImportBatch>();
  private reimbursementClaims = new Map<string, StoredReimbursementClaim>();
  private reimbursementClaimItems = new Map<string, StoredReimbursementClaimExpense[]>();
  private expensePolicies = new Map<string, StoredExpensePolicy>();
  private approvalWorkflows = new Map<string, StoredApprovalWorkflow>();
  private categoryIds = new Map<string, string>();
  public readonly categoryPredictions: StoredMLCategoryPrediction[] = [];

  async create(input: CreateExpenseInput): Promise<{ expense: StoredExpense; lineItems: StoredExpenseLineItem[] }> {
    const now = new Date();
    const expense: StoredExpense = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      merchantId: input.merchantName ? randomUUID() : null,
      merchantName: input.merchantName ?? null,
      categoryId: null,
      paymentMethodId: input.paymentMethodName ? randomUUID() : null,
      paymentMethodName: input.paymentMethodName ?? null,
      documentId: input.documentId ?? null,
      status: input.status ?? "DRAFT",
      title: input.title,
      description: input.description ?? null,
      currency: input.currency,
      amountMinor: input.amountMinor,
      taxMinor: input.taxMinor ?? 0n,
      occurredAt: input.occurredAt,
      reimbursable: input.reimbursable ?? false,
      businessExpense: input.businessExpense ?? false,
      projectCode: input.projectCode ?? null,
      costCenter: input.costCenter ?? null,
      duplicateGroup: input.duplicateGroup ?? null,
      createdById: input.createdById,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    const items = (input.lineItems ?? []).map((item) => ({
      id: randomUUID(),
      tenantId: input.tenantId,
      expenseId: expense.id,
      name: item.name,
      quantity: item.quantity ?? "1",
      unitPriceMinor: item.unitPriceMinor ?? item.totalMinor,
      taxRateBps: item.taxRateBps ?? null,
      totalMinor: item.totalMinor,
      createdAt: now
    }));
    this.expenses.set(expense.id, expense);
    this.lineItems.set(expense.id, items);
    this.approvalWorkflows.set(expense.id, createPendingApprovalWorkflow(input.tenantId, input.workspaceId, expense.id, expense.createdAt));
    return { expense, lineItems: items };
  }

  async list(input: { tenantId: string; workspaceId?: string }): Promise<StoredExpense[]> {
    return [...this.expenses.values()]
      .filter(
        (expense) =>
          expense.tenantId === input.tenantId &&
          !expense.archivedAt &&
          (!input.workspaceId || expense.workspaceId === input.workspaceId)
      )
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
  }

  async listPage(input: Parameters<ExpenseRepository["listPage"]>[0]): ReturnType<ExpenseRepository["listPage"]> {
    const search = input.search?.trim().toLocaleLowerCase("tr-TR") ?? "";
    const ordered = (await this.list({ tenantId: input.tenantId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) }))
      .filter((expense) => !input.status || expense.status === input.status)
      .filter((expense) =>
        !search || [expense.title, expense.description, expense.merchantName].some((value) => value?.toLocaleLowerCase("tr-TR").includes(search))
      );
    const cursorIndex = input.cursor ? ordered.findIndex((expense) => expense.id === input.cursor) : -1;
    const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const page = ordered.slice(start, start + input.limit + 1);
    const hasMore = page.length > input.limit;
    const expenses = page.slice(0, input.limit);
    return { expenses, nextCursor: hasMore ? expenses.at(-1)?.id ?? null : null };
  }

  async createImportBatch(input: Parameters<ExpenseRepository["createImportBatch"]>[0]): Promise<StoredImportBatch> {
    const now = new Date();
    const batch: StoredImportBatch = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      source: input.source,
      status: input.status,
      stats: input.stats,
      createdById: input.createdById,
      createdAt: now,
      completedAt: now
    };
    this.importBatches.set(batch.id, batch);
    return batch;
  }

  async listImportBatches(input: Parameters<ExpenseRepository["listImportBatches"]>[0]): Promise<StoredImportBatch[]> {
    return [...this.importBatches.values()]
      .filter((batch) => batch.tenantId === input.tenantId && batch.workspaceId === input.workspaceId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async findById(input: { tenantId: string; expenseId: string }): Promise<StoredExpense | null> {
    const expense = this.expenses.get(input.expenseId);
    return expense?.tenantId === input.tenantId && !expense.archivedAt ? expense : null;
  }

  async update(input: Parameters<ExpenseRepository["update"]>[0]): Promise<StoredExpense | null> {
    const existing = await this.findById(input);
    if (!existing) return null;
    const updated: StoredExpense = {
      ...existing,
      title: input.title ?? existing.title,
      description: input.description !== undefined ? input.description : existing.description,
      amountMinor: input.amountMinor ?? existing.amountMinor,
      taxMinor: input.taxMinor ?? existing.taxMinor,
      occurredAt: input.occurredAt ?? existing.occurredAt,
      merchantId: input.merchantName !== undefined ? (input.merchantName ? existing.merchantId ?? randomUUID() : null) : existing.merchantId,
      merchantName: input.merchantName !== undefined ? input.merchantName : existing.merchantName,
      paymentMethodId:
        input.paymentMethodName !== undefined
          ? input.paymentMethodName
            ? existing.paymentMethodId ?? randomUUID()
            : null
          : existing.paymentMethodId,
      paymentMethodName: input.paymentMethodName !== undefined ? input.paymentMethodName : existing.paymentMethodName,
      reimbursable: input.reimbursable ?? existing.reimbursable,
      businessExpense: input.businessExpense ?? existing.businessExpense,
      projectCode: input.projectCode !== undefined ? input.projectCode : existing.projectCode,
      costCenter: input.costCenter !== undefined ? input.costCenter : existing.costCenter,
      updatedAt: new Date()
    };
    this.expenses.set(updated.id, updated);
    return updated;
  }

  async listAttachments(input: Parameters<ExpenseRepository["listAttachments"]>[0]): Promise<StoredExpenseAttachment[]> {
    return (this.attachments.get(input.expenseId) ?? [])
      .filter((attachment) => attachment.tenantId === input.tenantId && attachment.detachedAt === null)
      .sort((a, b) => a.attachedAt.getTime() - b.attachedAt.getTime());
  }

  async attachDocument(input: Parameters<ExpenseRepository["attachDocument"]>[0]): ReturnType<ExpenseRepository["attachDocument"]> {
    const existing = await this.findById(input);
    if (!existing) return null;
    const current = await this.listAttachments(input);
    const duplicate = current.find((attachment) => attachment.documentFileId === input.documentFileId);
    const attachment: StoredExpenseAttachment =
      duplicate ??
      ({
        id: randomUUID(),
        tenantId: input.tenantId,
        expenseId: input.expenseId,
        documentFileId: input.documentFileId,
        label: input.label ?? null,
        note: input.note ?? null,
        attachedById: input.actorUserId,
        attachedAt: new Date(),
        detachedAt: null
      } satisfies StoredExpenseAttachment);
    if (!duplicate) this.attachments.set(input.expenseId, [...(this.attachments.get(input.expenseId) ?? []), attachment]);
    const shouldPromote = input.primary === true || !existing.documentId;
    const updated: StoredExpense = { ...existing, documentId: shouldPromote ? input.documentFileId : existing.documentId, updatedAt: new Date() };
    this.expenses.set(updated.id, updated);
    return { expense: updated, attachment };
  }

  async detachDocument(input: Parameters<ExpenseRepository["detachDocument"]>[0]): ReturnType<ExpenseRepository["detachDocument"]> {
    const existing = await this.findById(input);
    if (!existing) return null;
    const active = await this.listAttachments(input);
    const attachment = active.find((entry) => entry.documentFileId === input.documentFileId);
    if (!attachment && existing.documentId !== input.documentFileId) return null;
    const detached: StoredExpenseAttachment =
      attachment ??
      ({
        id: randomUUID(),
        tenantId: input.tenantId,
        expenseId: input.expenseId,
        documentFileId: input.documentFileId,
        label: null,
        note: null,
        attachedById: input.actorUserId,
        attachedAt: existing.createdAt,
        detachedAt: new Date()
      } satisfies StoredExpenseAttachment);
    const all = this.attachments.get(input.expenseId) ?? [];
    this.attachments.set(
      input.expenseId,
      attachment
        ? all.map((entry) => (entry.id === attachment.id ? { ...entry, detachedAt: detached.detachedAt ?? new Date() } : entry))
        : [...all, detached]
    );
    const remaining = active.filter((entry) => entry.documentFileId !== input.documentFileId);
    const updated: StoredExpense = { ...existing, documentId: existing.documentId === input.documentFileId ? remaining[0]?.documentFileId ?? null : existing.documentId, updatedAt: new Date() };
    this.expenses.set(updated.id, updated);
    return { expense: updated, attachment: { ...detached, detachedAt: detached.detachedAt ?? new Date() } };
  }

  async archive(input: Parameters<ExpenseRepository["archive"]>[0]): Promise<StoredExpense | null> {
    const existing = await this.findById(input);
    if (!existing) return null;
    const archived: StoredExpense = {
      ...existing,
      status: "ARCHIVED",
      archivedAt: new Date(),
      updatedAt: new Date()
    };
    this.expenses.set(archived.id, archived);
    return archived;
  }

  async createReimbursementClaim(input: Parameters<ExpenseRepository["createReimbursementClaim"]>[0]) {
    const selected = input.expenseIds.map((expenseId) => this.expenses.get(expenseId));
    if (selected.some((expense) => !expense || expense.tenantId !== input.tenantId || expense.workspaceId !== input.workspaceId || expense.archivedAt)) {
      return null;
    }
    const expenses = selected as StoredExpense[];
    const now = new Date();
    const claim: StoredReimbursementClaim = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      claimantId: input.claimantId,
      status: "NEEDS_REVIEW",
      totalMinor: expenses.reduce((total, expense) => total + expense.amountMinor, 0n),
      currency: expenses[0]?.currency ?? "TRY",
      createdAt: now,
      updatedAt: now,
      submittedAt: now,
      paidAt: null
    };
    const items = expenses.map((expense) => ({
      id: randomUUID(),
      tenantId: input.tenantId,
      claimId: claim.id,
      expenseId: expense.id,
      amountMinor: expense.amountMinor,
      createdAt: now
    }));
    this.reimbursementClaims.set(claim.id, claim);
    this.reimbursementClaimItems.set(claim.id, items);
    return { claim, items, expenses };
  }

  async listReimbursementClaims(input: Parameters<ExpenseRepository["listReimbursementClaims"]>[0]) {
    return [...this.reimbursementClaims.values()]
      .filter((claim) => claim.tenantId === input.tenantId && claim.workspaceId === input.workspaceId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map((claim) => ({ claim, items: this.reimbursementClaimItems.get(claim.id) ?? [] }));
  }

  async findReimbursementClaimById(input: Parameters<ExpenseRepository["findReimbursementClaimById"]>[0]) {
    const claim = this.reimbursementClaims.get(input.claimId);
    if (!claim || claim.tenantId !== input.tenantId) return null;
    return { claim, items: this.reimbursementClaimItems.get(claim.id) ?? [] };
  }

  async transitionReimbursementClaim(input: Parameters<ExpenseRepository["transitionReimbursementClaim"]>[0]) {
    const existing = this.reimbursementClaims.get(input.claimId);
    if (!existing || existing.tenantId !== input.tenantId) return null;
    const now = new Date();
    const claim: StoredReimbursementClaim = {
      ...existing,
      status: input.status,
      updatedAt: now,
      paidAt: input.status === "REIMBURSED" ? now : existing.paidAt
    };
    this.reimbursementClaims.set(claim.id, claim);
    const items = this.reimbursementClaimItems.get(claim.id) ?? [];
    const expenses = items.map((item) => this.expenses.get(item.expenseId)).filter(Boolean) as StoredExpense[];
    const updatedExpenses =
      input.status === "REIMBURSED"
        ? expenses.map((expense) => {
            const updated: StoredExpense = { ...expense, status: "REIMBURSED", updatedAt: now };
            this.expenses.set(updated.id, updated);
            return updated;
          })
        : expenses;
    return { claim, items, expenses: updatedExpenses };
  }

  async createExpensePolicy(input: Parameters<ExpenseRepository["createExpensePolicy"]>[0]): Promise<StoredExpensePolicy> {
    const now = new Date();
    const policy: StoredExpensePolicy = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      name: input.name,
      ruleType: input.ruleType,
      config: input.config,
      severity: input.severity,
      active: true,
      createdById: input.actorUserId,
      createdAt: now,
      updatedAt: now
    };
    this.expensePolicies.set(policy.id, policy);
    return policy;
  }

  async listExpensePolicies(input: Parameters<ExpenseRepository["listExpensePolicies"]>[0]): Promise<StoredExpensePolicy[]> {
    return [...this.expensePolicies.values()]
      .filter(
        (policy) =>
          policy.tenantId === input.tenantId &&
          policy.workspaceId === input.workspaceId &&
          (input.includeInactive || policy.active)
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  async archiveExpensePolicy(input: Parameters<ExpenseRepository["archiveExpensePolicy"]>[0]): Promise<StoredExpensePolicy | null> {
    const existing = this.expensePolicies.get(input.policyId);
    if (!existing || existing.tenantId !== input.tenantId || !existing.active) return null;
    const updated: StoredExpensePolicy = { ...existing, active: false, updatedAt: new Date() };
    this.expensePolicies.set(updated.id, updated);
    return updated;
  }

  async listComments(input: Parameters<ExpenseRepository["listComments"]>[0]): Promise<StoredExpenseComment[]> {
    const existing = await this.findById({ tenantId: input.tenantId, expenseId: input.expenseId });
    if (!existing) return [];
    return [...(this.comments.get(input.expenseId) ?? [])].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  async addComment(input: Parameters<ExpenseRepository["addComment"]>[0]): Promise<StoredExpenseComment | null> {
    const existing = await this.findById({ tenantId: input.tenantId, expenseId: input.expenseId });
    if (!existing) return null;
    const now = new Date();
    const comment: StoredExpenseComment = {
      id: randomUUID(),
      tenantId: input.tenantId,
      expenseId: input.expenseId,
      authorId: input.actorUserId,
      body: input.body,
      createdAt: now,
      updatedAt: now
    };
    this.comments.set(input.expenseId, [...(this.comments.get(input.expenseId) ?? []), comment]);
    return comment;
  }

  async listSubscriptions(input: Parameters<ExpenseRepository["listSubscriptions"]>[0]): Promise<StoredSubscription[]> {
    return [...this.subscriptions.values()]
      .filter((subscription) => subscription.tenantId === input.tenantId && subscription.workspaceId === input.workspaceId && subscription.active)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async upsertSubscription(input: Parameters<ExpenseRepository["upsertSubscription"]>[0]): Promise<StoredSubscription> {
    const key = `${input.tenantId}:${input.workspaceId}:${normalizeName(input.name)}:${input.amountMinor.toString()}:${input.currency}:${input.cadence}`;
    const existing = this.subscriptions.get(key);
    const now = new Date();
    const subscription: StoredSubscription = existing
      ? {
          ...existing,
          merchantId: input.merchantId ?? existing.merchantId,
          detectedFromExpenseId: input.detectedFromExpenseId,
          updatedAt: now
        }
      : {
          id: randomUUID(),
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          merchantId: input.merchantId ?? null,
          name: input.name,
          amountMinor: input.amountMinor,
          currency: input.currency,
          cadence: input.cadence,
          detectedFromExpenseId: input.detectedFromExpenseId,
          active: true,
          createdAt: now,
          updatedAt: now
        };
    this.subscriptions.set(key, subscription);
    return subscription;
  }

  async listRecurring(input: Parameters<ExpenseRepository["listRecurring"]>[0]): Promise<StoredRecurringExpense[]> {
    return [...this.recurringExpenses.values()]
      .filter((rule) => rule.tenantId === input.tenantId && rule.workspaceId === input.workspaceId && rule.active)
      .sort((left, right) => left.nextDueAt.getTime() - right.nextDueAt.getTime());
  }

  async createRecurringFromExpense(input: Parameters<ExpenseRepository["createRecurringFromExpense"]>[0]): Promise<StoredRecurringExpense | null> {
    const expense = await this.findById({ tenantId: input.tenantId, expenseId: input.expenseId });
    if (!expense) return null;
    const now = new Date();
    const rule: StoredRecurringExpense = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: expense.workspaceId,
      merchantId: expense.merchantId,
      merchantName: expense.merchantName,
      amountMinor: expense.amountMinor,
      currency: expense.currency,
      cadence: input.cadence,
      nextDueAt: input.nextDueAt,
      active: true,
      createdAt: now,
      updatedAt: now
    };
    this.recurringExpenses.set(rule.id, rule);
    return rule;
  }

  async findRecurringById(input: Parameters<ExpenseRepository["findRecurringById"]>[0]): Promise<StoredRecurringExpense | null> {
    const rule = this.recurringExpenses.get(input.recurringExpenseId);
    return rule?.tenantId === input.tenantId && rule.active ? rule : null;
  }

  async advanceRecurring(input: Parameters<ExpenseRepository["advanceRecurring"]>[0]): Promise<StoredRecurringExpense | null> {
    const existing = await this.findRecurringById(input);
    if (!existing) return null;
    const updated: StoredRecurringExpense = { ...existing, nextDueAt: input.nextDueAt, updatedAt: new Date() };
    this.recurringExpenses.set(updated.id, updated);
    return updated;
  }

  async saveCategoryPrediction(input: Parameters<ExpenseRepository["saveCategoryPrediction"]>[0]): Promise<StoredMLCategoryPrediction> {
    const existing = await this.findById({ tenantId: input.tenantId, expenseId: input.expenseId });
    if (!existing) throw new Error("EXPENSE_NOT_FOUND");
    const categoryMapKey = `${input.tenantId}:${input.categoryKey}`;
    const categoryId = this.categoryIds.get(categoryMapKey) ?? randomUUID();
    this.categoryIds.set(categoryMapKey, categoryId);
    const updatedExpense: StoredExpense = { ...existing, categoryId, updatedAt: new Date() };
    this.expenses.set(existing.id, updatedExpense);
    const prediction: StoredMLCategoryPrediction = {
      id: randomUUID(),
      tenantId: input.tenantId,
      expenseId: input.expenseId,
      documentFileId: input.documentFileId ?? null,
      modelVersionId: null,
      categoryId,
      confidence: input.confidence.toFixed(4),
      explanation: {
        prediction: input.prediction,
        anomalies: input.anomalies,
        model: input.model,
        categoryKey: input.categoryKey
      },
      createdAt: new Date()
    };
    this.categoryPredictions.push(prediction);
    return prediction;
  }

  async transitionStatus(input: Parameters<ExpenseRepository["transitionStatus"]>[0]) {
    const existing = await this.findById(input);
    if (!existing) return null;
    const now = new Date();
    const expense: StoredExpense = { ...existing, status: input.status, updatedAt: now };
    const existingWorkflow = this.approvalWorkflows.get(existing.id);
    const slaDueAt = existingWorkflow?.slaDueAt ?? addHours(existing.createdAt, DEFAULT_APPROVAL_SLA_HOURS);
    const finalSla = finalizeApprovalSla(input.status, slaDueAt, now);
    const workflow: StoredApprovalWorkflow = {
      id: existingWorkflow?.id ?? randomUUID(),
      tenantId: input.tenantId,
      workspaceId: existing.workspaceId,
      targetType: "Expense",
      targetId: existing.id,
      state: input.status,
      approverId: input.actorUserId,
      policySnapshot: { reason: input.reason ?? null, previousStatus: existing.status, policyEvaluation: input.policyEvaluation ?? null },
      slaDueAt,
      slaBreachedAt: finalSla.slaBreachedAt,
      slaStatus: finalSla.slaStatus,
      slaHours: existingWorkflow?.slaHours ?? DEFAULT_APPROVAL_SLA_HOURS,
      createdAt: existingWorkflow?.createdAt ?? now,
      updatedAt: now
    };
    this.expenses.set(expense.id, expense);
    this.approvalWorkflows.set(expense.id, workflow);
    return { expense, approvalWorkflow: workflow };
  }

  async listApprovalSla(input: Parameters<ExpenseRepository["listApprovalSla"]>[0]): Promise<ApprovalSlaItem[]> {
    const now = input.now ?? new Date();
    const expenses = await this.list({ tenantId: input.tenantId, workspaceId: input.workspaceId });
    return expenses.map((expense) => {
      const workflow = this.approvalWorkflows.get(expense.id) ?? createPendingApprovalWorkflow(input.tenantId, expense.workspaceId, expense.id, expense.createdAt);
      return buildApprovalSlaItem(expense, workflow, now);
    });
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

const DEFAULT_APPROVAL_SLA_HOURS = 48;
const APPROVAL_DUE_SOON_MINUTES = 6 * 60;

function createPendingApprovalWorkflow(tenantId: string, workspaceId: string, expenseId: string, createdAt: Date): StoredApprovalWorkflow {
  return {
    id: randomUUID(),
    tenantId,
    workspaceId,
    targetType: "Expense",
    targetId: expenseId,
    state: "PENDING",
    approverId: null,
    policySnapshot: null,
    slaDueAt: addHours(createdAt, DEFAULT_APPROVAL_SLA_HOURS),
    slaBreachedAt: null,
    slaStatus: "ON_TRACK",
    slaHours: DEFAULT_APPROVAL_SLA_HOURS,
    createdAt,
    updatedAt: createdAt
  };
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function finalizeApprovalSla(status: "APPROVED" | "REJECTED", dueAt: Date | null, decidedAt: Date) {
  if (!dueAt) return { slaStatus: status === "APPROVED" ? "MET_ON_TIME" : "REJECTED_ON_TIME", slaBreachedAt: null };
  const late = decidedAt.getTime() > dueAt.getTime();
  return {
    slaStatus: status === "APPROVED" ? (late ? "MET_LATE" : "MET_ON_TIME") : late ? "REJECTED_LATE" : "REJECTED_ON_TIME",
    slaBreachedAt: late ? dueAt : null
  };
}

function buildApprovalSlaItem(expense: StoredExpense, workflow: StoredApprovalWorkflow, now: Date): ApprovalSlaItem {
  const dueAt = workflow.slaDueAt;
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - expense.createdAt.getTime()) / 60000));
  const remainingMinutes = dueAt ? Math.floor((dueAt.getTime() - now.getTime()) / 60000) : null;
  const pending = workflow.state === "PENDING";
  const dynamicStatus =
    pending && remainingMinutes !== null
      ? remainingMinutes < 0
        ? "BREACHED"
        : remainingMinutes <= APPROVAL_DUE_SOON_MINUTES
          ? "DUE_SOON"
          : "ON_TRACK"
      : workflow.slaStatus;
  return {
    expense,
    workflow,
    slaStatus: dynamicStatus,
    slaDueAt: dueAt,
    slaBreachedAt: workflow.slaBreachedAt ?? (dynamicStatus === "BREACHED" ? dueAt : null),
    remainingMinutes,
    ageMinutes
  };
}
