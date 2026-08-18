import type { ExpenseStatus, JobStatus } from "@prisma/client";
import type { CategoryPrediction, ExpenseAnomaly, ExpenseCategoryKey } from "@spendlens/shared";

export type StoredExpense = {
  id: string;
  tenantId: string;
  workspaceId: string;
  merchantId: string | null;
  merchantName: string | null;
  categoryId: string | null;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  documentId: string | null;
  status: ExpenseStatus;
  title: string;
  description: string | null;
  currency: string;
  amountMinor: bigint;
  taxMinor: bigint;
  occurredAt: Date;
  reimbursable: boolean;
  businessExpense: boolean;
  projectCode: string | null;
  costCenter: string | null;
  duplicateGroup: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type ExpenseListPageInput = {
  tenantId: string;
  workspaceId?: string;
  limit: number;
  cursor?: string;
  status?: ExpenseStatus;
  search?: string;
};

export type ExpenseListPage = {
  expenses: StoredExpense[];
  nextCursor: string | null;
};

export type StoredExpenseLineItem = {
  id: string;
  tenantId: string;
  expenseId: string;
  name: string;
  quantity: string;
  unitPriceMinor: bigint;
  taxRateBps: number | null;
  totalMinor: bigint;
  createdAt: Date;
};

export type StoredExpenseComment = {
  id: string;
  tenantId: string;
  expenseId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredExpenseAttachment = {
  id: string;
  tenantId: string;
  expenseId: string;
  documentFileId: string;
  label: string | null;
  note: string | null;
  attachedById: string;
  attachedAt: Date;
  detachedAt: Date | null;
};

export type StoredApprovalWorkflow = {
  id: string;
  tenantId: string;
  workspaceId: string;
  targetType: string;
  targetId: string;
  state: string;
  approverId: string | null;
  policySnapshot: unknown;
  slaDueAt: Date | null;
  slaBreachedAt: Date | null;
  slaStatus: string;
  slaHours: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ApprovalSlaItem = {
  expense: StoredExpense;
  workflow: StoredApprovalWorkflow;
  slaStatus: string;
  slaDueAt: Date | null;
  slaBreachedAt: Date | null;
  remainingMinutes: number | null;
  ageMinutes: number;
};

export type StoredMLCategoryPrediction = {
  id: string;
  tenantId: string;
  expenseId: string | null;
  documentFileId: string | null;
  modelVersionId: string | null;
  categoryId: string;
  confidence: string;
  explanation: unknown;
  createdAt: Date;
};

export type StoredSubscription = {
  id: string;
  tenantId: string;
  workspaceId: string;
  merchantId: string | null;
  name: string;
  amountMinor: bigint;
  currency: string;
  cadence: string;
  detectedFromExpenseId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredRecurringExpense = {
  id: string;
  tenantId: string;
  workspaceId: string;
  merchantId: string | null;
  merchantName: string | null;
  amountMinor: bigint;
  currency: string;
  cadence: string;
  nextDueAt: Date;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredImportBatch = {
  id: string;
  tenantId: string;
  workspaceId: string;
  source: string;
  status: JobStatus;
  stats: unknown;
  createdById: string;
  createdAt: Date;
  completedAt: Date | null;
};

export type StoredReimbursementClaim = {
  id: string;
  tenantId: string;
  workspaceId: string;
  claimantId: string;
  status: ExpenseStatus;
  totalMinor: bigint;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  submittedAt: Date | null;
  paidAt: Date | null;
};

export type StoredReimbursementClaimExpense = {
  id: string;
  tenantId: string;
  claimId: string;
  expenseId: string;
  amountMinor: bigint;
  createdAt: Date;
};

export type StoredExpensePolicy = {
  id: string;
  tenantId: string;
  workspaceId: string;
  name: string;
  ruleType: string;
  config: unknown;
  severity: string;
  active: boolean;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ExpensePolicyEvaluation = {
  expenseId: string;
  checkedPolicyCount: number;
  violations: Array<{
    policyId: string;
    policyName: string;
    ruleType: string;
    severity: string;
    code: string;
    message: string;
    evidence: Record<string, string | number | boolean | null>;
  }>;
};

export type CreateExpenseInput = {
  tenantId: string;
  workspaceId: string;
  title: string;
  description?: string | null;
  currency: "TRY" | "USD" | "EUR" | "GBP";
  amountMinor: bigint;
  taxMinor?: bigint;
  occurredAt: Date;
  status?: ExpenseStatus;
  documentId?: string | null;
  merchantName?: string | null;
  paymentMethodName?: string | null;
  reimbursable?: boolean;
  businessExpense?: boolean;
  projectCode?: string | null;
  costCenter?: string | null;
  duplicateGroup?: string | null;
  createdById: string;
  lineItems?: Array<{
    name: string;
    quantity?: string | null;
    unitPriceMinor?: bigint | null;
    taxRateBps?: number | null;
    totalMinor: bigint;
  }>;
};

export type UpdateExpenseInput = {
  tenantId: string;
  expenseId: string;
  title?: string;
  description?: string | null;
  amountMinor?: bigint;
  taxMinor?: bigint;
  occurredAt?: Date;
  merchantName?: string | null;
  paymentMethodName?: string | null;
  reimbursable?: boolean;
  businessExpense?: boolean;
  projectCode?: string | null;
  costCenter?: string | null;
  actorUserId: string;
};

export type ExpenseRepository = {
  create(input: CreateExpenseInput): Promise<{ expense: StoredExpense; lineItems: StoredExpenseLineItem[] }>;
  list(input: { tenantId: string; workspaceId?: string }): Promise<StoredExpense[]>;
  listPage(input: ExpenseListPageInput): Promise<ExpenseListPage>;
  createImportBatch(input: {
    tenantId: string;
    workspaceId: string;
    source: string;
    status: "SUCCEEDED" | "FAILED";
    stats: unknown;
    createdById: string;
  }): Promise<StoredImportBatch>;
  listImportBatches(input: { tenantId: string; workspaceId: string }): Promise<StoredImportBatch[]>;
  findById(input: { tenantId: string; expenseId: string }): Promise<StoredExpense | null>;
  update(input: UpdateExpenseInput): Promise<StoredExpense | null>;
  listAttachments(input: { tenantId: string; expenseId: string }): Promise<StoredExpenseAttachment[]>;
  attachDocument(input: {
    tenantId: string;
    expenseId: string;
    documentFileId: string;
    actorUserId: string;
    label?: string | null;
    note?: string | null;
    primary?: boolean;
  }): Promise<{ expense: StoredExpense; attachment: StoredExpenseAttachment } | null>;
  detachDocument(input: {
    tenantId: string;
    expenseId: string;
    documentFileId: string;
    actorUserId: string;
  }): Promise<{ expense: StoredExpense; attachment: StoredExpenseAttachment } | null>;
  archive(input: { tenantId: string; expenseId: string; actorUserId: string; reason?: string | null }): Promise<StoredExpense | null>;
  createReimbursementClaim(input: {
    tenantId: string;
    workspaceId: string;
    claimantId: string;
    expenseIds: string[];
    actorUserId: string;
  }): Promise<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[]; expenses: StoredExpense[] } | null>;
  listReimbursementClaims(input: {
    tenantId: string;
    workspaceId: string;
  }): Promise<Array<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[] }>>;
  findReimbursementClaimById(input: {
    tenantId: string;
    claimId: string;
  }): Promise<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[] } | null>;
  transitionReimbursementClaim(input: {
    tenantId: string;
    claimId: string;
    status: "APPROVED" | "REJECTED" | "REIMBURSED";
    actorUserId: string;
    reason?: string | null;
  }): Promise<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[]; expenses: StoredExpense[] } | null>;
  createExpensePolicy(input: {
    tenantId: string;
    workspaceId: string;
    name: string;
    ruleType: string;
    config: unknown;
    severity: "warning" | "block";
    actorUserId: string;
  }): Promise<StoredExpensePolicy>;
  listExpensePolicies(input: { tenantId: string; workspaceId: string; includeInactive?: boolean }): Promise<StoredExpensePolicy[]>;
  archiveExpensePolicy(input: { tenantId: string; policyId: string; actorUserId: string }): Promise<StoredExpensePolicy | null>;
  listComments(input: { tenantId: string; expenseId: string }): Promise<StoredExpenseComment[]>;
  addComment(input: { tenantId: string; expenseId: string; actorUserId: string; body: string }): Promise<StoredExpenseComment | null>;
  listSubscriptions(input: { tenantId: string; workspaceId: string }): Promise<StoredSubscription[]>;
  upsertSubscription(input: {
    tenantId: string;
    workspaceId: string;
    merchantId?: string | null;
    name: string;
    amountMinor: bigint;
    currency: string;
    cadence: string;
    nextDueAt: Date;
    detectedFromExpenseId: string;
    actorUserId: string;
  }): Promise<StoredSubscription>;
  listRecurring(input: { tenantId: string; workspaceId: string }): Promise<StoredRecurringExpense[]>;
  createRecurringFromExpense(input: {
    tenantId: string;
    expenseId: string;
    actorUserId: string;
    cadence: "weekly" | "monthly";
    nextDueAt: Date;
  }): Promise<StoredRecurringExpense | null>;
  findRecurringById(input: { tenantId: string; recurringExpenseId: string }): Promise<StoredRecurringExpense | null>;
  advanceRecurring(input: {
    tenantId: string;
    recurringExpenseId: string;
    actorUserId: string;
    generatedExpenseId: string;
    nextDueAt: Date;
  }): Promise<StoredRecurringExpense | null>;
  saveCategoryPrediction(input: {
    tenantId: string;
    expenseId: string;
    documentFileId?: string | null;
    categoryKey: ExpenseCategoryKey;
    confidence: number;
    prediction: CategoryPrediction;
    anomalies: ExpenseAnomaly[];
    model: { name: string; version: string; externalServicesUsed: boolean };
    actorUserId: string;
  }): Promise<StoredMLCategoryPrediction>;
  transitionStatus(input: {
    tenantId: string;
    expenseId: string;
    status: "APPROVED" | "REJECTED";
    actorUserId: string;
    reason?: string | null;
    policyEvaluation?: ExpensePolicyEvaluation | null;
  }): Promise<{ expense: StoredExpense; approvalWorkflow: StoredApprovalWorkflow } | null>;
  listApprovalSla(input: { tenantId: string; workspaceId: string; now?: Date }): Promise<ApprovalSlaItem[]>;
};
