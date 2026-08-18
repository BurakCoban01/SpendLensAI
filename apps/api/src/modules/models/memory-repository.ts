import { randomUUID } from "node:crypto";
import type {
  CreateModelVersionInput,
  ModelRepository,
  StoredModelEvaluationRun,
  StoredModelTrainingRun,
  StoredModelVersion
} from "./types";

export class InMemoryModelRepository implements ModelRepository {
  private versions = new Map<string, StoredModelVersion>();
  private trainingRuns = new Map<string, StoredModelTrainingRun>();
  private evaluationRuns = new Map<string, StoredModelEvaluationRun>();

  async listModelVersions(input: { tenantId: string }): Promise<StoredModelVersion[]> {
    return [...this.versions.values()]
      .filter((version) => version.tenantId === input.tenantId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async findModelVersion(input: { tenantId: string; modelVersionId: string }): Promise<StoredModelVersion | null> {
    const version = this.versions.get(input.modelVersionId);
    return version?.tenantId === input.tenantId ? version : null;
  }

  async createModelVersion(input: CreateModelVersionInput): Promise<StoredModelVersion> {
    const now = new Date();
    const version: StoredModelVersion = {
      id: randomUUID(),
      tenantId: input.tenantId,
      name: input.name,
      engine: input.engine,
      status: input.status ?? "CANDIDATE",
      artifactBucket: input.artifactBucket ?? null,
      artifactKey: input.artifactKey ?? null,
      metrics: input.metrics ?? null,
      promotedAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.versions.set(version.id, version);
    return version;
  }

  async updateModelVersionMetrics(input: { tenantId: string; modelVersionId: string; metrics: unknown }): Promise<StoredModelVersion | null> {
    const existing = await this.findModelVersion(input);
    if (!existing) return null;
    const updated = { ...existing, metrics: input.metrics, updatedAt: new Date() };
    this.versions.set(updated.id, updated);
    return updated;
  }

  async promoteModelVersion(input: { tenantId: string; modelVersionId: string }): Promise<StoredModelVersion | null> {
    const existing = await this.findModelVersion(input);
    if (!existing) return null;
    const now = new Date();
    for (const version of this.versions.values()) {
      if (version.tenantId === input.tenantId && version.engine === existing.engine && version.status === "ACTIVE") {
        this.versions.set(version.id, { ...version, status: "ARCHIVED", updatedAt: now });
      }
    }
    const promoted = { ...existing, status: "ACTIVE" as const, promotedAt: now, updatedAt: now };
    this.versions.set(promoted.id, promoted);
    return promoted;
  }

  async createTrainingRun(input: { tenantId: string; profile: string; seed: number; datasetId?: string | null }): Promise<StoredModelTrainingRun> {
    const now = new Date();
    const run: StoredModelTrainingRun = {
      id: randomUUID(),
      tenantId: input.tenantId,
      modelVersionId: null,
      datasetId: input.datasetId ?? null,
      status: "RUNNING",
      profile: input.profile,
      seed: input.seed,
      metrics: null,
      logsKey: null,
      failureReason: null,
      createdAt: now,
      startedAt: now,
      completedAt: null
    };
    this.trainingRuns.set(run.id, run);
    return run;
  }

  async completeTrainingRun(input: Parameters<ModelRepository["completeTrainingRun"]>[0]): Promise<StoredModelTrainingRun | null> {
    const existing = this.trainingRuns.get(input.trainingRunId);
    if (!existing || existing.tenantId !== input.tenantId) return null;
    const completed = {
      ...existing,
      status: "SUCCEEDED" as const,
      modelVersionId: input.modelVersionId,
      metrics: input.metrics,
      logsKey: input.logsKey ?? null,
      completedAt: new Date()
    };
    this.trainingRuns.set(completed.id, completed);
    return completed;
  }

  async failTrainingRun(input: { tenantId: string; trainingRunId: string; failureReason: string }): Promise<StoredModelTrainingRun | null> {
    const existing = this.trainingRuns.get(input.trainingRunId);
    if (!existing || existing.tenantId !== input.tenantId) return null;
    const failed = { ...existing, status: "FAILED" as const, failureReason: input.failureReason, completedAt: new Date() };
    this.trainingRuns.set(failed.id, failed);
    return failed;
  }

  async listTrainingRuns(input: { tenantId: string }): Promise<StoredModelTrainingRun[]> {
    return [...this.trainingRuns.values()]
      .filter((run) => run.tenantId === input.tenantId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async createEvaluationRun(input: Parameters<ModelRepository["createEvaluationRun"]>[0]): Promise<StoredModelEvaluationRun> {
    const now = new Date();
    const run: StoredModelEvaluationRun = {
      id: randomUUID(),
      tenantId: input.tenantId,
      modelVersionId: input.modelVersionId,
      datasetId: null,
      status: "SUCCEEDED",
      metrics: input.metrics,
      reportKey: input.reportKey ?? null,
      failureReason: null,
      createdAt: now,
      completedAt: now
    };
    this.evaluationRuns.set(run.id, run);
    return run;
  }

  async listEvaluationRuns(input: { tenantId: string; modelVersionId?: string }): Promise<StoredModelEvaluationRun[]> {
    return [...this.evaluationRuns.values()]
      .filter((run) => run.tenantId === input.tenantId && (!input.modelVersionId || run.modelVersionId === input.modelVersionId))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }
}
