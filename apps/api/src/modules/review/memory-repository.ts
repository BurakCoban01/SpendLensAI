import { randomUUID } from "node:crypto";
import type {
  CreateCorrectionResult,
  ReviewMetricSample,
  ReviewRepository,
  StoredActiveLearningSuggestion,
  StoredAnnotation,
  StoredCorrection,
  StoredReviewTask
} from "./types";

const statuses: StoredReviewTask["status"][] = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"];

export class InMemoryReviewRepository implements ReviewRepository {
  private reviewTasks = new Map<string, StoredReviewTask>();
  private corrections = new Map<string, StoredCorrection[]>();
  private annotations = new Map<string, StoredAnnotation>();
  private suggestions = new Map<string, StoredActiveLearningSuggestion>();

  async createReviewTask(input: Parameters<ReviewRepository["createReviewTask"]>[0]): Promise<StoredReviewTask> {
    const now = new Date();
    const task: StoredReviewTask = {
      id: randomUUID(),
      tenantId: input.tenantId,
      documentFileId: input.documentFileId,
      status: "QUEUED",
      assignedToId: input.assignedToId ?? null,
      reasonCodes: input.reasonCodes,
      dueAt: input.dueAt ?? null,
      createdAt: now,
      completedAt: null
    };
    this.reviewTasks.set(task.id, task);
    return task;
  }

  async listReviewTasks(input: Parameters<ReviewRepository["listReviewTasks"]>[0]): Promise<StoredReviewTask[]> {
    return [...this.reviewTasks.values()]
      .filter(
        (task) =>
          task.tenantId === input.tenantId &&
          (!input.status || task.status === input.status) &&
          (input.assignedToId === undefined || task.assignedToId === input.assignedToId)
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, input.limit ?? Number.POSITIVE_INFINITY);
  }

  async assignReviewTask(input: Parameters<ReviewRepository["assignReviewTask"]>[0]): Promise<StoredReviewTask | null> {
    const task = this.reviewTasks.get(input.reviewTaskId);
    if (!task || task.tenantId !== input.tenantId) return null;
    const assigned = { ...task, assignedToId: input.assignedToId };
    this.reviewTasks.set(task.id, assigned);
    return assigned;
  }

  async escalateReviewTask(input: Parameters<ReviewRepository["escalateReviewTask"]>[0]): Promise<StoredReviewTask | null> {
    const task = this.reviewTasks.get(input.reviewTaskId);
    if (!task || task.tenantId !== input.tenantId) return null;
    const escalated = {
      ...task,
      assignedToId: input.assignedToId === undefined ? task.assignedToId : input.assignedToId,
      reasonCodes: [...new Set([...task.reasonCodes, ...input.reasonCodes])]
    };
    this.reviewTasks.set(task.id, escalated);
    return escalated;
  }

  async completeReviewTask(input: Parameters<ReviewRepository["completeReviewTask"]>[0]): Promise<StoredReviewTask | null> {
    const task = this.reviewTasks.get(input.reviewTaskId);
    if (!task || task.tenantId !== input.tenantId) return null;
    const completed = { ...task, status: "SUCCEEDED" as const, completedAt: new Date() };
    this.reviewTasks.set(task.id, completed);
    return completed;
  }

  async rejectReviewTask(input: Parameters<ReviewRepository["rejectReviewTask"]>[0]): Promise<StoredReviewTask | null> {
    const task = this.reviewTasks.get(input.reviewTaskId);
    if (!task || task.tenantId !== input.tenantId) return null;
    const rejected = { ...task, status: "FAILED" as const, completedAt: new Date() };
    this.reviewTasks.set(task.id, rejected);
    return rejected;
  }

  async createCorrection(input: Parameters<ReviewRepository["createCorrection"]>[0]): Promise<CreateCorrectionResult> {
    const now = new Date();
    const correction: StoredCorrection = {
      id: randomUUID(),
      tenantId: input.tenantId,
      documentFileId: input.documentFileId,
      fieldName: input.fieldName ?? null,
      beforeValue: input.beforeValue ?? null,
      afterValue: input.afterValue,
      correctedById: input.correctedById,
      createdAt: now
    };
    const annotation: StoredAnnotation | null = input.createAnnotation
      ? {
          id: randomUUID(),
          tenantId: input.tenantId,
          datasetItemId: null,
          documentFileId: input.documentFileId,
          label: input.annotationLabel ?? input.fieldName ?? "ocr_correction",
          payload: input.annotationPayload ?? {
            fieldName: input.fieldName ?? null,
            beforeValue: input.beforeValue ?? null,
            afterValue: input.afterValue
          },
          createdById: input.correctedById,
          createdAt: now
        }
      : null;
    const suggestion: StoredActiveLearningSuggestion = {
      id: randomUUID(),
      tenantId: input.tenantId,
      documentFileId: input.documentFileId,
      reasonCode: "HUMAN_CORRECTION",
      score: "1",
      payload: {
        correctionId: correction.id,
        fieldName: correction.fieldName,
        annotationId: annotation?.id ?? null
      },
      createdAt: now,
      acceptedAt: null
    };
    this.corrections.set(input.documentFileId, [...(this.corrections.get(input.documentFileId) ?? []), correction]);
    if (annotation) this.annotations.set(annotation.id, annotation);
    this.suggestions.set(suggestion.id, suggestion);
    return { correction, annotation, suggestion };
  }

  async createAnnotation(input: Parameters<ReviewRepository["createAnnotation"]>[0]): Promise<StoredAnnotation> {
    const annotation: StoredAnnotation = {
      id: randomUUID(),
      tenantId: input.tenantId,
      datasetItemId: null,
      documentFileId: input.documentFileId,
      label: input.label,
      payload: input.payload,
      createdById: input.createdById,
      createdAt: new Date()
    };
    this.annotations.set(annotation.id, annotation);
    return annotation;
  }

  async listCorrections(input: Parameters<ReviewRepository["listCorrections"]>[0]): Promise<StoredCorrection[]> {
    return (this.corrections.get(input.documentFileId) ?? [])
      .filter((correction) => correction.tenantId === input.tenantId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async listAnnotations(input: Parameters<ReviewRepository["listAnnotations"]>[0]): Promise<StoredAnnotation[]> {
    const allowed = input.documentFileIds ? new Set(input.documentFileIds) : null;
    return [...this.annotations.values()]
      .filter(
        (annotation) =>
          annotation.tenantId === input.tenantId &&
          (!allowed || (annotation.documentFileId !== null && allowed.has(annotation.documentFileId)))
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async listActiveLearningSuggestions(
    input: Parameters<ReviewRepository["listActiveLearningSuggestions"]>[0]
  ): Promise<StoredActiveLearningSuggestion[]> {
    const allowed = input.documentFileIds ? new Set(input.documentFileIds) : null;
    return [...this.suggestions.values()]
      .filter((suggestion) => suggestion.tenantId === input.tenantId && (!allowed || allowed.has(suggestion.documentFileId)))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, input.limit ?? Number.POSITIVE_INFINITY);
  }

  async metrics(): Promise<{
    tasksByStatus: ReviewMetricSample[];
    correctionCount: number;
    annotationCount: number;
    activeLearningSuggestionCount: number;
    correctionRate: number;
  }> {
    const tasksByStatus = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<StoredReviewTask["status"], number>;
    for (const task of this.reviewTasks.values()) tasksByStatus[task.status] += 1;
    const correctionCount = [...this.corrections.values()].reduce((count, rows) => count + rows.length, 0);
    const completedTasks = tasksByStatus.SUCCEEDED;
    return {
      tasksByStatus: statuses.map((status) => ({ status, count: tasksByStatus[status] })),
      correctionCount,
      annotationCount: this.annotations.size,
      activeLearningSuggestionCount: this.suggestions.size,
      correctionRate: completedTasks > 0 ? correctionCount / completedTasks : 0
    };
  }
}
