import { Prisma, PrismaClient, type JobStatus } from "@prisma/client";
import type {
  CreateCorrectionResult,
  ReviewMetricSample,
  ReviewRepository,
  StoredActiveLearningSuggestion,
  StoredAnnotation,
  StoredCorrection
} from "./types";

const statuses: JobStatus[] = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"];

export class PrismaReviewRepository implements ReviewRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createReviewTask(input: Parameters<ReviewRepository["createReviewTask"]>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.oCRReviewTask.create({
        data: {
          tenantId: input.tenantId,
          documentFileId: input.documentFileId,
          status: "QUEUED",
          assignedToId: input.assignedToId ?? null,
          reasonCodes: input.reasonCodes,
          dueAt: input.dueAt ?? null
        }
      });
      return task;
    });
  }

  async listReviewTasks(input: Parameters<ReviewRepository["listReviewTasks"]>[0]) {
    return this.prisma.oCRReviewTask.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {})
      },
      orderBy: { createdAt: "desc" },
      ...(input.limit ? { take: input.limit } : {})
    });
  }

  async assignReviewTask(input: Parameters<ReviewRepository["assignReviewTask"]>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.oCRReviewTask.findFirst({ where: { id: input.reviewTaskId, tenantId: input.tenantId } });
      if (!existing) return null;
      const task = await tx.oCRReviewTask.update({
        where: { id: existing.id },
        data: { assignedToId: input.assignedToId }
      });
      return task;
    });
  }

  async escalateReviewTask(input: Parameters<ReviewRepository["escalateReviewTask"]>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.oCRReviewTask.findFirst({ where: { id: input.reviewTaskId, tenantId: input.tenantId } });
      if (!existing) return null;
      const reasonCodes = [...new Set([...existing.reasonCodes, ...input.reasonCodes])];
      const task = await tx.oCRReviewTask.update({
        where: { id: existing.id },
        data: {
          reasonCodes,
          ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {})
        }
      });
      return task;
    });
  }

  async completeReviewTask(input: Parameters<ReviewRepository["completeReviewTask"]>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.oCRReviewTask.findFirst({ where: { id: input.reviewTaskId, tenantId: input.tenantId } });
      if (!existing) return null;
      const task = await tx.oCRReviewTask.update({
        where: { id: existing.id },
        data: { status: "SUCCEEDED", completedAt: new Date() }
      });
      return task;
    });
  }

  async rejectReviewTask(input: Parameters<ReviewRepository["rejectReviewTask"]>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.oCRReviewTask.findFirst({ where: { id: input.reviewTaskId, tenantId: input.tenantId } });
      if (!existing) return null;
      const task = await tx.oCRReviewTask.update({
        where: { id: existing.id },
        data: { status: "FAILED", completedAt: new Date() }
      });
      return task;
    });
  }

  async createCorrection(input: Parameters<ReviewRepository["createCorrection"]>[0]): Promise<CreateCorrectionResult> {
    return this.prisma.$transaction(async (tx) => {
      const correction = await tx.oCRCorrection.create({
        data: {
          tenantId: input.tenantId,
          documentFileId: input.documentFileId,
          fieldName: input.fieldName ?? null,
          beforeValue: input.beforeValue ?? null,
          afterValue: input.afterValue,
          correctedById: input.correctedById
        }
      });
      const annotation = input.createAnnotation
        ? await tx.annotation.create({
            data: {
              tenantId: input.tenantId,
              documentFileId: input.documentFileId,
              label: input.annotationLabel ?? input.fieldName ?? "ocr_correction",
              payload:
                input.annotationPayload === undefined
                  ? {
                      fieldName: input.fieldName ?? null,
                      beforeValue: input.beforeValue ?? null,
                      afterValue: input.afterValue
                    }
                  : (input.annotationPayload as Prisma.InputJsonValue),
              createdById: input.correctedById
            }
          })
        : null;
      const suggestion = await tx.activeLearningSuggestion.create({
        data: {
          tenantId: input.tenantId,
          documentFileId: input.documentFileId,
          reasonCode: "HUMAN_CORRECTION",
          score: new Prisma.Decimal("1"),
          payload: {
            correctionId: correction.id,
            fieldName: correction.fieldName,
            annotationId: annotation?.id ?? null
          }
        }
      });
      return {
        correction,
        annotation,
        suggestion: serializeSuggestion(suggestion)
      };
    });
  }

  async createAnnotation(input: Parameters<ReviewRepository["createAnnotation"]>[0]): Promise<StoredAnnotation> {
    return this.prisma.$transaction(async (tx) => {
      const annotation = await tx.annotation.create({
        data: {
          tenantId: input.tenantId,
          documentFileId: input.documentFileId,
          label: input.label,
          payload: input.payload as Prisma.InputJsonValue,
          createdById: input.createdById
        }
      });
      return annotation;
    });
  }

  async listCorrections(input: Parameters<ReviewRepository["listCorrections"]>[0]): Promise<StoredCorrection[]> {
    return this.prisma.oCRCorrection.findMany({
      where: { tenantId: input.tenantId, documentFileId: input.documentFileId },
      orderBy: { createdAt: "desc" }
    });
  }

  async listAnnotations(input: Parameters<ReviewRepository["listAnnotations"]>[0]): Promise<StoredAnnotation[]> {
    return this.prisma.annotation.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.documentFileIds ? { documentFileId: { in: input.documentFileIds } } : {})
      },
      orderBy: { createdAt: "desc" }
    });
  }

  async listActiveLearningSuggestions(
    input: Parameters<ReviewRepository["listActiveLearningSuggestions"]>[0]
  ): Promise<StoredActiveLearningSuggestion[]> {
    const suggestions = await this.prisma.activeLearningSuggestion.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.documentFileIds ? { documentFileId: { in: input.documentFileIds } } : {})
      },
      orderBy: { createdAt: "desc" },
      ...(input.limit ? { take: input.limit } : {})
    });
    return suggestions.map(serializeSuggestion);
  }

  async metrics(): Promise<{
    tasksByStatus: ReviewMetricSample[];
    correctionCount: number;
    annotationCount: number;
    activeLearningSuggestionCount: number;
    correctionRate: number;
  }> {
    const taskRows = await this.prisma.oCRReviewTask.groupBy({
      by: ["status"],
      _count: { _all: true }
    });
    const [correctionCount, annotationCount, activeLearningSuggestionCount] = await Promise.all([
      this.prisma.oCRCorrection.count(),
      this.prisma.annotation.count(),
      this.prisma.activeLearningSuggestion.count()
    ]);
    const taskSummary = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<JobStatus, number>;
    for (const row of taskRows) taskSummary[row.status] = row._count._all;
    return {
      tasksByStatus: statuses.map((status) => ({ status, count: taskSummary[status] })),
      correctionCount,
      annotationCount,
      activeLearningSuggestionCount,
      correctionRate: taskSummary.SUCCEEDED > 0 ? correctionCount / taskSummary.SUCCEEDED : 0
    };
  }
}

function serializeSuggestion(suggestion: {
  id: string;
  tenantId: string;
  documentFileId: string;
  reasonCode: string;
  score: Prisma.Decimal;
  payload: unknown;
  createdAt: Date;
  acceptedAt: Date | null;
}): StoredActiveLearningSuggestion {
  return {
    ...suggestion,
    score: suggestion.score.toString()
  };
}
