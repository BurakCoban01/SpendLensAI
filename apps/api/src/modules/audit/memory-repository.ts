import { randomUUID } from "node:crypto";
import type { AuditLogEntry, AuditRepository, AuditSummary, ListAuditLogsInput, SeedAuditLogInput } from "./types";

export class InMemoryAuditRepository implements AuditRepository {
  private readonly logs: AuditLogEntry[] = [];

  async create(input: SeedAuditLogInput): Promise<AuditLogEntry> {
    const log: AuditLogEntry = {
      id: randomUUID(),
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      metadata: input.metadata ?? null,
      ipHash: input.ipHash ?? null,
      userAgent: input.userAgent ?? null,
      correlationId: input.correlationId ?? null,
      createdAt: input.createdAt ?? new Date()
    };
    this.logs.push(log);
    return log;
  }

  async list(input: ListAuditLogsInput): Promise<AuditLogEntry[]> {
    return this.logs
      .filter((log) => log.tenantId === input.tenantId)
      .filter((log) => !input.action || log.action === input.action)
      .filter((log) => !input.resourceType || log.resourceType === input.resourceType)
      .filter((log) => !input.actorUserId || log.actorUserId === input.actorUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, input.limit ?? 50);
  }

  async summary(tenantId: string): Promise<AuditSummary> {
    const tenantLogs = this.logs.filter((log) => log.tenantId === tenantId);
    return {
      total: tenantLogs.length,
      actions: summarize(tenantLogs.map((log) => log.action), "action"),
      resources: summarize(tenantLogs.map((log) => log.resourceType), "resourceType")
    };
  }

  async listOlderThan(input: { tenantId: string; cutoff: Date; limit?: number }): Promise<AuditLogEntry[]> {
    return this.logs
      .filter((log) => log.tenantId === input.tenantId)
      .filter((log) => log.createdAt < input.cutoff)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, input.limit ?? 50);
  }

  async countOlderThan(input: { tenantId: string; cutoff: Date }): Promise<number> {
    return this.logs.filter((log) => log.tenantId === input.tenantId && log.createdAt < input.cutoff).length;
  }

  async deleteOlderThan(input: { tenantId: string; cutoff: Date }): Promise<number> {
    const before = this.logs.length;
    for (let index = this.logs.length - 1; index >= 0; index -= 1) {
      const log = this.logs[index];
      if (log && log.tenantId === input.tenantId && log.createdAt < input.cutoff) this.logs.splice(index, 1);
    }
    return before - this.logs.length;
  }
}

function summarize<T extends "action" | "resourceType">(
  values: string[],
  key: T
): Array<T extends "action" ? { action: string; count: number } : { resourceType: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([value, count]) => ({ [key]: value, count })) as Array<
    T extends "action" ? { action: string; count: number } : { resourceType: string; count: number }
  >;
}
