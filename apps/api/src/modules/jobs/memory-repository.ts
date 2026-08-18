import { randomUUID } from "node:crypto";
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

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, StoredWorkerJob>();

  async enqueue(input: EnqueueWorkerJobInput): Promise<{ job: StoredWorkerJob; deduped: boolean }> {
    if (input.dedupeKey) {
      const existing = [...this.jobs.values()].find((job) => job.tenantId === input.tenantId && job.dedupeKey === input.dedupeKey);
      if (existing) return { job: existing, deduped: true };
    }
    const now = new Date();
    const job: StoredWorkerJob = {
      id: randomUUID(),
      tenantId: input.tenantId,
      queue: input.queue,
      jobType: input.jobType,
      dedupeKey: input.dedupeKey ?? null,
      status: "QUEUED",
      progress: 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      payload: input.payload,
      result: null,
      failureReason: null,
      lockedBy: null,
      createdById: input.createdById ?? null,
      correlationId: input.correlationId ?? null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    };
    this.jobs.set(job.id, job);
    return { job, deduped: false };
  }

  async list(input: ListWorkerJobsInput): Promise<StoredWorkerJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.tenantId === input.tenantId)
      .filter((job) => !input.queue || job.queue === input.queue)
      .filter((job) => !input.status || job.status === input.status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, input.limit ?? 50);
  }

  async backlog(tenantId: string): Promise<JobBacklogSummary> {
    const summary = emptyBacklog();
    for (const job of this.jobs.values()) {
      if (job.tenantId === tenantId) summary[job.status] += 1;
    }
    return summary;
  }

  async metrics() {
    const byStatus = emptyBacklog();
    const byQueueStatus = new Map<string, JobMetricSample>();
    const failedByQueueWorker = new Map<string, JobMetricSample>();
    for (const job of this.jobs.values()) {
      byStatus[job.status] += 1;
      const key = `${job.queue}:${job.status}`;
      const existing = byQueueStatus.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        byQueueStatus.set(key, { queue: job.queue, status: job.status, count: 1 });
      }
      if (job.status === "FAILED" && job.lockedBy) {
        const failureKey = `${job.queue}:${job.lockedBy}`;
        const existing = failedByQueueWorker.get(failureKey);
        if (existing) {
          existing.count += 1;
        } else {
          failedByQueueWorker.set(failureKey, { queue: job.queue, workerId: job.lockedBy, count: 1 });
        }
      }
    }
    return {
      jobsByStatus: statuses.map((status) => ({ status, count: byStatus[status] })),
      jobsByQueueStatus: [...byQueueStatus.values()].sort(compareJobMetricSamples),
      failedJobsByQueueWorker: [...failedByQueueWorker.values()].sort(compareJobMetricSamples)
    };
  }

  async start(input: { tenantId: string; id: string; workerId: string }): Promise<StoredWorkerJob | null> {
    return this.update(input.tenantId, input.id, (job) => ({
      ...job,
      status: "RUNNING",
      lockedBy: input.workerId,
      attempts: job.attempts + 1,
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
      failureReason: null
    }));
  }

  async updateProgress(input: { tenantId: string; id: string; progress: number }): Promise<StoredWorkerJob | null> {
    return this.update(input.tenantId, input.id, (job) => ({
      ...job,
      progress: input.progress,
      updatedAt: new Date()
    }));
  }

  async complete(input: { tenantId: string; id: string; result?: Record<string, unknown> | null }): Promise<StoredWorkerJob | null> {
    return this.update(input.tenantId, input.id, (job) => ({
      ...job,
      status: "SUCCEEDED",
      progress: 100,
      result: input.result ?? null,
      lockedBy: null,
      failureReason: null,
      completedAt: new Date(),
      updatedAt: new Date()
    }));
  }

  async fail(input: { tenantId: string; id: string; failureReason: string }): Promise<StoredWorkerJob | null> {
    return this.update(input.tenantId, input.id, (job) => ({
      ...job,
      status: "FAILED",
      failureReason: input.failureReason,
      completedAt: new Date(),
      updatedAt: new Date()
    }));
  }

  async retry(input: { tenantId: string; id: string }): Promise<StoredWorkerJob | null> {
    return this.update(input.tenantId, input.id, (job) =>
      job.attempts >= job.maxAttempts
        ? job
        : {
            ...job,
            status: "QUEUED",
            progress: 0,
            failureReason: null,
            lockedBy: null,
            completedAt: null,
            updatedAt: new Date()
          }
    );
  }

  private update(tenantId: string, id: string, updater: (job: StoredWorkerJob) => StoredWorkerJob): StoredWorkerJob | null {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId) return null;
    const updated = updater(job);
    this.jobs.set(updated.id, updated);
    return updated;
  }
}

function emptyBacklog(): JobBacklogSummary {
  return Object.fromEntries(statuses.map((status) => [status, 0])) as JobBacklogSummary;
}

function compareJobMetricSamples(left: JobMetricSample, right: JobMetricSample): number {
  return `${left.queue ?? ""}:${left.status ?? ""}:${left.workerId ?? ""}`.localeCompare(
    `${right.queue ?? ""}:${right.status ?? ""}:${right.workerId ?? ""}`
  );
}
