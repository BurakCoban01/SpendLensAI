import type { AuthPrincipal } from "../auth/types";
import type { WorkerRunnerService } from "./worker-runner";

export type WorkerRuntimeStatus = "RUNNING" | "IDLE" | "STOPPED" | "ERROR";

export type WorkerHeartbeat = {
  workerId: string;
  tenantId: string;
  queue: string | null;
  status: WorkerRuntimeStatus;
  intervalMs: number;
  maxJobsPerTick: number;
  processedJobs: number;
  emptyPolls: number;
  lastJobId: string | null;
  lastError: string | null;
  startedAt: Date;
  lastHeartbeatAt: Date;
  stoppedAt: Date | null;
};

type RuntimeEntry = {
  principal: AuthPrincipal;
  heartbeat: WorkerHeartbeat;
  timer: NodeJS.Timeout | null;
  tickActive: boolean;
};

export class WorkerRuntimeService {
  private readonly workers = new Map<string, RuntimeEntry>();

  constructor(private readonly runner: WorkerRunnerService) {}

  start(input: {
    principal: AuthPrincipal;
    workerId: string;
    queue?: string;
    intervalMs?: number;
    maxJobsPerTick?: number;
  }): WorkerHeartbeat {
    const workerId = normalizeWorkerId(input.workerId);
    const existing = this.workers.get(workerId);
    if (existing && existing.heartbeat.status !== "STOPPED") return copyHeartbeat(existing.heartbeat);

    const now = new Date();
    const entry: RuntimeEntry = {
      principal: input.principal,
      tickActive: false,
      timer: null,
      heartbeat: {
        workerId,
        tenantId: input.principal.tenantId,
        queue: input.queue?.trim() || null,
        status: "IDLE",
        intervalMs: clamp(input.intervalMs ?? 1000, 100, 60_000),
        maxJobsPerTick: clamp(input.maxJobsPerTick ?? 3, 1, 25),
        processedJobs: 0,
        emptyPolls: 0,
        lastJobId: null,
        lastError: null,
        startedAt: now,
        lastHeartbeatAt: now,
        stoppedAt: null
      }
    };
    this.workers.set(workerId, entry);
    entry.timer = setInterval(() => {
      void this.tick(workerId);
    }, entry.heartbeat.intervalMs);
    entry.timer.unref?.();
    void this.tick(workerId);
    return copyHeartbeat(entry.heartbeat);
  }

  async stop(workerId: string): Promise<WorkerHeartbeat | null> {
    const entry = this.workers.get(workerId);
    if (!entry) return null;
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = null;
    entry.heartbeat.status = "STOPPED";
    entry.heartbeat.stoppedAt = new Date();
    entry.heartbeat.lastHeartbeatAt = entry.heartbeat.stoppedAt;
    return copyHeartbeat(entry.heartbeat);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.workers.keys()].map((workerId) => this.stop(workerId)));
  }

  list(): WorkerHeartbeat[] {
    return [...this.workers.values()].map((entry) => copyHeartbeat(entry.heartbeat));
  }

  snapshot(): { active: number; workers: WorkerHeartbeat[] } {
    const workers = this.list();
    return {
      active: workers.filter((worker) => worker.status !== "STOPPED").length,
      workers
    };
  }

  private async tick(workerId: string): Promise<void> {
    const entry = this.workers.get(workerId);
    if (!entry || entry.tickActive || entry.heartbeat.status === "STOPPED") return;
    entry.tickActive = true;
    entry.heartbeat.status = "RUNNING";
    entry.heartbeat.lastHeartbeatAt = new Date();
    try {
      let processedThisTick = 0;
      for (let index = 0; index < entry.heartbeat.maxJobsPerTick; index += 1) {
        const result = await this.runner.runNext({
          principal: entry.principal,
          workerId,
          ...(entry.heartbeat.queue ? { queue: entry.heartbeat.queue } : {})
        });
        entry.heartbeat.lastHeartbeatAt = new Date();
        if (!result.processed) {
          entry.heartbeat.emptyPolls += 1;
          break;
        }
        processedThisTick += 1;
        entry.heartbeat.processedJobs += 1;
        entry.heartbeat.lastJobId = result.job?.id ?? null;
      }
      entry.heartbeat.status = processedThisTick > 0 ? "RUNNING" : "IDLE";
      entry.heartbeat.lastError = null;
    } catch (error) {
      entry.heartbeat.status = "ERROR";
      entry.heartbeat.lastError = error instanceof Error ? error.message : "WORKER_RUNTIME_ERROR";
      entry.heartbeat.lastHeartbeatAt = new Date();
    } finally {
      entry.tickActive = false;
    }
  }
}

export function serializeHeartbeat(heartbeat: WorkerHeartbeat) {
  return {
    ...heartbeat,
    startedAt: heartbeat.startedAt.toISOString(),
    lastHeartbeatAt: heartbeat.lastHeartbeatAt.toISOString(),
    stoppedAt: heartbeat.stoppedAt?.toISOString() ?? null
  };
}

function copyHeartbeat(heartbeat: WorkerHeartbeat): WorkerHeartbeat {
  return {
    ...heartbeat,
    startedAt: new Date(heartbeat.startedAt),
    lastHeartbeatAt: new Date(heartbeat.lastHeartbeatAt),
    stoppedAt: heartbeat.stoppedAt ? new Date(heartbeat.stoppedAt) : null
  };
}

function normalizeWorkerId(workerId: string): string {
  const normalized = workerId.trim();
  if (!/^[a-zA-Z0-9._:-]{2,120}$/.test(normalized)) throw new Error("INVALID_WORKER_ID");
  return normalized;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
