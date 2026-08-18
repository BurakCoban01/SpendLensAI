import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OCREngineCode } from "@prisma/client";
import type { OcrComparisonResult } from "@spendlens/shared";
import { z } from "zod";
import type { AuditRepository } from "../audit/types";
import type { AuthPrincipal } from "../auth/types";
import type { CacheService } from "../cache/service";
import type {
  DocumentCustomOcrClient,
  DocumentPreprocessingClient,
  DocumentService,
  DocumentTesseractOcrClient
} from "../documents/service";
import type { DocumentStorage } from "../documents/types";
import type { ExtractionService } from "../extraction/service";
import { getCustomOcrPromotionBlockCode, type CustomOcrPromotionBlockCode } from "../models/custom-ocr-readiness";
import type { ModelService } from "../models/service";
import type { ModelRepository, StoredModelVersion } from "../models/types";
import type { NotificationService } from "../notifications/service";
import type { OcrComparisonService } from "../ocr-comparison/service";
import type { OcrCandidateInput } from "../ocr-comparison/types";
import type { ReportService } from "../reports/service";
import type { WebhookService } from "../webhooks/service";
import { reportExportTypes } from "../reports/types";
import type { JobService } from "./service";
import type { TempCleanupService } from "./temp-cleanup";
import type { StoredWorkerJob, WorkerJobState } from "./types";

const OcrEngineSchema = z.enum(["TESSERACT", "CUSTOM_CRNN"]);
const ExtractionEngineSchema = z.enum(["TESSERACT", "CUSTOM_CRNN", "ENSEMBLE"]);
const CurrencySchema = z.enum(["TRY", "USD", "EUR"]);

const OcrTokenSchema = z.object({
  text: z.string().max(500),
  confidence: z.number().min(0).max(1),
  bbox: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]),
  pageNumber: z.number().int().positive().optional()
});

const OcrCandidateSchema = z.object({
  engine: OcrEngineSchema,
  text: z.string(),
  confidence: z.number().min(0).max(1),
  tokens: z.array(OcrTokenSchema).max(5000).optional(),
  latencyMs: z.number().int().min(0).optional(),
  failed: z.boolean().optional(),
  failureReason: z.string().trim().min(1).max(500).optional()
});

const OcrComparePayloadSchema = z.object({
  documentFileId: z.string().trim().min(1),
  runs: z.array(OcrCandidateSchema).min(1),
  groundTruthText: z.string().optional(),
  defaultCurrency: CurrencySchema.optional()
});

const TesseractOcrPayloadSchema = z.object({
  documentFileId: z.string().trim().min(1),
  language: z.string().trim().min(1).max(32).default("tur+eng"),
  groundTruthText: z.string().optional(),
  defaultCurrency: CurrencySchema.optional()
});

const CustomCrnnOcrPayloadSchema = z.object({
  documentFileId: z.string().trim().min(1),
  modelVersionId: z.string().trim().min(1).optional(),
  checkpoint: z.string().trim().min(1).max(500).optional(),
  groundTruthText: z.string().optional(),
  defaultCurrency: CurrencySchema.optional()
});

const CategorySmokeTrainPayloadSchema = z.object({
  seed: z.number().int().min(0).max(1_000_000).default(42),
  samplesPerCategory: z.number().int().min(4).max(64).default(12)
});

const CustomOcrSmokeTrainPayloadSchema = z.object({
  seed: z.number().int().min(0).max(1_000_000).default(42),
  samples: z.number().int().min(8).max(64).default(16),
  epochs: z.number().int().min(1).max(3).default(1)
});

const CategoryEvaluatePayloadSchema = z.object({
  modelVersionId: z.string().trim().min(1),
  seed: z.number().int().min(0).max(1_000_000).default(42),
  samplesPerCategory: z.number().int().min(4).max(64).default(12),
  split: z.enum(["all", "train", "validation", "test"]).default("test")
});

const ModelOcrBenchmarkPayloadSchema = z.object({
  modelVersionId: z.string().trim().min(1),
  samples: z.number().int().min(1).max(64).default(8),
  seed: z.number().int().min(0).max(1_000_000).default(42),
  split: z.enum(["all", "train", "validation", "test"]).default("all"),
  skipTesseract: z.boolean().default(true)
});

const ReportExportPayloadSchema = z.object({
  workspaceId: z.string().trim().min(1),
  type: z.enum(reportExportTypes),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional()
});

const AnnotationExportPayloadSchema = z.object({
  workspaceId: z.string().trim().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional()
});

const TempCleanupPayloadSchema = z.object({
  subdir: z.string().trim().max(200).default(""),
  maxAgeMs: z.number().int().min(1_000).max(365 * 24 * 60 * 60 * 1000).default(24 * 60 * 60 * 1000),
  dryRun: z.boolean().default(false)
});

const NotificationCreatePayloadSchema = z.object({
  userId: z.string().trim().min(1).optional(),
  type: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(1000),
  payload: z.record(z.string(), z.unknown()).optional()
});

const WebhookDeliveryPayloadSchema = z.object({
  endpointId: z.string().trim().min(1).optional(),
  eventType: z.string().trim().min(1).max(120),
  payload: z.record(z.string(), z.unknown()).default({})
});

const ExtractionPayloadSchema = z.object({
  documentFileId: z.string().trim().min(1),
  text: z.string().trim().min(1),
  sourceEngine: ExtractionEngineSchema.nullable().optional()
});
const PreprocessingPayloadSchema = z.object({
  documentFileId: z.string().trim().min(1),
  profile: z
    .enum([
      "DEFAULT",
      "TESSERACT_OPTIMIZED",
      "CUSTOM_MODEL_OPTIMIZED",
      "LOW_LIGHT",
      "THERMAL_RECEIPT",
      "CRUMPLED_RECEIPT"
    ])
    .default("TESSERACT_OPTIMIZED"),
  runTesseractAfter: z.boolean().optional()
});

export type WorkerRunResult = {
  processed: boolean;
  job: StoredWorkerJob | null;
  skippedReason?: string;
  coordination?: {
    lockAcquired: boolean;
    degraded: boolean;
    key: string | null;
  };
};

export type DocumentOcrPipelineRunResult = {
  processed: boolean;
  documentFileId: string;
  jobsProcessed: StoredWorkerJob[];
  latestStage: "none" | "preprocessing" | "ocr" | "extraction";
  latestStatus: WorkerJobState | "IDLE";
  rawOcrAvailable: boolean;
  extractionAvailable: boolean;
  canProceed: boolean;
  failureReason: string | null;
  skippedReason?: string;
  coordination?: {
    lockAcquired: boolean;
    degraded: boolean;
    key: string | null;
  };
};

export class WorkerRunnerService {
  constructor(
    private readonly jobs: JobService,
    private readonly extraction: ExtractionService,
    private readonly ocrComparison: OcrComparisonService,
    private readonly documents?: DocumentService,
    private readonly preprocessingClient?: DocumentPreprocessingClient,
    private readonly tesseractClient?: DocumentTesseractOcrClient,
    private readonly customOcrClient?: DocumentCustomOcrClient,
    private readonly modelRepository?: ModelRepository,
    private readonly modelService?: ModelService,
    private readonly reports?: ReportService,
    private readonly tempCleanup?: TempCleanupService,
    private readonly notifications?: NotificationService,
    private readonly webhooks?: WebhookService,
    private readonly cache?: CacheService,
    private readonly audit?: AuditRepository,
    private readonly artifactStorage?: DocumentStorage,
    private readonly allowUnregisteredCustomOcrCheckpoint = false
  ) {}

  async runNext(input: { principal: AuthPrincipal; queue?: string; workerId: string }): Promise<WorkerRunResult> {
    const coordinated = await this.jobs.withWorkerRunLock(
      {
        principal: input.principal,
        workerId: input.workerId,
        ...(input.queue ? { queue: input.queue } : {})
      },
      async () => this.runNextLocked(input)
    );
    if (!coordinated.acquired) {
      const skipped = {
        processed: false,
        job: null,
        skippedReason: "WORKER_QUEUE_LOCKED",
        coordination: {
          lockAcquired: false,
          degraded: coordinated.degraded,
          key: coordinated.key
        }
      };
      await this.auditRunNext(input, skipped);
      return skipped;
    }
    const result = {
      ...(coordinated.result ?? { processed: false, job: null }),
      coordination: {
        lockAcquired: true,
        degraded: coordinated.degraded,
        key: coordinated.key
      }
    };
    await this.auditRunNext(input, result);
    return result;
  }

  async runDocumentOcrPipeline(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    workerId: string;
    drainUntil?: "ocr" | "extraction";
    maxSteps?: number;
    stopOnFailure?: boolean;
  }): Promise<DocumentOcrPipelineRunResult> {
    const coordinated = await this.jobs.withWorkerRunLock(
      {
        principal: input.principal,
        workerId: input.workerId,
        queue: `document-ocr-${input.documentFileId}`,
        ttlMs: 120_000
      },
      async () => this.runDocumentOcrPipelineLocked(input)
    );
    if (!coordinated.acquired) {
      return {
        processed: false,
        documentFileId: input.documentFileId,
        jobsProcessed: [],
        latestStage: "none",
        latestStatus: "IDLE",
        rawOcrAvailable: false,
        extractionAvailable: false,
        canProceed: false,
        failureReason: null,
        skippedReason: "WORKER_QUEUE_LOCKED",
        coordination: {
          lockAcquired: false,
          degraded: coordinated.degraded,
          key: coordinated.key
        }
      };
    }
    return {
      ...(coordinated.result ?? emptyDocumentPipelineResult(input.documentFileId, "NO_DOCUMENT_OCR_JOBS")),
      coordination: {
        lockAcquired: true,
        degraded: coordinated.degraded,
        key: coordinated.key
      }
    };
  }

  private async runNextLocked(input: { principal: AuthPrincipal; queue?: string; workerId: string }): Promise<WorkerRunResult> {
    const queued = await this.jobs.list({
      principal: input.principal,
      ...(input.queue ? { queue: input.queue } : {}),
      status: "QUEUED",
      limit: 50
    });
    const next = oldest(queued.jobs);
    if (!next) return { processed: false, job: null };

    return this.runQueuedJob({ principal: input.principal, workerId: input.workerId }, next);
  }

  private async runDocumentOcrPipelineLocked(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    workerId: string;
    drainUntil?: "ocr" | "extraction";
    maxSteps?: number;
    stopOnFailure?: boolean;
  }): Promise<Omit<DocumentOcrPipelineRunResult, "coordination">> {
    const drainUntil = input.drainUntil ?? "ocr";
    const stopOnFailure = input.stopOnFailure ?? true;
    const maxSteps = Math.max(1, Math.min(input.maxSteps ?? 8, 20));
    const jobsProcessed: StoredWorkerJob[] = [];
    let latestStage: DocumentOcrPipelineRunResult["latestStage"] = "none";
    let latestStatus: DocumentOcrPipelineRunResult["latestStatus"] = "IDLE";
    let failureReason: string | null = null;

    for (let step = 0; step < maxSteps; step += 1) {
      const next = await this.findNextDocumentOcrJob(input.principal, input.documentFileId, drainUntil);
      if (!next) break;
      const run = await this.runQueuedJob({ principal: input.principal, workerId: input.workerId }, next);
      if (!run.job) break;
      jobsProcessed.push(run.job);
      latestStage = stageFromDocumentOcrJob(run.job);
      latestStatus = run.job.status;
      failureReason = run.job.failureReason;
      if (run.job.status === "FAILED" && stopOnFailure) break;
      if (drainUntil === "ocr" && run.job.status === "SUCCEEDED" && isRawOcrJob(run.job)) {
        const nextRawOcr = await this.findNextDocumentOcrJob(input.principal, input.documentFileId, drainUntil);
        if (!nextRawOcr || !isRawOcrJob(nextRawOcr)) break;
      }
      if (drainUntil === "extraction" && run.job.status === "SUCCEEDED" && run.job.jobType === "extraction.from_text") break;
    }

    const failed = jobsProcessed.find((job) => job.status === "FAILED") ?? null;
    return {
      processed: jobsProcessed.length > 0,
      documentFileId: input.documentFileId,
      jobsProcessed,
      latestStage,
      latestStatus,
      rawOcrAvailable: jobsProcessed.some((job) => job.status === "SUCCEEDED" && isRawOcrJob(job)),
      extractionAvailable: jobsProcessed.some((job) => job.status === "SUCCEEDED" && job.jobType === "extraction.from_text"),
      canProceed: !failed,
      failureReason: failed?.failureReason ?? failureReason,
      ...(jobsProcessed.length === 0 ? { skippedReason: "NO_DOCUMENT_OCR_JOBS" } : {})
    };
  }

  private async findNextDocumentOcrJob(
    principal: AuthPrincipal,
    documentFileId: string,
    drainUntil: "ocr" | "extraction"
  ): Promise<StoredWorkerJob | null> {
    const queues = drainUntil === "extraction" ? documentOcrPipelineQueues : documentOcrPipelineQueues.slice(0, 2);
    for (const queue of queues) {
      const listed = await this.jobs.list({ principal, queue, status: "QUEUED", limit: 200 });
      const next = oldest(listed.jobs.filter((job) => isDocumentOcrPipelineJob(job, documentFileId)));
      if (next) return next;
      const recovered = await this.recoverStaleDocumentOcrJob(principal, queue, documentFileId);
      if (recovered) return recovered;
      const retriedFailed = await this.recoverFailedDocumentOcrJob(principal, queue, documentFileId);
      if (retriedFailed) return retriedFailed;
    }
    return null;
  }

  private async recoverStaleDocumentOcrJob(
    principal: AuthPrincipal,
    queue: (typeof documentOcrPipelineQueues)[number],
    documentFileId: string
  ): Promise<StoredWorkerJob | null> {
    const running = await this.jobs.list({ principal, queue, status: "RUNNING", limit: 200 });
    const stale = oldest(
      running.jobs.filter(
        (job) =>
          isDocumentOcrPipelineJob(job, documentFileId) &&
          Date.now() - job.updatedAt.getTime() > staleDocumentPipelineJobMs &&
          job.attempts < job.maxAttempts
      )
    );
    if (!stale) return null;
    return this.jobs.retry({ principal, id: stale.id });
  }

  private async recoverFailedDocumentOcrJob(
    principal: AuthPrincipal,
    queue: (typeof documentOcrPipelineQueues)[number],
    documentFileId: string
  ): Promise<StoredWorkerJob | null> {
    const failed = await this.jobs.list({ principal, queue, status: "FAILED", limit: 200 });
    const retryable = oldest(
      failed.jobs.filter(
        (job) => isDocumentOcrPipelineJob(job, documentFileId) && job.attempts < job.maxAttempts
      )
    );
    if (!retryable) return null;
    return this.jobs.retry({ principal, id: retryable.id });
  }

  private async runQueuedJob(input: { principal: AuthPrincipal; workerId: string }, next: StoredWorkerJob): Promise<WorkerRunResult> {
    await this.jobs.start({ principal: input.principal, id: next.id, workerId: input.workerId });
    try {
      await this.jobs.progress({ principal: input.principal, id: next.id, progress: 20 });
      const result = await this.dispatch(input.principal, next);
      const completed = await this.jobs.complete({ principal: input.principal, id: next.id, result });
      return { processed: true, job: completed };
    } catch (error) {
      const failed = await this.jobs.fail({
        principal: input.principal,
        id: next.id,
        failureReason: error instanceof Error ? error.message : "WORKER_JOB_FAILED"
      });
      return { processed: true, job: failed };
    }
  }

  private async dispatch(principal: AuthPrincipal, job: StoredWorkerJob): Promise<Record<string, unknown>> {
    if (job.jobType === "document.preprocess") {
      if (!this.documents || !this.preprocessingClient) throw new Error("PREPROCESSING_WORKER_NOT_CONFIGURED");
      const payload = PreprocessingPayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 35 });
      const persisted = await this.documents.runPreprocessing({
        principal,
        documentFileId: payload.documentFileId,
        profile: payload.profile,
        client: this.preprocessingClient,
        correlationId: job.correlationId
      });
      const chainedOcrJob =
        payload.runTesseractAfter === true && this.tesseractClient
          ? (
              await this.jobs.enqueue({
                principal,
                queue: "ocr",
                jobType: "ocr.tesseract",
                dedupeKey: `ocr:tesseract:${payload.documentFileId}:tur+eng`,
                eventTopic: "ocr.job.created",
                aggregateId: payload.documentFileId,
                correlationId: job.correlationId,
                payload: {
                  documentFileId: payload.documentFileId,
                  language: "tur+eng"
                }
              })
            ).job
          : null;
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return {
        documentFileId: payload.documentFileId,
        profile: payload.profile,
        pageCount: persisted.pages.length,
        manifestObjectKey: persisted.manifestObjectKey,
        processedKeys: persisted.pages.map((page) => page.processedKey).filter(Boolean),
        chainedOcrJobId: chainedOcrJob?.id ?? null
      };
    }

    if (job.jobType === "ocr.tesseract") {
      if (!this.documents || !this.tesseractClient) throw new Error("OCR_TESSERACT_WORKER_NOT_CONFIGURED");
      const payload = TesseractOcrPayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 40 });
      const cacheKey = ocrResultCacheKey(principal.tenantId, payload.documentFileId, `tesseract:${hashCachePart(payload.language)}`);
      const cachedRun = await this.readCachedOcrRun(cacheKey);
      const ocrRun =
        cachedRun ??
        (await this.documents.runTesseractOcr({
          principal,
          documentFileId: payload.documentFileId,
          language: payload.language,
          client: this.tesseractClient
        }));
      if (!cachedRun) await this.rememberOcrRun(cacheKey, ocrRun);
      await this.jobs.progress({ principal, id: job.id, progress: 65 });
      const comparison = await this.ocrComparison.compare({
        principal,
        documentFileId: payload.documentFileId,
        runs: [
          {
            engine: "TESSERACT",
            text: ocrRun.text,
            confidence: ocrRun.confidence,
            ...(ocrRun.tokens !== undefined ? { tokens: ocrRun.tokens } : {}),
            ...(ocrRun.latencyMs !== undefined ? { latencyMs: ocrRun.latencyMs } : {}),
            ...(ocrRun.metadata !== undefined ? { metadata: ocrRun.metadata } : {})
          }
        ],
        ...(payload.groundTruthText !== undefined ? { groundTruthText: payload.groundTruthText } : {}),
        ...(payload.defaultCurrency ? { defaultCurrency: payload.defaultCurrency } : {}),
        correlationId: job.correlationId
      });
      const chainedExtractionJob =
        comparison.comparison.selectedEngine === "NONE" || !comparison.comparison.selectedText.trim()
          ? null
          : (
              await this.jobs.enqueue({
                principal,
                queue: "extraction",
                jobType: "extraction.from_text",
                dedupeKey: `extraction:${comparison.job.documentFileId}:${comparison.job.id}`,
                payload: {
                  documentFileId: comparison.job.documentFileId,
                  text: comparison.comparison.selectedText,
                  sourceEngine: comparison.comparison.selectedEngine
                },
                aggregateId: comparison.job.id
              })
            ).job;
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return {
        documentFileId: payload.documentFileId,
        ocrJobId: comparison.job.id,
        selectedEngine: comparison.comparison.selectedEngine,
        averageConfidence: comparison.comparison.averageConfidence,
        pageCount: ocrRun.pageCount ?? null,
        warningCount: ocrRun.warnings?.length ?? 0,
        attemptCount: Array.isArray(ocrRun.metadata?.attempts) ? ocrRun.metadata.attempts.length : null,
        selectedAttempts: Array.isArray(ocrRun.metadata?.selectedAttempts) ? ocrRun.metadata.selectedAttempts : [],
        cacheHit: Boolean(cachedRun),
        chainedExtractionJobId: chainedExtractionJob?.id ?? null
      };
    }

    if (job.jobType === "ocr.custom_crnn") {
      if (!this.documents || !this.customOcrClient) throw new Error("OCR_CUSTOM_CRNN_WORKER_NOT_CONFIGURED");
      const payload = CustomCrnnOcrPayloadSchema.parse(job.payload);
      const { checkpoint, modelVersion } = await this.resolveCustomCrnnCheckpoint(principal, payload);
      await this.jobs.progress({ principal, id: job.id, progress: 40 });
      const cacheKey = ocrResultCacheKey(principal.tenantId, payload.documentFileId, `custom-crnn:${hashCachePart(checkpoint)}`);
      const cachedRun = await this.readCachedOcrRun(cacheKey);
      const ocrRun =
        cachedRun ??
        (await this.documents.runCustomOcr({
          principal,
          documentFileId: payload.documentFileId,
          checkpoint,
          client: this.customOcrClient
        }));
      if (!cachedRun) await this.rememberOcrRun(cacheKey, ocrRun);
      await this.jobs.progress({ principal, id: job.id, progress: 65 });
      const comparison = await this.ocrComparison.compare({
        principal,
        documentFileId: payload.documentFileId,
        runs: [
          {
            engine: "CUSTOM_CRNN",
            text: ocrRun.text,
            confidence: ocrRun.confidence,
            ...(ocrRun.tokens !== undefined ? { tokens: ocrRun.tokens } : {}),
            ...(ocrRun.latencyMs !== undefined ? { latencyMs: ocrRun.latencyMs } : {}),
            ...(ocrRun.metadata !== undefined ? { metadata: ocrRun.metadata } : {})
          }
        ],
        ...(payload.groundTruthText !== undefined ? { groundTruthText: payload.groundTruthText } : {}),
        ...(payload.defaultCurrency ? { defaultCurrency: payload.defaultCurrency } : {}),
        correlationId: job.correlationId
      });
      const extractionSkipReason = customOcrExtractionSkipReason(comparison.comparison, ocrRun);
      const chainedExtractionJob =
        comparison.comparison.selectedEngine === "NONE" || !comparison.comparison.selectedText.trim() || extractionSkipReason
          ? null
          : (
              await this.jobs.enqueue({
                principal,
                queue: "extraction",
                jobType: "extraction.from_text",
                dedupeKey: `extraction:${comparison.job.documentFileId}:${comparison.job.id}`,
                payload: {
                  documentFileId: comparison.job.documentFileId,
                  text: preferredCustomOcrExtractionText(ocrRun, comparison.comparison.selectedText),
                  sourceEngine: comparison.comparison.selectedEngine
                },
                aggregateId: comparison.job.id
              })
            ).job;
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return {
        documentFileId: payload.documentFileId,
        ocrJobId: comparison.job.id,
        selectedEngine: comparison.comparison.selectedEngine,
        averageConfidence: comparison.comparison.averageConfidence,
        pageCount: ocrRun.pageCount ?? null,
        warningCount: ocrRun.warnings?.length ?? 0,
        segmentationManifest: typeof ocrRun.metadata?.segmentationManifest === "string" ? ocrRun.metadata.segmentationManifest : null,
        customModelVersion: typeof ocrRun.metadata?.modelVersion === "string" ? ocrRun.metadata.modelVersion : null,
        vocabVersion: typeof ocrRun.metadata?.vocabVersion === "string" ? ocrRun.metadata.vocabVersion : null,
        modelVersionId: modelVersion?.id ?? null,
        checkpoint,
        cacheHit: Boolean(cachedRun),
        extractionSkippedReason: extractionSkipReason,
        chainedExtractionJobId: chainedExtractionJob?.id ?? null
      };
    }

    if (job.jobType === "ocr.compare") {
      const payload = OcrComparePayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 45 });
      const comparison = await this.ocrComparison.compare({
        principal,
        documentFileId: payload.documentFileId,
        runs: payload.runs as OcrCandidateInput[],
        ...(payload.groundTruthText !== undefined ? { groundTruthText: payload.groundTruthText } : {}),
        ...(payload.defaultCurrency ? { defaultCurrency: payload.defaultCurrency } : {}),
        correlationId: job.correlationId
      });
      const chainedExtractionJob =
        comparison.comparison.selectedEngine === "NONE" || !comparison.comparison.selectedText.trim()
          ? null
          : (
              await this.jobs.enqueue({
                principal,
                queue: "extraction",
                jobType: "extraction.from_text",
                dedupeKey: `extraction:${comparison.job.documentFileId}:${comparison.job.id}`,
                payload: {
                  documentFileId: comparison.job.documentFileId,
                  text: comparison.comparison.selectedText,
                  sourceEngine: comparison.comparison.selectedEngine
                },
                aggregateId: comparison.job.id
              })
            ).job;
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return {
        ocrJobId: comparison.job.id,
        selectedEngine: comparison.comparison.selectedEngine,
        averageConfidence: comparison.comparison.averageConfidence,
        conflictFields: comparison.comparison.conflictFields,
        runCount: comparison.runs.length,
        chainedExtractionJobId: chainedExtractionJob?.id ?? null
      };
    }

    if (job.jobType === "model.category_smoke_train") {
      if (!this.modelService) throw new Error("MODEL_TRAINING_WORKER_NOT_CONFIGURED");
      const payload = CategorySmokeTrainPayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 35 });
      const trained = await this.modelService.trainCategorySmoke({
        principal,
        seed: payload.seed,
        samplesPerCategory: payload.samplesPerCategory
      });
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return modelTrainingWorkerResult(trained);
    }

    if (job.jobType === "model.custom_ocr_smoke_train") {
      if (!this.modelService) throw new Error("MODEL_TRAINING_WORKER_NOT_CONFIGURED");
      const payload = CustomOcrSmokeTrainPayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 35 });
      const trained = await this.modelService.trainCustomOcrSmoke({
        principal,
        seed: payload.seed,
        samples: payload.samples,
        epochs: payload.epochs
      });
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return modelTrainingWorkerResult(trained);
    }

    if (job.jobType === "model.ocr_benchmark") {
      if (!this.modelService) throw new Error("MODEL_BENCHMARK_WORKER_NOT_CONFIGURED");
      const payload = ModelOcrBenchmarkPayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 35 });
      const benchmarked = await this.modelService.benchmarkCustomOcr({
        principal,
        modelVersionId: payload.modelVersionId,
        samples: payload.samples,
        seed: payload.seed,
        split: payload.split,
        skipTesseract: payload.skipTesseract
      });
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return {
        engine: benchmarked.modelVersion.engine,
        modelVersionId: benchmarked.modelVersion.id,
        evaluationRunId: benchmarked.evaluationRun.id,
        evaluationStatus: benchmarked.evaluationRun.status,
        artifactKey: benchmarked.benchmark.artifactKey,
        reportKey: benchmarked.benchmark.reportKey,
        metricKeys:
          benchmarked.benchmark.metrics && typeof benchmarked.benchmark.metrics === "object"
            ? Object.keys(benchmarked.benchmark.metrics as Record<string, unknown>)
            : []
      };
    }

    if (job.jobType === "model.category_evaluate") {
      if (!this.modelService) throw new Error("MODEL_EVALUATION_WORKER_NOT_CONFIGURED");
      const payload = CategoryEvaluatePayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 35 });
      const evaluated = await this.modelService.evaluateCategoryModel({
        principal,
        modelVersionId: payload.modelVersionId,
        samplesPerCategory: payload.samplesPerCategory,
        seed: payload.seed,
        split: payload.split
      });
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return {
        engine: evaluated.modelVersion.engine,
        modelVersionId: evaluated.modelVersion.id,
        evaluationRunId: evaluated.evaluationRun.id,
        evaluationStatus: evaluated.evaluationRun.status,
        artifactKey: evaluated.evaluation.artifactKey,
        reportKey: evaluated.evaluation.reportKey,
        metricKeys:
          evaluated.evaluation.metrics && typeof evaluated.evaluation.metrics === "object"
            ? Object.keys(evaluated.evaluation.metrics as Record<string, unknown>)
            : []
      };
    }

    if (job.jobType === "report.export") {
      if (!this.reports) throw new Error("REPORT_EXPORT_WORKER_NOT_CONFIGURED");
      const payload = ReportExportPayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 35 });
      const generated = await this.reports.createExport({
        principal,
        workspaceId: payload.workspaceId,
        type: payload.type,
        ...(payload.month ? { month: payload.month } : {})
      });
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return {
        exportJobId: generated.exportJob.id,
        workspaceId: generated.exportJob.workspaceId,
        reportType: generated.exportJob.type,
        contentType: generated.contentType,
        filename: generated.filename,
        sizeBytes: generated.sizeBytes,
        sha256: generated.sha256,
        bucket: generated.exportJob.bucket,
        objectKey: generated.exportJob.objectKey,
        signedUrl: generated.signedUrl
      };
    }

    if (job.jobType === "annotation.export_dataset") {
      if (!this.reports) throw new Error("ANNOTATION_EXPORT_WORKER_NOT_CONFIGURED");
      const payload = AnnotationExportPayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 35 });
      const generated = await this.reports.createExport({
        principal,
        workspaceId: payload.workspaceId,
        type: "dataset_export_jsonl",
        ...(payload.month ? { month: payload.month } : {})
      });
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return {
        exportJobId: generated.exportJob.id,
        workspaceId: generated.exportJob.workspaceId,
        reportType: generated.exportJob.type,
        contentType: generated.contentType,
        filename: generated.filename,
        sizeBytes: generated.sizeBytes,
        sha256: generated.sha256,
        bucket: generated.exportJob.bucket,
        objectKey: generated.exportJob.objectKey,
        signedUrl: generated.signedUrl
      };
    }

    if (job.jobType === "cleanup.temp_files") {
      if (!this.tempCleanup) throw new Error("TEMP_CLEANUP_WORKER_NOT_CONFIGURED");
      const payload = TempCleanupPayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 35 });
      const cleanup = await this.tempCleanup.cleanup({
        subdir: payload.subdir,
        maxAgeMs: payload.maxAgeMs,
        dryRun: payload.dryRun
      });
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return cleanup;
    }

    if (job.jobType === "notification.create") {
      if (!this.notifications) throw new Error("NOTIFICATION_WORKER_NOT_CONFIGURED");
      const payload = NotificationCreatePayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 45 });
      const notification = await this.notifications.create({
        principal,
        userId: payload.userId ?? principal.userId,
        type: payload.type,
        title: payload.title,
        body: payload.body,
        payload: payload.payload ?? null
      });
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return {
        notificationId: notification.id,
        userId: notification.userId,
        type: notification.type,
        readAt: notification.readAt,
        createdAt: notification.createdAt.toISOString()
      };
    }

    if (job.jobType === "webhook.delivery") {
      if (!this.webhooks) throw new Error("WEBHOOK_WORKER_NOT_CONFIGURED");
      const payload = WebhookDeliveryPayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 45 });
      const result = await this.webhooks.deliver({
        principal,
        endpointId: payload.endpointId ?? null,
        eventType: payload.eventType,
        payload: payload.payload,
        correlationId: job.correlationId
      });
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return result;
    }

    if (job.jobType === "extraction.from_text") {
      const payload = ExtractionPayloadSchema.parse(job.payload);
      await this.jobs.progress({ principal, id: job.id, progress: 45 });
      const extraction = await this.extraction.extractFromText({
        principal,
        documentFileId: payload.documentFileId,
        text: payload.text,
        sourceEngine: (payload.sourceEngine ?? null) as OCREngineCode | null,
        correlationId: job.correlationId
      });
      await this.jobs.progress({ principal, id: job.id, progress: 85 });
      return {
        extractionJobId: extraction.job.id,
        fieldCount: extraction.fields.length,
        issueCount: extraction.issues.length,
        totalAmountMinor: extraction.extracted.total?.amountMinor.toString() ?? null,
        currency: extraction.extracted.total?.currency ?? extraction.extracted.currency,
        merchantName: extraction.extracted.merchantName
      };
    }

    throw new Error(`UNSUPPORTED_WORKER_JOB_TYPE:${job.jobType}`);
  }

  private async resolveCustomCrnnCheckpoint(
    principal: AuthPrincipal,
    payload: z.infer<typeof CustomCrnnOcrPayloadSchema>
  ): Promise<{ checkpoint: string; modelVersion: StoredModelVersion | null }> {
    if (payload.checkpoint) {
      if (!this.allowUnregisteredCustomOcrCheckpoint) {
        throw new Error("CUSTOM_OCR_UNREGISTERED_CHECKPOINT_DISABLED");
      }
      return { checkpoint: normalizeCheckpoint(payload.checkpoint), modelVersion: null };
    }
    if (!this.modelRepository) throw new Error("CUSTOM_OCR_MODEL_REGISTRY_NOT_CONFIGURED");

    const modelVersion = payload.modelVersionId
      ? await this.modelRepository.findModelVersion({ tenantId: principal.tenantId, modelVersionId: payload.modelVersionId })
      : (await this.modelRepository.listModelVersions({ tenantId: principal.tenantId })).find(
          (version) => version.engine === "CUSTOM_CRNN" && version.status === "ACTIVE"
        ) ?? null;
    if (!modelVersion) throw new Error("CUSTOM_OCR_ACTIVE_MODEL_NOT_FOUND");
    if (modelVersion.engine !== "CUSTOM_CRNN") throw new Error("CUSTOM_OCR_MODEL_ENGINE_MISMATCH");
    if (modelVersion.status !== "ACTIVE") throw new Error("CUSTOM_OCR_MODEL_NOT_ACTIVE");
    if (!modelVersion.artifactBucket || !modelVersion.artifactKey) {
      throw new Error("CUSTOM_OCR_MODEL_ARTIFACT_UNAVAILABLE");
    }
    const blockCode = getCustomOcrPromotionBlockCode(modelVersion);
    if (blockCode) throw new Error(customOcrWorkerReadinessCode(blockCode));
    if (modelVersion.artifactBucket === "local-artifacts") {
      return { checkpoint: normalizeCheckpoint(`${modelVersion.artifactKey}/model.pt`), modelVersion };
    }
    if (!this.artifactStorage) throw new Error("CUSTOM_OCR_MODEL_ARTIFACT_STORAGE_NOT_CONFIGURED");
    const checkpoint = await this.cacheObjectStorageCheckpoint({
      tenantId: principal.tenantId,
      modelVersionId: modelVersion.id,
      bucket: modelVersion.artifactBucket,
      artifactKey: modelVersion.artifactKey
    });
    return { checkpoint: normalizeCheckpoint(checkpoint), modelVersion };
  }

  private async cacheObjectStorageCheckpoint(input: {
    tenantId: string;
    modelVersionId: string;
    bucket: string;
    artifactKey: string;
  }): Promise<string> {
    const artifactKey = normalizeArtifactObjectPrefix(input.artifactKey);
    const checkpoint = await this.artifactStorage!.getObject({
      bucket: input.bucket,
      objectKey: `${artifactKey}/model.pt`
    });
    const projectRoot = findProjectRoot();
    const root = path.resolve(projectRoot, "artifacts", "models", "cache");
    const target = path.resolve(root, input.tenantId, input.modelVersionId, "model.pt");
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("CUSTOM_OCR_MODEL_CACHE_PATH_INVALID");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, checkpoint);
    return path.relative(projectRoot, target).replace(/\\/g, "/");
  }

  private async readCachedOcrRun(key: string): Promise<CachedOcrRun | null> {
    try {
      const cached = await this.cache?.getHotState<CachedOcrRun>(key);
      if (!cached || typeof cached.text !== "string" || !Number.isFinite(cached.confidence)) return null;
      const tokens = sanitizeCachedOcrTokens(cached.tokens);
      return {
        text: cached.text,
        confidence: clampConfidence(cached.confidence),
        ...(tokens.length > 0 ? { tokens } : {}),
        ...(Number.isFinite(cached.latencyMs) ? { latencyMs: cached.latencyMs } : {}),
        ...(Array.isArray(cached.warnings) ? { warnings: cached.warnings.filter((warning) => typeof warning === "string") } : {}),
        ...(Number.isInteger(cached.pageCount) ? { pageCount: cached.pageCount } : {}),
        ...(isRecord(cached.metadata) ? { metadata: cached.metadata } : {})
      };
    } catch {
      return null;
    }
  }

  private async rememberOcrRun(key: string, run: CachedOcrRun): Promise<void> {
    try {
      const tokens = sanitizeCachedOcrTokens(run.tokens);
      await this.cache?.setHotState({
        key,
        ttlSeconds: 6 * 60 * 60,
        value: {
          text: run.text,
          confidence: clampConfidence(run.confidence),
          ...(tokens.length > 0 ? { tokens } : {}),
          ...(Number.isFinite(run.latencyMs) ? { latencyMs: run.latencyMs } : {}),
          ...(run.warnings ? { warnings: run.warnings } : {}),
          ...(Number.isInteger(run.pageCount) ? { pageCount: run.pageCount } : {}),
          ...(isRecord(run.metadata) ? { metadata: run.metadata } : {})
        }
      });
    } catch {
      // OCR result cache is an optimization; persisted OCR comparison/extraction rows remain authoritative.
    }
  }

  private async auditRunNext(
    input: { principal: AuthPrincipal; queue?: string; workerId: string },
    result: WorkerRunResult
  ): Promise<void> {
    // An empty, healthy queue poll is heartbeat noise rather than an auditable action.
    if (!result.processed && !result.skippedReason) return;
    try {
      await this.audit?.create({
        tenantId: input.principal.tenantId,
        actorUserId: input.principal.userId,
        action: "worker.run_next.completed",
        resourceType: "WorkerQueue",
        resourceId: input.queue ?? null,
        metadata: {
          queue: input.queue ?? null,
          workerId: input.workerId,
          processed: result.processed,
          skippedReason: result.skippedReason ?? null,
          coordination: result.coordination
            ? {
                lockAcquired: result.coordination.lockAcquired,
                degraded: result.coordination.degraded,
                keyPresent: Boolean(result.coordination.key)
              }
            : null,
          jobId: result.job?.id ?? null,
          jobType: result.job?.jobType ?? null,
          jobStatus: result.job?.status ?? null
        }
      });
    } catch {
      // Worker output is authoritative; audit persistence must not block local job draining.
    }
  }
}

type CachedOcrRun = {
  text: string;
  confidence: number;
  tokens?: Array<{ text: string; confidence: number; bbox: [number, number, number, number]; pageNumber?: number | undefined }>;
  latencyMs?: number;
  warnings?: string[];
  pageCount?: number;
  metadata?: Record<string, unknown>;
};

const documentOcrPipelineQueues = ["preprocessing", "ocr", "extraction"] as const;
const documentOcrPipelineJobTypes = new Set(["document.preprocess", "ocr.tesseract", "ocr.custom_crnn", "extraction.from_text"]);
const staleDocumentPipelineJobMs = parsePositiveInteger(
  process.env.WORKER_DOCUMENT_PIPELINE_STALE_MS,
  process.env.NODE_ENV === "test" ? 1 : 2 * 60 * 1000
);

export function ocrResultCacheKey(tenantId: string, documentFileId: string, engineKey: string): string {
  return `ocr-result:${tenantId}:${documentFileId}:${engineKey}`;
}

function hashCachePart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeCachedOcrTokens(value: unknown): NonNullable<CachedOcrRun["tokens"]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((token): NonNullable<CachedOcrRun["tokens"]> => {
    if (!token || typeof token !== "object") return [];
    const row = token as Record<string, unknown>;
    const bbox = row.bbox;
    if (
      typeof row.text !== "string" ||
      typeof row.confidence !== "number" ||
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)
    ) {
      return [];
    }
    const pageNumber = row.pageNumber;
    return [
      {
        text: row.text,
        confidence: clampConfidence(row.confidence),
        bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        ...(typeof pageNumber === "number" && Number.isInteger(pageNumber) && pageNumber > 0 ? { pageNumber } : {})
      }
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function preferredCustomOcrExtractionText(run: CachedOcrRun, fallback: string): string {
  const normalizedText = isRecord(run.metadata) && typeof run.metadata.normalizedText === "string" ? run.metadata.normalizedText.trim() : "";
  return normalizedText || fallback;
}

function customOcrExtractionSkipReason(comparison: OcrComparisonResult, run?: CachedOcrRun): string | null {
  if (comparison.selectedEngine !== "CUSTOM_CRNN") return null;
  const warnings = new Set(run?.warnings ?? []);
  if (warnings.has("CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE")) return "CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE";
  if (warnings.has("CUSTOM_OCR_LOW_CONFIDENCE")) return "CUSTOM_OCR_LOW_CONFIDENCE";
  if (warnings.has("CUSTOM_OCR_SEGMENTATION_SUSPECT")) return "CUSTOM_OCR_SEGMENTATION_SUSPECT";
  const selectedScore = comparison.selectionScores.find((score) => score.engine === "CUSTOM_CRNN");
  if (!selectedScore) return "CUSTOM_OCR_REVIEW_REQUIRED";
  if (selectedScore.criticalIssueCount > 0) return "CUSTOM_OCR_REQUIRES_REVIEW";
  return null;
}

function customOcrWorkerReadinessCode(code: CustomOcrPromotionBlockCode): string {
  if (code === "CUSTOM_OCR_PROMOTION_ARTIFACT_REQUIRED") return "CUSTOM_OCR_MODEL_ARTIFACT_UNAVAILABLE";
  if (code === "CUSTOM_OCR_PROMOTION_REAL_FIXTURE_GATE_FAILED") return "CUSTOM_OCR_REAL_FIXTURE_GATE_FAILED";
  return "CUSTOM_OCR_MODEL_NOT_REAL_VALIDATED";
}

function oldest(jobs: StoredWorkerJob[]): StoredWorkerJob | null {
  return jobs.reduce<StoredWorkerJob | null>((selected, job) => {
    if (!selected) return job;
    return job.createdAt.getTime() < selected.createdAt.getTime() ? job : selected;
  }, null);
}

function emptyDocumentPipelineResult(documentFileId: string, skippedReason: string): Omit<DocumentOcrPipelineRunResult, "coordination"> {
  return {
    processed: false,
    documentFileId,
    jobsProcessed: [],
    latestStage: "none",
    latestStatus: "IDLE",
    rawOcrAvailable: false,
    extractionAvailable: false,
    canProceed: true,
    failureReason: null,
    skippedReason
  };
}

function isDocumentOcrPipelineJob(job: StoredWorkerJob, documentFileId: string): boolean {
  return documentOcrPipelineJobTypes.has(job.jobType) && (recordDocumentId(job.payload) === documentFileId || recordDocumentId(job.result) === documentFileId);
}

function recordDocumentId(record: Record<string, unknown> | null): string | null {
  const value = record?.documentFileId ?? record?.documentId;
  return typeof value === "string" ? value : null;
}

function stageFromDocumentOcrJob(job: StoredWorkerJob): DocumentOcrPipelineRunResult["latestStage"] {
  if (job.jobType === "document.preprocess") return "preprocessing";
  if (job.jobType === "extraction.from_text") return "extraction";
  if (job.jobType === "ocr.tesseract" || job.jobType === "ocr.custom_crnn") return "ocr";
  return "none";
}

function isRawOcrJob(job: StoredWorkerJob): boolean {
  return job.jobType === "ocr.tesseract" || job.jobType === "ocr.custom_crnn";
}

function normalizeCheckpoint(checkpoint: string): string {
  const normalized = checkpoint.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!normalized.startsWith("artifacts/models/") || normalized.includes("../")) {
    throw new Error("INVALID_CUSTOM_OCR_CHECKPOINT_PATH");
  }
  return normalized;
}

function normalizeArtifactObjectPrefix(artifactKey: string): string {
  const normalized = artifactKey.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error("CUSTOM_OCR_MODEL_ARTIFACT_KEY_INVALID");
  }
  return normalized;
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

function modelTrainingWorkerResult(input: {
  modelVersion: {
    id: string;
    engine: string;
    status: string;
    artifactKey: string | null;
    metrics: unknown;
  };
  trainingRun: { id: string; status: string } | null;
  evaluationRun: { id: string };
}): Record<string, unknown> {
  return {
    engine: input.modelVersion.engine,
    modelVersionId: input.modelVersion.id,
    modelStatus: input.modelVersion.status,
    trainingRunId: input.trainingRun?.id ?? null,
    trainingStatus: input.trainingRun?.status ?? null,
    evaluationRunId: input.evaluationRun.id,
    artifactKey: input.modelVersion.artifactKey,
    metricKeys:
      input.modelVersion.metrics && typeof input.modelVersion.metrics === "object"
        ? Object.keys(input.modelVersion.metrics as Record<string, unknown>)
        : []
  };
}
