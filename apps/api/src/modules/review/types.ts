import type { JobStatus } from "@prisma/client";

export type StoredReviewTask = {
  id: string;
  tenantId: string;
  documentFileId: string;
  status: JobStatus;
  assignedToId: string | null;
  reasonCodes: string[];
  dueAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type StoredCorrection = {
  id: string;
  tenantId: string;
  documentFileId: string;
  fieldName: string | null;
  beforeValue: string | null;
  afterValue: string;
  correctedById: string;
  createdAt: Date;
};

export type StoredAnnotation = {
  id: string;
  tenantId: string;
  datasetItemId: string | null;
  documentFileId: string | null;
  label: string;
  payload: unknown;
  createdById: string;
  createdAt: Date;
};

export type StoredActiveLearningSuggestion = {
  id: string;
  tenantId: string;
  documentFileId: string;
  reasonCode: string;
  score: string;
  payload: unknown;
  createdAt: Date;
  acceptedAt: Date | null;
};

export type CreateCorrectionResult = {
  correction: StoredCorrection;
  annotation: StoredAnnotation | null;
  suggestion: StoredActiveLearningSuggestion;
};

export type ReviewMetricSample = {
  status?: JobStatus;
  count: number;
};

export type ReviewMetricsSnapshot = {
  tasksByStatus: ReviewMetricSample[];
  correctionCount: number;
  annotationCount: number;
  activeLearningSuggestionCount: number;
  correctionRate: number;
};

export type ReviewRepository = {
  createReviewTask(input: {
    tenantId: string;
    documentFileId: string;
    reasonCodes: string[];
    assignedToId?: string | null;
    dueAt?: Date | null;
    actorUserId: string;
  }): Promise<StoredReviewTask>;
  listReviewTasks(input: { tenantId: string; status?: JobStatus; assignedToId?: string | null; limit?: number }): Promise<StoredReviewTask[]>;
  assignReviewTask(input: {
    tenantId: string;
    reviewTaskId: string;
    assignedToId: string | null;
    actorUserId: string;
  }): Promise<StoredReviewTask | null>;
  escalateReviewTask(input: {
    tenantId: string;
    reviewTaskId: string;
    actorUserId: string;
    reasonCodes: string[];
    assignedToId?: string | null;
    note?: string | null;
  }): Promise<StoredReviewTask | null>;
  completeReviewTask(input: { tenantId: string; reviewTaskId: string; actorUserId: string }): Promise<StoredReviewTask | null>;
  rejectReviewTask(input: { tenantId: string; reviewTaskId: string; actorUserId: string; rejectionReason: string }): Promise<StoredReviewTask | null>;
  createCorrection(input: {
    tenantId: string;
    documentFileId: string;
    fieldName?: string | null;
    beforeValue?: string | null;
    afterValue: string;
    correctedById: string;
    createAnnotation: boolean;
    annotationLabel?: string | null;
    annotationPayload?: unknown;
  }): Promise<CreateCorrectionResult>;
  createAnnotation(input: {
    tenantId: string;
    documentFileId: string;
    label: string;
    payload: unknown;
    createdById: string;
  }): Promise<StoredAnnotation>;
  listCorrections(input: { tenantId: string; documentFileId: string }): Promise<StoredCorrection[]>;
  listAnnotations(input: { tenantId: string; documentFileIds?: string[] }): Promise<StoredAnnotation[]>;
  listActiveLearningSuggestions(input: { tenantId: string; documentFileIds?: string[]; limit?: number }): Promise<StoredActiveLearningSuggestion[]>;
  metrics(): Promise<ReviewMetricsSnapshot>;
};
