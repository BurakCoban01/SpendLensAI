import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { buildCsv, normalizeSafeFilename } from "@spendlens/shared";
import type { AuditLogEntry, AuditRepository } from "../audit/types";
import type { AuthPrincipal } from "../auth/types";
import type { DocumentRepository, DocumentStorage, StoredDocumentFile } from "../documents/types";
import type { EventService } from "../events/service";
import type {
  ApprovalSlaItem,
  ExpenseRepository,
  StoredExpense,
  StoredReimbursementClaim,
  StoredReimbursementClaimExpense
} from "../expenses/types";
import type { ModelRepository, StoredModelEvaluationRun, StoredModelTrainingRun, StoredModelVersion } from "../models/types";
import type { OcrComparisonRepository, StoredOcrEngineRun, StoredOcrJob } from "../ocr-comparison/types";
import type { ReviewRepository, StoredActiveLearningSuggestion, StoredAnnotation, StoredCorrection } from "../review/types";
import type { GeneratedReport, ReportExportType, ReportRepository } from "./types";

export class ReportError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class ReportService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly expenses: ExpenseRepository,
    private readonly reports: ReportRepository,
    private readonly storage: DocumentStorage,
    private readonly bucket: string,
    private readonly events?: EventService,
    private readonly ocrComparisons?: OcrComparisonRepository,
    private readonly models?: ModelRepository,
    private readonly auditLogs?: AuditRepository,
    private readonly reviews?: ReviewRepository
  ) {}

  async createExport(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    type: ReportExportType;
    month?: string;
    correlationId?: string | null;
  }): Promise<GeneratedReport> {
    await this.assertWorkspace(input.principal.tenantId, input.workspaceId);
    const expenses =
      input.type === "ocr_quality_report_csv" || input.type === "dataset_export_jsonl"
        ? []
        : await this.expensesForReport(
            input.principal.tenantId,
            input.workspaceId,
            input.type === "reimbursement_batch_csv" || input.type === "reimbursement_claim_report_pdf" ? undefined : input.month
          );
    const reimbursementClaims =
      input.type === "reimbursement_batch_csv" || input.type === "reimbursement_claim_report_pdf"
        ? await this.reimbursementClaimsForReport(input.principal.tenantId, input.workspaceId, input.month)
        : input.type === "approval_evidence_csv"
          ? await this.reimbursementClaimEvidenceForReport(input.principal.tenantId, input.workspaceId, input.month)
        : [];
    const approvalEvidenceEntries =
      input.type === "approval_evidence_csv"
        ? await this.approvalEvidenceEntriesForReport(input.principal.tenantId, input.workspaceId, input.month)
        : [];
    const ocrQualityEntries =
      input.type === "ocr_quality_report_csv"
        ? await this.ocrQualityEntriesForReport(input.principal.tenantId, input.workspaceId, input.month)
        : [];
    const modelEvaluationEntries =
      input.type === "model_evaluation_report_csv"
        ? await this.modelEvaluationEntriesForReport(input.principal.tenantId, input.month)
        : { versions: [], trainingRuns: [], evaluationRuns: [] };
    const auditPackEntries =
      input.type === "audit_pack_csv"
        ? await this.auditPackEntriesForReport(input.principal.tenantId, input.workspaceId, expenses, input.month)
        : [];
    const datasetEntries =
      input.type === "dataset_export_jsonl"
        ? await this.datasetEntriesForReport(input.principal.tenantId, input.workspaceId, input.month)
        : [];
    const rendered = await this.renderReport(
      input.type,
      expenses,
      reimbursementClaims,
      ocrQualityEntries,
      modelEvaluationEntries,
      auditPackEntries,
      approvalEvidenceEntries,
      datasetEntries,
      {
        workspaceId: input.workspaceId,
        ...(input.month !== undefined ? { month: input.month } : {})
      }
    );
    const body = rendered.body;
    const sha256 = createHash("sha256").update(body).digest("hex");
    const filename = normalizeSafeFilename(
      `${input.type}-${input.workspaceId}${input.month ? `-${input.month}` : ""}.${rendered.extension}`
    );
    const objectKey = [
      "tenants",
      input.principal.tenantId,
      "workspaces",
      input.workspaceId,
      "reports",
      `${Date.now()}-${sha256.slice(0, 12)}-${filename}`
    ].join("/");

    await this.storage.putObject({
      bucket: this.bucket,
      objectKey,
      body,
      mimeType: rendered.contentType,
      metadata: {
        tenantId: input.principal.tenantId,
        workspaceId: input.workspaceId,
        reportType: input.type,
        sha256
      }
    });
    const exportJob = await this.reports.createExportJob({
      tenantId: input.principal.tenantId,
      workspaceId: input.workspaceId,
      type: input.type,
      bucket: this.bucket,
      objectKey,
      createdById: input.principal.userId
    });
    await this.auditLogs?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "report.generated",
      resourceType: "ExportJob",
      resourceId: exportJob.id,
      metadata: {
        workspaceId: input.workspaceId,
        reportType: input.type,
        contentType: rendered.contentType,
        sizeBytes: body.byteLength,
        filename,
        ...(input.month !== undefined ? { month: input.month } : {})
      },
      correlationId: input.correlationId ?? null
    });
    await this.events?.publish({
      tenantId: input.principal.tenantId,
      topic: "report.generated",
      aggregateId: exportJob.id,
      payload: {
        exportJobId: exportJob.id,
        workspaceId: input.workspaceId,
        type: input.type,
        objectKey,
        sizeBytes: body.byteLength,
        sha256
      },
      correlationId: input.correlationId ?? null
    });
    const signedUrl = await this.storage.createSignedGetUrl({ bucket: this.bucket, objectKey, expiresInSeconds: 900 });

    return {
      exportJob,
      filename,
      contentType: rendered.contentType,
      sizeBytes: body.byteLength,
      sha256,
      signedUrl
    };
  }

  async listExports(principal: AuthPrincipal, workspaceId: string) {
    await this.assertWorkspace(principal.tenantId, workspaceId);
    return this.reports.listExportJobs({ tenantId: principal.tenantId, workspaceId });
  }

  private async assertWorkspace(tenantId: string, workspaceId: string) {
    if (!(await this.documents.workspaceExists(tenantId, workspaceId))) {
      throw new ReportError("WORKSPACE_NOT_FOUND", 404);
    }
  }

  private async expensesForReport(tenantId: string, workspaceId: string, month?: string): Promise<StoredExpense[]> {
    const expenses = await this.expenses.list({ tenantId, workspaceId });
    if (!month) return expenses;
    const { startsAt, endsAt } = monthRange(month);
    return expenses.filter((expense) => expense.occurredAt.getTime() >= startsAt.getTime() && expense.occurredAt.getTime() < endsAt.getTime());
  }

  private async reimbursementClaimsForReport(
    tenantId: string,
    workspaceId: string,
    month?: string
  ): Promise<Array<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[] }>> {
    const claims = await this.expenses.listReimbursementClaims({ tenantId, workspaceId });
    const exportable = claims.filter((entry) => entry.claim.status === "APPROVED" || entry.claim.status === "REIMBURSED");
    if (!month) return exportable;
    const { startsAt, endsAt } = monthRange(month);
    const monthlyExpenseIds = new Set((await this.expensesForReport(tenantId, workspaceId, month)).map((expense) => expense.id));
    return exportable
      .map((entry) => {
        const effectiveAt = entry.claim.paidAt ?? entry.claim.submittedAt ?? entry.claim.createdAt;
        const claimIsInMonth = effectiveAt.getTime() >= startsAt.getTime() && effectiveAt.getTime() < endsAt.getTime();
        const monthlyItems = entry.items.filter((item) => monthlyExpenseIds.has(item.expenseId));
        return {
          claim: entry.claim,
          items: monthlyItems.length > 0 || !claimIsInMonth ? monthlyItems : entry.items
        };
      })
      .filter((entry) => {
        const effectiveAt = entry.claim.paidAt ?? entry.claim.submittedAt ?? entry.claim.createdAt;
        return entry.items.length > 0 || (effectiveAt.getTime() >= startsAt.getTime() && effectiveAt.getTime() < endsAt.getTime());
      });
  }

  private async reimbursementClaimEvidenceForReport(
    tenantId: string,
    workspaceId: string,
    month?: string
  ): Promise<Array<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[] }>> {
    const claims = await this.expenses.listReimbursementClaims({ tenantId, workspaceId });
    if (!month) return claims;
    const { startsAt, endsAt } = monthRange(month);
    const monthlyExpenseIds = new Set((await this.expensesForReport(tenantId, workspaceId, month)).map((expense) => expense.id));
    return claims
      .map((entry) => {
        const effectiveAt = entry.claim.paidAt ?? entry.claim.submittedAt ?? entry.claim.createdAt;
        const claimIsInMonth = effectiveAt.getTime() >= startsAt.getTime() && effectiveAt.getTime() < endsAt.getTime();
        const monthlyItems = entry.items.filter((item) => monthlyExpenseIds.has(item.expenseId));
        return {
          claim: entry.claim,
          items: monthlyItems.length > 0 || !claimIsInMonth ? monthlyItems : entry.items
        };
      })
      .filter((entry) => {
        const effectiveAt = entry.claim.paidAt ?? entry.claim.submittedAt ?? entry.claim.createdAt;
        return entry.items.length > 0 || (effectiveAt.getTime() >= startsAt.getTime() && effectiveAt.getTime() < endsAt.getTime());
      });
  }

  private async approvalEvidenceEntriesForReport(tenantId: string, workspaceId: string, month?: string): Promise<ApprovalSlaItem[]> {
    const entries = await this.expenses.listApprovalSla({ tenantId, workspaceId });
    if (!month) return entries;
    const { startsAt, endsAt } = monthRange(month);
    return entries.filter((entry) => {
      const effectiveAt = entry.expense.occurredAt;
      return effectiveAt.getTime() >= startsAt.getTime() && effectiveAt.getTime() < endsAt.getTime();
    });
  }

  private async ocrQualityEntriesForReport(tenantId: string, workspaceId: string, month?: string): Promise<OcrQualityEntry[]> {
    if (!this.ocrComparisons) return [];
    const documents = await this.documents.list({ tenantId, workspaceId });
    const entries = await Promise.all(
      documents.map(async (document) => ({
        document,
        jobs: await this.ocrComparisons!.listByDocument(tenantId, document.id)
      }))
    );
    const range = month ? monthRange(month) : null;
    return entries.flatMap(({ document, jobs }) =>
      jobs
        .filter(({ job }) => {
          if (!range) return true;
          const effectiveAt = job.completedAt ?? job.createdAt;
          return effectiveAt.getTime() >= range.startsAt.getTime() && effectiveAt.getTime() < range.endsAt.getTime();
        })
        .map(({ job, runs }) => ({ document, job, runs }))
    );
  }

  private async modelEvaluationEntriesForReport(tenantId: string, month?: string): Promise<ModelEvaluationReportData> {
    if (!this.models) return { versions: [], trainingRuns: [], evaluationRuns: [] };
    const [versions, trainingRuns, evaluationRuns] = await Promise.all([
      this.models.listModelVersions({ tenantId }),
      this.models.listTrainingRuns({ tenantId }),
      this.models.listEvaluationRuns({ tenantId })
    ]);
    if (!month) return { versions, trainingRuns, evaluationRuns };
    const { startsAt, endsAt } = monthRange(month);
    return {
      versions,
      trainingRuns: trainingRuns.filter((run) => isWithinRange(run.completedAt ?? run.createdAt, startsAt, endsAt)),
      evaluationRuns: evaluationRuns.filter((run) => isWithinRange(run.completedAt ?? run.createdAt, startsAt, endsAt))
    };
  }

  private async auditPackEntriesForReport(
    tenantId: string,
    workspaceId: string,
    expenses: StoredExpense[],
    month?: string
  ): Promise<AuditLogEntry[]> {
    if (!this.auditLogs) return [];
    const range = month ? monthRange(month) : null;
    const expenseIds = new Set(expenses.map((expense) => expense.id));
    const logs = await this.auditLogs.list({ tenantId, limit: 1000 });
    return logs.filter((log) => {
      if (log.resourceType === "Expense" && log.resourceId && expenseIds.has(log.resourceId)) return true;
      if (range && !isWithinRange(log.createdAt, range.startsAt, range.endsAt)) return false;
      if (log.metadata && log.metadata.workspaceId === workspaceId) return true;
      return false;
    });
  }

  private async datasetEntriesForReport(tenantId: string, workspaceId: string, month?: string): Promise<DatasetExportEntry[]> {
    if (!this.reviews) return [];
    const range = month ? monthRange(month) : null;
    const documents = (await this.documents.list({ tenantId, workspaceId })).filter((document) => {
      if (document.deletedAt) return false;
      if (!range) return true;
      return isWithinRange(document.createdAt, range.startsAt, range.endsAt);
    });
    const documentIds = documents.map((document) => document.id);
    const [annotations, suggestions, correctionsByDocument] = await Promise.all([
      this.reviews.listAnnotations({ tenantId, documentFileIds: documentIds }),
      this.reviews.listActiveLearningSuggestions({ tenantId, documentFileIds: documentIds }),
      Promise.all(
        documents.map(async (document) => ({
          documentId: document.id,
          corrections: await this.reviews!.listCorrections({ tenantId, documentFileId: document.id })
        }))
      )
    ]);
    const annotationsByDocument = groupByDocumentId(annotations, (annotation) => annotation.documentFileId);
    const suggestionsByDocument = groupByDocumentId(suggestions, (suggestion) => suggestion.documentFileId);
    const corrections = new Map(correctionsByDocument.map((entry) => [entry.documentId, entry.corrections]));
    return documents.map((document) => ({
      document,
      annotations: annotationsByDocument.get(document.id) ?? [],
      corrections: corrections.get(document.id) ?? [],
      suggestions: suggestionsByDocument.get(document.id) ?? []
    }));
  }

  private async renderReport(
    type: ReportExportType,
    expenses: StoredExpense[],
    reimbursementClaims: Array<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[] }>,
    ocrQualityEntries: OcrQualityEntry[],
    modelEvaluationEntries: ModelEvaluationReportData,
    auditPackEntries: AuditLogEntry[],
    approvalEvidenceEntries: ApprovalSlaItem[],
    datasetEntries: DatasetExportEntry[],
    context: { workspaceId: string; month?: string }
  ): Promise<{ body: Buffer; contentType: "text/csv" | "application/pdf" | "application/x-ndjson"; extension: "csv" | "pdf" | "jsonl" }> {
    if (type === "monthly_expense_report_pdf") {
      return {
        body: await renderMonthlyExpenseReportPdf(expenses, context),
        contentType: "application/pdf",
        extension: "pdf"
      };
    }
    if (type === "reimbursement_claim_report_pdf") {
      return {
        body: await renderReimbursementClaimReportPdf(reimbursementClaims, expenses, context),
        contentType: "application/pdf",
        extension: "pdf"
      };
    }
    if (type === "dataset_export_jsonl") {
      return {
        body: Buffer.from(renderDatasetExportJsonl(datasetEntries, context), "utf8"),
        contentType: "application/x-ndjson",
        extension: "jsonl"
      };
    }
    const content = renderCsv(
      type,
      expenses,
      reimbursementClaims,
      ocrQualityEntries,
      modelEvaluationEntries,
      auditPackEntries,
      approvalEvidenceEntries
    );
    return { body: Buffer.from(content, "utf8"), contentType: "text/csv", extension: "csv" };
  }
}

type OcrQualityEntry = {
  document: StoredDocumentFile;
  job: StoredOcrJob;
  runs: StoredOcrEngineRun[];
};

type ModelEvaluationReportData = {
  versions: StoredModelVersion[];
  trainingRuns: StoredModelTrainingRun[];
  evaluationRuns: StoredModelEvaluationRun[];
};

type DatasetExportEntry = {
  document: StoredDocumentFile;
  annotations: StoredAnnotation[];
  corrections: StoredCorrection[];
  suggestions: StoredActiveLearningSuggestion[];
};

type ApprovalEvidenceEntry = ApprovalSlaItem;

function renderCsv(
  type: ReportExportType,
  expenses: StoredExpense[],
  reimbursementClaims: Array<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[] }>,
  ocrQualityEntries: OcrQualityEntry[],
  modelEvaluationEntries: ModelEvaluationReportData,
  auditPackEntries: AuditLogEntry[],
  approvalEvidenceEntries: ApprovalEvidenceEntry[]
): string {
  if (type === "expense_ledger_csv") return renderExpenseLedger(expenses);
  if (type === "category_breakdown_csv") return renderCategoryBreakdown(expenses);
  if (type === "approval_evidence_csv") return renderApprovalEvidence(approvalEvidenceEntries, reimbursementClaims);
  if (type === "reimbursement_batch_csv") return renderReimbursementBatch(reimbursementClaims, expenses);
  if (type === "ocr_quality_report_csv") return renderOcrQualityReport(ocrQualityEntries);
  if (type === "model_evaluation_report_csv") return renderModelEvaluationReport(modelEvaluationEntries);
  if (type === "audit_pack_csv") return renderAuditPack(expenses, auditPackEntries);
  return renderMerchantSpend(expenses);
}

function renderExpenseLedger(expenses: StoredExpense[]): string {
  return buildCsv(
    [
      "expense_id",
      "occurred_at",
      "title",
      "merchant",
      "status",
      "currency",
      "amount_minor",
      "tax_minor",
      "reimbursable",
      "business_expense",
      "project_code",
      "cost_center"
    ],
    expenses.map((expense) => [
      expense.id,
      expense.occurredAt,
      expense.title,
      expense.merchantName ?? "",
      expense.status,
      expense.currency,
      expense.amountMinor,
      expense.taxMinor,
      expense.reimbursable,
      expense.businessExpense,
      expense.projectCode ?? "",
      expense.costCenter ?? ""
    ])
  );
}

function renderCategoryBreakdown(expenses: StoredExpense[]): string {
  const groups = groupExpenses(expenses, (expense) => expense.categoryId ?? "uncategorized");
  return buildCsv(
    ["category_id", "currency", "expense_count", "total_minor", "tax_minor"],
    [...groups.values()].map((group) => [group.label, group.currency, group.count, group.totalMinor, group.taxMinor])
  );
}

function renderMerchantSpend(expenses: StoredExpense[]): string {
  const groups = groupExpenses(expenses, (expense) => expense.merchantName ?? expense.title);
  return buildCsv(
    ["merchant", "currency", "expense_count", "total_minor", "tax_minor"],
    [...groups.values()].map((group) => [group.label, group.currency, group.count, group.totalMinor, group.taxMinor])
  );
}

function renderReimbursementBatch(
  claims: Array<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[] }>,
  expenses: StoredExpense[]
): string {
  const expensesById = new Map(expenses.map((expense) => [expense.id, expense]));
  return buildCsv(
    [
      "claim_id",
      "claim_status",
      "claimant_id",
      "submitted_at",
      "paid_at",
      "claim_total_minor",
      "currency",
      "expense_id",
      "expense_title",
      "merchant",
      "expense_status",
      "line_amount_minor",
      "business_expense",
      "project_code",
      "cost_center"
    ],
    claims.flatMap(({ claim, items }) =>
      items.map((item) => {
        const expense = expensesById.get(item.expenseId);
        return [
          claim.id,
          claim.status,
          claim.claimantId,
          claim.submittedAt,
          claim.paidAt,
          claim.totalMinor,
          claim.currency,
          item.expenseId,
          expense?.title ?? "",
          expense?.merchantName ?? "",
          expense?.status ?? "",
          item.amountMinor,
          expense?.businessExpense ?? "",
          expense?.projectCode ?? "",
          expense?.costCenter ?? ""
        ];
      })
    )
  );
}

function renderApprovalEvidence(
  entries: ApprovalEvidenceEntry[],
  claims: Array<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[] }>
): string {
  const claimsByExpenseId = new Map<string, StoredReimbursementClaim[]>();
  for (const { claim, items } of claims) {
    for (const item of items) {
      claimsByExpenseId.set(item.expenseId, [...(claimsByExpenseId.get(item.expenseId) ?? []), claim]);
    }
  }
  return buildCsv(
    [
      "expense_id",
      "expense_title",
      "expense_status",
      "occurred_at",
      "currency",
      "amount_minor",
      "merchant",
      "business_expense",
      "reimbursable",
      "project_code",
      "cost_center",
      "workflow_id",
      "workflow_state",
      "approver_id",
      "sla_status",
      "sla_due_at",
      "sla_breached_at",
      "sla_hours",
      "remaining_minutes",
      "age_minutes",
      "policy_snapshot_json",
      "reimbursement_claim_ids",
      "reimbursement_claim_statuses"
    ],
    entries.map((entry) => {
      const expenseClaims = claimsByExpenseId.get(entry.expense.id) ?? [];
      return [
        entry.expense.id,
        entry.expense.title,
        entry.expense.status,
        entry.expense.occurredAt,
        entry.expense.currency,
        entry.expense.amountMinor,
        entry.expense.merchantName ?? "",
        entry.expense.businessExpense,
        entry.expense.reimbursable,
        entry.expense.projectCode ?? "",
        entry.expense.costCenter ?? "",
        entry.workflow.id,
        entry.workflow.state,
        entry.workflow.approverId ?? "",
        entry.slaStatus,
        entry.slaDueAt ?? "",
        entry.slaBreachedAt ?? "",
        entry.workflow.slaHours,
        entry.remainingMinutes ?? "",
        entry.ageMinutes,
        entry.workflow.policySnapshot === null ? "" : JSON.stringify(entry.workflow.policySnapshot),
        expenseClaims.map((claim) => claim.id).join("|"),
        expenseClaims.map((claim) => claim.status).join("|")
      ];
    })
  );
}

function renderOcrQualityReport(entries: OcrQualityEntry[]): string {
  return buildCsv(
    [
      "document_id",
      "document_kind",
      "document_name",
      "ocr_job_id",
      "job_status",
      "job_completed_at",
      "requested_engines",
      "engine",
      "run_status",
      "confidence",
      "latency_ms",
      "selected_engine",
      "average_confidence",
      "failure_rate",
      "character_error_rate",
      "word_error_rate",
      "pairwise_text_similarity",
      "conflict_fields",
      "failure_reason"
    ],
    entries.flatMap(({ document, job, runs }) =>
      runs.map((run) => {
        const comparison = run.engine === "ENSEMBLE" ? readComparisonMetrics(run.normalizedJson) : {};
        return [
          document.id,
          document.kind,
          document.safeName,
          job.id,
          job.status,
          job.completedAt ?? "",
          job.requestedEngines.join("|"),
          run.engine,
          run.status,
          run.confidence ?? "",
          run.latencyMs ?? "",
          comparison.selectedEngine ?? "",
          formatOptionalMetric(comparison.averageConfidence),
          formatOptionalMetric(comparison.failureRate),
          formatOptionalMetric(comparison.characterErrorRate),
          formatOptionalMetric(comparison.wordErrorRate),
          formatOptionalMetric(comparison.pairwiseTextSimilarity),
          comparison.conflictFields?.join("|") ?? "",
          run.failureReason ?? ""
        ];
      })
    )
  );
}

function renderModelEvaluationReport(data: ModelEvaluationReportData): string {
  const versionsById = new Map(data.versions.map((version) => [version.id, version]));
  const latestTrainingByModel = new Map<string, StoredModelTrainingRun>();
  for (const run of data.trainingRuns) {
    if (!run.modelVersionId) continue;
    const existing = latestTrainingByModel.get(run.modelVersionId);
    if (!existing || run.createdAt.getTime() > existing.createdAt.getTime()) {
      latestTrainingByModel.set(run.modelVersionId, run);
    }
  }

  return buildCsv(
    [
      "model_version_id",
      "model_name",
      "engine",
      "model_status",
      "artifact_key",
      "training_run_id",
      "training_status",
      "training_profile",
      "training_seed",
      "training_completed_at",
      "evaluation_run_id",
      "evaluation_status",
      "evaluation_completed_at",
      "accuracy",
      "macro_f1",
      "loss",
      "cer",
      "wer",
      "field_accuracy",
      "confusion_matrix_json",
      "accuracy_note",
      "failure_reason",
      "report_key"
    ],
    data.evaluationRuns.map((evaluation) => {
      const version = evaluation.modelVersionId ? versionsById.get(evaluation.modelVersionId) : undefined;
      const training = evaluation.modelVersionId ? latestTrainingByModel.get(evaluation.modelVersionId) : undefined;
      const metrics = readModelMetrics(evaluation.metrics);
      return [
        evaluation.modelVersionId ?? "",
        version?.name ?? "",
        version?.engine ?? "",
        version?.status ?? "",
        version?.artifactKey ?? "",
        training?.id ?? "",
        training?.status ?? "",
        training?.profile ?? "",
        training?.seed ?? "",
        training?.completedAt ?? "",
        evaluation.id,
        evaluation.status,
        evaluation.completedAt ?? "",
        formatOptionalMetric(metrics.accuracy),
        formatOptionalMetric(metrics.macroF1),
        formatOptionalMetric(metrics.loss),
        formatOptionalMetric(metrics.cer),
        formatOptionalMetric(metrics.wer),
        formatOptionalMetric(metrics.fieldAccuracy),
        metrics.confusionMatrixJson ?? "",
        metrics.accuracyNote ?? "",
        evaluation.failureReason ?? "",
        evaluation.reportKey ?? ""
      ];
    })
  );
}

function renderAuditPack(expenses: StoredExpense[], auditLogs: AuditLogEntry[]): string {
  return buildCsv(
    [
      "row_type",
      "workspace_id",
      "resource_type",
      "resource_id",
      "event_at",
      "actor_user_id",
      "action_or_status",
      "title",
      "merchant",
      "amount_minor",
      "currency",
      "document_id",
      "business_expense",
      "reimbursable",
      "correlation_id",
      "metadata_json"
    ],
    [
      ...expenses.map((expense) => [
        "expense",
        expense.workspaceId,
        "Expense",
        expense.id,
        expense.updatedAt,
        expense.createdById,
        expense.status,
        expense.title,
        expense.merchantName ?? "",
        expense.amountMinor,
        expense.currency,
        expense.documentId ?? "",
        expense.businessExpense,
        expense.reimbursable,
        "",
        JSON.stringify({
          categoryId: expense.categoryId,
          projectCode: expense.projectCode,
          costCenter: expense.costCenter,
          taxMinor: expense.taxMinor.toString()
        })
      ]),
      ...auditLogs.map((log) => [
        "audit_event",
        typeof log.metadata?.workspaceId === "string" ? log.metadata.workspaceId : "",
        log.resourceType,
        log.resourceId ?? "",
        log.createdAt,
        log.actorUserId ?? "",
        log.action,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        log.correlationId ?? "",
        JSON.stringify(log.metadata ?? {})
      ])
    ]
  );
}

function renderDatasetExportJsonl(entries: DatasetExportEntry[], context: { workspaceId: string; month?: string }): string {
  return (
    entries
      .map((entry) =>
        JSON.stringify({
          schemaVersion: 1,
          exportType: "dataset_export_jsonl",
          workspaceId: context.workspaceId,
          month: context.month ?? null,
          document: {
            id: entry.document.id,
            kind: entry.document.kind,
            safeName: entry.document.safeName,
            mimeType: entry.document.mimeType,
            sizeBytes: entry.document.sizeBytes.toString(),
            sha256: entry.document.sha256,
            bucket: entry.document.bucket,
            objectKey: entry.document.objectKey,
            createdAt: entry.document.createdAt.toISOString()
          },
          labels: entry.annotations.map((annotation) => ({
            id: annotation.id,
            label: annotation.label,
            payload: annotation.payload,
            datasetItemId: annotation.datasetItemId,
            createdById: annotation.createdById,
            createdAt: annotation.createdAt.toISOString()
          })),
          corrections: entry.corrections.map((correction) => ({
            id: correction.id,
            fieldName: correction.fieldName,
            beforeValue: correction.beforeValue,
            afterValue: correction.afterValue,
            correctedById: correction.correctedById,
            createdAt: correction.createdAt.toISOString()
          })),
          activeLearningSuggestions: entry.suggestions.map((suggestion) => ({
            id: suggestion.id,
            reasonCode: suggestion.reasonCode,
            score: suggestion.score,
            payload: suggestion.payload,
            createdAt: suggestion.createdAt.toISOString(),
            acceptedAt: suggestion.acceptedAt?.toISOString() ?? null
          }))
        })
      )
      .join("\n") + (entries.length > 0 ? "\n" : "")
  );
}

function readModelMetrics(value: unknown): {
  accuracy?: number;
  macroF1?: number;
  loss?: number;
  cer?: number;
  wer?: number;
  fieldAccuracy?: number;
  confusionMatrixJson?: string;
  accuracyNote?: string;
} {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const result: ReturnType<typeof readModelMetrics> = {};
  if (typeof record.accuracy === "number") result.accuracy = record.accuracy;
  if (typeof record.macro_f1 === "number") result.macroF1 = record.macro_f1;
  if (typeof record.loss === "number") result.loss = record.loss;
  if (typeof record.cer === "number") result.cer = record.cer;
  if (typeof record.wer === "number") result.wer = record.wer;
  if (typeof record.field_accuracy === "number") result.fieldAccuracy = record.field_accuracy;
  if (Array.isArray(record.confusion_matrix)) result.confusionMatrixJson = JSON.stringify(record.confusion_matrix);
  if (typeof record.accuracy_note === "string") result.accuracyNote = record.accuracy_note;
  return result;
}

function formatOptionalMetric(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return value.toFixed(4);
}

function readComparisonMetrics(value: unknown): {
  selectedEngine?: string;
  averageConfidence?: number;
  failureRate?: number;
  characterErrorRate?: number | null;
  wordErrorRate?: number | null;
  pairwiseTextSimilarity?: number | null;
  conflictFields?: string[];
} {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const result: ReturnType<typeof readComparisonMetrics> = {};
  if (typeof record.selectedEngine === "string") result.selectedEngine = record.selectedEngine;
  if (typeof record.averageConfidence === "number") result.averageConfidence = record.averageConfidence;
  if (typeof record.failureRate === "number") result.failureRate = record.failureRate;
  if (typeof record.characterErrorRate === "number" || record.characterErrorRate === null) {
    result.characterErrorRate = record.characterErrorRate;
  }
  if (typeof record.wordErrorRate === "number" || record.wordErrorRate === null) {
    result.wordErrorRate = record.wordErrorRate;
  }
  if (typeof record.pairwiseTextSimilarity === "number" || record.pairwiseTextSimilarity === null) {
    result.pairwiseTextSimilarity = record.pairwiseTextSimilarity;
  }
  if (Array.isArray(record.conflictFields)) {
    result.conflictFields = record.conflictFields.filter((item): item is string => typeof item === "string");
  }
  return result;
}

function groupExpenses(expenses: StoredExpense[], labelFor: (expense: StoredExpense) => string) {
  const groups = new Map<string, { label: string; currency: string; count: number; totalMinor: bigint; taxMinor: bigint }>();
  for (const expense of expenses) {
    const label = labelFor(expense).trim() || "unknown";
    const key = `${label}:${expense.currency}`;
    const current = groups.get(key) ?? {
      label,
      currency: expense.currency,
      count: 0,
      totalMinor: 0n,
      taxMinor: 0n
    };
    current.count += 1;
    current.totalMinor += expense.amountMinor;
    current.taxMinor += expense.taxMinor;
    groups.set(key, current);
  }
  return groups;
}

function monthRange(month: string): { startsAt: Date; endsAt: Date } {
  const match = /^(?<year>\d{4})-(?<month>\d{2})$/.exec(month);
  const year = Number(match?.groups?.year);
  const monthNumber = Number(match?.groups?.month);
  if (!match || monthNumber < 1 || monthNumber > 12) throw new ReportError("INVALID_MONTH", 400);
  return {
    startsAt: new Date(Date.UTC(year, monthNumber - 1, 1)),
    endsAt: new Date(Date.UTC(year, monthNumber, 1))
  };
}

function isWithinRange(value: Date, startsAt: Date, endsAt: Date): boolean {
  return value.getTime() >= startsAt.getTime() && value.getTime() < endsAt.getTime();
}

function groupByDocumentId<T>(items: T[], documentIdFor: (item: T) => string | null): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const documentId = documentIdFor(item);
    if (!documentId) continue;
    grouped.set(documentId, [...(grouped.get(documentId) ?? []), item]);
  }
  return grouped;
}

async function renderMonthlyExpenseReportPdf(
  expenses: StoredExpense[],
  context: { workspaceId: string; month?: string }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "A4",
      margin: 42,
      info: {
        Title: "SpendLens AI Monthly Expense Report",
        Author: "SpendLens AI"
      },
      compress: false
    });
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const totalMinor = expenses.reduce((sum, expense) => sum + expense.amountMinor, 0n);
    const taxMinor = expenses.reduce((sum, expense) => sum + expense.taxMinor, 0n);
    const businessMinor = expenses.filter((expense) => expense.businessExpense).reduce((sum, expense) => sum + expense.amountMinor, 0n);
    const reimbursableMinor = expenses.filter((expense) => expense.reimbursable).reduce((sum, expense) => sum + expense.amountMinor, 0n);
    const currencies = [...new Set(expenses.map((expense) => expense.currency))].sort();

    doc.font("Helvetica-Bold").fontSize(20).text("SpendLens AI Monthly Expense Report");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(10).fillColor("#4b5563");
    doc.text(`Workspace: ${safePdfText(context.workspaceId)}`);
    doc.text(`Month: ${safePdfText(context.month ?? "all")}`);
    doc.text(`Generated at: ${new Date().toISOString()}`);
    doc.moveDown();

    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(13).text("Summary");
    doc.moveDown(0.4);
    drawMetric(doc, "Expense count", expenses.length.toString());
    drawMetric(doc, "Currencies", currencies.join(", ") || "none");
    drawMetric(doc, "Total amount", formatMinor(totalMinor));
    drawMetric(doc, "Tax amount", formatMinor(taxMinor));
    drawMetric(doc, "Business amount", formatMinor(businessMinor));
    drawMetric(doc, "Reimbursable amount", formatMinor(reimbursableMinor));

    doc.moveDown();
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text("Merchant Spend");
    doc.moveDown(0.4);
    const merchantGroups = [...groupExpenses(expenses, (expense) => expense.merchantName ?? expense.title).values()]
      .sort((left, right) => Number(right.totalMinor - left.totalMinor))
      .slice(0, 12);
    drawTable(doc, ["Merchant", "Currency", "Count", "Total"], merchantGroups.map((group) => [
      group.label,
      group.currency,
      group.count.toString(),
      formatMinor(group.totalMinor)
    ]));

    doc.moveDown();
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text("Expense Ledger");
    doc.moveDown(0.4);
    drawTable(
      doc,
      ["Date", "Title", "Merchant", "Amount", "Status"],
      expenses.slice(0, 24).map((expense) => [
        expense.occurredAt.toISOString().slice(0, 10),
        expense.title,
        expense.merchantName ?? "",
        `${expense.currency} ${formatMinor(expense.amountMinor)}`,
        expense.status
      ])
    );
    if (expenses.length > 24) {
      doc.moveDown(0.3);
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#6b7280").text(`Only first 24 of ${expenses.length} expenses are shown in this PDF summary.`);
    }

    doc.end();
  });
}

async function renderReimbursementClaimReportPdf(
  claims: Array<{ claim: StoredReimbursementClaim; items: StoredReimbursementClaimExpense[] }>,
  expenses: StoredExpense[],
  context: { workspaceId: string; month?: string }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "A4",
      margin: 42,
      info: {
        Title: "SpendLens AI Reimbursement Claim Report",
        Author: "SpendLens AI"
      },
      compress: false
    });
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const expensesById = new Map(expenses.map((expense) => [expense.id, expense]));
    const totalMinor = claims.reduce((sum, entry) => sum + entry.claim.totalMinor, 0n);
    const approvedCount = claims.filter((entry) => entry.claim.status === "APPROVED").length;
    const reimbursedCount = claims.filter((entry) => entry.claim.status === "REIMBURSED").length;
    const currencies = [...new Set(claims.map((entry) => entry.claim.currency))].sort();

    doc.font("Helvetica-Bold").fontSize(20).text("SpendLens AI Reimbursement Claim Report");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(10).fillColor("#4b5563");
    doc.text(`Workspace: ${safePdfText(context.workspaceId)}`);
    doc.text(`Month: ${safePdfText(context.month ?? "all")}`);
    doc.text(`Generated at: ${new Date().toISOString()}`);
    doc.moveDown();

    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(13).text("Summary");
    doc.moveDown(0.4);
    drawMetric(doc, "Claim count", claims.length.toString());
    drawMetric(doc, "Approved claims", approvedCount.toString());
    drawMetric(doc, "Reimbursed claims", reimbursedCount.toString());
    drawMetric(doc, "Currencies", currencies.join(", ") || "none");
    drawMetric(doc, "Total amount", formatMinor(totalMinor));

    doc.moveDown();
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text("Claims");
    doc.moveDown(0.4);
    drawTable(
      doc,
      ["Claim", "Status", "Claimant", "Submitted", "Paid", "Total"],
      claims.slice(0, 18).map(({ claim }) => [
        claim.id,
        claim.status,
        claim.claimantId,
        claim.submittedAt ? claim.submittedAt.toISOString().slice(0, 10) : "",
        claim.paidAt ? claim.paidAt.toISOString().slice(0, 10) : "",
        `${claim.currency} ${formatMinor(claim.totalMinor)}`
      ])
    );

    doc.moveDown();
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text("Claim Expense Lines");
    doc.moveDown(0.4);
    drawTable(
      doc,
      ["Claim", "Expense", "Merchant", "Amount", "Project", "Cost center"],
      claims
        .flatMap(({ claim, items }) =>
          items.map((item) => {
            const expense = expensesById.get(item.expenseId);
            return [
              claim.id,
              expense?.title ?? item.expenseId,
              expense?.merchantName ?? "",
              `${claim.currency} ${formatMinor(item.amountMinor)}`,
              expense?.projectCode ?? "",
              expense?.costCenter ?? ""
            ];
          })
        )
        .slice(0, 28)
    );

    const lineCount = claims.reduce((sum, entry) => sum + entry.items.length, 0);
    if (claims.length > 18 || lineCount > 28) {
      doc.moveDown(0.3);
      doc
        .font("Helvetica-Oblique")
        .fontSize(8)
        .fillColor("#6b7280")
        .text(`This PDF summary shows the first 18 claims and first 28 claim lines. Full line-level data is available in the reimbursement batch CSV export.`);
    }

    doc.end();
  });
}

function drawMetric(doc: PDFKit.PDFDocument, label: string, value: string): void {
  doc.font("Helvetica").fontSize(10).fillColor("#374151").text(`${label}: `, { continued: true });
  doc.font("Helvetica-Bold").fillColor("#111827").text(safePdfText(value));
}

function drawTable(doc: PDFKit.PDFDocument, headers: string[], rows: string[][]): void {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columnWidth = pageWidth / headers.length;
  const rowTop = doc.y;
  doc.rect(doc.page.margins.left, rowTop, pageWidth, 18).fill("#f3f4f6");
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(8);
  headers.forEach((header, index) => {
    doc.text(safePdfText(header), doc.page.margins.left + index * columnWidth + 4, rowTop + 5, { width: columnWidth - 8 });
  });
  doc.y = rowTop + 22;
  doc.font("Helvetica").fontSize(8).fillColor("#374151");
  if (rows.length === 0) {
    doc.text("No persisted expenses matched this report scope.");
    return;
  }
  for (const row of rows) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 24) {
      doc.addPage();
    }
    const y = doc.y;
    row.forEach((cell, index) => {
      doc.text(safePdfText(cell), doc.page.margins.left + index * columnWidth + 4, y, {
        width: columnWidth - 8,
        height: 20,
        ellipsis: true
      });
    });
    doc.y = y + 22;
  }
}

function formatMinor(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const major = absolute / 100n;
  const minor = absolute % 100n;
  return `${sign}${major.toString()}.${minor.toString().padStart(2, "0")}`;
}

function safePdfText(value: string): string {
  return value.normalize("NFKD").replace(/[^\x20-\x7E]/g, "?");
}
