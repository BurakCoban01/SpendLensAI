import { readQueryLocale, readStoredLocale, resolveBrowserLocale, type Locale } from "./locale";
import { clearSession, readSession, saveSession, shouldRefreshSession } from "./session";

export type AuthResponse = {
  tenant: { id: string; name: string; slug: string };
  user: { id: string; email: string; displayName: string };
  roles: string[];
  permissions: string[];
  tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number };
}

export type PrincipalResponse = {
  principal: {
    tenantId: string;
    userId: string;
    sessionId: string;
    email: string;
    displayName: string;
    roles: string[];
    permissions: string[];
  };
};

export type ApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type AiProviderStatus = {
  provider: "disabled" | "gemini" | "zai";
  enabled: boolean;
  configured: boolean;
  model: string | null;
  rawInputStorage: boolean;
  capabilityWarnings: string[];
};

export type WebhookEndpointSummary = {
  id: string;
  tenantId: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AuthSessionSummary = {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  userAgent: string | null;
};

export type WorkspaceSummary = {
  id: string;
  tenantId: string;
  name: string;
  kind: string;
};

export type DocumentSummary = {
  id: string;
  tenantId?: string;
  workspaceId: string;
  kind: "RECEIPT" | "INVOICE" | "OTHER";
  originalName: string;
  safeName: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  createdAt: string;
  deletedAt?: string | null;
};

export type DocumentUploadWarning = {
  code: "EXTENSION_CONTENT_MISMATCH";
  originalExtension: string;
  detectedMimeType: string;
  message: string;
};

export type UploadSessionSummary = {
  id: string;
  workspaceId: string;
  kind: "RECEIPT" | "INVOICE" | "OTHER";
  originalName: string;
  safeName: string;
  clientMimeType: string;
  totalSizeBytes: string;
  chunkSizeBytes: number;
  totalChunks: number;
  status: "INITIATED" | "UPLOADING" | "PAUSED" | "COMPLETING" | "COMPLETED" | "CANCELED" | "EXPIRED" | "FAILED";
  finalSha256: string | null;
  documentFileId: string | null;
  failureReason: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
};

export type UploadChunkSummary = {
  chunkIndex: number;
  sizeBytes: number;
  clientCrc32: string;
  serverCrc32: string;
  status: "UPLOADED" | "FAILED";
  retryCount: number;
  uploadedAt: string | null;
};

export type UploadSessionStatusResponse = {
  upload: UploadSessionSummary;
  uploadedChunks: number[];
  missingChunks: number[];
  chunks: UploadChunkSummary[];
};

export type UploadChunkResponse = {
  chunk: UploadChunkSummary;
  uploadedChunks: number[];
  missingChunks: number[];
  duplicate: boolean;
};

export type UploadCompleteResponse = {
  document: DocumentSummary;
  duplicate: boolean;
  warnings?: DocumentUploadWarning[];
  upload: UploadSessionStatusResponse;
};

export type DocumentDownloadUrlResponse = {
  url: string;
  expiresInSeconds: number;
};

export type DocumentPageSummary = {
  id: string;
  tenantId: string;
  documentFileId: string;
  pageNumber: number;
  width: number | null;
  height: number | null;
  processedBucket: string | null;
  processedKey: string | null;
  processedImageUrl: string | null;
  preprocessingProfile: string | null;
  qualityScore: string | null;
  createdAt: string;
};

export type OcrEngineCode = "TESSERACT" | "CUSTOM_CRNN" | "ENSEMBLE";

export type OcrComparisonResultSummary = {
  selectedText: string;
  selectedEngine: "TESSERACT" | "CUSTOM_CRNN" | "NONE";
  averageConfidence: number;
  averageLatencyMs: number | null;
  failureRate: number;
  fieldDecisions: Array<{
    field: string;
    value: string | null;
    sourceEngine: "TESSERACT" | "CUSTOM_CRNN" | "NONE";
    confidence: number;
    status: "missing" | "single_source" | "exact_match" | "conflict";
    candidates: Array<{
      engine: "TESSERACT" | "CUSTOM_CRNN";
      value: string;
      confidence: number;
      validationPenalty: number;
    }>;
  }>;
  conflictFields: string[];
  pairwiseTextSimilarity: number | null;
  characterErrorRate: number | null;
  wordErrorRate: number | null;
};

export type OcrJobSummary = {
  id: string;
  tenantId: string;
  documentFileId: string;
  status: WorkerJobStatus;
  requestedEngines: string[];
  progress: number;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type OcrEngineRunSummary = {
  id: string;
  tenantId: string;
  ocrJobId: string;
  engine: OcrEngineCode;
  status: WorkerJobStatus;
  normalizedJson: unknown;
  confidence: string | null;
  latencyMs: number | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type PersistedOcrComparisonSummary = {
  job: OcrJobSummary;
  runs: OcrEngineRunSummary[];
  comparison: OcrComparisonResultSummary;
};

export type OcrJobsResponse = {
  jobs: Array<{ job: OcrJobSummary; runs: OcrEngineRunSummary[] }>;
};

export type ExpenseSummary = {
  id: string;
  tenantId: string;
  workspaceId: string;
  merchantId: string | null;
  merchantName: string | null;
  categoryId: string | null;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  documentId: string | null;
  status: "DRAFT" | "EXTRACTED" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED" | "REIMBURSED" | "ARCHIVED";
  title: string;
  description: string | null;
  currency: "TRY" | "USD" | "EUR" | "GBP";
  amountMinor: string;
  taxMinor?: string;
  occurredAt: string;
  reimbursable: boolean;
  businessExpense: boolean;
  projectCode: string | null;
  costCenter: string | null;
  duplicateGroup: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type ExpenseCommentSummary = {
  id: string;
  tenantId: string;
  expenseId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type ExpenseAttachmentSummary = {
  id: string;
  tenantId: string;
  expenseId: string;
  documentFileId: string;
  label: string | null;
  note: string | null;
  attachedById: string;
  attachedAt: string;
  detachedAt: string | null;
};

export type ImportBatchSummary = {
  id: string;
  tenantId: string;
  workspaceId: string;
  source: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  stats: unknown;
  createdById: string;
  createdAt: string;
  completedAt: string | null;
};

export type ReimbursementClaimSummary = {
  id: string;
  tenantId: string;
  workspaceId: string;
  claimantId: string;
  status: ExpenseSummary["status"];
  totalMinor: string;
  currency: "TRY" | "USD" | "EUR" | "GBP";
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  paidAt: string | null;
};

export type ReimbursementClaimItemSummary = {
  id: string;
  tenantId: string;
  claimId: string;
  expenseId: string;
  amountMinor: string;
  createdAt: string;
};

export type ExpensePolicySummary = {
  id: string;
  tenantId: string;
  workspaceId: string;
  name: string;
  ruleType:
    | "MAX_AMOUNT_BY_CATEGORY"
    | "RECEIPT_REQUIRED_ABOVE"
    | "RECEIPT_REQUIRED_ABOVE_AMOUNT"
    | "PROJECT_REQUIRED"
    | "ALLOWED_CATEGORIES"
    | "DUPLICATE_RECEIPT_REJECTION";
  config: Record<string, unknown>;
  severity: "warning" | "block";
  active: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
};

export type ExpensePolicyEvaluationSummary = {
  expenseId: string;
  checkedPolicyCount: number;
  violations: Array<{
    policyId: string;
    policyName: string;
    ruleType: ExpensePolicySummary["ruleType"];
    severity: "warning" | "block";
    code: string;
    message: string;
    evidence: Record<string, string | number | boolean | null>;
  }>;
};

export type SubscriptionSummary = {
  id: string;
  tenantId: string;
  workspaceId: string;
  merchantId: string | null;
  name: string;
  amountMinor: string;
  currency: "TRY" | "USD" | "EUR" | "GBP";
  cadence: string;
  detectedFromExpenseId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RecurringExpenseSummary = {
  id: string;
  tenantId: string;
  workspaceId: string;
  merchantId: string | null;
  merchantName: string | null;
  amountMinor: string;
  currency: "TRY" | "USD" | "EUR" | "GBP";
  cadence: string;
  nextDueAt: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalWorkflowSummary = {
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

export type ExpenseDecisionSummary = {
  expense: ExpenseSummary;
  approvalWorkflow: ApprovalWorkflowSummary;
};

export type ApprovalSlaSummary = {
  expense: ExpenseSummary;
  workflow: ApprovalWorkflowSummary;
  slaStatus: string;
  slaDueAt: string | null;
  slaBreachedAt: string | null;
  remainingMinutes: number | null;
  ageMinutes: number;
};

export type ExpenseAiAnalysis = {
  expenseId: string;
  prediction: {
    categoryKey: string;
    confidence: number;
    reasons: string[];
    matchedKeywords: string[];
  };
  anomalies: Array<{
    code: string;
    severity: "info" | "warning" | "critical";
    message: string;
    evidence: Record<string, string | number | boolean | null>;
  }>;
  persistedPrediction: {
    id: string;
    tenantId: string;
    expenseId: string | null;
    documentFileId: string | null;
    modelVersionId: string | null;
    categoryId: string;
    confidence: string;
    explanation: unknown;
    createdAt: string;
  } | null;
  model: {
    name: string;
    version: string;
    externalServicesUsed: boolean;
  };
  cacheHit: boolean;
};

export type BudgetSummary = {
  id: string;
  tenantId: string;
  workspaceId: string;
  categoryId: string | null;
  name: string;
  currency: "TRY" | "USD" | "EUR" | "GBP";
  amountMinor: string;
  alertPercent: number;
  createdAt: string;
  updatedAt: string;
};

export type BudgetPeriodSummary = {
  id: string;
  tenantId: string;
  budgetId: string;
  startsAt: string;
  endsAt: string;
  spentMinor: string;
  createdAt: string;
  updatedAt: string;
};

export type BudgetUsageSummary = {
  budget: BudgetSummary;
  period: BudgetPeriodSummary;
  utilizationPercent: number;
  alertTriggered: boolean;
  remainingMinor: string;
};

export type MonthlySpendAnalytics = {
  workspaceId: string;
  month: string;
  currency: "TRY" | "USD" | "EUR" | "GBP";
  totalMinor: string;
  businessMinor: string;
  reimbursableMinor: string;
  expenseCount: number;
  budgetUsage: BudgetUsageSummary[];
};

export type FinanceInsightAnalytics = {
  workspaceId: string;
  month: string;
  currency: "TRY" | "USD" | "EUR" | "GBP";
  generatedAt: string;
  weeklySpend: Array<{
    weekStart: string;
    weekEnd: string;
    totalMinor: string;
    expenseCount: number;
  }>;
  categoryBreakdown: Array<{
    categoryId: string;
    totalMinor: string;
    expenseCount: number;
    sharePercent: number;
  }>;
  merchantBreakdown: Array<{
    merchant: string;
    totalMinor: string;
    expenseCount: number;
  }>;
  paymentMethodBreakdown: Array<{
    paymentMethod: string;
    totalMinor: string;
    expenseCount: number;
  }>;
  cashflow: {
    incomeMinor: string;
    spendMinor: string;
    netMinor: string;
    businessMinor: string;
    reimbursableMinor: string;
  };
  trend: {
    currentMonthMinor: string;
    previousMonthMinor: string;
    deltaMinor: string;
    deltaPercent: number | null;
  };
  forecast: {
    observedDayCount: number;
    monthDayCount: number;
    dailyAverageMinor: string;
    projectedMonthEndMinor: string;
    projectedDeltaFromPreviousMinor: string;
    projectedBudgetUtilizationPercent: number | null;
    largestBudgetRisk: {
      budgetId: string;
      name: string;
      projectedUtilizationPercent: number;
      projectedOverspendMinor: string;
    } | null;
  };
  budgetAlerts: Array<{
    budgetId: string;
    name: string;
    severity: "ok" | "warning" | "over";
    utilizationPercent: number;
    remainingMinor: string;
  }>;
  anomalySummary: Array<{
    code: string;
    severity: "info" | "warning" | "critical";
    count: number;
    evidence: Record<string, string | number | boolean | null>;
  }>;
  recommendations: Array<{
    code: "PROJECTED_OVER_BUDGET" | "HIGH_RUN_RATE" | "REIMBURSABLE_FOLLOW_UP" | "NO_BUDGET";
    severity: "info" | "warning" | "critical";
    message: string;
    evidence: Record<string, string | number | boolean | null>;
  }>;
};

export type ReportExportType =
  | "expense_ledger_csv"
  | "category_breakdown_csv"
  | "merchant_spend_csv"
  | "monthly_expense_report_pdf"
  | "approval_evidence_csv"
  | "reimbursement_batch_csv"
  | "reimbursement_claim_report_pdf"
  | "ocr_quality_report_csv"
  | "model_evaluation_report_csv"
  | "audit_pack_csv"
  | "dataset_export_jsonl";

export type ExportJobSummary = {
  id: string;
  tenantId: string;
  workspaceId: string;
  type: ReportExportType;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  bucket: string | null;
  objectKey: string | null;
  createdById: string;
  createdAt: string;
  completedAt: string | null;
  failureReason: string | null;
};

export type GeneratedReportSummary = {
  exportJob: ExportJobSummary;
  filename: string;
  contentType: "text/csv" | "application/pdf" | "application/x-ndjson";
  sizeBytes: number;
  sha256: string;
  signedUrl: string;
};

export type DocumentDownloadUrlSummary = {
  url: string;
  expiresInSeconds: number;
};

export type ExtractedMoneySummary = {
  amountMinor: string;
  currency: "TRY" | "USD" | "EUR" | "GBP";
};

export type PersistedExtractionSummary = {
  job: {
    id: string;
    tenantId: string;
    documentFileId: string;
    ocrJobId: string | null;
    status: WorkerJobStatus;
    confidence: string | null;
    failureReason: string | null;
    createdAt: string;
    completedAt: string | null;
  };
  fields: Array<{
    fieldName: string;
    value: string;
    valueType: string;
    confidence: string | null;
    sourceEngine: OcrEngineCode | null;
  }>;
  issues: Array<{
    code: string;
    severity: "info" | "warning" | "critical";
    message: string;
  }>;
  extracted: {
    normalizedText: string;
    normalizationCorrections: string[];
    documentType:
      | "retail_receipt"
      | "invoice"
      | "e_archive_invoice"
      | "bank_transfer_receipt"
      | "payment_proof"
      | "card_slip"
      | "unknown_document";
    documentTypeConfidence: number;
    merchantName: string | null;
    date: string | null;
    time: string | null;
    currency: "TRY" | "USD" | "EUR" | "GBP";
    subtotal: ExtractedMoneySummary | null;
    discount: ExtractedMoneySummary | null;
    taxTotal: ExtractedMoneySummary | null;
    total: ExtractedMoneySummary | null;
    paymentMethod: string | null;
    cardLast4: string | null;
    receiptNumber: string | null;
    lineItems: Array<{
      name: string;
      quantity: string | null;
      unitPrice: ExtractedMoneySummary | null;
      total: ExtractedMoneySummary;
      confidence: number;
    }>;
    fieldEvidence: Array<{
      fieldName: string;
      confidence: number;
      source: "normalized_ocr_text" | "heuristic" | "review";
      rawEvidence: string | null;
      normalizedEvidence: string | null;
    }>;
    confidence: number;
    validationIssues: Array<{
      code: string;
      severity: "info" | "warning" | "critical";
      message: string;
    }>;
  };
  reviewState: {
    status: "NEEDS_REVIEW" | "APPROVED" | "REJECTED";
    reviewedById: string;
    reviewedAt: string;
    reasonPresent: boolean;
    correctedFields: string[];
  } | null;
};

export type AdminHealthResponse = {
  status: "ok" | "degraded";
  checkedAt: string;
  checks: Record<
    string,
    {
      status: "ok" | "degraded" | "unknown";
      detail?: string;
    }
  >;
  operations: {
    tenantUsage: {
      workspaceCount: number;
      documentCount: number;
      activeExpenseCount: number;
      archivedExpenseCount: number;
      totalExpenseMinorByCurrency: Record<string, string>;
    };
    storageUsage: {
      backend: string;
      connected: boolean;
      documentBytes: string;
      storedObjectCount: number | null;
      operationErrorCount: number;
      quota: {
        softLimitBytes: string;
        usedBytes: string;
        remainingBytes: string;
        utilizationPercent: number;
        status: "ok" | "warning" | "exceeded";
      };
    };
    rateLimit: {
      max: number;
      timeWindow: string;
      scope: string;
    };
    featureFlags: Array<{
      key: string;
      enabled: boolean;
      detail: string;
    }>;
    runbooks: Array<{
      label: string;
      path: string;
      detail: string;
    }>;
  } | null;
};

export type AdminDocumentReprocessResponse = {
  reprocess: {
    documentFileId: string;
    workspaceId: string;
    requestedStages: Array<"preprocess" | "tesseract" | "custom_crnn">;
    enqueued: Array<{
      stage: "preprocess" | "tesseract" | "custom_crnn";
      job: WorkerJobSummary;
      deduped: boolean;
      retried?: boolean;
    }>;
  };
};

export type EventCatalogEntry = {
  producer: string;
  aggregate: string;
  description: string;
  durable: boolean;
  dlqTopic: string;
};

export type OutboxEventSummary = {
  id: string;
  tenantId: string;
  topic: string;
  aggregateId: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  correlationId: string;
  createdAt: string;
  publishedAt: string | null;
  failureReason: string | null;
};

export type AdminEventsResponse = {
  backlog: {
    pending: number;
    published: number;
    failed: number;
  };
  events: OutboxEventSummary[];
};

export type EventDrainResponse = {
  attempted: number;
  published: number;
  failed: number;
  dlqPublished: number;
  events: Array<{
    id: string;
    topic: string;
    state: "pending" | "published" | "failed";
    failureReason: string | null;
    dlqTopic: string | null;
  }>;
};

export type InboxEventSummary = {
  id: string;
  tenantId: string;
  consumerName: string;
  eventId: string;
  topic: string;
  aggregateId: string;
  schemaVersion: number;
  correlationId: string;
  payload: Record<string, unknown>;
  status: "processed" | "failed";
  failureReason: string | null;
  receivedAt: string;
  processedAt: string | null;
};

export type AdminEventInboxResponse = {
  events: InboxEventSummary[];
};

export type AdminEventDlqResponse = {
  events: OutboxEventSummary[];
};

export type EventDlqReplayResponse = {
  dryRun: boolean;
  policy: {
    topic: string | null;
    reasonContains: string | null;
    limit: number;
  };
  scanned: number;
  replayed: number;
  skipped: number;
  events: Array<{
    id: string;
    topic: string;
    aggregateId: string;
    action: "would_requeue" | "requeued" | "skipped";
    failureReason: string | null;
    skipReason: string | null;
  }>;
};

export type WorkerJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";

export type WorkerJobSummary = {
  id: string;
  tenantId: string;
  queue: string;
  jobType: string;
  dedupeKey: string | null;
  status: WorkerJobStatus;
  progress: number;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  failureReason: string | null;
  lockedBy: string | null;
  createdById: string | null;
  correlationId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type AdminJobsResponse = {
  backlog: Record<WorkerJobStatus, number>;
  jobs: WorkerJobSummary[];
};

export type WorkerRunNextResponse = {
  processed: boolean;
  job: WorkerJobSummary | null;
};

export type DocumentOcrPipelineRunResponse = {
  processed: boolean;
  documentFileId: string;
  jobsProcessed: WorkerJobSummary[];
  latestStage: "none" | "preprocessing" | "ocr" | "extraction";
  latestStatus: WorkerJobStatus | "IDLE";
  rawOcrAvailable: boolean;
  extractionAvailable: boolean;
  canProceed: boolean;
  failureReason: string | null;
  skippedReason?: string;
};

export type WorkerRuntimeStatus = "RUNNING" | "IDLE" | "STOPPED" | "ERROR";

export type WorkerHeartbeatSummary = {
  workerId: string;
  tenantId: string;
  queue: string | null;
  status: WorkerRuntimeStatus;
  intervalMs: number;
  maxJobsPerTick: number;
  processedJobs: number;
  emptyPolls: number;
  lastJobId: string | null;
  lastError: string | null;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
};

export type WorkerRuntimeResponse = {
  active: number;
  workers: WorkerHeartbeatSummary[];
};

export type WorkerRuntimeMutationResponse = {
  worker: WorkerHeartbeatSummary;
};

export type CacheKeySummary = {
  key: string;
  ttlSeconds: number | null;
};

export type AdminCacheResponse = {
  health: {
    backend: "memory" | "redis";
    connected: boolean;
    detail?: string;
  };
  keys: CacheKeySummary[];
};

export type AuditLogSummary = {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  ipHash: string | null;
  userAgent: string | null;
  correlationId: string | null;
  createdAt: string;
};

export type AdminAuditResponse = {
  summary: {
    total: number;
    actions: Array<{ action: string; count: number }>;
    resources: Array<{ resourceType: string; count: number }>;
  };
  logs: AuditLogSummary[];
};

export type AdminAuditExportResponse = {
  generatedAt: string;
  filename: string;
  format: "jsonl";
  count: number;
  content: string;
};

export type AdminAuditRetentionResponse = {
  dryRun: boolean;
  retentionDays: number;
  cutoff: string;
  matched: number;
  deleted: number;
  sample: AuditLogSummary[];
};

export type ModelStatus = "CANDIDATE" | "ACTIVE" | "ARCHIVED" | "FAILED";

export type ModelVersionSummary = {
  id: string;
  tenantId: string;
  name: string;
  engine: "TESSERACT" | "CUSTOM_CRNN" | "ENSEMBLE" | "CATEGORY_ML";
  status: ModelStatus;
  artifactBucket: string | null;
  artifactKey: string | null;
  metrics: Record<string, unknown> | null;
  promotedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ModelTrainingRunSummary = {
  id: string;
  tenantId: string;
  modelVersionId: string | null;
  datasetId: string | null;
  status: WorkerJobStatus;
  profile: string;
  seed: number;
  metrics: Record<string, unknown> | null;
  logsKey: string | null;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type ModelEvaluationRunSummary = {
  id: string;
  tenantId: string;
  modelVersionId: string | null;
  datasetId: string | null;
  status: WorkerJobStatus;
  metrics: Record<string, unknown> | null;
  reportKey: string | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ModelsOverviewResponse = {
  models: ModelVersionSummary[];
  trainingRuns: ModelTrainingRunSummary[];
  evaluationRuns: ModelEvaluationRunSummary[];
};

export type OcrCapabilitiesResponse = {
  tesseract: { configured: boolean };
  customOcr: {
    configured: boolean;
    available: boolean;
    activeModel: Pick<ModelVersionSummary, "id" | "name" | "status" | "metrics" | "promotedAt" | "updatedAt"> | null;
  };
};

export type ModelTrainResultSummary = {
  modelVersion: ModelVersionSummary;
  trainingRun: ModelTrainingRunSummary;
  evaluationRun: ModelEvaluationRunSummary;
};

export type ModelBenchmarkResultSummary = {
  modelVersion: ModelVersionSummary;
  evaluationRun: ModelEvaluationRunSummary;
  benchmark: {
    metrics: Record<string, unknown>;
    artifactBucket: string;
    artifactKey: string;
    reportKey: string;
  };
};

export type ModelRollbackResultSummary = {
  modelVersion: ModelVersionSummary;
  rolledBackFromModelVersionId: string;
};

export type ReviewTaskSummary = {
  id: string;
  tenantId: string;
  documentFileId: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  assignedToId: string | null;
  reasonCodes: string[];
  dueAt: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ReviewTaskWithDocument = {
  task: ReviewTaskSummary;
  document: DocumentSummary;
};

export type ReviewAssigneeSummary = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
};

export type ReviewWorkloadResponse = {
  generatedAt: string;
  workspaceId: string | null;
  reviewers: Array<{
    reviewer: ReviewAssigneeSummary;
    queued: number;
    running: number;
    completed: number;
    rejected: number;
    overdue: number;
    dueSoon: number;
    oldestQueuedAgeMinutes: number | null;
    workloadScore: number;
  }>;
  unassigned: {
    queued: number;
    running: number;
    overdue: number;
    dueSoon: number;
    oldestQueuedAgeMinutes: number | null;
    workloadScore: number;
  };
  totals: {
    reviewers: number;
    queued: number;
    running: number;
    overdue: number;
    dueSoon: number;
  };
};

export type ReviewRebalanceSuggestionsResponse = {
  generatedAt: string;
  workspaceId: string | null;
  suggestions: Array<{
    action: "ASSIGN" | "REASSIGN";
    reasonCode: "SLA_OVERDUE_UNASSIGNED" | "SLA_DUE_SOON_UNASSIGNED" | "OVERLOADED_REVIEWER";
    priority: number;
    task: ReviewTaskSummary;
    document: DocumentSummary;
    currentAssigneeId: string | null;
    targetReviewer: ReviewAssigneeSummary;
    targetWorkloadScore: number;
    currentAssigneeWorkloadScore: number | null;
    ageMinutes: number;
    dueInMinutes: number | null;
    overdueMinutes: number | null;
  }>;
};

export type ReviewEscalationsRunResponse = {
  generatedAt: string;
  workspaceId: string | null;
  dryRun: boolean;
  planned: Array<{
    action: "ASSIGN" | "REASSIGN";
    reasonCode: ReviewRebalanceSuggestionsResponse["suggestions"][number]["reasonCode"];
    task: ReviewTaskSummary;
    document: DocumentSummary;
    currentAssigneeId: string | null;
    targetReviewer: ReviewAssigneeSummary;
    ageMinutes: number;
    dueInMinutes: number | null;
    overdueMinutes: number | null;
    escalationReasonCodes: string[];
  }>;
  applied: Array<{
    action: "ASSIGN" | "REASSIGN";
    reasonCode: ReviewRebalanceSuggestionsResponse["suggestions"][number]["reasonCode"];
    task: ReviewTaskSummary;
    document: DocumentSummary;
    currentAssigneeId: string | null;
    targetReviewer: ReviewAssigneeSummary;
    ageMinutes: number;
    dueInMinutes: number | null;
    overdueMinutes: number | null;
    escalationReasonCodes: string[];
  }>;
};

export type CorrectionSummary = {
  id: string;
  tenantId: string;
  documentFileId: string;
  fieldName: string | null;
  beforeValue: string | null;
  afterValue: string;
  correctedById: string;
  createdAt: string;
};

export type AnnotationSummary = {
  id: string;
  tenantId: string;
  documentFileId: string | null;
  label: string;
  payload: unknown;
  createdById: string;
  createdAt: string;
};

export type ActiveLearningSuggestionSummary = {
  id: string;
  tenantId: string;
  documentFileId: string;
  reasonCode: string;
  score: string;
  payload: unknown;
  createdAt: string;
  acceptedAt: string | null;
};

export type CorrectionResultSummary = {
  correction: CorrectionSummary;
  annotation: AnnotationSummary | null;
  suggestion: ActiveLearningSuggestionSummary;
};

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:18621";

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly issues: ApiErrorIssue[] = []
  ) {
    super(formatApiErrorMessage(code, issues, resolveErrorLocale()));
  }
}

let refreshInFlight: Promise<string | null> | null = null;

const safeTurkishErrorMessages: Record<string, string> = {
  MIME_SIGNATURE_MISMATCH:
    "Dosya içeriği güvenli şekilde tanınamadı. Lütfen dosyayı desteklenen bir görsel veya PDF formatında yeniden dışa aktarın.",
  UNSUPPORTED_MEDIA_TYPE: "Bu dosya türü şu anda OCR için desteklenmiyor. Desteklenen türler: JPG/JPEG, PNG, WebP, TIFF, BMP, GIF ve PDF.",
  EMPTY_FILE: "Dosya boş görünüyor. Lütfen okunabilir bir belge seçin.",
  FILE_TOO_LARGE: "Dosya boyutu sınırı aşıldı. En fazla 25 MB yükleyebilirsiniz.",
  FILE_REQUIRED: "Lütfen yüklemek için bir belge seçin.",
  DOCUMENT_NOT_FOUND: "Belge bulunamadı veya bu çalışma alanından erişilemiyor.",
  EXTRACTION_NOT_FOUND: "Bu belge için henüz kaydedilmiş bir extraction sonucu yok.",
  EXTRACTION_TOTAL_REQUIRED: "Gider oluşturmak için extraction sonucunda toplam tutar bulunmalı.",
  INVALID_TOKEN: "Oturum süresi doldu. Lütfen yeniden giriş yapın.",
  INVALID_REFRESH_TOKEN: "Oturum yenileme bilgisi geçersiz. Lütfen yeniden giriş yapın.",
  SESSION_REVOKED: "Oturum kapatılmış veya süresi dolmuş. Lütfen yeniden giriş yapın.",
  WORKER_RUNNER_NOT_CONFIGURED: "Worker çalıştırıcı yapılandırılmamış. Yerel worker/API servislerini başlatın.",
  PREPROCESSING_WORKER_NOT_CONFIGURED: "Ön işleme Worker servisi hazır değil. OCR servislerini çalıştırın.",
  OCR_TESSERACT_WORKER_NOT_CONFIGURED: "Tesseract Worker hazır değil. OCR servisi ve Worker sürecini başlatın.",
  OCR_CUSTOM_CRNN_WORKER_NOT_CONFIGURED: "Custom OCR Worker hazır değil. OCR servisi ve Worker sürecini başlatın.",
  CUSTOM_OCR_ACTIVE_MODEL_NOT_FOUND:
    "Custom OCR modeli hazır değil. Yerelde `pnpm custom-ocr:bootstrap` komutunu çalıştırıp aktif modeli kaydedin.",
  CUSTOM_OCR_MODEL_ARTIFACT_UNAVAILABLE:
    "Custom OCR model dosyası bulunamadı. `pnpm custom-ocr:bootstrap` ile artifact yolunu doğrulayıp modeli yeniden aktif edin.",
  CUSTOM_OCR_MODEL_REGISTRY_NOT_CONFIGURED: "Custom OCR model kayıt defteri yapılandırılmamış.",
  OCR_SERVICE_UNAVAILABLE: "OCR servisi hazır değil. OCR kullanmak için `pnpm dev:ocr` komutuyla yerel OCR servisini başlatın, ardından `pnpm dev` sürecini yenileyin.",
  NETWORK_ERROR: "API sunucusuna bağlanılamadı. Yerel backend/worker servislerinin çalıştığını ve `NEXT_PUBLIC_API_BASE_URL` ayarını kontrol edin."
};

type ApiErrorIssue = {
  path?: Array<string | number>;
  message?: string;
};

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = await prepareHeaders(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  let response = await performFetch(path, init, headers);
  if (response.status === 401 && headers.has("authorization") && path !== "/auth/refresh") {
    const refreshedAccessToken = await refreshStoredSession(true);
    if (refreshedAccessToken) {
      headers.set("authorization", `Bearer ${refreshedAccessToken}`);
      response = await performFetch(path, init, headers);
    }
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: { code: "REQUEST_FAILED" } }))) as {
      error?: { code?: string; issues?: ApiErrorIssue[] };
    };
    if (response.status === 401) clearSession();
    throw new ApiRequestError(error.error?.code ?? `HTTP_${response.status}`, response.status, error.error?.issues ?? []);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function prepareHeaders(headersInit: HeadersInit | undefined): Promise<Headers> {
  const headers = new Headers(headersInit);
  if (!headers.has("authorization")) return headers;
  const accessToken = await refreshStoredSession(false);
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}

async function performFetch(path: string, init: RequestInit, headers: Headers): Promise<Response> {
  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers
    });
  } catch {
    throw new ApiRequestError("NETWORK_ERROR", 0);
  }
}

async function refreshStoredSession(force: boolean): Promise<string | null> {
  const session = readSession();
  if (!session?.tokens.refreshToken) return null;
  if (!force && !shouldRefreshSession(session)) return session.tokens.accessToken;
  refreshInFlight ??= fetch(`${API_BASE_URL}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: session.tokens.refreshToken })
  })
    .then(async (response) => {
      if (!response.ok) {
        clearSession();
        return null;
      }
      const refreshed = (await response.json()) as { tokens: AuthResponse["tokens"] };
      const latest = readSession();
      if (!latest) return null;
      const nextSession: AuthResponse = { ...latest, tokens: refreshed.tokens };
      saveSession(nextSession);
      return refreshed.tokens.accessToken;
    })
    .catch(() => {
      clearSession();
      return null;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

function resolveErrorLocale(): Locale {
  return readQueryLocale() ?? readStoredLocale() ?? resolveBrowserLocale();
}

function formatApiErrorMessage(code: string, issues: ApiErrorIssue[], locale: Locale): string {
  if (code === "VALIDATION_ERROR" && issues.length > 0) {
    return issues
      .map((issue) => {
        const field = issue.path?.join(".") || "form";
        return `${field}: ${issue.message ?? "Invalid value"}`;
      })
      .join("; ");
  }
  if (code === "DATABASE_NOT_READY") {
    return "Yerel veritabanı hazır değil. `pnpm dev:up` çalıştırın, ardından migration/seed adımlarını tamamlayın veya `pnpm dev` sürecini yeniden başlatın.";
  }
  const mapped = uiErrorMessages[locale][code as keyof (typeof uiErrorMessages)["tr"]];
  if (mapped) return mapped;
  if (locale === "tr" && safeTurkishErrorMessages[code]) return `${safeTurkishErrorMessages[code]} (${code})`;
  return code;
}

const uiErrorMessages = {
  tr: {
    NETWORK_ERROR:
      "API sunucusuna bağlanılamadı. Yerel backend/worker servislerinin çalıştığını ve `NEXT_PUBLIC_API_BASE_URL` ayarını kontrol edin.",
    REQUEST_FAILED: "İstek başarısız oldu. API yanıtını ve ağ bağlantısını kontrol edin.",
    SESSION_FAILED: "Oturum bilgisi alınamadı. Sayfayı yenileyin veya yeniden giriş yapın.",
    UPLOAD_FAILED: "Yükleme başarısız oldu. Dosya biçimini, boyutunu ve ağ bağlantısını kontrol edin.",
    MIME_SIGNATURE_MISMATCH:
      "Dosya içeriği güvenli şekilde tanınamadı. Lütfen dosyayı desteklenen bir görsel veya PDF formatında yeniden dışa aktarın.",
    UNSUPPORTED_MEDIA_TYPE: "Bu dosya türü şu anda OCR için desteklenmiyor. Desteklenen türler: JPG/JPEG, PNG, WebP, TIFF, BMP, GIF ve PDF.",
    EMPTY_FILE: "Dosya boş görünüyor. Lütfen okunabilir bir belge seçin.",
    FILE_TOO_LARGE: "Dosya boyutu sınırı aşıldı. En fazla 25 MB yükleyebilirsiniz.",
    FILE_REQUIRED: "Lütfen yüklemek için bir belge seçin.",
    DOCUMENT_NOT_FOUND: "Belge bulunamadı veya bu çalışma alanından erişilemiyor.",
    EXTRACTION_NOT_FOUND: "Bu belge için henüz kaydedilmiş bir extraction sonucu yok.",
    EXTRACTION_TOTAL_REQUIRED: "Gider oluşturmak için extraction sonucunda toplam tutar bulunmalı.",
    INVALID_TOKEN: "Oturum süresi doldu. Lütfen yeniden giriş yapın.",
    INVALID_REFRESH_TOKEN: "Oturum yenileme bilgisi geçersiz. Lütfen yeniden giriş yapın.",
    SESSION_REVOKED: "Oturum kapatılmış veya süresi dolmuş. Lütfen yeniden giriş yapın.",
    WORKER_RUNNER_NOT_CONFIGURED: "Worker çalıştırıcı yapılandırılmamış. Yerel worker/API servislerini başlatın.",
    PREPROCESSING_WORKER_NOT_CONFIGURED: "Ön işleme Worker servisi hazır değil. OCR servislerini çalıştırın.",
    OCR_TESSERACT_WORKER_NOT_CONFIGURED: "Tesseract Worker hazır değil. OCR servisi ve Worker sürecini başlatın.",
    OCR_CUSTOM_CRNN_WORKER_NOT_CONFIGURED: "Custom OCR Worker hazır değil. OCR servisi ve Worker sürecini başlatın.",
    CUSTOM_OCR_ACTIVE_MODEL_NOT_FOUND:
      "Custom OCR modeli hazır değil. Yerelde `pnpm custom-ocr:bootstrap` komutunu çalıştırıp aktif modeli kaydedin.",
    CUSTOM_OCR_MODEL_ARTIFACT_UNAVAILABLE:
      "Custom OCR model dosyası bulunamadı. `pnpm custom-ocr:bootstrap` ile artifact yolunu doğrulayıp modeli yeniden aktif edin.",
    CUSTOM_OCR_MODEL_REGISTRY_NOT_CONFIGURED: "Custom OCR model kayıt defteri yapılandırılmamış.",
    OCR_SERVICE_UNAVAILABLE:
      "OCR servisi hazır değil. OCR kullanmak için `pnpm dev:ocr` komutuyla yerel OCR servisini başlatın, ardından `pnpm dev` sürecini yenileyin.",
    DATABASE_NOT_READY:
      "Yerel veritabanı hazır değil. `pnpm dev:up` çalıştırın, ardından migration/seed adımlarını tamamlayın veya `pnpm dev` sürecini yeniden başlatın.",
    SETTINGS_LOAD_FAILED: "Ayarlar yüklenemedi. Oturum ve API bağlantısını kontrol edin.",
    CACHE_LOAD_FAILED: "Önbellek durumu yüklenemedi. Redis ve API bağlantısını kontrol edin.",
    AUDIT_LOAD_FAILED: "Audit logları yüklenemedi. API ve yetki durumunu kontrol edin.",
    HEALTH_LOAD_FAILED: "Sağlık durumu yüklenemedi. API ve servis erişimini kontrol edin.",
    EVENTS_LOAD_FAILED: "Olay durumu yüklenemedi. Kafka ve API bağlantısını kontrol edin.",
    JOBS_LOAD_FAILED: "Worker işleri yüklenemedi. Worker ve API bağlantısını kontrol edin.",
    MODELS_LOAD_FAILED: "Model kayıt defteri yüklenemedi. API ve Python bağımlılıklarını kontrol edin.",
    OCR_COMPARISON_LOAD_FAILED: "OCR çalışma alanı yüklenemedi. API ve belge erişimini kontrol edin."
  },
  en: {
    NETWORK_ERROR:
      "Could not connect to the API server. Check the local backend/worker services and the `NEXT_PUBLIC_API_BASE_URL` setting.",
    REQUEST_FAILED: "The request failed. Check the API response and your network connection.",
    SESSION_FAILED: "Could not load the session. Refresh the page or sign in again.",
    UPLOAD_FAILED: "Upload failed. Check the file format, size and network connection.",
    MIME_SIGNATURE_MISMATCH:
      "The file contents could not be safely identified. Re-export the file as a supported image or PDF format.",
    UNSUPPORTED_MEDIA_TYPE: "This file type is not supported for OCR. Supported types: JPG/JPEG, PNG, WebP, TIFF, BMP, GIF and PDF.",
    EMPTY_FILE: "The file appears to be empty. Please choose a readable document.",
    FILE_TOO_LARGE: "The file size limit was exceeded. You can upload up to 25 MB.",
    FILE_REQUIRED: "Please choose a document to upload.",
    DOCUMENT_NOT_FOUND: "The document was not found or cannot be accessed from this workspace.",
    EXTRACTION_NOT_FOUND: "There is no saved extraction result for this document yet.",
    EXTRACTION_TOTAL_REQUIRED: "An extraction result must include a total amount before creating an expense.",
    INVALID_TOKEN: "The session has expired. Please sign in again.",
    INVALID_REFRESH_TOKEN: "The refresh token is invalid. Please sign in again.",
    SESSION_REVOKED: "The session has been revoked or expired. Please sign in again.",
    WORKER_RUNNER_NOT_CONFIGURED: "The worker runner is not configured. Start the local worker/API services.",
    PREPROCESSING_WORKER_NOT_CONFIGURED: "The preprocessing worker service is not ready. Start the OCR services.",
    OCR_TESSERACT_WORKER_NOT_CONFIGURED: "The Tesseract worker is not ready. Start the OCR service and worker process.",
    OCR_CUSTOM_CRNN_WORKER_NOT_CONFIGURED: "The Custom OCR worker is not ready. Start the OCR service and worker process.",
    CUSTOM_OCR_ACTIVE_MODEL_NOT_FOUND: "Custom OCR model is not ready. Run `pnpm custom-ocr:bootstrap` to register an active model.",
    CUSTOM_OCR_MODEL_ARTIFACT_UNAVAILABLE:
      "The Custom OCR model artifact is unavailable. Run `pnpm custom-ocr:bootstrap` to validate the artifact path.",
    CUSTOM_OCR_MODEL_REGISTRY_NOT_CONFIGURED: "The Custom OCR model registry is not configured.",
    OCR_SERVICE_UNAVAILABLE: "The OCR service is not ready. Start the local OCR service with `pnpm dev:ocr`, then restart `pnpm dev`.",
    DATABASE_NOT_READY:
      "The local database is not ready. Run `pnpm dev:up`, complete the migration/seed steps, or restart `pnpm dev`.",
    SETTINGS_LOAD_FAILED: "Settings could not be loaded. Check the session and API connection.",
    CACHE_LOAD_FAILED: "Cache state could not be loaded. Check Redis and the API connection.",
    AUDIT_LOAD_FAILED: "Audit logs could not be loaded. Check the API and permission state.",
    HEALTH_LOAD_FAILED: "Health status could not be loaded. Check the API and service access.",
    EVENTS_LOAD_FAILED: "Event status could not be loaded. Check Kafka and the API connection.",
    JOBS_LOAD_FAILED: "Worker jobs could not be loaded. Check the worker and API connection.",
    MODELS_LOAD_FAILED: "Model ledger could not be loaded. Check the API and Python dependencies.",
    OCR_COMPARISON_LOAD_FAILED: "OCR workspace could not be loaded. Check the API and document access."
  }
} as const;

export function formatUserFacingError(message: string, locale: "tr" | "en"): string {
  const trimmed = message.trim();
  if (/Failed to fetch|fetch failed|NetworkError/i.test(trimmed)) {
    return uiErrorMessages[locale].NETWORK_ERROR;
  }

  const codeMatch = trimmed.match(/\(([^()]+)\)\s*$/);
  const code = codeMatch?.[1] ?? trimmed;
  if (/^HTTP_\d+$/.test(code)) {
    return locale === "tr"
      ? "İstek başarısız oldu. API yanıt kodunu ve ağ bağlantısını kontrol edin."
      : "The request failed. Check the API response code and your network connection.";
  }
  if (trimmed.startsWith("OCR_SERVICE_UNAVAILABLE")) return uiErrorMessages[locale].OCR_SERVICE_UNAVAILABLE;
  const mapped = uiErrorMessages[locale][code as keyof (typeof uiErrorMessages)["tr"]];
  if (mapped) return mapped;
  return trimmed;
}

export function authHeaders(accessToken: string): HeadersInit {
  return { authorization: `Bearer ${accessToken}` };
}
