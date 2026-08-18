import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import Redis from "ioredis";
import { kafkaTopics, permissions, roles, supportedUploadMimeTypes } from "@spendlens/shared";
import { PrismaClient } from "@prisma/client";
import { type AppConfig, loadConfig } from "./config";
import { InMemoryAuditRepository } from "./modules/audit/memory-repository";
import { PrismaAuditRepository } from "./modules/audit/prisma-repository";
import { registerAuditRoutes } from "./modules/audit/routes";
import { AuditService } from "./modules/audit/service";
import type { AuditRepository } from "./modules/audit/types";
import { registerAiRoutes } from "./modules/ai/routes";
import { AiService } from "./modules/ai/service";
import { InMemoryAuthRepository } from "./modules/auth/memory-repository";
import { PrismaAuthRepository } from "./modules/auth/prisma-repository";
import { ApiKeyService } from "./modules/auth/api-keys";
import { registerApiKeyRoutes } from "./modules/auth/api-key-routes";
import { registerAuthRoutes } from "./modules/auth/routes";
import { AuthService } from "./modules/auth/service";
import type { AuthPrincipal, AuthRepository, AuthWorkspace } from "./modules/auth/types";
import { InMemoryBudgetRepository } from "./modules/budgets/memory-repository";
import { PrismaBudgetRepository } from "./modules/budgets/prisma-repository";
import { registerBudgetRoutes } from "./modules/budgets/routes";
import { BudgetService } from "./modules/budgets/service";
import type { BudgetRepository } from "./modules/budgets/types";
import { InMemoryCacheStore } from "./modules/cache/memory-store";
import { RedisCacheStore } from "./modules/cache/redis-store";
import { registerCacheRoutes } from "./modules/cache/routes";
import { CacheService } from "./modules/cache/service";
import type { CacheStore } from "./modules/cache/types";
import { InMemoryDocumentRepository } from "./modules/documents/memory-repository";
import { PrismaDocumentRepository } from "./modules/documents/prisma-repository";
import { registerDocumentRoutes } from "./modules/documents/routes";
import { DocumentService } from "./modules/documents/service";
import type { DocumentCustomOcrClient, DocumentPreprocessingClient, DocumentTesseractOcrClient } from "./modules/documents/service";
import { InMemoryDocumentStorage, MinioDocumentStorage } from "./modules/documents/storage";
import type { DocumentRepository, DocumentStorage, DocumentStorageMetrics, StoredDocumentFile } from "./modules/documents/types";
import { InMemoryEventInboxRepository, InMemoryEventRepository } from "./modules/events/memory-repository";
import { KafkaJsConsumerLagProvider, parseCsv } from "./modules/events/lag";
import { KafkaJsEventProducer } from "./modules/events/producer";
import { PrismaEventInboxRepository, PrismaEventRepository } from "./modules/events/prisma-repository";
import { registerEventRoutes } from "./modules/events/routes";
import { EventService } from "./modules/events/service";
import type { EventInboxRepository, EventProducer, EventRepository } from "./modules/events/types";
import type { KafkaConsumerLagProvider } from "./modules/events/types";
import { InMemoryExtractionRepository } from "./modules/extraction/memory-repository";
import { PrismaExtractionRepository } from "./modules/extraction/prisma-repository";
import { registerExtractionRoutes } from "./modules/extraction/routes";
import { ExtractionService } from "./modules/extraction/service";
import type { ExtractionRepository } from "./modules/extraction/types";
import { InMemoryJobRepository } from "./modules/jobs/memory-repository";
import { PrismaJobRepository } from "./modules/jobs/prisma-repository";
import { registerJobRoutes } from "./modules/jobs/routes";
import { JobService } from "./modules/jobs/service";
import type { JobRepository } from "./modules/jobs/types";
import { OcrServiceCustomCrnnClient, OcrServicePreprocessingClient, OcrServiceTesseractClient } from "./modules/jobs/preprocessing-client";
import { TempCleanupService } from "./modules/jobs/temp-cleanup";
import { WorkerRuntimeService } from "./modules/jobs/worker-runtime";
import { WorkerRunnerService } from "./modules/jobs/worker-runner";
import { MetricsRegistry } from "./modules/metrics/registry";
import { InMemoryModelRepository } from "./modules/models/memory-repository";
import { PrismaModelRepository } from "./modules/models/prisma-repository";
import { registerModelRoutes } from "./modules/models/routes";
import {
  localCategoryTrainingRunner,
  localCategoryEvaluationRunner,
  localCustomOcrTrainingRunner,
  localOcrBenchmarkRunner,
  ocrServiceCustomOcrTrainingRunner
} from "./modules/models/runner";
import { ModelService } from "./modules/models/service";
import type {
  CategoryEvaluationRunner,
  CategoryTrainingRunner,
  CustomOcrTrainingRunner,
  ModelRepository,
  OcrBenchmarkRunner
} from "./modules/models/types";
import { InMemoryNotificationRepository } from "./modules/notifications/memory-repository";
import { PrismaNotificationRepository } from "./modules/notifications/prisma-repository";
import { registerNotificationRoutes } from "./modules/notifications/routes";
import { NotificationService } from "./modules/notifications/service";
import type { NotificationRepository } from "./modules/notifications/types";
import { InMemoryExpenseRepository } from "./modules/expenses/memory-repository";
import { PrismaExpenseRepository } from "./modules/expenses/prisma-repository";
import { registerExpenseRoutes } from "./modules/expenses/routes";
import { ExpenseService } from "./modules/expenses/service";
import type { ExpenseRepository, StoredExpense } from "./modules/expenses/types";
import { InMemoryOcrComparisonRepository } from "./modules/ocr-comparison/memory-repository";
import { PrismaOcrComparisonRepository } from "./modules/ocr-comparison/prisma-repository";
import { registerOcrComparisonRoutes } from "./modules/ocr-comparison/routes";
import { OcrComparisonService } from "./modules/ocr-comparison/service";
import type { OcrComparisonRepository } from "./modules/ocr-comparison/types";
import { InMemoryReportRepository } from "./modules/reports/memory-repository";
import { PrismaReportRepository } from "./modules/reports/prisma-repository";
import { registerReportRoutes } from "./modules/reports/routes";
import { ReportService } from "./modules/reports/service";
import type { ReportRepository } from "./modules/reports/types";
import { InMemoryReviewRepository } from "./modules/review/memory-repository";
import { PrismaReviewRepository } from "./modules/review/prisma-repository";
import { registerReviewRoutes } from "./modules/review/routes";
import { ReviewService } from "./modules/review/service";
import type { ReviewRepository } from "./modules/review/types";
import { registerTurkishSandboxRoutes } from "./modules/turkish-sandbox/routes";
import { buildCorsOptions } from "./modules/security/http-security";
import { InMemoryWebhookRepository } from "./modules/webhooks/memory-repository";
import { PrismaWebhookRepository } from "./modules/webhooks/prisma-repository";
import { registerWebhookRoutes } from "./modules/webhooks/routes";
import { WebhookService } from "./modules/webhooks/service";
import type { WebhookDeliveryClient, WebhookRepository } from "./modules/webhooks/types";
import { registerWorkspaceRoutes } from "./modules/workspaces/routes";
import {
  AdminOperationError,
  registerHealthRoutes,
  type AdminDocumentReprocessResult,
  type AdminOperationsSnapshot
} from "./routes/health";

export type BuildAppOptions = {
  authRepository?: AuthRepository;
  documentRepository?: DocumentRepository;
  documentStorage?: DocumentStorage;
  extractionRepository?: ExtractionRepository;
  expenseRepository?: ExpenseRepository;
  ocrComparisonRepository?: OcrComparisonRepository;
  budgetRepository?: BudgetRepository;
  reportRepository?: ReportRepository;
  reviewRepository?: ReviewRepository;
  eventRepository?: EventRepository;
  eventInboxRepository?: EventInboxRepository;
  eventProducer?: EventProducer;
  eventLagProvider?: KafkaConsumerLagProvider;
  jobRepository?: JobRepository;
  cacheStore?: CacheStore;
  auditRepository?: AuditRepository;
  modelRepository?: ModelRepository;
  modelArtifactStorage?: DocumentStorage;
  modelArtifactBucket?: string;
  notificationRepository?: NotificationRepository;
  webhookRepository?: WebhookRepository;
  webhookDeliveryClient?: WebhookDeliveryClient;
  categoryEvaluationRunner?: CategoryEvaluationRunner;
  categoryTrainingRunner?: CategoryTrainingRunner;
  customOcrTrainingRunner?: CustomOcrTrainingRunner;
  ocrBenchmarkRunner?: OcrBenchmarkRunner;
  preprocessingClient?: DocumentPreprocessingClient;
  tesseractClient?: DocumentTesseractOcrClient;
  customOcrClient?: DocumentCustomOcrClient;
  tempCleanupService?: TempCleanupService;
  rateLimitRedisClient?: RateLimitRedisClient;
  config?: Partial<AppConfig>;
};

type RateLimitRedisClient = {
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void;
  disconnect?: () => void;
  rateLimit?: unknown;
};

const ADMIN_HEALTH_OPERATIONS_CACHE_TTL_SECONDS = 60;

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...options.config };
  const metrics = new MetricsRegistry();
  const requestStarts = new WeakMap<object, bigint>();
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie"]
    },
    genReqId: (request) =>
      (request.headers["x-request-id"] as string | undefined) ??
      (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`)
  });
  const useMemoryAdapters = config.SPENDLENS_USE_MEMORY_ADAPTERS;
  const ownedRateLimitRedisClient =
    !options.rateLimitRedisClient && !useMemoryAdapters && config.REDIS_URL
      ? new Redis(config.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false
        })
      : null;
  const rateLimitRedisClient = options.rateLimitRedisClient ?? ownedRateLimitRedisClient ?? undefined;

  await app.register(helmet, {
    contentSecurityPolicy: false,
    global: true
  });
  await app.register(cors, buildCorsOptions(config.CORS_ALLOWED_ORIGINS));
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_TIME_WINDOW,
    skipOnError: Boolean(rateLimitRedisClient),
    ...(rateLimitRedisClient ? { redis: rateLimitRedisClient, nameSpace: "spendlens-rate-limit-" } : {})
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "SpendLens AI API",
        version: "0.1.0",
        description: "Local-first OCR, expense, review, model and operations API."
      },
      servers: [
        {
          url: "http://localhost:4000",
          description: "Local API"
        }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Email/password sessions use Authorization: Bearer <access-token>."
          },
          apiKeyAuth: {
            type: "apiKey",
            in: "header",
            name: "Authorization",
            description: "Automation callers use Authorization: ApiKey <raw-key> with x-tenant-id."
          },
          tenantHeader: {
            type: "apiKey",
            in: "header",
            name: "x-tenant-id",
            description: "Required only for API-key automation calls."
          }
        },
        schemas: {
          ErrorResponse: {
            type: "object",
            required: ["message", "error", "statusCode"],
            properties: {
              message: { type: "string" },
              error: { type: "string" },
              statusCode: { type: "integer", example: 400 },
              requestId: { type: "string" },
              correlationId: { type: "string" }
            }
          },
          MoneyMinorUnit: {
            type: "object",
            required: ["amountMinor", "currency"],
            properties: {
              amountMinor: { type: "string", pattern: "^-?[0-9]+$", example: "18550" },
              currency: { type: "string", minLength: 3, maxLength: 3, example: "TRY" }
            }
          },
          ValidationIssue: {
            type: "object",
            required: ["code", "severity", "message"],
            properties: {
              code: { type: "string", example: "TOTAL_MISMATCH" },
              severity: { type: "string", enum: ["info", "warning", "error"] },
              message: { type: "string" }
            }
          }
        },
        examples: {
          RegisterRequest: {
            summary: "Create a local demo tenant owner",
            value: {
              tenantName: "Demo Tenant",
              tenantSlug: "demo-tenant",
              workspaceName: "Demo Workspace",
              email: "owner@example.test",
              displayName: "Demo Owner",
              password: "very-secure-password"
            }
          },
          ExpenseCreateRequest: {
            summary: "Create an integer-minor-unit expense",
            value: {
              workspaceId: "workspace-id",
              merchantName: "Metro Market",
              occurredAt: "2026-05-21T09:30:00.000Z",
              currency: "TRY",
              totalAmountMinor: 18550,
              paymentMethodName: "Corporate Card",
              lineItems: [
                {
                  name: "Kahve",
                  quantity: "2",
                  unitPriceMinor: 4500,
                  totalMinor: 9000
                }
              ]
            }
          },
          DocumentReprocessRequest: {
            summary: "Queue local OCR reprocessing stages",
            value: {
              stages: ["preprocess", "tesseract", "custom_crnn"],
              preprocessingProfile: "TESSERACT_OPTIMIZED",
              language: "tur+eng",
              checkpoint: null
            }
          },
          TurkishSandboxParseRequest: {
            summary: "Parse local-only sandbox Turkish invoice data",
            value: {
              contentType: "qr",
              content: "vkn=1234567890&date=2026-05-21&total=185.50&currency=TRY",
              documentKind: "invoice"
            }
          }
        }
      }
    }
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs"
  });

  app.addHook("onRequest", async (request, reply) => {
    requestStarts.set(request, process.hrtime.bigint());
    reply.header("x-request-id", request.id);
    reply.header("x-correlation-id", request.headers["x-correlation-id"] ?? request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStarts.get(request);
    const durationSeconds = startedAt ? Number(process.hrtime.bigint() - startedAt) / 1_000_000_000 : 0;
    metrics.recordHttpRequest({
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      statusCode: reply.statusCode,
      durationSeconds
    });
  });

  const workerRuntimeHolder: { runtime?: WorkerRuntimeService } = {};
  const needsPrisma = !useMemoryAdapters && !options.authRepository;
  const prisma = needsPrisma ? new PrismaClient() : null;
  const cacheStore =
    options.cacheStore ?? (!useMemoryAdapters && config.REDIS_URL ? new RedisCacheStore(config.REDIS_URL) : new InMemoryCacheStore());
  const eventProducer =
    options.eventProducer ??
    (!useMemoryAdapters && config.KAFKA_BROKERS
      ? new KafkaJsEventProducer(config.KAFKA_BROKERS.split(",").map((broker) => broker.trim()).filter(Boolean))
      : undefined);
  const eventLagProvider =
    options.eventLagProvider ??
    (!useMemoryAdapters && config.KAFKA_BROKERS && config.KAFKA_LAG_CONSUMER_GROUPS
      ? new KafkaJsConsumerLagProvider(
          parseCsv(config.KAFKA_BROKERS),
          parseCsv(config.KAFKA_LAG_CONSUMER_GROUPS),
          [...kafkaTopics]
        )
      : undefined);
  app.addHook("onClose", async () => {
    await workerRuntimeHolder.runtime?.stopAll();
    await eventLagProvider?.close?.();
    await eventProducer?.close?.();
    ownedRateLimitRedisClient?.disconnect();
    await prisma?.$disconnect();
    await cacheStore.close?.();
  });

  const authRepository = options.authRepository ?? (prisma ? new PrismaAuthRepository(prisma) : new InMemoryAuthRepository());
  const auditRepository =
    options.auditRepository ?? (prisma ? new PrismaAuditRepository(prisma) : new InMemoryAuditRepository());
  const authService = new AuthService({
    repository: authRepository,
    accessTokenSecret: config.JWT_ACCESS_SECRET,
    refreshTokenSecret: config.JWT_REFRESH_SECRET,
    auditRepository
  });
  await registerAuthRoutes(app, authService);
  await registerWorkspaceRoutes(app, authService, authRepository);
  await registerApiKeyRoutes(app, authService, new ApiKeyService(authRepository, config.API_KEY_PEPPER, auditRepository));
  await registerAiRoutes(app, authService, new AiService(config, auditRepository));
  const cacheService = new CacheService(cacheStore, auditRepository);
  await registerCacheRoutes(app, authService, cacheService);
  await registerAuditRoutes(app, authService, new AuditService(auditRepository));
  const eventRepository =
    options.eventRepository ?? (prisma ? new PrismaEventRepository(prisma) : new InMemoryEventRepository());
  const eventInboxRepository =
    options.eventInboxRepository ?? (prisma ? new PrismaEventInboxRepository(prisma) : new InMemoryEventInboxRepository());
  const eventService = new EventService(eventRepository, eventInboxRepository, eventProducer, eventLagProvider, auditRepository);
  await registerEventRoutes(app, authService, eventService);
  const jobRepository = options.jobRepository ?? (prisma ? new PrismaJobRepository(prisma) : new InMemoryJobRepository());
  const jobService = new JobService(jobRepository, eventService, cacheService, auditRepository);
  const documentRepository =
    options.documentRepository ??
    (prisma ? new PrismaDocumentRepository(prisma) : new InMemoryDocumentRepository(useMemoryAdapters));
  const documentStorage =
    options.documentStorage ??
    (!useMemoryAdapters && config.MINIO_ENDPOINT
      ? MinioDocumentStorage.fromEndpoint({
          endpoint: config.MINIO_ENDPOINT,
          accessKey: config.MINIO_ROOT_USER,
          secretKey: config.MINIO_ROOT_PASSWORD
        })
      : new InMemoryDocumentStorage());
  const preprocessingClient =
    options.preprocessingClient ?? (config.OCR_SERVICE_URL ? new OcrServicePreprocessingClient(config.OCR_SERVICE_URL) : undefined);
  const tesseractClient =
    options.tesseractClient ?? (config.OCR_SERVICE_URL ? new OcrServiceTesseractClient(config.OCR_SERVICE_URL) : undefined);
  const customOcrClient =
    options.customOcrClient ?? (config.OCR_SERVICE_URL ? new OcrServiceCustomCrnnClient(config.OCR_SERVICE_URL) : undefined);
  const extractionRepository =
    options.extractionRepository ??
    (prisma ? new PrismaExtractionRepository(prisma) : new InMemoryExtractionRepository());
  const documentService = new DocumentService({
    repository: documentRepository,
    storage: documentStorage,
    bucket: config.MINIO_BUCKET_DOCUMENTS,
    maxBytes: config.DOCUMENT_MAX_UPLOAD_BYTES,
    maxResumableBytes: Math.max(config.DOCUMENT_MAX_UPLOAD_BYTES, 512 * 1024 * 1024),
    tenantStorageSoftLimitBytes: config.TENANT_STORAGE_SOFT_LIMIT_BYTES,
    events: eventService,
    jobs: jobService,
    cache: cacheService,
    audit: auditRepository,
    extractionRepository,
    enqueueTesseractAfterPreprocessing: Boolean(tesseractClient)
  });
  await registerDocumentRoutes(app, authService, documentService, config.DOCUMENT_MAX_UPLOAD_BYTES);
  await registerTurkishSandboxRoutes(app, authService);
  const extractionService = new ExtractionService(documentRepository, extractionRepository, auditRepository);
  await registerExtractionRoutes(app, authService, extractionService);
  const expenseRepository =
    options.expenseRepository ?? (prisma ? new PrismaExpenseRepository(prisma) : new InMemoryExpenseRepository());
  await registerHealthRoutes(
    app,
    authService,
    () => workerRuntimeHolder.runtime,
    (principal) =>
      buildCachedAdminOperationsSnapshot({
        principal,
        authRepository,
        documentRepository,
        expenseRepository,
        documentStorage,
        cacheService,
        config,
        eventProducer,
        eventLagProvider,
        rateLimitRedisClient
      }),
    {
      reprocessDocument: async (input) => {
        if (
          input.stages.includes("custom_crnn") &&
          input.checkpoint &&
          !config.CUSTOM_OCR_ALLOW_UNREGISTERED_CHECKPOINT
        ) {
          throw new AdminOperationError("CUSTOM_OCR_UNREGISTERED_CHECKPOINT_DISABLED", 400);
        }
        const document = await documentRepository.findById(input.principal.tenantId, input.documentFileId);
        if (!document || document.deletedAt) throw new AdminOperationError("DOCUMENT_NOT_FOUND", 404);
        const enqueued: AdminDocumentReprocessResult["enqueued"] = [];
        const pushQueuedStage = async (
          stage: AdminDocumentReprocessResult["enqueued"][number]["stage"],
          queued: Awaited<ReturnType<JobService["enqueue"]>>
        ) => {
          const retryableTerminalJob =
            queued.deduped &&
            (queued.job.status === "FAILED" || queued.job.status === "CANCELED") &&
            queued.job.attempts < queued.job.maxAttempts;
          if (retryableTerminalJob) {
            const retriedJob = await jobService.retry({ principal: input.principal, id: queued.job.id });
            enqueued.push({ stage, job: retriedJob, deduped: false, retried: true });
            return;
          }
          enqueued.push({ stage, job: queued.job, deduped: queued.deduped });
        };
        if (input.stages.includes("preprocess")) {
          const queued = await jobService.enqueue({
            principal: input.principal,
            queue: "preprocessing",
            jobType: "document.preprocess",
            dedupeKey: `preprocess:${document.id}:${input.preprocessingProfile}`,
            eventTopic: "ocr.job.created",
            aggregateId: document.id,
            correlationId: input.correlationId ?? null,
            payload: {
              documentFileId: document.id,
              profile: input.preprocessingProfile,
              runTesseractAfter: false,
              source: "admin_reprocess"
            }
          });
          await pushQueuedStage("preprocess", queued);
        }
        if (input.stages.includes("tesseract")) {
          const queued = await jobService.enqueue({
            principal: input.principal,
            queue: "ocr",
            jobType: "ocr.tesseract",
            dedupeKey: `ocr:tesseract:${document.id}:${input.language}`,
            eventTopic: "ocr.job.created",
            aggregateId: document.id,
            correlationId: input.correlationId ?? null,
            payload: {
              documentFileId: document.id,
              language: input.language,
              source: "admin_reprocess"
            }
          });
          await pushQueuedStage("tesseract", queued);
        }
        if (input.stages.includes("custom_crnn")) {
          const queued = await jobService.enqueue({
            principal: input.principal,
            queue: "ocr",
            jobType: "ocr.custom_crnn",
            dedupeKey: `ocr:custom-crnn:${document.id}:${input.checkpoint ?? "active"}`,
            eventTopic: "ocr.job.created",
            aggregateId: document.id,
            correlationId: input.correlationId ?? null,
            payload: {
              documentFileId: document.id,
              ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
              source: "admin_reprocess"
            }
          });
          await pushQueuedStage("custom_crnn", queued);
        }
        await auditRepository
          .create({
            tenantId: input.principal.tenantId,
            actorUserId: input.principal.userId,
            action: "admin.document_reprocess.requested",
            resourceType: "AdminOperation",
            resourceId: document.id,
            metadata: {
              operation: "document_reprocess",
              documentFileId: document.id,
              workspaceId: document.workspaceId,
              requestedStages: input.stages,
              enqueuedStages: enqueued.map((item) => item.stage),
              enqueuedJobCount: enqueued.length,
              enqueuedQueues: [...new Set(enqueued.map((item) => item.job.queue))],
              preprocessingProfile: input.preprocessingProfile,
              language: input.language,
              checkpointProvided: Boolean(input.checkpoint)
            },
            correlationId: input.correlationId ?? null
          })
          .catch(() => undefined);
        return {
          documentFileId: document.id,
          workspaceId: document.workspaceId,
          requestedStages: input.stages,
          enqueued
        };
      }
    },
    prisma
      ? async () => {
          try {
            await prisma.$queryRaw`SELECT 1`;
            return { status: "ok" };
          } catch (error) {
            return {
              status: "degraded",
              detail: error instanceof Error ? error.message : "PostgreSQL readiness check failed"
            };
          }
        }
      : undefined
  );
  const reviewRepository =
    options.reviewRepository ?? (prisma ? new PrismaReviewRepository(prisma) : new InMemoryReviewRepository());
  await registerExpenseRoutes(
    app,
    authService,
    new ExpenseService(documentRepository, extractionRepository, expenseRepository, eventService, cacheService, auditRepository, reviewRepository)
  );
  const budgetRepository =
    options.budgetRepository ?? (prisma ? new PrismaBudgetRepository(prisma) : new InMemoryBudgetRepository());
  await registerBudgetRoutes(
    app,
    authService,
    new BudgetService(documentRepository, expenseRepository, budgetRepository, cacheService, auditRepository)
  );
  const ocrComparisonRepository =
    options.ocrComparisonRepository ??
    (prisma ? new PrismaOcrComparisonRepository(prisma) : new InMemoryOcrComparisonRepository());
  const modelRepository =
    options.modelRepository ?? (prisma ? new PrismaModelRepository(prisma) : new InMemoryModelRepository());
  const reportRepository =
    options.reportRepository ?? (prisma ? new PrismaReportRepository(prisma) : new InMemoryReportRepository());
  const modelService = new ModelService(
    modelRepository,
    options.categoryTrainingRunner ?? localCategoryTrainingRunner,
    options.customOcrTrainingRunner ??
      (config.OCR_SERVICE_URL ? ocrServiceCustomOcrTrainingRunner(config.OCR_SERVICE_URL) : localCustomOcrTrainingRunner),
    options.ocrBenchmarkRunner ?? localOcrBenchmarkRunner,
    options.categoryEvaluationRunner ?? localCategoryEvaluationRunner,
    eventService,
    reportRepository,
    cacheService,
    auditRepository,
    options.modelArtifactStorage ?? (!useMemoryAdapters && config.MINIO_ENDPOINT ? documentStorage : undefined),
    options.modelArtifactBucket ?? config.MINIO_BUCKET_ARTIFACTS
  );
  const notificationRepository =
    options.notificationRepository ??
    (prisma ? new PrismaNotificationRepository(prisma) : new InMemoryNotificationRepository());
  const webhookRepository =
    options.webhookRepository ?? (prisma ? new PrismaWebhookRepository(prisma) : new InMemoryWebhookRepository());
  const reportService = new ReportService(
    documentRepository,
    expenseRepository,
    reportRepository,
    documentStorage,
    config.MINIO_BUCKET_DOCUMENTS,
    eventService,
    ocrComparisonRepository,
    modelRepository,
    auditRepository,
    reviewRepository
  );
  await registerReportRoutes(app, authService, reportService);
  const reviewService = new ReviewService(documentRepository, reviewRepository, authRepository, auditRepository);
  await registerReviewRoutes(app, authService, reviewService);
  const notificationService = new NotificationService(notificationRepository, auditRepository);
  await registerNotificationRoutes(app, authService, notificationService);
  const webhookService = new WebhookService(
    webhookRepository,
    options.webhookDeliveryClient,
    eventService,
    auditRepository,
    config.WEBHOOK_SECRET_ENCRYPTION_KEY
  );
  await registerWebhookRoutes(app, authService, webhookService);
  const ocrComparisonService = new OcrComparisonService(documentRepository, ocrComparisonRepository, auditRepository);
  await registerOcrComparisonRoutes(app, authService, ocrComparisonService, jobService);
  const tempCleanupService = options.tempCleanupService ?? new TempCleanupService();
  const workerRunner = new WorkerRunnerService(
    jobService,
    extractionService,
    ocrComparisonService,
    documentService,
    preprocessingClient,
    tesseractClient,
    customOcrClient,
    modelRepository,
    modelService,
    reportService,
    tempCleanupService,
    notificationService,
    webhookService,
    cacheService,
    auditRepository,
    options.modelArtifactStorage ?? (!useMemoryAdapters && config.MINIO_ENDPOINT ? documentStorage : undefined),
    config.CUSTOM_OCR_ALLOW_UNREGISTERED_CHECKPOINT
  );
  const workerRuntime = new WorkerRuntimeService(workerRunner);
  workerRuntimeHolder.runtime = workerRuntime;
  await registerJobRoutes(app, authService, jobService, workerRunner, workerRuntime);
  await registerModelRoutes(app, authService, modelService, {
    tesseract: Boolean(tesseractClient),
    customOcr: Boolean(customOcrClient)
  });

  app.get("/catalog", async () => ({
    roles,
    permissions,
    kafkaTopics,
    supportedUploadMimeTypes
  }));

  app.get("/metrics", async (_request, reply) => {
    reply.type("text/plain");
    const input: Parameters<typeof metrics.render>[0] = {};
    try {
      input.events = await eventService.metrics();
    } catch {
      // Metrics must stay scrapeable if an optional repository is degraded.
    }
    try {
      input.jobs = await jobService.metrics();
    } catch {
      // Metrics must stay scrapeable if an optional repository is degraded.
    }
    try {
      input.cache = await cacheService.metrics();
    } catch {
      // Metrics must stay scrapeable if an optional dependency is degraded.
    }
    try {
      input.storage = await documentStorage.metrics();
    } catch {
      // Metrics must stay scrapeable if object storage is degraded.
    }
    try {
      input.ocr = await ocrComparisonService.metrics();
    } catch {
      // Metrics must stay scrapeable if an optional repository is degraded.
    }
    try {
      input.review = await reviewService.metrics();
    } catch {
      // Metrics must stay scrapeable if an optional repository is degraded.
    }
    return metrics.render(input);
  });

  return app;
}

type AdminOperationsSnapshotInput = {
  principal: AuthPrincipal;
  authRepository: AuthRepository;
  documentRepository: DocumentRepository;
  expenseRepository: ExpenseRepository;
  documentStorage: DocumentStorage;
  cacheService: CacheService;
  config: AppConfig;
  eventProducer: EventProducer | undefined;
  eventLagProvider: KafkaConsumerLagProvider | undefined;
  rateLimitRedisClient: RateLimitRedisClient | undefined;
};

async function buildCachedAdminOperationsSnapshot(input: AdminOperationsSnapshotInput): Promise<AdminOperationsSnapshot> {
  const workspaces = await input.authRepository.listWorkspaces(input.principal.tenantId);
  const documents = await input.documentRepository.list({ tenantId: input.principal.tenantId });
  const expenses = await input.expenseRepository.list({ tenantId: input.principal.tenantId });
  const fingerprint = adminHealthOperationsFingerprint({
    workspaces,
    documents,
    expenses,
    config: input.config,
    kafkaProducerEnabled: Boolean(input.eventProducer),
    kafkaLagMetricsEnabled: Boolean(input.eventLagProvider),
    redisRateLimitEnabled: Boolean(input.rateLimitRedisClient)
  });
  const cacheKey = adminHealthOperationsCacheKey(input.principal.tenantId, fingerprint);
  const cached = await input.cacheService.getHotState(cacheKey).catch(() => null);
  if (isCachedAdminOperationsSnapshot(cached)) return cached.operations;

  const storageMetrics = await input.documentStorage.metrics();
  const operations = buildAdminOperationsSnapshot({
    workspaces,
    documents,
    expenses,
    storageMetrics,
    config: input.config,
    kafkaProducerEnabled: Boolean(input.eventProducer),
    kafkaLagMetricsEnabled: Boolean(input.eventLagProvider),
    redisRateLimitEnabled: Boolean(input.rateLimitRedisClient)
  });
  await input.cacheService
    .setHotState({
      key: cacheKey,
      value: { operations },
      ttlSeconds: ADMIN_HEALTH_OPERATIONS_CACHE_TTL_SECONDS
    })
    .catch(() => undefined);
  return operations;
}

function adminHealthOperationsCacheKey(tenantId: string, fingerprint: string): string {
  return `dashboard:${tenantId}:admin-health:${fingerprint}`;
}

function buildAdminOperationsSnapshot(input: {
  workspaces: AuthWorkspace[];
  documents: StoredDocumentFile[];
  expenses: StoredExpense[];
  storageMetrics: DocumentStorageMetrics;
  config: AppConfig;
  kafkaProducerEnabled: boolean;
  kafkaLagMetricsEnabled: boolean;
  redisRateLimitEnabled: boolean;
}): AdminOperationsSnapshot {
  const liveDocuments = input.documents.filter((document) => document.deletedAt === null);
  const activeExpenses = input.expenses.filter((expense) => expense.archivedAt === null);
  const archivedExpenses = input.expenses.filter((expense) => expense.archivedAt !== null);
  const documentBytes = liveDocuments.reduce((total, document) => total + document.sizeBytes, 0n);
  const storageQuota = buildStorageQuota(documentBytes, BigInt(input.config.TENANT_STORAGE_SOFT_LIMIT_BYTES));
  const totalExpenseMinorByCurrency = activeExpenses.reduce<Record<string, bigint>>((totals, expense) => {
    totals[expense.currency] = (totals[expense.currency] ?? 0n) + expense.amountMinor;
    return totals;
  }, {});

  return {
    tenantUsage: {
      workspaceCount: input.workspaces.length,
      documentCount: liveDocuments.length,
      activeExpenseCount: activeExpenses.length,
      archivedExpenseCount: archivedExpenses.length,
      totalExpenseMinorByCurrency: Object.fromEntries(
        Object.entries(totalExpenseMinorByCurrency)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, amount]) => [currency, amount.toString()])
      )
    },
    storageUsage: {
      backend: input.storageMetrics.health.backend,
      connected: input.storageMetrics.health.connected,
      documentBytes: documentBytes.toString(),
      storedObjectCount: input.storageMetrics.storedObjectCount ?? null,
      operationErrorCount: input.storageMetrics.operationErrors.reduce((total, item) => total + item.count, 0),
      quota: storageQuota
    },
    rateLimit: {
      max: input.config.RATE_LIMIT_MAX,
      timeWindow: input.config.RATE_LIMIT_TIME_WINDOW,
      scope: "Fastify per-client request budget"
    },
    featureFlags: [
      {
        key: "memoryAdapters",
        enabled: input.config.SPENDLENS_USE_MEMORY_ADAPTERS,
        detail: "Use in-memory repositories for local smoke tests and browser E2E"
      },
      {
        key: "customOcrUnregisteredCheckpoint",
        enabled: input.config.CUSTOM_OCR_ALLOW_UNREGISTERED_CHECKPOINT,
        detail: "Allow explicit unregistered Custom OCR checkpoints only for controlled local smoke diagnostics"
      },
      {
        key: "kafkaProducer",
        enabled: input.kafkaProducerEnabled,
        detail: "Dispatch durable outbox events to configured Kafka-compatible brokers"
      },
      {
        key: "kafkaLagMetrics",
        enabled: input.kafkaLagMetricsEnabled,
        detail: "Collect configured consumer group lag for Prometheus"
      },
      {
        key: "redisRateLimit",
        enabled: input.redisRateLimitEnabled,
        detail: "Use Redis-backed global API request budgets when Redis is configured"
      },
      {
        key: "minioStorage",
        enabled: input.storageMetrics.health.backend === "minio",
        detail: "Persist document and report artifacts through S3-compatible object storage"
      }
    ],
    runbooks: [
      {
        label: "Dependency degraded",
        path: "docs/runbooks/dependency-degraded.md",
        detail: "Recover degraded local PostgreSQL, Redis, Kafka, MinIO, OCR or worker dependencies"
      },
      {
        label: "Testing",
        path: "TESTING.md",
        detail: "Review the test matrix: unit, integration, E2E, accessibility, security and live smoke gates"
      },
      {
        label: "Kafka events",
        path: "KAFKA_EVENTS.md",
        detail: "Review event catalog, outbox/inbox behavior, DLQ and lag metric notes"
      }
    ]
  };
}

function adminHealthOperationsFingerprint(input: {
  workspaces: AuthWorkspace[];
  documents: StoredDocumentFile[];
  expenses: StoredExpense[];
  config: AppConfig;
  kafkaProducerEnabled: boolean;
  kafkaLagMetricsEnabled: boolean;
  redisRateLimitEnabled: boolean;
}): string {
  const payload = {
    workspaces: [...input.workspaces]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((workspace) => [workspace.id, workspace.kind, workspace.name]),
    documents: [...input.documents]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((document) => [
        document.id,
        document.workspaceId,
        document.sizeBytes.toString(),
        document.sha256,
        document.deletedAt?.toISOString() ?? null
      ]),
    expenses: [...input.expenses]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((expense) => [
        expense.id,
        expense.workspaceId,
        expense.currency,
        expense.amountMinor.toString(),
        expense.status,
        expense.updatedAt.toISOString(),
        expense.archivedAt?.toISOString() ?? null
      ]),
    config: {
      rateLimitMax: input.config.RATE_LIMIT_MAX,
      rateLimitTimeWindow: input.config.RATE_LIMIT_TIME_WINDOW,
      tenantStorageSoftLimitBytes: input.config.TENANT_STORAGE_SOFT_LIMIT_BYTES,
      memoryAdapters: input.config.SPENDLENS_USE_MEMORY_ADAPTERS,
      customOcrUnregisteredCheckpoint: input.config.CUSTOM_OCR_ALLOW_UNREGISTERED_CHECKPOINT,
      kafkaProducerEnabled: input.kafkaProducerEnabled,
      kafkaLagMetricsEnabled: input.kafkaLagMetricsEnabled,
      redisRateLimitEnabled: input.redisRateLimitEnabled
    }
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

function buildStorageQuota(
  usedBytes: bigint,
  softLimitBytes: bigint
): AdminOperationsSnapshot["storageUsage"]["quota"] {
  const utilizationPercent = softLimitBytes === 0n ? 0 : Number((usedBytes * 10_000n) / softLimitBytes) / 100;
  return {
    softLimitBytes: softLimitBytes.toString(),
    usedBytes: usedBytes.toString(),
    remainingBytes: (softLimitBytes - usedBytes).toString(),
    utilizationPercent,
    status: utilizationPercent >= 100 ? "exceeded" : utilizationPercent >= 80 ? "warning" : "ok"
  };
}

function isCachedAdminOperationsSnapshot(value: Record<string, unknown> | null): value is { operations: AdminOperationsSnapshot } {
  return isRecord(value) && isAdminOperationsSnapshot(value.operations);
}

function isAdminOperationsSnapshot(value: unknown): value is AdminOperationsSnapshot {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.tenantUsage) &&
    isRecord(value.storageUsage) &&
    isRecord(value.rateLimit) &&
    Array.isArray(value.featureFlags) &&
    Array.isArray(value.runbooks)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
