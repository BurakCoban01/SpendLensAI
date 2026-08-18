import { Prisma, PrismaClient } from "@prisma/client";
import type {
  JobBacklogSummary,
  JobMetricSample,
  JobRepository,
  ListWorkerJobsInput,
  EnqueueWorkerJobInput,
  StoredWorkerJob,
  WorkerJobState
} from "./types";

const statuses: WorkerJobState[] = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"];

export class PrismaJobRepository implements JobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueue(input: EnqueueWorkerJobInput): Promise<{ job: StoredWorkerJob; deduped: boolean }> {
    if (input.dedupeKey) {
      const existing = await this.prisma.workerJob.findUnique({
        where: { tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey: input.dedupeKey } }
      });
      if (existing) return { job: serialize(existing), deduped: true };
    }
    const job = await this.prisma.workerJob.create({
      data: {
        tenantId: input.tenantId,
        queue: input.queue,
        jobType: input.jobType,
        dedupeKey: input.dedupeKey ?? null,
        payload: input.payload as Prisma.InputJsonObject,
        maxAttempts: input.maxAttempts ?? 3,
        createdById: input.createdById ?? null,
        correlationId: input.correlationId ?? null
      }
    });
    return { job: serialize(job), deduped: false };
  }

  async list(input: ListWorkerJobsInput): Promise<StoredWorkerJob[]> {
    const jobs = await this.prisma.workerJob.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.queue ? { queue: input.queue } : {}),
        ...(input.status ? { status: input.status } : {})
      },
      orderBy: { createdAt: "desc" },
      take: input.limit ?? 50
    });
    return jobs.map(serialize);
  }

  async backlog(tenantId: string): Promise<JobBacklogSummary> {
    const rows = await this.prisma.workerJob.groupBy({
      by: ["status"],
      where: { tenantId },
      _count: { _all: true }
    });
    const summary = emptyBacklog();
    for (const row of rows) summary[row.status] = row._count._all;
    return summary;
  }

  async metrics() {
    const statusRows = await this.prisma.workerJob.groupBy({
      by: ["status"],
      _count: { _all: true }
    });
    const queueRows = await this.prisma.workerJob.groupBy({
      by: ["queue", "status"],
      _count: { _all: true }
    });
    const failedRows = await this.prisma.workerJob.groupBy({
      by: ["queue", "lockedBy"],
      where: {
        status: "FAILED",
        lockedBy: { not: null }
      },
      _count: { _all: true }
    });
    const summary = emptyBacklog();
    for (const row of statusRows) summary[row.status] = row._count._all;
    return {
      jobsByStatus: statuses.map((status) => ({ status, count: summary[status] })),
      jobsByQueueStatus: queueRows
        .map((row) => ({ queue: row.queue, status: row.status, count: row._count._all }))
        .sort(compareJobMetricSamples),
      failedJobsByQueueWorker: failedRows
        .map((row) => ({ queue: row.queue, workerId: row.lockedBy, count: row._count._all }))
        .sort(compareJobMetricSamples)
    };
  }

  async start(input: { tenantId: string; id: string; workerId: string }): Promise<StoredWorkerJob | null> {
    return this.update(input.tenantId, input.id, {
      status: "RUNNING",
      lockedBy: input.workerId,
      attempts: { increment: 1 },
      startedAt: new Date(),
      completedAt: null,
      failureReason: null
    });
  }

  async updateProgress(input: { tenantId: string; id: string; progress: number }): Promise<StoredWorkerJob | null> {
    return this.update(input.tenantId, input.id, { progress: input.progress });
  }

  async complete(input: { tenantId: string; id: string; result?: Record<string, unknown> | null }): Promise<StoredWorkerJob | null> {
    return this.update(input.tenantId, input.id, {
      status: "SUCCEEDED",
      progress: 100,
      result: input.result ? (input.result as Prisma.InputJsonObject) : Prisma.DbNull,
      lockedBy: null,
      failureReason: null,
      completedAt: new Date()
    });
  }

  async fail(input: { tenantId: string; id: string; failureReason: string }): Promise<StoredWorkerJob | null> {
    return this.update(input.tenantId, input.id, {
      status: "FAILED",
      failureReason: input.failureReason,
      completedAt: new Date()
    });
  }

  async retry(input: { tenantId: string; id: string }): Promise<StoredWorkerJob | null> {
    const current = await this.prisma.workerJob.findFirst({ where: { tenantId: input.tenantId, id: input.id } });
    if (!current) return null;
    if (current.attempts >= current.maxAttempts) return serialize(current);
    return this.update(input.tenantId, input.id, {
      status: "QUEUED",
      progress: 0,
      failureReason: null,
      lockedBy: null,
      completedAt: null
    });
  }

  private async update(tenantId: string, id: string, data: Prisma.WorkerJobUpdateInput): Promise<StoredWorkerJob | null> {
    const result = await this.prisma.workerJob.updateMany({ where: { tenantId, id }, data });
    if (result.count === 0) return null;
    const row = await this.prisma.workerJob.findFirst({ where: { tenantId, id } });
    return row ? serialize(row) : null;
  }
}

function serialize(row: {
  id: string;
  tenantId: string;
  queue: string;
  jobType: string;
  dedupeKey: string | null;
  status: WorkerJobState;
  progress: number;
  attempts: number;
  maxAttempts: number;
  payload: Prisma.JsonValue;
  result: Prisma.JsonValue | null;
  failureReason: string | null;
  lockedBy: string | null;
  createdById: string | null;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): StoredWorkerJob {
  return {
    ...row,
    payload: normalizeObject(row.payload),
    result: row.result ? normalizeObject(row.result) : null
  };
}

function normalizeObject(value: Prisma.JsonValue): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function emptyBacklog(): JobBacklogSummary {
  return Object.fromEntries(statuses.map((status) => [status, 0])) as JobBacklogSummary;
}

function compareJobMetricSamples(left: JobMetricSample, right: JobMetricSample): number {
  return `${left.queue ?? ""}:${left.status ?? ""}:${left.workerId ?? ""}`.localeCompare(
    `${right.queue ?? ""}:${right.status ?? ""}:${right.workerId ?? ""}`
  );
}
