import { Prisma, PrismaClient } from "@prisma/client";
import type { AuditLogEntry, AuditRepository, AuditSummary, ListAuditLogsInput, SeedAuditLogInput } from "./types";

export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: SeedAuditLogInput): Promise<AuditLogEntry> {
    const log = await this.prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        metadata: input.metadata == null ? Prisma.JsonNull : (input.metadata as Prisma.InputJsonValue),
        ipHash: input.ipHash ?? null,
        userAgent: input.userAgent ?? null,
        correlationId: input.correlationId ?? null,
        ...(input.createdAt ? { createdAt: input.createdAt } : {})
      }
    });
    return serialize(log);
  }

  async list(input: ListAuditLogsInput): Promise<AuditLogEntry[]> {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.action ? { action: input.action } : {}),
        ...(input.resourceType ? { resourceType: input.resourceType } : {}),
        ...(input.actorUserId ? { actorUserId: input.actorUserId } : {})
      },
      orderBy: { createdAt: "desc" },
      take: input.limit ?? 50
    });
    return logs.map(serialize);
  }

  async summary(tenantId: string): Promise<AuditSummary> {
    const [total, actionRows, resourceRows] = await Promise.all([
      this.prisma.auditLog.count({ where: { tenantId } }),
      this.prisma.auditLog.groupBy({
        by: ["action"],
        where: { tenantId },
        _count: { _all: true },
        orderBy: { _count: { action: "desc" } },
        take: 10
      }),
      this.prisma.auditLog.groupBy({
        by: ["resourceType"],
        where: { tenantId },
        _count: { _all: true },
        orderBy: { _count: { resourceType: "desc" } },
        take: 10
      })
    ]);

    return {
      total,
      actions: actionRows.map((row) => ({ action: row.action, count: row._count._all })),
      resources: resourceRows.map((row) => ({ resourceType: row.resourceType, count: row._count._all }))
    };
  }

  async listOlderThan(input: { tenantId: string; cutoff: Date; limit?: number }): Promise<AuditLogEntry[]> {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        tenantId: input.tenantId,
        createdAt: { lt: input.cutoff }
      },
      orderBy: { createdAt: "asc" },
      take: input.limit ?? 50
    });
    return logs.map(serialize);
  }

  async countOlderThan(input: { tenantId: string; cutoff: Date }): Promise<number> {
    return await this.prisma.auditLog.count({
      where: {
        tenantId: input.tenantId,
        createdAt: { lt: input.cutoff }
      }
    });
  }

  async deleteOlderThan(input: { tenantId: string; cutoff: Date }): Promise<number> {
    const result = await this.prisma.auditLog.deleteMany({
      where: {
        tenantId: input.tenantId,
        createdAt: { lt: input.cutoff }
      }
    });
    return result.count;
  }
}

function serialize(row: {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Prisma.JsonValue | null;
  ipHash: string | null;
  userAgent: string | null;
  correlationId: string | null;
  createdAt: Date;
}): AuditLogEntry {
  return {
    ...row,
    metadata: normalizeObject(row.metadata)
  };
}

function normalizeObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}
