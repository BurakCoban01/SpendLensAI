import type { PrismaClient } from "@prisma/client";
import type { CreateExportJobInput, ReportRepository, StoredExportJob } from "./types";

export class PrismaReportRepository implements ReportRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createExportJob(input: CreateExportJobInput): Promise<StoredExportJob> {
    return this.prisma.exportJob.create({
      data: {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        type: input.type,
        status: "SUCCEEDED",
        bucket: input.bucket,
        objectKey: input.objectKey,
        createdById: input.createdById,
        completedAt: new Date()
      }
    });
  }

  async listExportJobs(input: { tenantId: string; workspaceId: string }): Promise<StoredExportJob[]> {
    return this.prisma.exportJob.findMany({
      where: { tenantId: input.tenantId, workspaceId: input.workspaceId },
      orderBy: { createdAt: "desc" }
    });
  }
}
