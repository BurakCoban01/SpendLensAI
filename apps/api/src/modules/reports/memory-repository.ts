import { randomUUID } from "node:crypto";
import type { CreateExportJobInput, ReportRepository, StoredExportJob } from "./types";

export class InMemoryReportRepository implements ReportRepository {
  private exportJobs = new Map<string, StoredExportJob>();

  async createExportJob(input: CreateExportJobInput): Promise<StoredExportJob> {
    const now = new Date();
    const exportJob: StoredExportJob = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      type: input.type,
      status: "SUCCEEDED",
      bucket: input.bucket,
      objectKey: input.objectKey,
      createdById: input.createdById,
      createdAt: now,
      completedAt: now,
      failureReason: null
    };
    this.exportJobs.set(exportJob.id, exportJob);
    return exportJob;
  }

  async listExportJobs(input: { tenantId: string; workspaceId: string }): Promise<StoredExportJob[]> {
    return [...this.exportJobs.values()]
      .filter((job) => job.tenantId === input.tenantId && job.workspaceId === input.workspaceId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }
}
