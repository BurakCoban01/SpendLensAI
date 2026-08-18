import { assertKafkaTopic, type KafkaTopic } from "@spendlens/shared";
import type { AuditRepository } from "../audit/types";
import type { AuthPrincipal } from "../auth/types";
import { CacheService, workerJobCacheKey } from "../cache/service";
import type { EventService } from "../events/service";
import type { JobRepository, WorkerJobState } from "./types";

export class JobError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class JobService {
  constructor(
    private readonly repository: JobRepository,
    private readonly events?: EventService,
    private readonly cache?: CacheService,
    private readonly audit?: AuditRepository
  ) {}

  async enqueue(input: {
    principal: AuthPrincipal;
    queue: string;
    jobType: string;
    dedupeKey?: string | null;
    payload: Record<string, unknown>;
    maxAttempts?: number;
    eventTopic?: string | null;
    aggregateId?: string | null;
    correlationId?: string | null;
  }) {
    const eventTopic = input.eventTopic ? assertKafkaTopic(input.eventTopic) : null;
    const result = await this.repository.enqueue({
      tenantId: input.principal.tenantId,
      queue: normalizeCode(input.queue, "QUEUE"),
      jobType: normalizeCode(input.jobType, "JOB_TYPE"),
      dedupeKey: input.dedupeKey ?? null,
      payload: input.payload,
      maxAttempts: input.maxAttempts ?? 3,
      createdById: input.principal.userId,
      correlationId: input.correlationId ?? null,
      eventTopic,
      aggregateId: input.aggregateId ?? null
    });
    if (!result.deduped && eventTopic) {
      await this.emit(input.principal.tenantId, eventTopic, input.aggregateId ?? result.job.id, result.job);
    }
    await this.mirrorHotState(result.job);
    await this.auditJob(input.principal, result.deduped ? "worker.job.enqueue_deduped" : "worker.job.enqueued", result.job, {
      dedupeKeyPresent: Boolean(input.dedupeKey),
      eventTopic,
      aggregateId: input.aggregateId ?? null
    });
    return result;
  }

  async list(input: { principal: AuthPrincipal; queue?: string; status?: WorkerJobState; limit?: number }) {
    return {
      backlog: await this.repository.backlog(input.principal.tenantId),
      jobs: await this.repository.list({
        tenantId: input.principal.tenantId,
        ...(input.queue ? { queue: normalizeCode(input.queue, "QUEUE") } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.limit ? { limit: input.limit } : {})
      })
    };
  }

  async metrics() {
    return this.repository.metrics();
  }

  async start(input: { principal: AuthPrincipal; id: string; workerId: string }) {
    const job = await this.repository.start({
      tenantId: input.principal.tenantId,
      id: input.id,
      workerId: normalizeCode(input.workerId, "WORKER_ID")
    });
    if (!job) throw new JobError("WORKER_JOB_NOT_FOUND", 404);
    await this.mirrorHotState(job);
    await this.auditJob(input.principal, "worker.job.started", job, { workerId: normalizeCode(input.workerId, "WORKER_ID") });
    return job;
  }

  async progress(input: { principal: AuthPrincipal; id: string; progress: number }) {
    const job = await this.repository.updateProgress({
      tenantId: input.principal.tenantId,
      id: input.id,
      progress: clampProgress(input.progress)
    });
    if (!job) throw new JobError("WORKER_JOB_NOT_FOUND", 404);
    await this.mirrorHotState(job);
    return job;
  }

  async complete(input: { principal: AuthPrincipal; id: string; result?: Record<string, unknown> | null }) {
    const job = await this.repository.complete({
      tenantId: input.principal.tenantId,
      id: input.id,
      result: input.result ?? null
    });
    if (!job) throw new JobError("WORKER_JOB_NOT_FOUND", 404);
    await this.mirrorHotState(job);
    await this.auditJob(input.principal, "worker.job.completed", job, {
      resultPresent: Boolean(input.result && Object.keys(input.result).length > 0)
    });
    return job;
  }

  async fail(input: { principal: AuthPrincipal; id: string; failureReason: string }) {
    const job = await this.repository.fail({
      tenantId: input.principal.tenantId,
      id: input.id,
      failureReason: input.failureReason
    });
    if (!job) throw new JobError("WORKER_JOB_NOT_FOUND", 404);
    await this.mirrorHotState(job);
    await this.auditJob(input.principal, "worker.job.failed", job, { failureReasonPresent: true });
    return job;
  }

  async retry(input: { principal: AuthPrincipal; id: string }) {
    const job = await this.repository.retry({ tenantId: input.principal.tenantId, id: input.id });
    if (!job) throw new JobError("WORKER_JOB_NOT_FOUND", 404);
    if (job.attempts >= job.maxAttempts) throw new JobError("WORKER_JOB_MAX_ATTEMPTS_REACHED", 409);
    await this.mirrorHotState(job);
    await this.auditJob(input.principal, "worker.job.retried", job);
    return job;
  }

  async withWorkerRunLock<T>(
    input: { principal: AuthPrincipal; workerId: string; queue?: string; ttlMs?: number },
    fn: () => Promise<T>
  ): Promise<{ acquired: boolean; degraded: boolean; key: string | null; result: T | null }> {
    if (!this.cache) return { acquired: true, degraded: false, key: null, result: await fn() };

    const queue = input.queue ? normalizeCode(input.queue, "QUEUE") : "all";
    const workerId = normalizeCode(input.workerId, "WORKER_ID");
    const key = workerRunCoordinationKey(input.principal.tenantId, queue);
    const owner = `${input.principal.tenantId}:${workerId}`;
    let acquired: Awaited<ReturnType<CacheService["acquireSystemLock"]>>;
    try {
      acquired = await this.cache.acquireSystemLock({ key, owner, ttlMs: input.ttlMs ?? 30_000 });
    } catch {
      return { acquired: true, degraded: true, key, result: await fn() };
    }
    if (!acquired.acquired) return { acquired: false, degraded: false, key, result: null };

    try {
      return { acquired: true, degraded: false, key, result: await fn() };
    } finally {
      await this.cache.releaseSystemLock({ key, owner }).catch(() => undefined);
    }
  }

  private async emit(tenantId: string, topic: KafkaTopic, aggregateId: string, job: { id: string; queue: string; jobType: string }) {
    await this.events?.publish({
      tenantId,
      topic,
      aggregateId,
      payload: {
        workerJobId: job.id,
        queue: job.queue,
        jobType: job.jobType
      }
    });
  }

  private async mirrorHotState(job: {
    id: string;
    tenantId: string;
    queue: string;
    jobType: string;
    status: string;
    progress: number;
    attempts: number;
    maxAttempts: number;
    failureReason: string | null;
    lockedBy: string | null;
    updatedAt: Date;
  }) {
    try {
      await this.cache?.setHotState({
        key: workerJobCacheKey(job.tenantId, job.id),
        ttlSeconds: 3600,
        value: {
          jobId: job.id,
          queue: job.queue,
          jobType: job.jobType,
          status: job.status,
          progress: job.progress,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          failureReason: job.failureReason,
          lockedBy: job.lockedBy,
          updatedAt: job.updatedAt.toISOString()
        }
      });
    } catch {
      // PostgreSQL remains the source of truth; cache failures only degrade hot progress state.
    }
  }

  private async auditJob(
    principal: AuthPrincipal,
    action: string,
    job: {
      id: string;
      tenantId: string;
      queue: string;
      jobType: string;
      status: string;
      attempts: number;
      maxAttempts: number;
      dedupeKey?: string | null;
      correlationId?: string | null;
    },
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      await this.audit?.create({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action,
        resourceType: "WorkerJob",
        resourceId: job.id,
        correlationId: job.correlationId ?? null,
        metadata: {
          queue: job.queue,
          jobType: job.jobType,
          status: job.status,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          dedupeKeyPresent: Boolean(job.dedupeKey),
          ...metadata
        }
      });
    } catch {
      // Job state remains authoritative; audit write failures must not break worker execution.
    }
  }
}

export function workerRunCoordinationKey(tenantId: string, queue: string): string {
  return `worker-runner:${tenantId}:${queue}`;
}

function normalizeCode(value: string, code: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9._:-]{2,120}$/.test(normalized)) throw new JobError(`INVALID_${code}`, 400);
  return normalized;
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, value));
}
