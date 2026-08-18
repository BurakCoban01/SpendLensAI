import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, type AuthService } from "../auth/service";
import { JobError, JobService } from "./service";
import { serializeHeartbeat, type WorkerRuntimeService } from "./worker-runtime";
import type { WorkerRunnerService } from "./worker-runner";

const statuses = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"] as const;

const EnqueueSchema = z.object({
  queue: z.string().trim().min(2).max(120),
  jobType: z.string().trim().min(2).max(120),
  dedupeKey: z.string().trim().min(2).max(160).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  eventTopic: z.string().trim().min(1).nullable().optional(),
  aggregateId: z.string().trim().min(1).max(160).nullable().optional()
});

const ListQuerySchema = z.object({
  queue: z.string().trim().min(2).max(120).optional(),
  status: z.enum(statuses).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const ParamsSchema = z.object({ id: z.string().min(1) });
const StartSchema = z.object({ workerId: z.string().trim().min(2).max(120) });
const ProgressSchema = z.object({ progress: z.number().int().min(0).max(100) });
const CompleteSchema = z.object({ result: z.record(z.string(), z.unknown()).nullable().optional() });
const FailSchema = z.object({ failureReason: z.string().trim().min(1).max(500) });
const RunNextSchema = z.object({
  queue: z.string().trim().min(2).max(120).optional(),
  workerId: z.string().trim().min(2).max(120).default("api-local-worker")
});
const RunDocumentOcrPipelineSchema = z.object({
  documentFileId: z.string().trim().min(1).max(160),
  drainUntil: z.enum(["ocr", "extraction"]).default("ocr"),
  maxSteps: z.number().int().min(1).max(20).default(8),
  stopOnFailure: z.boolean().default(true),
  workerId: z.string().trim().min(2).max(120).default("api-document-ocr-worker")
});
const StartWorkerSchema = z.object({
  queue: z.string().trim().min(2).max(120).optional(),
  workerId: z.string().trim().min(2).max(120).default("api-runtime-worker"),
  intervalMs: z.number().int().min(100).max(60_000).default(1000),
  maxJobsPerTick: z.number().int().min(1).max(25).default(3)
});
const WorkerParamsSchema = z.object({ workerId: z.string().trim().min(2).max(120) });

export async function registerJobRoutes(
  app: FastifyInstance,
  auth: AuthService,
  jobs: JobService,
  runner?: WorkerRunnerService,
  runtime?: WorkerRuntimeService
): Promise<void> {
  app.get("/admin/jobs", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.read");
      const query = ListQuerySchema.parse(request.query);
      return serialize(
        await jobs.list({
          principal,
          ...(query.queue ? { queue: query.queue } : {}),
          ...(query.status ? { status: query.status } : {}),
          limit: query.limit
        })
      );
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/admin/jobs", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.manage");
      const body = EnqueueSchema.parse(request.body);
      const result = await jobs.enqueue({
        principal,
        queue: body.queue,
        jobType: body.jobType,
        payload: body.payload,
        maxAttempts: body.maxAttempts,
        correlationId: correlationId(request),
        ...(body.dedupeKey !== undefined ? { dedupeKey: body.dedupeKey } : {}),
        ...(body.eventTopic !== undefined ? { eventTopic: body.eventTopic } : {}),
        ...(body.aggregateId !== undefined ? { aggregateId: body.aggregateId } : {})
      });
      reply.code(result.deduped ? 200 : 201);
      return { job: serializeJob(result.job), deduped: result.deduped };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/admin/jobs/run-next", async (request, reply) => {
    try {
      if (!runner) throw new JobError("WORKER_RUNNER_NOT_CONFIGURED", 503);
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.manage");
      const body = RunNextSchema.parse(request.body ?? {});
      return await runner.runNext({
        principal,
        workerId: body.workerId,
        ...(body.queue ? { queue: body.queue } : {})
      });
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/admin/jobs/run-document-ocr-pipeline", async (request, reply) => {
    try {
      if (!runner) throw new JobError("WORKER_RUNNER_NOT_CONFIGURED", 503);
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.manage");
      const body = RunDocumentOcrPipelineSchema.parse(request.body ?? {});
      const result = await runner.runDocumentOcrPipeline({
        principal,
        documentFileId: body.documentFileId,
        workerId: body.workerId,
        drainUntil: body.drainUntil,
        maxSteps: body.maxSteps,
        stopOnFailure: body.stopOnFailure
      });
      return {
        ...result,
        jobsProcessed: result.jobsProcessed.map(serializeJob)
      };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.get("/admin/jobs/workers", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.read");
      const workers = runtime?.list().filter((worker) => worker.tenantId === principal.tenantId) ?? [];
      return {
        active: workers.filter((worker) => worker.status !== "STOPPED").length,
        workers: workers.map(serializeHeartbeat)
      };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/admin/jobs/workers/start", async (request, reply) => {
    try {
      if (!runtime) throw new JobError("WORKER_RUNTIME_NOT_CONFIGURED", 503);
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.manage");
      const body = StartWorkerSchema.parse(request.body ?? {});
      const heartbeat = runtime.start({
        principal,
        workerId: body.workerId,
        intervalMs: body.intervalMs,
        maxJobsPerTick: body.maxJobsPerTick,
        ...(body.queue ? { queue: body.queue } : {})
      });
      return { worker: serializeHeartbeat(heartbeat) };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/admin/jobs/workers/:workerId/stop", async (request, reply) => {
    try {
      if (!runtime) throw new JobError("WORKER_RUNTIME_NOT_CONFIGURED", 503);
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.manage");
      const params = WorkerParamsSchema.parse(request.params);
      const existing = runtime.list().find((worker) => worker.workerId === params.workerId && worker.tenantId === principal.tenantId);
      if (!existing) throw new JobError("WORKER_RUNTIME_NOT_FOUND", 404);
      const worker = await runtime.stop(params.workerId);
      if (!worker) throw new JobError("WORKER_RUNTIME_NOT_FOUND", 404);
      return { worker: serializeHeartbeat(worker) };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/admin/jobs/:id/start", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.manage");
      const params = ParamsSchema.parse(request.params);
      const body = StartSchema.parse(request.body);
      return { job: serializeJob(await jobs.start({ principal, id: params.id, workerId: body.workerId })) };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/admin/jobs/:id/progress", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.manage");
      const params = ParamsSchema.parse(request.params);
      const body = ProgressSchema.parse(request.body);
      return { job: serializeJob(await jobs.progress({ principal, id: params.id, progress: body.progress })) };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/admin/jobs/:id/complete", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.manage");
      const params = ParamsSchema.parse(request.params);
      const body = CompleteSchema.parse(request.body ?? {});
      return { job: serializeJob(await jobs.complete({ principal, id: params.id, result: body.result ?? null })) };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/admin/jobs/:id/fail", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.manage");
      const params = ParamsSchema.parse(request.params);
      const body = FailSchema.parse(request.body);
      return { job: serializeJob(await jobs.fail({ principal, id: params.id, failureReason: body.failureReason })) };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });

  app.post("/admin/jobs/:id/retry", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.jobs.manage");
      const params = ParamsSchema.parse(request.params);
      return { job: serializeJob(await jobs.retry({ principal, id: params.id })) };
    } catch (error) {
      return sendJobError(reply, error);
    }
  });
}

function serialize(input: Awaited<ReturnType<JobService["list"]>>) {
  return {
    backlog: input.backlog,
    jobs: input.jobs.map(serializeJob)
  };
}

function serializeJob(job: {
  id: string;
  tenantId: string;
  queue: string;
  jobType: string;
  dedupeKey: string | null;
  status: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  failureReason: string | null;
  lockedBy: string | null;
  createdById: string | null;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}) {
  return {
    ...job,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null
  };
}

function sendJobError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError || error instanceof JobError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof Error && error.message === "UNKNOWN_KAFKA_TOPIC") {
    reply.code(400);
    return { error: { code: "UNKNOWN_KAFKA_TOPIC" } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function correlationId(request: { headers: Record<string, unknown>; id: string }): string {
  const value = request.headers["x-correlation-id"];
  return typeof value === "string" ? value : request.id;
}
