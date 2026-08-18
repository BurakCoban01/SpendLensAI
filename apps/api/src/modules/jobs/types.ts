import type { JobStatus } from "@prisma/client";
import type { KafkaTopic } from "@spendlens/shared";

export type WorkerJobState = JobStatus;

export type StoredWorkerJob = {
  id: string;
  tenantId: string;
  queue: string;
  jobType: string;
  dedupeKey: string | null;
  status: WorkerJobState;
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
};

export type JobBacklogSummary = Record<WorkerJobState, number>;

export type JobMetricSample = {
  queue?: string;
  workerId?: string | null;
  status?: WorkerJobState;
  count: number;
};

export type JobMetricsSnapshot = {
  jobsByStatus: JobMetricSample[];
  jobsByQueueStatus: JobMetricSample[];
  failedJobsByQueueWorker: JobMetricSample[];
};

export type EnqueueWorkerJobInput = {
  tenantId: string;
  queue: string;
  jobType: string;
  dedupeKey?: string | null;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  createdById?: string | null;
  correlationId?: string | null;
  eventTopic?: KafkaTopic | null;
  aggregateId?: string | null;
};

export type ListWorkerJobsInput = {
  tenantId: string;
  queue?: string;
  status?: WorkerJobState;
  limit?: number;
};

export type JobRepository = {
  enqueue(input: EnqueueWorkerJobInput): Promise<{ job: StoredWorkerJob; deduped: boolean }>;
  list(input: ListWorkerJobsInput): Promise<StoredWorkerJob[]>;
  backlog(tenantId: string): Promise<JobBacklogSummary>;
  metrics(): Promise<JobMetricsSnapshot>;
  start(input: { tenantId: string; id: string; workerId: string }): Promise<StoredWorkerJob | null>;
  updateProgress(input: { tenantId: string; id: string; progress: number }): Promise<StoredWorkerJob | null>;
  complete(input: { tenantId: string; id: string; result?: Record<string, unknown> | null }): Promise<StoredWorkerJob | null>;
  fail(input: { tenantId: string; id: string; failureReason: string }): Promise<StoredWorkerJob | null>;
  retry(input: { tenantId: string; id: string }): Promise<StoredWorkerJob | null>;
};
