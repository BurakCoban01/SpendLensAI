import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../modules/auth/routes";
import { AuthError, type AuthService } from "../modules/auth/service";
import type { AuthPrincipal } from "../modules/auth/types";
import type { StoredWorkerJob } from "../modules/jobs/types";
import type { WorkerRuntimeService } from "../modules/jobs/worker-runtime";

type ComponentStatus = "ok" | "degraded" | "unknown";

type HealthComponent = {
  status: ComponentStatus;
  detail?: string;
};

type ReadinessCheck = () => Promise<HealthComponent>;

export type AdminOperationsSnapshot = {
  tenantUsage: {
    workspaceCount: number;
    documentCount: number;
    activeExpenseCount: number;
    archivedExpenseCount: number;
    totalExpenseMinorByCurrency: Record<string, string>;
  };
  storageUsage: {
    backend: string;
    connected: boolean;
    documentBytes: string;
    storedObjectCount: number | null;
    operationErrorCount: number;
    quota: {
      softLimitBytes: string;
      usedBytes: string;
      remainingBytes: string;
      utilizationPercent: number;
      status: "ok" | "warning" | "exceeded";
    };
  };
  rateLimit: {
    max: number;
    timeWindow: string;
    scope: string;
  };
  featureFlags: Array<{
    key: string;
    enabled: boolean;
    detail: string;
  }>;
  runbooks: Array<{
    label: string;
    path: string;
    detail: string;
  }>;
};

export type AdminDocumentReprocessResult = {
  documentFileId: string;
  workspaceId: string;
  requestedStages: AdminDocumentReprocessStage[];
  enqueued: Array<{
    stage: AdminDocumentReprocessStage;
    job: StoredWorkerJob;
    deduped: boolean;
    retried?: boolean;
  }>;
};

export type AdminDocumentReprocessStage = "preprocess" | "tesseract" | "custom_crnn";

export type AdminOperationsActions = {
  reprocessDocument(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    stages: AdminDocumentReprocessStage[];
    preprocessingProfile: string;
    language: string;
    checkpoint?: string | null;
    correlationId?: string | null;
  }): Promise<AdminDocumentReprocessResult>;
};

export class AdminOperationError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

const ReprocessParamsSchema = z.object({ id: z.string().min(1) });
const ReprocessDocumentSchema = z.object({
  stages: z.array(z.enum(["preprocess", "tesseract", "custom_crnn"])).min(1).max(3).default(["preprocess", "tesseract"]),
  preprocessingProfile: z.string().trim().min(2).max(80).default("TESSERACT_OPTIMIZED"),
  language: z.string().trim().min(2).max(32).default("tur+eng"),
  checkpoint: z.string().trim().min(1).max(300).nullable().optional()
});

export async function registerHealthRoutes(
  app: FastifyInstance,
  auth?: AuthService,
  workerRuntime?: () => WorkerRuntimeService | undefined,
  operationsSnapshot?: (principal: AuthPrincipal) => Promise<AdminOperationsSnapshot>,
  adminOperations?: AdminOperationsActions,
  readinessCheck?: ReadinessCheck
): Promise<void> {
  app.get("/health/live", async () => ({
    status: "ok",
    service: "api"
  }));

  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, HealthComponent> = {
      process: { status: "ok" }
    };
    if (readinessCheck) {
      checks.postgres = await readinessCheck();
    }
    const ready = Object.values(checks).every((check) => check.status === "ok");
    if (!ready) {
      reply.code(503);
    }
    return {
      status: ready ? "ok" : "degraded",
      service: "api",
      checks
    };
  });

  app.get("/admin/health", async (request, reply) => {
    try {
      if (!auth) {
        throw new Error("ADMIN_HEALTH_AUTH_NOT_CONFIGURED");
      }
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.health.read");
      const ocr = await ocrServiceHealth(process.env.OCR_SERVICE_URL);
      const checks: Record<string, HealthComponent> = {
        api: { status: "ok" },
        postgres: dependencyFromEnv("DATABASE_URL"),
        redis: dependencyFromEnv("REDIS_URL"),
        kafka: dependencyFromEnv("KAFKA_BROKERS"),
        minio: dependencyFromEnv("MINIO_ENDPOINT"),
        ocrService: ocr.service,
        tesseract: ocr.tesseract,
        workers: workerHealth(workerRuntime?.())
      };

      const operations = operationsSnapshot ? await operationsSnapshot(principal) : null;
      const degraded = Object.values(checks).some((check) => check.status !== "ok");
      return {
        status: degraded ? "degraded" : "ok",
        checkedAt: new Date().toISOString(),
        checks,
        operations
      };
    } catch (error) {
      return sendHealthError(reply, error);
    }
  });

  app.post("/admin/operations/documents/:id/reprocess", async (request, reply) => {
    try {
      if (!auth || !adminOperations) {
        throw new Error("ADMIN_OPERATIONS_NOT_CONFIGURED");
      }
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.health.read");
      requirePermission(auth, principal, "admin.jobs.manage");
      const params = ReprocessParamsSchema.parse(request.params);
      const body = ReprocessDocumentSchema.parse(request.body ?? {});
      reply.code(202);
      return serializeForJson({
        reprocess: await adminOperations.reprocessDocument({
          principal,
          documentFileId: params.id,
          stages: body.stages,
          preprocessingProfile: body.preprocessingProfile,
          language: body.language,
          ...(body.checkpoint !== undefined ? { checkpoint: body.checkpoint } : {}),
          correlationId: request.id
        })
      });
    } catch (error) {
      return sendHealthError(reply, error);
    }
  });
}

function workerHealth(runtime: WorkerRuntimeService | undefined): HealthComponent {
  if (!runtime) return { status: "unknown", detail: "Worker runtime is not configured" };
  const snapshot = runtime.snapshot();
  if (snapshot.active === 0) return { status: "degraded", detail: "No active local worker runtime heartbeat" };
  const errored = snapshot.workers.filter((worker) => worker.status === "ERROR");
  if (errored.length > 0) return { status: "degraded", detail: `${errored.length} worker runtime(s) reporting errors` };
  return { status: "ok", detail: `${snapshot.active} active local worker runtime heartbeat(s)` };
}

function dependencyFromEnv(name: string): HealthComponent {
  return process.env[name] ? { status: "ok" } : { status: "degraded", detail: `${name} is not configured` };
}

async function ocrServiceHealth(baseUrl: string | undefined): Promise<{ service: HealthComponent; tesseract: HealthComponent }> {
  if (!baseUrl) {
    const unavailable = { status: "degraded", detail: "OCR_SERVICE_URL is not configured. Start OCR with pnpm dev:ocr and restart the API." } as const;
    return { service: unavailable, tesseract: unavailable };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(new URL("/health/ready", baseUrl), { signal: controller.signal });
    if (!response.ok) {
      const unavailable = { status: "degraded", detail: `OCR service readiness returned HTTP ${response.status}` } as const;
      return { service: unavailable, tesseract: unavailable };
    }
    const body = (await response.json().catch(() => null)) as {
      status?: string;
      checks?: { tesseract?: { available?: boolean; languages?: string[]; missing_languages?: string[] } };
    } | null;
    const service: HealthComponent =
      body?.status === "ok"
        ? { status: "ok", detail: "OCR service is reachable and ready" }
        : { status: "degraded", detail: "OCR service is reachable but not ready" };
    const tesseractCheck = body?.checks?.tesseract;
    const requiredLanguages = ["tur", "eng"];
    const languages = tesseractCheck?.languages ?? [];
    const tesseract: HealthComponent =
      tesseractCheck?.available === true && requiredLanguages.every((language) => languages.includes(language))
        ? { status: "ok", detail: `Ready with ${requiredLanguages.join("+")} languages` }
        : {
            status: "degraded",
            detail: tesseractCheck?.available === false
              ? "Tesseract is unavailable in the OCR service"
              : `Tesseract readiness is missing required language(s): ${requiredLanguages.filter((language) => !languages.includes(language)).join(", ")}`
          };
    return { service, tesseract };
  } catch (error) {
    const detail = error instanceof Error && error.name === "AbortError" ? "OCR service readiness timed out" : error instanceof Error ? error.message : "OCR service is unreachable";
    const unavailable = { status: "degraded", detail } as const;
    return { service: unavailable, tesseract: unavailable };
  } finally {
    clearTimeout(timeout);
  }
}

function sendHealthError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof AdminOperationError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function serializeForJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested)));
}
