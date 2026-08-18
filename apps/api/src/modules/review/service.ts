import type { JobStatus } from "@prisma/client";
import type { AuditRepository, SeedAuditLogInput } from "../audit/types";
import { permissionsForRoles } from "../auth/service";
import type { AuthPrincipal, AuthRepository, AuthUserWithRoles } from "../auth/types";
import type { DocumentRepository, StoredDocumentFile } from "../documents/types";
import type { ReviewRepository } from "./types";

export class ReviewError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class ReviewService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly reviews: ReviewRepository,
    private readonly auth: AuthRepository,
    private readonly audit?: AuditRepository
  ) {}

  async createTask(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    reasonCodes: string[];
    assignedToId?: string | null;
    dueAt?: string | null;
  }) {
    const document = await this.assertDocument(input.principal.tenantId, input.documentFileId);
    await this.assertAssignableReviewTarget(input.principal, input.assignedToId ?? null);
    const reasonCodes = normalizeReasonCodes(input.reasonCodes);
    const task = await this.reviews.createReviewTask({
      tenantId: input.principal.tenantId,
      documentFileId: input.documentFileId,
      reasonCodes,
      assignedToId: input.assignedToId ?? null,
      dueAt: input.dueAt ? parseDate(input.dueAt) : null,
      actorUserId: input.principal.userId
    });
    await this.auditReviewTask(input.principal, "review.task.created", task, document, {
      reasonCodes,
      assignedToId: task.assignedToId,
      dueAt: task.dueAt?.toISOString() ?? null
    });
    return task;
  }

  async listTasks(input: { principal: AuthPrincipal; workspaceId?: string; status?: JobStatus; assignedToId?: string | null; limit?: number }) {
    const tasks = await this.reviews.listReviewTasks({
      tenantId: input.principal.tenantId,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {})
    });
    return this.withDocuments(input.principal.tenantId, tasks, input.workspaceId);
  }

  async assignTask(input: { principal: AuthPrincipal; reviewTaskId: string; assignedToId?: string | null }) {
    const assignedToId = input.assignedToId === undefined ? input.principal.userId : input.assignedToId;
    await this.assertAssignableReviewTarget(input.principal, assignedToId);
    const task = await this.reviews.assignReviewTask({
      tenantId: input.principal.tenantId,
      reviewTaskId: input.reviewTaskId,
      assignedToId,
      actorUserId: input.principal.userId
    });
    if (!task) throw new ReviewError("REVIEW_TASK_NOT_FOUND", 404);
    await this.auditReviewTask(input.principal, "review.task.assigned", task, null, {
      assignedToId: task.assignedToId
    });
    return task;
  }

  async listAssignableReviewers(principal: AuthPrincipal) {
    const users = await this.auth.listUsersWithRoles(principal.tenantId);
    return users
      .filter((user) => user.disabledAt === null && permissionsForRoles(user.roles).includes("ocr.review"))
      .map((user) => publicReviewer(user));
  }

  async workload(input: { principal: AuthPrincipal; workspaceId?: string }) {
    const [reviewers, taskRows] = await Promise.all([
      this.listAssignableReviewers(input.principal),
      this.listTasks({ principal: input.principal, ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}) })
    ]);
    const now = new Date();
    const dueSoonUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const reviewerSummaries = new Map(
      reviewers.map((reviewer) => [
        reviewer.id,
        {
          reviewer,
          queued: 0,
          running: 0,
          completed: 0,
          rejected: 0,
          overdue: 0,
          dueSoon: 0,
          oldestQueuedAgeMinutes: null as number | null,
          workloadScore: 0
        }
      ])
    );
    const unassigned = {
      queued: 0,
      running: 0,
      overdue: 0,
      dueSoon: 0,
      oldestQueuedAgeMinutes: null as number | null,
      workloadScore: 0
    };

    for (const row of taskRows) {
      const task = row.task;
      const open = task.status === "QUEUED" || task.status === "RUNNING";
      const target = task.assignedToId ? reviewerSummaries.get(task.assignedToId) : null;
      const bucket = target ?? (task.assignedToId ? null : unassigned);
      if (!bucket) continue;
      if (task.status === "QUEUED") bucket.queued += 1;
      if (task.status === "RUNNING") bucket.running += 1;
      if (target && task.status === "SUCCEEDED") target.completed += 1;
      if (target && task.status === "FAILED") target.rejected += 1;
      if (open && task.dueAt && task.dueAt.getTime() < now.getTime()) bucket.overdue += 1;
      if (open && task.dueAt && task.dueAt.getTime() >= now.getTime() && task.dueAt.getTime() <= dueSoonUntil.getTime()) {
        bucket.dueSoon += 1;
      }
      if (open) {
        const ageMinutes = Math.max(0, Math.floor((now.getTime() - task.createdAt.getTime()) / 60000));
        bucket.oldestQueuedAgeMinutes =
          bucket.oldestQueuedAgeMinutes === null ? ageMinutes : Math.max(bucket.oldestQueuedAgeMinutes, ageMinutes);
      }
    }

    for (const summary of reviewerSummaries.values()) {
      summary.workloadScore = summary.queued + summary.running + summary.overdue * 2 + summary.dueSoon;
    }
    unassigned.workloadScore = unassigned.queued + unassigned.running + unassigned.overdue * 2 + unassigned.dueSoon;

    const summaries = [...reviewerSummaries.values()].sort(
      (left, right) => right.workloadScore - left.workloadScore || left.reviewer.displayName.localeCompare(right.reviewer.displayName)
    );
    return {
      generatedAt: now.toISOString(),
      workspaceId: input.workspaceId ?? null,
      reviewers: summaries,
      unassigned,
      totals: {
        reviewers: summaries.length,
        queued: summaries.reduce((sum, item) => sum + item.queued, unassigned.queued),
        running: summaries.reduce((sum, item) => sum + item.running, unassigned.running),
        overdue: summaries.reduce((sum, item) => sum + item.overdue, unassigned.overdue),
        dueSoon: summaries.reduce((sum, item) => sum + item.dueSoon, unassigned.dueSoon)
      }
    };
  }

  async rebalanceSuggestions(input: { principal: AuthPrincipal; workspaceId?: string }) {
    const [workload, taskRows] = await Promise.all([
      this.workload(input),
      this.listTasks({ principal: input.principal, ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}) })
    ]);
    const now = new Date();
    const dueSoonUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const reviewerCapacity = [...workload.reviewers].sort(
      (left, right) => left.workloadScore - right.workloadScore || left.reviewer.displayName.localeCompare(right.reviewer.displayName)
    );
    const suggestions: Array<{
      action: "ASSIGN" | "REASSIGN";
      reasonCode: "SLA_OVERDUE_UNASSIGNED" | "SLA_DUE_SOON_UNASSIGNED" | "OVERLOADED_REVIEWER";
      priority: number;
      task: (typeof taskRows)[number]["task"];
      document: (typeof taskRows)[number]["document"];
      currentAssigneeId: string | null;
      targetReviewer: (typeof workload.reviewers)[number]["reviewer"];
      targetWorkloadScore: number;
      currentAssigneeWorkloadScore: number | null;
      ageMinutes: number;
      dueInMinutes: number | null;
      overdueMinutes: number | null;
    }> = [];
    const leastLoadedReviewer = reviewerCapacity[0];
    if (!leastLoadedReviewer) {
      return { generatedAt: now.toISOString(), workspaceId: input.workspaceId ?? null, suggestions };
    }

    const workloadByReviewer = new Map(workload.reviewers.map((summary) => [summary.reviewer.id, summary]));
    const openRows = taskRows.filter(({ task }) => task.status === "QUEUED" || task.status === "RUNNING");

    for (const row of openRows) {
      if (row.task.assignedToId) continue;
      const dueStatus = dueStatusForTask(row.task.dueAt, now, dueSoonUntil);
      if (!dueStatus) continue;
      suggestions.push({
        action: "ASSIGN",
        reasonCode: dueStatus.overdueMinutes !== null ? "SLA_OVERDUE_UNASSIGNED" : "SLA_DUE_SOON_UNASSIGNED",
        priority: dueStatus.overdueMinutes !== null ? 1000 + dueStatus.overdueMinutes : 700 - Math.min(dueStatus.dueInMinutes ?? 0, 700),
        task: row.task,
        document: row.document,
        currentAssigneeId: null,
        targetReviewer: leastLoadedReviewer.reviewer,
        targetWorkloadScore: leastLoadedReviewer.workloadScore,
        currentAssigneeWorkloadScore: null,
        ageMinutes: ageMinutes(row.task.createdAt, now),
        dueInMinutes: dueStatus.dueInMinutes,
        overdueMinutes: dueStatus.overdueMinutes
      });
    }

    const heaviestReviewers = [...workload.reviewers].sort(
      (left, right) => right.workloadScore - left.workloadScore || left.reviewer.displayName.localeCompare(right.reviewer.displayName)
    );
    for (const source of heaviestReviewers) {
      const target = reviewerCapacity.find((candidate) => candidate.reviewer.id !== source.reviewer.id);
      if (!target || source.workloadScore - target.workloadScore < 3) continue;
      const row = openRows
        .filter(({ task }) => task.assignedToId === source.reviewer.id)
        .sort((left, right) => taskPressure(right.task, now) - taskPressure(left.task, now))[0];
      if (!row) continue;
      suggestions.push({
        action: "REASSIGN",
        reasonCode: "OVERLOADED_REVIEWER",
        priority: 500 + source.workloadScore - target.workloadScore + taskPressure(row.task, now),
        task: row.task,
        document: row.document,
        currentAssigneeId: source.reviewer.id,
        targetReviewer: target.reviewer,
        targetWorkloadScore: target.workloadScore,
        currentAssigneeWorkloadScore: source.workloadScore,
        ageMinutes: ageMinutes(row.task.createdAt, now),
        dueInMinutes: row.task.dueAt ? Math.max(0, Math.floor((row.task.dueAt.getTime() - now.getTime()) / 60000)) : null,
        overdueMinutes: row.task.dueAt && row.task.dueAt.getTime() < now.getTime() ? Math.floor((now.getTime() - row.task.dueAt.getTime()) / 60000) : null
      });
    }

    return {
      generatedAt: now.toISOString(),
      workspaceId: input.workspaceId ?? null,
      suggestions: suggestions
        .filter((suggestion) => workloadByReviewer.has(suggestion.targetReviewer.id))
        .sort((left, right) => right.priority - left.priority || right.ageMinutes - left.ageMinutes)
        .slice(0, 8)
    };
  }

  async runEscalations(input: { principal: AuthPrincipal; workspaceId?: string; dryRun?: boolean; maxActions?: number }) {
    const suggestions = await this.rebalanceSuggestions({
      principal: input.principal,
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {})
    });
    const maxActions = Math.max(1, Math.min(input.maxActions ?? 8, 25));
    const planned = suggestions.suggestions.slice(0, maxActions).map((suggestion) => ({
      action: suggestion.action,
      reasonCode: suggestion.reasonCode,
      task: suggestion.task,
      document: suggestion.document,
      currentAssigneeId: suggestion.currentAssigneeId,
      targetReviewer: suggestion.targetReviewer,
      ageMinutes: suggestion.ageMinutes,
      dueInMinutes: suggestion.dueInMinutes,
      overdueMinutes: suggestion.overdueMinutes,
      escalationReasonCodes: ["SLA_ESCALATED", suggestion.reasonCode]
    }));

    if (input.dryRun) {
      return {
        generatedAt: suggestions.generatedAt,
        workspaceId: suggestions.workspaceId,
        dryRun: true,
        planned,
        applied: []
      };
    }

    const applied = [];
    for (const action of planned) {
      const task = await this.reviews.escalateReviewTask({
        tenantId: input.principal.tenantId,
        reviewTaskId: action.task.id,
        actorUserId: input.principal.userId,
        reasonCodes: action.escalationReasonCodes,
        assignedToId: action.targetReviewer.id,
        note: `${action.reasonCode} automated escalation`
      });
      if (!task) continue;
      await this.auditReviewTask(input.principal, "review.task.escalated", task, null, {
        reasonCodes: action.escalationReasonCodes,
        assignedToId: task.assignedToId,
        escalationReasonCode: action.reasonCode
      });
      applied.push({
        ...action,
        task
      });
    }

    return {
      generatedAt: suggestions.generatedAt,
      workspaceId: suggestions.workspaceId,
      dryRun: false,
      planned,
      applied
    };
  }

  async completeTask(input: { principal: AuthPrincipal; reviewTaskId: string }) {
    const task = await this.reviews.completeReviewTask({
      tenantId: input.principal.tenantId,
      reviewTaskId: input.reviewTaskId,
      actorUserId: input.principal.userId
    });
    if (!task) throw new ReviewError("REVIEW_TASK_NOT_FOUND", 404);
    await this.auditReviewTask(input.principal, "review.task.completed", task);
    return task;
  }

  async rejectTask(input: { principal: AuthPrincipal; reviewTaskId: string; rejectionReason: string }) {
    const rejectionReason = input.rejectionReason.trim();
    if (!rejectionReason) throw new ReviewError("REJECTION_REASON_REQUIRED", 400);
    const task = await this.reviews.rejectReviewTask({
      tenantId: input.principal.tenantId,
      reviewTaskId: input.reviewTaskId,
      actorUserId: input.principal.userId,
      rejectionReason
    });
    if (!task) throw new ReviewError("REVIEW_TASK_NOT_FOUND", 404);
    await this.auditReviewTask(input.principal, "review.task.rejected", task, null, {
      rejectionReasonPresent: true
    });
    return task;
  }

  async createCorrection(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    fieldName?: string | null;
    beforeValue?: string | null;
    afterValue: string;
    createAnnotation?: boolean;
    annotationLabel?: string | null;
    annotationPayload?: unknown;
  }) {
    const document = await this.assertDocument(input.principal.tenantId, input.documentFileId);
    const afterValue = input.afterValue.trim();
    if (!afterValue) throw new ReviewError("CORRECTION_VALUE_REQUIRED", 400);
    const result = await this.reviews.createCorrection({
      tenantId: input.principal.tenantId,
      documentFileId: input.documentFileId,
      fieldName: input.fieldName?.trim() || null,
      beforeValue: input.beforeValue ?? null,
      afterValue,
      correctedById: input.principal.userId,
      createAnnotation: input.createAnnotation ?? true,
      annotationLabel: input.annotationLabel?.trim() || null,
      annotationPayload: input.annotationPayload
    });
    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "ocr.correction.created",
      resourceType: "OCRCorrection",
      resourceId: result.correction.id,
      metadata: {
        documentFileId: input.documentFileId,
        workspaceId: document.workspaceId,
        fieldName: result.correction.fieldName,
        beforeValuePresent: result.correction.beforeValue !== null,
        afterValuePresent: true,
        annotationId: result.annotation?.id ?? null,
        activeLearningSuggestionId: result.suggestion.id
      }
    });
    return result;
  }

  async createAnnotation(input: { principal: AuthPrincipal; documentFileId: string; label: string; payload: unknown }) {
    const document = await this.assertDocument(input.principal.tenantId, input.documentFileId);
    const label = normalizeAnnotationLabel(input.label);
    const annotation = await this.reviews.createAnnotation({
      tenantId: input.principal.tenantId,
      documentFileId: input.documentFileId,
      label,
      payload: input.payload,
      createdById: input.principal.userId
    });
    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "annotation.created",
      resourceType: "Annotation",
      resourceId: annotation.id,
      metadata: {
        documentFileId: input.documentFileId,
        workspaceId: document.workspaceId,
        label,
        ...annotationPayloadAuditSummary(input.payload)
      }
    });
    return annotation;
  }

  async listCorrections(principal: AuthPrincipal, documentFileId: string) {
    await this.assertDocument(principal.tenantId, documentFileId);
    return this.reviews.listCorrections({ tenantId: principal.tenantId, documentFileId });
  }

  async listAnnotations(principal: AuthPrincipal, documentFileId: string) {
    await this.assertDocument(principal.tenantId, documentFileId);
    return this.reviews.listAnnotations({ tenantId: principal.tenantId, documentFileIds: [documentFileId] });
  }

  async listActiveLearningSuggestions(input: { principal: AuthPrincipal; workspaceId?: string; limit?: number }) {
    if (!input.workspaceId) {
      return this.reviews.listActiveLearningSuggestions({
        tenantId: input.principal.tenantId,
        ...(input.limit !== undefined ? { limit: input.limit } : {})
      });
    }
    const documents = await this.documents.list({ tenantId: input.principal.tenantId, workspaceId: input.workspaceId });
    return this.reviews.listActiveLearningSuggestions({
      tenantId: input.principal.tenantId,
      documentFileIds: documents.map((document) => document.id),
      ...(input.limit !== undefined ? { limit: input.limit } : {})
    });
  }

  async metrics() {
    return this.reviews.metrics();
  }

  private async assertDocument(tenantId: string, documentFileId: string): Promise<StoredDocumentFile> {
    const document = await this.documents.findById(tenantId, documentFileId);
    if (!document || document.deletedAt) throw new ReviewError("DOCUMENT_NOT_FOUND", 404);
    return document;
  }

  private async assertAssignableReviewTarget(principal: AuthPrincipal, assignedToId: string | null): Promise<void> {
    if (assignedToId === null) return;
    if (assignedToId !== principal.userId && !principal.permissions.includes("users.manage")) {
      throw new ReviewError("REVIEW_ASSIGNMENT_MANAGE_REQUIRED", 403);
    }
    const user = await this.auth.findUserById(principal.tenantId, assignedToId);
    if (!user || user.disabledAt) throw new ReviewError("REVIEW_ASSIGNEE_NOT_FOUND", 404);
    const roles = await this.auth.getUserRoles(principal.tenantId, assignedToId);
    if (!permissionsForRoles(roles).includes("ocr.review")) {
      throw new ReviewError("REVIEW_ASSIGNEE_NOT_ELIGIBLE", 400);
    }
  }

  private async withDocuments(
    tenantId: string,
    tasks: Awaited<ReturnType<ReviewRepository["listReviewTasks"]>>,
    workspaceId?: string
  ) {
    const rows = [];
    for (const task of tasks) {
      const document = await this.documents.findById(tenantId, task.documentFileId);
      if (!document || document.deletedAt) continue;
      if (workspaceId && document.workspaceId !== workspaceId) continue;
      rows.push({ task, document });
    }
    return rows;
  }

  private async auditReviewTask(
    principal: AuthPrincipal,
    action: string,
    task: {
      id: string;
      documentFileId: string;
      status: JobStatus;
      assignedToId: string | null;
      reasonCodes: string[];
      dueAt: Date | null;
    },
    document?: StoredDocumentFile | null,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.writeAudit({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action,
      resourceType: "OCRReviewTask",
      resourceId: task.id,
      metadata: {
        documentFileId: task.documentFileId,
        ...(document ? { workspaceId: document.workspaceId } : {}),
        status: task.status,
        assignedToId: task.assignedToId,
        reasonCodes: task.reasonCodes,
        dueAt: task.dueAt?.toISOString() ?? null,
        ...metadata
      }
    });
  }

  private async writeAudit(input: SeedAuditLogInput): Promise<void> {
    try {
      await this.audit?.create(input);
    } catch {
      // Review persistence remains authoritative; audit failures should not break reviewer workflows.
    }
  }
}

function publicReviewer(user: AuthUserWithRoles) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles,
    permissions: permissionsForRoles(user.roles)
  };
}

function normalizeReasonCodes(reasonCodes: string[]): string[] {
  const normalized = [
    ...new Set(
      reasonCodes
        .map((reason) => reason.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_"))
        .filter(Boolean)
    )
  ];
  if (normalized.length === 0) throw new ReviewError("REASON_CODE_REQUIRED", 400);
  return normalized.slice(0, 12);
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ReviewError("INVALID_DUE_DATE", 400);
  return date;
}

function dueStatusForTask(dueAt: Date | null, now: Date, dueSoonUntil: Date) {
  if (!dueAt) return null;
  if (dueAt.getTime() < now.getTime()) {
    return {
      dueInMinutes: null,
      overdueMinutes: Math.floor((now.getTime() - dueAt.getTime()) / 60000)
    };
  }
  if (dueAt.getTime() <= dueSoonUntil.getTime()) {
    return {
      dueInMinutes: Math.floor((dueAt.getTime() - now.getTime()) / 60000),
      overdueMinutes: null
    };
  }
  return null;
}

function taskPressure(task: { dueAt: Date | null; createdAt: Date }, now: Date): number {
  const age = ageMinutes(task.createdAt, now);
  if (!task.dueAt) return age;
  if (task.dueAt.getTime() < now.getTime()) return age + Math.floor((now.getTime() - task.dueAt.getTime()) / 60000) + 1440;
  return age + Math.max(0, 1440 - Math.floor((task.dueAt.getTime() - now.getTime()) / 60000));
}

function ageMinutes(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 60000));
}

function normalizeAnnotationLabel(label: string): string {
  const normalized = label.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
  if (!normalized) throw new ReviewError("ANNOTATION_LABEL_REQUIRED", 400);
  return normalized.slice(0, 120);
}

function payloadType(payload: unknown): string {
  if (Array.isArray(payload)) return "array";
  if (payload === null) return "null";
  return typeof payload;
}

function annotationPayloadAuditSummary(payload: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = { payloadType: payloadType(payload) };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return summary;

  const record = payload as Record<string, unknown>;
  if (typeof record.type === "string" && record.type.trim()) {
    summary.payloadKind = normalizeAuditCode(record.type);
  }
  if (typeof record.engine === "string" && record.engine.trim()) {
    summary.engine = normalizeAuditCode(record.engine);
  }
  if (Array.isArray(record.pageNumbers)) {
    summary.pageCount = new Set(record.pageNumbers.filter((page) => Number.isInteger(page))).size;
  } else if (Number.isInteger(record.pageNumber)) {
    summary.pageCount = 1;
  }
  if (Array.isArray(record.tokens)) {
    summary.tokenCount = record.tokens.length;
    summary.hasBoundingBoxes = record.tokens.some((token) => hasBoundingBox(token));
  } else {
    summary.tokenCount = 0;
    summary.hasBoundingBoxes = hasBoundingBox(record);
  }
  return summary;
}

function hasBoundingBox(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Array.isArray((value as Record<string, unknown>).bbox);
}

function normalizeAuditCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 80);
}
