import type { PrismaClient } from "@prisma/client";
import type { CreateModelVersionInput, ModelRepository } from "./types";

export class PrismaModelRepository implements ModelRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listModelVersions(input: { tenantId: string }) {
    return this.prisma.modelVersion.findMany({ where: { tenantId: input.tenantId }, orderBy: { createdAt: "desc" } });
  }

  async findModelVersion(input: { tenantId: string; modelVersionId: string }) {
    return this.prisma.modelVersion.findFirst({ where: { tenantId: input.tenantId, id: input.modelVersionId } });
  }

  async createModelVersion(input: CreateModelVersionInput) {
    return this.prisma.modelVersion.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        engine: input.engine,
        status: input.status ?? "CANDIDATE",
        artifactBucket: input.artifactBucket ?? null,
        artifactKey: input.artifactKey ?? null,
        ...(input.metrics === undefined ? {} : { metrics: input.metrics as never })
      }
    });
  }

  async updateModelVersionMetrics(input: { tenantId: string; modelVersionId: string; metrics: unknown }) {
    const existing = await this.prisma.modelVersion.findFirst({ where: { tenantId: input.tenantId, id: input.modelVersionId } });
    if (!existing) return null;
    return this.prisma.modelVersion.update({
      where: { id: existing.id },
      data: { metrics: input.metrics as never }
    });
  }

  async promoteModelVersion(input: { tenantId: string; modelVersionId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.modelVersion.findFirst({ where: { tenantId: input.tenantId, id: input.modelVersionId } });
      if (!existing) return null;
      await tx.modelVersion.updateMany({
        where: { tenantId: input.tenantId, engine: existing.engine, status: "ACTIVE", id: { not: existing.id } },
        data: { status: "ARCHIVED" }
      });
      return tx.modelVersion.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", promotedAt: new Date() }
      });
    });
  }

  async createTrainingRun(input: { tenantId: string; profile: string; seed: number; datasetId?: string | null }) {
    return this.prisma.modelTrainingRun.create({
      data: {
        tenantId: input.tenantId,
        profile: input.profile,
        seed: input.seed,
        datasetId: input.datasetId ?? null,
        status: "RUNNING",
        startedAt: new Date()
      }
    });
  }

  async completeTrainingRun(input: Parameters<ModelRepository["completeTrainingRun"]>[0]) {
    const existing = await this.prisma.modelTrainingRun.findFirst({
      where: { tenantId: input.tenantId, id: input.trainingRunId }
    });
    if (!existing) return null;
    return this.prisma.modelTrainingRun.update({
      where: { id: existing.id },
      data: {
        status: "SUCCEEDED",
        modelVersionId: input.modelVersionId,
        metrics: input.metrics as never,
        logsKey: input.logsKey ?? null,
        completedAt: new Date()
      }
    });
  }

  async failTrainingRun(input: { tenantId: string; trainingRunId: string; failureReason: string }) {
    const existing = await this.prisma.modelTrainingRun.findFirst({
      where: { tenantId: input.tenantId, id: input.trainingRunId }
    });
    if (!existing) return null;
    return this.prisma.modelTrainingRun.update({
      where: { id: existing.id },
      data: { status: "FAILED", failureReason: input.failureReason, completedAt: new Date() }
    });
  }

  async listTrainingRuns(input: { tenantId: string }) {
    return this.prisma.modelTrainingRun.findMany({ where: { tenantId: input.tenantId }, orderBy: { createdAt: "desc" } });
  }

  async createEvaluationRun(input: Parameters<ModelRepository["createEvaluationRun"]>[0]) {
    return this.prisma.modelEvaluationRun.create({
      data: {
        tenantId: input.tenantId,
        modelVersionId: input.modelVersionId,
        status: "SUCCEEDED",
        metrics: input.metrics as never,
        reportKey: input.reportKey ?? null,
        completedAt: new Date()
      }
    });
  }

  async listEvaluationRuns(input: { tenantId: string; modelVersionId?: string }) {
    return this.prisma.modelEvaluationRun.findMany({
      where: { tenantId: input.tenantId, ...(input.modelVersionId ? { modelVersionId: input.modelVersionId } : {}) },
      orderBy: { createdAt: "desc" }
    });
  }
}
