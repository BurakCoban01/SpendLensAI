import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AuthPrincipal } from "../auth/types";
import type { AuditRepository } from "../audit/types";
import type { CacheService } from "../cache/service";
import type { DocumentStorage } from "../documents/types";
import type { EventService } from "../events/service";
import type { ReportRepository, StoredExportJob } from "../reports/types";
import type {
  CategoryEvaluationRunner,
  CategoryTrainingRunner,
  CustomOcrTrainingRunner,
  ModelRepository,
  OcrBenchmarkResult,
  OcrBenchmarkRunner,
  StoredModelVersion
} from "./types";
import { getCustomOcrPromotionBlockCode } from "./custom-ocr-readiness";

export class ModelError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400,
    public readonly details?: unknown
  ) {
    super(code);
  }
}

export class ModelService {
  constructor(
    private readonly repository: ModelRepository,
    private readonly categoryTrainingRunner: CategoryTrainingRunner,
    private readonly customOcrTrainingRunner: CustomOcrTrainingRunner,
    private readonly ocrBenchmarkRunner?: OcrBenchmarkRunner,
    private readonly categoryEvaluationRunner?: CategoryEvaluationRunner,
    private readonly events?: EventService,
    private readonly reports?: ReportRepository,
    private readonly cache?: CacheService,
    private readonly audit?: AuditRepository,
    private readonly artifactStorage?: DocumentStorage,
    private readonly artifactBucket?: string
  ) {}

  async overview(principal: AuthPrincipal) {
    const version = await this.readRegistryCacheVersion(principal.tenantId);
    const cacheKey = modelRegistryOverviewCacheKey(principal.tenantId, version);
    const cached = await this.readCachedOverview(cacheKey);
    if (cached) return cached;

    const [models, trainingRuns, evaluationRuns] = await Promise.all([
      this.repository.listModelVersions({ tenantId: principal.tenantId }),
      this.repository.listTrainingRuns({ tenantId: principal.tenantId }),
      this.repository.listEvaluationRuns({ tenantId: principal.tenantId })
    ]);
    const overview = { models, trainingRuns, evaluationRuns };
    await this.rememberOverview(cacheKey, overview);
    return overview;
  }

  async ocrCapabilities(
    principal: AuthPrincipal,
    configured: { tesseract: boolean; customOcr: boolean }
  ) {
    const versions = await this.repository.listModelVersions({ tenantId: principal.tenantId });
    const active = versions.find((version) => version.engine === "CUSTOM_CRNN" && version.status === "ACTIVE") ?? null;
    const activeModel = active
      ? {
          id: active.id,
          name: active.name,
          status: active.status,
          metrics: active.metrics,
          promotedAt: active.promotedAt,
          updatedAt: active.updatedAt
        }
      : null;

    return {
      tesseract: { configured: configured.tesseract },
      customOcr: {
        configured: configured.customOcr,
        available: configured.customOcr && activeModel !== null,
        activeModel
      }
    };
  }

  async trainCategorySmoke(input: { principal: AuthPrincipal; seed: number; samplesPerCategory: number }) {
    return this.trainCategory(input, {
      profile: "category-smoke",
      name: `category-ml-v1-seed-${input.seed}`,
      failureCode: "CATEGORY_TRAINING_FAILED"
    });
  }

  async trainCategoryFull(input: { principal: AuthPrincipal; seed: number; samplesPerCategory: number }) {
    return this.trainCategory(input, {
      profile: "category-full-local",
      name: `category-ml-full-seed-${input.seed}`,
      failureCode: "CATEGORY_FULL_TRAINING_FAILED"
    });
  }

  private async trainCategory(
    input: { principal: AuthPrincipal; seed: number; samplesPerCategory: number },
    options: { profile: string; name: string; failureCode: string }
  ) {
    const trainingRun = await this.repository.createTrainingRun({
      tenantId: input.principal.tenantId,
      profile: options.profile,
      seed: input.seed
    });
    await this.events?.publish({
      tenantId: input.principal.tenantId,
      topic: "model.training.started",
      aggregateId: trainingRun.id,
      payload: { trainingRunId: trainingRun.id, profile: trainingRun.profile, seed: input.seed }
    });

    try {
      const result = await this.categoryTrainingRunner({
        tenantId: input.principal.tenantId,
        trainingRunId: trainingRun.id,
        seed: input.seed,
        samplesPerCategory: input.samplesPerCategory
      });
      const modelVersion = await this.repository.createModelVersion({
        tenantId: input.principal.tenantId,
        name: options.name,
        engine: "CATEGORY_ML",
        status: "CANDIDATE",
        artifactBucket: result.artifactBucket,
        artifactKey: result.artifactKey,
        metrics: result.metrics
      });
      const completedTrainingRun = await this.repository.completeTrainingRun({
        tenantId: input.principal.tenantId,
        trainingRunId: trainingRun.id,
        modelVersionId: modelVersion.id,
        metrics: result.metrics,
        logsKey: result.reportKey
      });
      if (!completedTrainingRun) throw new Error("MODEL_TRAINING_RUN_COMPLETION_FAILED");
      const evaluationRun = await this.repository.createEvaluationRun({
        tenantId: input.principal.tenantId,
        modelVersionId: modelVersion.id,
        metrics: result.metrics,
        reportKey: result.reportKey
      });
      await this.events?.publish({
        tenantId: input.principal.tenantId,
        topic: "model.training.completed",
        aggregateId: trainingRun.id,
        payload: {
          trainingRunId: trainingRun.id,
          modelVersionId: modelVersion.id,
          status: "SUCCEEDED",
          metrics: result.metrics
        }
      });
      await this.events?.publish({
        tenantId: input.principal.tenantId,
        topic: "model.evaluation.completed",
        aggregateId: evaluationRun.id,
        payload: {
          evaluationRunId: evaluationRun.id,
          modelVersionId: modelVersion.id,
          metrics: result.metrics
        }
      });
      await this.recordModelAudit(input.principal, {
        action: "model.training.completed",
        resourceType: "ModelVersion",
        resourceId: modelVersion.id,
        metadata: {
          engine: modelVersion.engine,
          modelVersionId: modelVersion.id,
          trainingRunId: completedTrainingRun.id,
          evaluationRunId: evaluationRun.id,
          profile: options.profile,
          status: completedTrainingRun.status,
          metricKeys: Object.keys(result.metrics)
        }
      });
      await this.bumpRegistryCacheVersion(input.principal.tenantId);
      return { modelVersion, trainingRun: completedTrainingRun, evaluationRun };
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : options.failureCode;
      await this.repository.failTrainingRun({
        tenantId: input.principal.tenantId,
        trainingRunId: trainingRun.id,
        failureReason
      });
      await this.recordModelAudit(input.principal, {
        action: "model.training.failed",
        resourceType: "ModelTrainingRun",
        resourceId: trainingRun.id,
        metadata: { trainingRunId: trainingRun.id, profile: options.profile, failureCode: options.failureCode }
      });
      await this.bumpRegistryCacheVersion(input.principal.tenantId);
      await this.events?.publish({
        tenantId: input.principal.tenantId,
        topic: "model.training.completed",
        aggregateId: trainingRun.id,
        payload: { trainingRunId: trainingRun.id, status: "FAILED", failureReason }
      });
      throw new ModelError(options.failureCode, 500);
    }
  }

  async trainCustomOcrSmoke(input: { principal: AuthPrincipal; seed: number; samples: number; epochs: number }) {
    return this.trainCustomOcr(input, {
      profile: "custom-ocr-smoke",
      name: `custom-crnn-smoke-seed-${input.seed}`,
      failureCode: "CUSTOM_OCR_TRAINING_FAILED"
    });
  }

  async trainCustomOcrFull(input: { principal: AuthPrincipal; seed: number; samples: number; epochs: number }) {
    return this.trainCustomOcr(input, {
      profile: "custom-ocr-full-local",
      name: `custom-crnn-full-seed-${input.seed}`,
      failureCode: "CUSTOM_OCR_FULL_TRAINING_FAILED"
    });
  }

  async trainCustomOcrFromDatasetExport(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    exportJobId: string;
    seed: number;
    samples: number;
    epochs: number;
  }) {
    if (!this.reports) throw new ModelError("REPORT_REPOSITORY_NOT_CONFIGURED", 500);
    const exportJob = await this.findUsableDatasetExport(input.principal.tenantId, input.workspaceId, input.exportJobId);
    return this.trainCustomOcr(
      {
        principal: input.principal,
        seed: input.seed,
        samples: input.samples,
        epochs: input.epochs,
        datasetExport: exportJob
      },
      {
        profile: "custom-ocr-dataset-export-smoke",
        name: `custom-crnn-dataset-${exportJob.id.slice(0, 8)}-seed-${input.seed}`,
        failureCode: "CUSTOM_OCR_DATASET_EXPORT_TRAINING_FAILED"
      }
    );
  }

  private async trainCustomOcr(
    input: { principal: AuthPrincipal; seed: number; samples: number; epochs: number; datasetExport?: StoredExportJob },
    options: { profile: string; name: string; failureCode: string }
  ) {
    const trainingRun = await this.repository.createTrainingRun({
      tenantId: input.principal.tenantId,
      profile: options.profile,
      seed: input.seed,
      datasetId: input.datasetExport?.id ?? null
    });
    await this.events?.publish({
      tenantId: input.principal.tenantId,
      topic: "model.training.started",
      aggregateId: trainingRun.id,
      payload: {
        trainingRunId: trainingRun.id,
        profile: trainingRun.profile,
        seed: input.seed,
        samples: input.samples,
        epochs: input.epochs,
        datasetExportJobId: input.datasetExport?.id ?? null,
        datasetObjectKey: input.datasetExport?.objectKey ?? null
      }
    });

    try {
      const result = await this.customOcrTrainingRunner({
        tenantId: input.principal.tenantId,
        trainingRunId: trainingRun.id,
        seed: input.seed,
        samples: input.samples,
        epochs: input.epochs,
        profile: options.profile,
        ...(input.datasetExport?.objectKey
          ? {
              datasetExport: {
                exportJobId: input.datasetExport.id,
                workspaceId: input.datasetExport.workspaceId,
                bucket: input.datasetExport.bucket,
                objectKey: input.datasetExport.objectKey
              }
            }
          : {})
      });
      const trainingResult = {
        ...result,
        metrics: normalizeCustomOcrTrainingMetrics(result.metrics, options.profile)
      };
      const registeredArtifact = await this.persistCustomOcrArtifactsIfConfigured({
        tenantId: input.principal.tenantId,
        trainingRunId: trainingRun.id,
        result: trainingResult
      });
      const modelVersion = await this.repository.createModelVersion({
        tenantId: input.principal.tenantId,
        name: options.name,
        engine: "CUSTOM_CRNN",
        status: "CANDIDATE",
        artifactBucket: registeredArtifact.artifactBucket,
        artifactKey: registeredArtifact.artifactKey,
        metrics: registeredArtifact.metrics
      });
      const completedTrainingRun = await this.repository.completeTrainingRun({
        tenantId: input.principal.tenantId,
        trainingRunId: trainingRun.id,
        modelVersionId: modelVersion.id,
        metrics: registeredArtifact.metrics,
        logsKey: registeredArtifact.reportKey
      });
      if (!completedTrainingRun) throw new Error("MODEL_TRAINING_RUN_COMPLETION_FAILED");
      const evaluationRun = await this.repository.createEvaluationRun({
        tenantId: input.principal.tenantId,
        modelVersionId: modelVersion.id,
        metrics: registeredArtifact.metrics,
        reportKey: registeredArtifact.reportKey
      });
      await this.events?.publish({
        tenantId: input.principal.tenantId,
        topic: "model.training.completed",
        aggregateId: trainingRun.id,
        payload: {
          trainingRunId: trainingRun.id,
          modelVersionId: modelVersion.id,
          status: "SUCCEEDED",
          metrics: registeredArtifact.metrics,
          datasetExportJobId: input.datasetExport?.id ?? null
        }
      });
      await this.events?.publish({
        tenantId: input.principal.tenantId,
        topic: "model.evaluation.completed",
        aggregateId: evaluationRun.id,
        payload: {
          evaluationRunId: evaluationRun.id,
          modelVersionId: modelVersion.id,
          metrics: registeredArtifact.metrics
        }
      });
      await this.recordModelAudit(input.principal, {
        action: "model.training.completed",
        resourceType: "ModelVersion",
        resourceId: modelVersion.id,
        metadata: {
          engine: modelVersion.engine,
          modelVersionId: modelVersion.id,
          trainingRunId: completedTrainingRun.id,
          evaluationRunId: evaluationRun.id,
          profile: options.profile,
          status: completedTrainingRun.status,
          datasetExportJobId: input.datasetExport?.id ?? null,
          metricKeys: Object.keys(registeredArtifact.metrics),
          artifactBucket: registeredArtifact.artifactBucket,
          artifactKeyPrefix: registeredArtifact.artifactKey
        }
      });
      await this.bumpRegistryCacheVersion(input.principal.tenantId);
      return { modelVersion, trainingRun: completedTrainingRun, evaluationRun };
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : options.failureCode;
      await this.repository.failTrainingRun({
        tenantId: input.principal.tenantId,
        trainingRunId: trainingRun.id,
        failureReason
      });
      await this.recordModelAudit(input.principal, {
        action: "model.training.failed",
        resourceType: "ModelTrainingRun",
        resourceId: trainingRun.id,
        metadata: {
          trainingRunId: trainingRun.id,
          profile: options.profile,
          failureCode: options.failureCode,
          datasetExportJobId: input.datasetExport?.id ?? null
        }
      });
      await this.bumpRegistryCacheVersion(input.principal.tenantId);
      await this.events?.publish({
        tenantId: input.principal.tenantId,
        topic: "model.training.completed",
        aggregateId: trainingRun.id,
        payload: { trainingRunId: trainingRun.id, status: "FAILED", failureReason }
      });
      throw new ModelError(options.failureCode, 500);
    }
  }

  private async findUsableDatasetExport(tenantId: string, workspaceId: string, exportJobId: string): Promise<StoredExportJob> {
    const exportJob = (await this.reports!.listExportJobs({ tenantId, workspaceId })).find((job) => job.id === exportJobId);
    if (!exportJob) throw new ModelError("DATASET_EXPORT_JOB_NOT_FOUND", 404);
    if (exportJob.type !== "dataset_export_jsonl") throw new ModelError("DATASET_EXPORT_JOB_TYPE_MISMATCH", 400);
    if (exportJob.status !== "SUCCEEDED") throw new ModelError("DATASET_EXPORT_JOB_NOT_READY", 409);
    if (!exportJob.objectKey) throw new ModelError("DATASET_EXPORT_ARTIFACT_MISSING", 409);
    return exportJob;
  }

  private async persistCustomOcrArtifactsIfConfigured(input: {
    tenantId: string;
    trainingRunId: string;
    result: Awaited<ReturnType<CustomOcrTrainingRunner>>;
  }): Promise<Awaited<ReturnType<CustomOcrTrainingRunner>>> {
    if (!this.artifactStorage || !this.artifactBucket) return input.result;
    if (input.result.artifactBucket !== "local-artifacts" || !input.result.artifactKey) return input.result;

    const artifactPrefix = `tenants/${input.tenantId}/models/custom-crnn/${input.trainingRunId}`;
    const checkpointPath = `${input.result.artifactKey}/model.pt`.replace(/\\/g, "/");
    const metricsPath = input.result.reportKey.replace(/\\/g, "/");
    const [checkpoint, metrics] = await Promise.all([
      readLocalModelArtifact(checkpointPath),
      readLocalModelArtifact(metricsPath)
    ]);
    const checkpointKey = `${artifactPrefix}/model.pt`;
    const reportKey = `${artifactPrefix}/metrics.json`;
    await Promise.all([
      this.artifactStorage.putObject({
        bucket: this.artifactBucket,
        objectKey: checkpointKey,
        body: checkpoint,
        mimeType: "application/octet-stream",
        metadata: {
          "artifact-kind": "custom-crnn-checkpoint",
          "tenant-id": input.tenantId,
          "training-run-id": input.trainingRunId
        }
      }),
      this.artifactStorage.putObject({
        bucket: this.artifactBucket,
        objectKey: reportKey,
        body: metrics,
        mimeType: "application/json",
        metadata: {
          "artifact-kind": "custom-crnn-metrics",
          "tenant-id": input.tenantId,
          "training-run-id": input.trainingRunId
        }
      })
    ]);

    return {
      ...input.result,
      artifactBucket: this.artifactBucket,
      artifactKey: artifactPrefix,
      reportKey,
      metrics: {
        ...input.result.metrics,
        artifact_storage: {
          backend: "object-storage",
          bucket: this.artifactBucket,
          artifactKey: artifactPrefix,
          checkpointKey,
          reportKey
        }
      }
    };
  }

  async promote(input: { principal: AuthPrincipal; modelVersionId: string }) {
    const target = await this.repository.findModelVersion({ tenantId: input.principal.tenantId, modelVersionId: input.modelVersionId });
    if (!target) throw new ModelError("MODEL_VERSION_NOT_FOUND", 404);
    const blockCode = getCustomOcrPromotionBlockCode(target);
    if (blockCode) throw new ModelError(blockCode, 400);
    const promoted = await this.repository.promoteModelVersion({
      tenantId: input.principal.tenantId,
      modelVersionId: input.modelVersionId
    });
    if (!promoted) throw new ModelError("MODEL_VERSION_NOT_FOUND", 404);
    await this.recordModelAudit(input.principal, {
      action: "model.promoted",
      resourceType: "ModelVersion",
      resourceId: promoted.id,
      metadata: { modelVersionId: promoted.id, engine: promoted.engine, status: promoted.status }
    });
    await this.bumpRegistryCacheVersion(input.principal.tenantId);
    return promoted;
  }

  async rollback(input: { principal: AuthPrincipal; modelVersionId: string }) {
    const versions = await this.repository.listModelVersions({ tenantId: input.principal.tenantId });
    const target = versions.find((version) => version.id === input.modelVersionId);
    if (!target) throw new ModelError("MODEL_VERSION_NOT_FOUND", 404);
    if (target.status !== "ARCHIVED") throw new ModelError("MODEL_ROLLBACK_TARGET_NOT_ARCHIVED", 400);
    const blockCode = getCustomOcrPromotionBlockCode(target);
    if (blockCode) throw new ModelError(blockCode, 400);
    const active = versions.find((version) => version.engine === target.engine && version.status === "ACTIVE");
    if (!active) throw new ModelError("MODEL_ROLLBACK_ACTIVE_VERSION_NOT_FOUND", 409);

    const modelVersion = await this.repository.promoteModelVersion({
      tenantId: input.principal.tenantId,
      modelVersionId: target.id
    });
    if (!modelVersion) throw new ModelError("MODEL_VERSION_NOT_FOUND", 404);
    await this.recordModelAudit(input.principal, {
      action: "model.rollback",
      resourceType: "ModelVersion",
      resourceId: modelVersion.id,
      metadata: { modelVersionId: modelVersion.id, rolledBackFromModelVersionId: active.id, engine: modelVersion.engine }
    });
    await this.bumpRegistryCacheVersion(input.principal.tenantId);
    return {
      modelVersion,
      rolledBackFromModelVersionId: active.id
    };
  }

  async benchmarkCustomOcr(input: {
    principal: AuthPrincipal;
    modelVersionId: string;
    samples: number;
    seed: number;
    split: "all" | "train" | "validation" | "test";
    skipTesseract: boolean;
  }) {
    if (!this.ocrBenchmarkRunner) throw new ModelError("OCR_BENCHMARK_RUNNER_NOT_CONFIGURED", 500);
    const modelVersion = await this.repository.findModelVersion({
      tenantId: input.principal.tenantId,
      modelVersionId: input.modelVersionId
    });
    if (!modelVersion) throw new ModelError("MODEL_VERSION_NOT_FOUND", 404);
    if (modelVersion.engine !== "CUSTOM_CRNN") throw new ModelError("OCR_BENCHMARK_MODEL_ENGINE_MISMATCH", 400);

    const checkpoint = await this.resolveCustomOcrBenchmarkCheckpoint(modelVersion);
    const cacheKey = modelOcrBenchmarkCacheKey(input.principal.tenantId, modelVersion, {
      samples: input.samples,
      seed: input.seed,
      split: input.split,
      skipTesseract: input.skipTesseract,
      checkpoint,
      datasetMode: "real-fixtures-v1"
    });
    const cachedBenchmark = await this.readCachedOcrBenchmark(cacheKey);
    await this.events?.publish({
      tenantId: input.principal.tenantId,
      topic: "model.evaluation.completed",
      aggregateId: modelVersion.id,
      payload: {
        modelVersionId: modelVersion.id,
        status: "STARTED",
        profile: "custom-ocr-benchmark",
        samples: input.samples,
        seed: input.seed,
        split: input.split,
        cacheHit: Boolean(cachedBenchmark)
      }
    });
    let result: Awaited<ReturnType<OcrBenchmarkRunner>>;
    if (cachedBenchmark) {
      result = cachedBenchmark;
    } else {
      try {
        result = await this.ocrBenchmarkRunner({
          tenantId: input.principal.tenantId,
          modelVersionId: modelVersion.id,
          artifactKey: modelVersion.artifactKey,
          checkpoint,
          samples: input.samples,
          seed: input.seed,
          split: input.split,
          skipTesseract: input.skipTesseract
        });
      } catch (error) {
        const failureDetails = modelRunnerErrorDetails(error);
        await this.events?.publish({
          tenantId: input.principal.tenantId,
          topic: "model.evaluation.completed",
          aggregateId: modelVersion.id,
          payload: {
            modelVersionId: modelVersion.id,
            status: "FAILED",
            profile: "custom-ocr-benchmark",
            failureCode: "OCR_BENCHMARK_FAILED",
            details: failureDetails
          }
        });
        await this.recordModelAudit(input.principal, {
          action: "model.ocr_benchmark.failed",
          resourceType: "ModelVersion",
          resourceId: modelVersion.id,
          metadata: {
            modelVersionId: modelVersion.id,
            profile: "custom-ocr-benchmark",
            samples: input.samples,
            split: input.split,
            failureCode: "OCR_BENCHMARK_FAILED",
            details: failureDetails
          }
        });
        throw new ModelError("OCR_BENCHMARK_FAILED", 500, failureDetails);
      }
      await this.rememberOcrBenchmark(cacheKey, result);
    }
    const evaluationRun = await this.repository.createEvaluationRun({
      tenantId: input.principal.tenantId,
      modelVersionId: modelVersion.id,
      metrics: result.metrics,
      reportKey: result.reportKey
    });
    const benchmarkedModelVersion =
      (await this.repository.updateModelVersionMetrics({
        tenantId: input.principal.tenantId,
        modelVersionId: modelVersion.id,
        metrics: mergeOcrBenchmarkIntoModelMetrics(modelVersion.metrics, result.metrics, result.reportKey)
      })) ?? modelVersion;
    await this.events?.publish({
      tenantId: input.principal.tenantId,
      topic: "model.evaluation.completed",
      aggregateId: evaluationRun.id,
      payload: {
        evaluationRunId: evaluationRun.id,
        modelVersionId: modelVersion.id,
        status: "SUCCEEDED",
        profile: "custom-ocr-benchmark",
        metrics: result.metrics,
        reportKey: result.reportKey,
        cacheHit: Boolean(cachedBenchmark)
      }
    });
    await this.recordModelAudit(input.principal, {
      action: "model.ocr_benchmark.completed",
      resourceType: "ModelEvaluationRun",
      resourceId: evaluationRun.id,
      metadata: {
        modelVersionId: modelVersion.id,
        evaluationRunId: evaluationRun.id,
        profile: "custom-ocr-benchmark",
        samples: input.samples,
        split: input.split,
        metricKeys: Object.keys(result.metrics),
        cacheHit: Boolean(cachedBenchmark)
      }
    });
    await this.bumpRegistryCacheVersion(input.principal.tenantId);
    return { modelVersion: benchmarkedModelVersion, evaluationRun, benchmark: result, cacheHit: Boolean(cachedBenchmark) };
  }

  private async resolveCustomOcrBenchmarkCheckpoint(modelVersion: StoredModelVersion): Promise<string | null> {
    if (modelVersion.artifactBucket === "local-artifacts" && modelVersion.artifactKey) {
      return `${modelVersion.artifactKey}/model.pt`.replace(/\\/g, "/");
    }
    if (!modelVersion.artifactBucket || !modelVersion.artifactKey || !this.artifactStorage) return null;

    const artifactPrefix = normalizeArtifactObjectPrefix(modelVersion.artifactKey);
    const checkpoint = await this.artifactStorage.getObject({
      bucket: modelVersion.artifactBucket,
      objectKey: `${artifactPrefix}/model.pt`
    });
    const relativePath = path
      .join(
        "artifacts",
        "models",
        "cache",
        "benchmarks",
        safePathSegment(modelVersion.tenantId),
        safePathSegment(modelVersion.id),
        "model.pt"
      )
      .replace(/\\/g, "/");
    const absolutePath = path.resolve(findProjectRoot(), relativePath);
    const allowedRoot = path.resolve(findProjectRoot(), "artifacts", "models", "cache", "benchmarks");
    if (!absolutePath.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("MODEL_BENCHMARK_CACHE_PATH_OUTSIDE_ALLOWED_ROOT");
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, checkpoint);
    return relativePath;
  }

  async evaluateCategoryModel(input: {
    principal: AuthPrincipal;
    modelVersionId: string;
    samplesPerCategory: number;
    seed: number;
    split: "all" | "train" | "validation" | "test";
  }) {
    if (!this.categoryEvaluationRunner) throw new ModelError("CATEGORY_EVALUATION_RUNNER_NOT_CONFIGURED", 500);
    const modelVersion = await this.repository.findModelVersion({
      tenantId: input.principal.tenantId,
      modelVersionId: input.modelVersionId
    });
    if (!modelVersion) throw new ModelError("MODEL_VERSION_NOT_FOUND", 404);
    if (modelVersion.engine !== "CATEGORY_ML") throw new ModelError("CATEGORY_EVALUATION_MODEL_ENGINE_MISMATCH", 400);
    const modelPath =
      modelVersion.artifactBucket === "local-artifacts" && modelVersion.artifactKey
        ? `${modelVersion.artifactKey}/category_model.joblib`.replace(/\\/g, "/")
        : null;
    await this.events?.publish({
      tenantId: input.principal.tenantId,
      topic: "model.evaluation.completed",
      aggregateId: modelVersion.id,
      payload: {
        modelVersionId: modelVersion.id,
        status: "STARTED",
        profile: "category-evaluation",
        samplesPerCategory: input.samplesPerCategory,
        seed: input.seed,
        split: input.split
      }
    });
    let result: Awaited<ReturnType<CategoryEvaluationRunner>>;
    try {
      result = await this.categoryEvaluationRunner({
        tenantId: input.principal.tenantId,
        modelVersionId: modelVersion.id,
        artifactKey: modelVersion.artifactKey,
        modelPath,
        samplesPerCategory: input.samplesPerCategory,
        seed: input.seed,
        split: input.split
      });
    } catch {
      await this.events?.publish({
        tenantId: input.principal.tenantId,
        topic: "model.evaluation.completed",
        aggregateId: modelVersion.id,
        payload: {
          modelVersionId: modelVersion.id,
          status: "FAILED",
          profile: "category-evaluation",
          failureCode: "CATEGORY_EVALUATION_FAILED"
        }
      });
      await this.recordModelAudit(input.principal, {
        action: "model.category_evaluation.failed",
        resourceType: "ModelVersion",
        resourceId: modelVersion.id,
        metadata: {
          modelVersionId: modelVersion.id,
          profile: "category-evaluation",
          samplesPerCategory: input.samplesPerCategory,
          split: input.split,
          failureCode: "CATEGORY_EVALUATION_FAILED"
        }
      });
      throw new ModelError("CATEGORY_EVALUATION_FAILED", 500);
    }
    const evaluationRun = await this.repository.createEvaluationRun({
      tenantId: input.principal.tenantId,
      modelVersionId: modelVersion.id,
      metrics: result.metrics,
      reportKey: result.reportKey
    });
    await this.events?.publish({
      tenantId: input.principal.tenantId,
      topic: "model.evaluation.completed",
      aggregateId: evaluationRun.id,
      payload: {
        evaluationRunId: evaluationRun.id,
        modelVersionId: modelVersion.id,
        status: "SUCCEEDED",
        profile: "category-evaluation",
        metrics: result.metrics,
        reportKey: result.reportKey
      }
    });
    await this.recordModelAudit(input.principal, {
      action: "model.category_evaluation.completed",
      resourceType: "ModelEvaluationRun",
      resourceId: evaluationRun.id,
      metadata: {
        modelVersionId: modelVersion.id,
        evaluationRunId: evaluationRun.id,
        profile: "category-evaluation",
        samplesPerCategory: input.samplesPerCategory,
        split: input.split,
        metricKeys: Object.keys(result.metrics)
      }
    });
    await this.bumpRegistryCacheVersion(input.principal.tenantId);
    return { modelVersion, evaluationRun, evaluation: result };
  }

  private async recordModelAudit(
    principal: AuthPrincipal,
    input: {
      action: string;
      resourceType: string;
      resourceId: string;
      metadata: Record<string, unknown>;
    }
  ): Promise<void> {
    try {
      await this.audit?.create({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadata: input.metadata,
        correlationId: principal.sessionId
      });
    } catch {
      // Audit writes should not corrupt the authoritative model mutation after it has been persisted.
    }
  }

  private async readRegistryCacheVersion(tenantId: string): Promise<string> {
    try {
      const cached = await this.cache?.getHotState<{ version?: unknown }>(modelRegistryVersionCacheKey(tenantId));
      return typeof cached?.version === "string" && cached.version.length > 0 ? cached.version : "v0";
    } catch {
      return "v0";
    }
  }

  private async bumpRegistryCacheVersion(tenantId: string): Promise<void> {
    try {
      await this.cache?.setHotState({
        key: modelRegistryVersionCacheKey(tenantId),
        value: { version: `v${process.hrtime.bigint().toString(36)}` },
        ttlSeconds: 24 * 60 * 60
      });
    } catch {
      // Model registry cache is an optimization; PostgreSQL model rows remain authoritative.
    }
  }

  private async readCachedOverview(key: string): Promise<ModelRegistryOverview | null> {
    try {
      const cached = await this.cache?.getHotState<CachedModelRegistryOverview>(key);
      return reviveOverview(cached);
    } catch {
      return null;
    }
  }

  private async rememberOverview(key: string, overview: ModelRegistryOverview): Promise<void> {
    try {
      await this.cache?.setHotState({
        key,
        value: serializeOverview(overview),
        ttlSeconds: 5 * 60
      });
    } catch {
      // Model registry cache is an optimization; PostgreSQL model rows remain authoritative.
    }
  }

  private async readCachedOcrBenchmark(key: string): Promise<OcrBenchmarkResult | null> {
    try {
      const cached = await this.cache?.getHotState<CachedOcrBenchmarkResult>(key);
      if (!cached || !isCachedOcrBenchmarkResult(cached)) return null;
      return cached;
    } catch {
      return null;
    }
  }

  private async rememberOcrBenchmark(key: string, benchmark: OcrBenchmarkResult): Promise<void> {
    try {
      await this.cache?.setHotState({
        key,
        value: benchmark,
        ttlSeconds: 60 * 60
      });
    } catch {
      // Benchmark cache only avoids repeated local inference work; evaluation rows remain authoritative.
    }
  }
}

type ModelRegistryOverview = {
  models: Awaited<ReturnType<ModelRepository["listModelVersions"]>>;
  trainingRuns: Awaited<ReturnType<ModelRepository["listTrainingRuns"]>>;
  evaluationRuns: Awaited<ReturnType<ModelRepository["listEvaluationRuns"]>>;
};

type CachedModelRegistryOverview = {
  models: CachedModelVersion[];
  trainingRuns: CachedModelTrainingRun[];
  evaluationRuns: CachedModelEvaluationRun[];
};

type CachedModelVersion = Omit<ModelRegistryOverview["models"][number], "createdAt" | "updatedAt" | "promotedAt"> & {
  createdAt: string;
  updatedAt: string;
  promotedAt: string | null;
};

type CachedModelTrainingRun = Omit<ModelRegistryOverview["trainingRuns"][number], "createdAt" | "startedAt" | "completedAt"> & {
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type CachedModelEvaluationRun = Omit<ModelRegistryOverview["evaluationRuns"][number], "createdAt" | "completedAt"> & {
  createdAt: string;
  completedAt: string | null;
};

type CachedOcrBenchmarkResult = OcrBenchmarkResult;

function modelRegistryVersionCacheKey(tenantId: string): string {
  return `model-registry:${tenantId}:overview-version`;
}

export function modelRegistryOverviewCacheKey(tenantId: string, version: string): string {
  return `model-registry:${tenantId}:overview:${version}`;
}

export function modelOcrBenchmarkCacheKey(
  tenantId: string,
  modelVersion: Pick<StoredModelVersion, "id" | "artifactBucket" | "artifactKey">,
  input: { samples: number; seed: number; split: string; skipTesseract: boolean; checkpoint: string | null; datasetMode?: string }
): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        modelVersionId: modelVersion.id,
        artifactBucket: modelVersion.artifactBucket,
        artifactKey: modelVersion.artifactKey,
        samples: input.samples,
        seed: input.seed,
        split: input.split,
        skipTesseract: input.skipTesseract,
        checkpoint: input.checkpoint,
        datasetMode: input.datasetMode ?? "synthetic"
      })
    )
    .digest("hex");
  return `model-inference:${tenantId}:ocr-benchmark:${modelVersion.id}:${fingerprint}`;
}

function modelRunnerErrorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  const row = error as {
    message?: unknown;
    code?: unknown;
    cmd?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    signal?: unknown;
    killed?: unknown;
  };
  return {
    message: typeof row.message === "string" ? redactModelRunnerDetail(row.message) : "MODEL_RUNNER_FAILED",
    ...(typeof row.code === "string" || typeof row.code === "number" ? { code: row.code } : {}),
    ...(typeof row.cmd === "string" ? { command: redactModelRunnerDetail(row.cmd) } : {}),
    ...(typeof row.stdout === "string" && row.stdout.trim() ? { stdout: redactModelRunnerDetail(row.stdout.slice(-4000)) } : {}),
    ...(typeof row.stderr === "string" && row.stderr.trim() ? { stderr: redactModelRunnerDetail(row.stderr.slice(-4000)) } : {}),
    ...(typeof row.signal === "string" ? { signal: row.signal } : {}),
    ...(typeof row.killed === "boolean" ? { killed: row.killed } : {})
  };
}

function redactModelRunnerDetail(value: string): string {
  return value
    .replace(/checkpoint=("[^"]+"|'[^']+'|\S+)/gi, "checkpoint:[redacted]")
    .replace(/objectKey=("[^"]+"|'[^']+'|\S+)/gi, "objectKey:[redacted]")
    .replace(/text=("[^"]+"|'[^']+'|.+)$/gim, "text:[redacted]");
}

function normalizeCustomOcrTrainingMetrics(metrics: Record<string, unknown>, trainingProfile: string): Record<string, unknown> {
  return {
    ...metrics,
    training_profile: trainingProfile,
    profile: typeof metrics.profile === "string" ? metrics.profile : trainingProfile
  };
}

function mergeOcrBenchmarkIntoModelMetrics(existingMetrics: unknown, benchmarkMetrics: Record<string, unknown>, reportKey: string): Record<string, unknown> {
  const base = isRecord(existingMetrics) ? { ...existingMetrics } : {};
  const dataset = isRecord(benchmarkMetrics.dataset) ? benchmarkMetrics.dataset : {};
  const engines = isRecord(benchmarkMetrics.engines) ? benchmarkMetrics.engines : {};
  const customCrnn = isRecord(engines.CUSTOM_CRNN) ? engines.CUSTOM_CRNN : {};
  const isRealFixtureBenchmark = dataset.mode === "real_fixtures";
  return {
    ...base,
    latestOcrBenchmark: benchmarkMetrics,
    latestOcrBenchmarkReportKey: reportKey,
    benchmarkDataset: dataset,
    engines,
    ...(isRealFixtureBenchmark
      ? {
          validatedOnRealFixtures: true,
          realFixtureBenchmarkStatus: typeof customCrnn.qualityGateStatus === "string" ? customCrnn.qualityGateStatus : "unknown",
          qualityGatePassed: customCrnn.qualityGatePassed === true,
          highConfidenceWrongCount:
            typeof customCrnn.highConfidenceWrongCount === "number" && Number.isFinite(customCrnn.highConfidenceWrongCount)
              ? customCrnn.highConfidenceWrongCount
              : null
        }
      : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function serializeOverview(overview: ModelRegistryOverview): CachedModelRegistryOverview {
  return {
    models: overview.models.map((model) => ({
      ...model,
      createdAt: model.createdAt.toISOString(),
      updatedAt: model.updatedAt.toISOString(),
      promotedAt: model.promotedAt?.toISOString() ?? null
    })),
    trainingRuns: overview.trainingRuns.map((run) => ({
      ...run,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null
    })),
    evaluationRuns: overview.evaluationRuns.map((run) => ({
      ...run,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null
    }))
  };
}

function reviveOverview(value: CachedModelRegistryOverview | null | undefined): ModelRegistryOverview | null {
  if (!isCachedModelRegistryOverview(value)) return null;
  return {
    models: value.models.map((model) => ({
      ...model,
      createdAt: new Date(model.createdAt),
      updatedAt: new Date(model.updatedAt),
      promotedAt: model.promotedAt ? new Date(model.promotedAt) : null
    })),
    trainingRuns: value.trainingRuns.map((run) => ({
      ...run,
      createdAt: new Date(run.createdAt),
      startedAt: run.startedAt ? new Date(run.startedAt) : null,
      completedAt: run.completedAt ? new Date(run.completedAt) : null
    })),
    evaluationRuns: value.evaluationRuns.map((run) => ({
      ...run,
      createdAt: new Date(run.createdAt),
      completedAt: run.completedAt ? new Date(run.completedAt) : null
    }))
  };
}

function isCachedModelRegistryOverview(value: unknown): value is CachedModelRegistryOverview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as CachedModelRegistryOverview;
  return (
    Array.isArray(candidate.models) &&
    candidate.models.every(isCachedModelVersion) &&
    Array.isArray(candidate.trainingRuns) &&
    candidate.trainingRuns.every(isCachedModelTrainingRun) &&
    Array.isArray(candidate.evaluationRuns) &&
    candidate.evaluationRuns.every(isCachedModelEvaluationRun)
  );
}

function isCachedModelVersion(value: unknown): value is CachedModelVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as CachedModelVersion;
  return (
    typeof model.id === "string" &&
    typeof model.tenantId === "string" &&
    typeof model.name === "string" &&
    typeof model.engine === "string" &&
    typeof model.status === "string" &&
    (model.artifactBucket === null || typeof model.artifactBucket === "string") &&
    (model.artifactKey === null || typeof model.artifactKey === "string") &&
    (model.promotedAt === null || isDateString(model.promotedAt)) &&
    isDateString(model.createdAt) &&
    isDateString(model.updatedAt)
  );
}

function isCachedModelTrainingRun(value: unknown): value is CachedModelTrainingRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as CachedModelTrainingRun;
  return (
    typeof run.id === "string" &&
    typeof run.tenantId === "string" &&
    (run.modelVersionId === null || typeof run.modelVersionId === "string") &&
    (run.datasetId === null || typeof run.datasetId === "string") &&
    typeof run.status === "string" &&
    typeof run.profile === "string" &&
    Number.isInteger(run.seed) &&
    (run.logsKey === null || typeof run.logsKey === "string") &&
    (run.failureReason === null || typeof run.failureReason === "string") &&
    isDateString(run.createdAt) &&
    (run.startedAt === null || isDateString(run.startedAt)) &&
    (run.completedAt === null || isDateString(run.completedAt))
  );
}

function isCachedModelEvaluationRun(value: unknown): value is CachedModelEvaluationRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as CachedModelEvaluationRun;
  return (
    typeof run.id === "string" &&
    typeof run.tenantId === "string" &&
    (run.modelVersionId === null || typeof run.modelVersionId === "string") &&
    (run.datasetId === null || typeof run.datasetId === "string") &&
    typeof run.status === "string" &&
    (run.reportKey === null || typeof run.reportKey === "string") &&
    (run.failureReason === null || typeof run.failureReason === "string") &&
    isDateString(run.createdAt) &&
    (run.completedAt === null || isDateString(run.completedAt))
  );
}

function isCachedOcrBenchmarkResult(value: unknown): value is CachedOcrBenchmarkResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const benchmark = value as CachedOcrBenchmarkResult;
  return (
    typeof benchmark.artifactBucket === "string" &&
    typeof benchmark.artifactKey === "string" &&
    typeof benchmark.reportKey === "string" &&
    Boolean(benchmark.metrics) &&
    typeof benchmark.metrics === "object" &&
    !Array.isArray(benchmark.metrics)
  );
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function normalizeArtifactObjectPrefix(artifactKey: string): string {
  const normalized = artifactKey.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.split("/").includes("..")) throw new Error("MODEL_ARTIFACT_OBJECT_KEY_INVALID");
  return normalized;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "unknown";
}

async function readLocalModelArtifact(relativePath: string): Promise<Buffer> {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..") || !normalized.startsWith("artifacts/models/")) {
    throw new Error("MODEL_ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT");
  }
  const root = findProjectRoot();
  const absolute = path.resolve(root, normalized);
  const allowedRoot = path.resolve(root, "artifacts", "models");
  if (!absolute.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("MODEL_ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT");
  return readFile(absolute);
}

function findProjectRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}
