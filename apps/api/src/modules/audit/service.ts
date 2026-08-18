import type { AuthPrincipal } from "../auth/types";
import type { AuditLogEntry, AuditRepository, ListAuditLogsInput } from "./types";

export class AuditError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async list(principal: AuthPrincipal, filters: Omit<ListAuditLogsInput, "tenantId">) {
    const [summary, logs] = await Promise.all([
      this.repository.summary(principal.tenantId),
      this.repository.list({
        tenantId: principal.tenantId,
        ...filters
      })
    ]);
    return { summary, logs };
  }

  async exportLogs(principal: AuthPrincipal, filters: Omit<ListAuditLogsInput, "tenantId">) {
    const logs = await this.repository.list({
      tenantId: principal.tenantId,
      ...filters,
      limit: filters.limit ?? 1000
    });
    const generatedAt = new Date();
    const result = {
      generatedAt,
      filename: `spendlens-audit-${principal.tenantId}-${generatedAt.toISOString().slice(0, 10)}.jsonl`,
      format: "jsonl" as const,
      count: logs.length,
      content: logs.map((log) => JSON.stringify(serializeLog(log))).join("\n")
    };
    await this.repository.create({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action: "audit.export.created",
      resourceType: "AuditLogExport",
      resourceId: null,
      metadata: {
        format: result.format,
        exportedLogCount: result.count,
        limit: filters.limit ?? 1000,
        actionFilter: filters.action ?? null,
        resourceTypeFilter: filters.resourceType ?? null,
        actorUserFilterPresent: Boolean(filters.actorUserId)
      },
      correlationId: principal.sessionId
    });
    return result;
  }

  async retention(input: {
    principal: AuthPrincipal;
    retentionDays: number;
    dryRun: boolean;
    confirm?: boolean;
    now?: Date;
  }) {
    const cutoff = new Date((input.now ?? new Date()).getTime() - input.retentionDays * 24 * 60 * 60 * 1000);
    const [matched, sample] = await Promise.all([
      this.repository.countOlderThan({ tenantId: input.principal.tenantId, cutoff }),
      this.repository.listOlderThan({
        tenantId: input.principal.tenantId,
        cutoff,
        limit: 50
      })
    ]);
    if (input.dryRun) {
      await this.repository.create({
        tenantId: input.principal.tenantId,
        actorUserId: input.principal.userId,
        action: "audit.retention.previewed",
        resourceType: "AuditLogRetention",
        resourceId: null,
        metadata: {
          retentionDays: input.retentionDays,
          cutoff: cutoff.toISOString(),
          matched,
          sampleCount: sample.length
        },
        correlationId: input.principal.sessionId
      });
      return {
        dryRun: true,
        retentionDays: input.retentionDays,
        cutoff,
        matched,
        deleted: 0,
        sample
      };
    }
    if (!input.confirm) throw new AuditError("AUDIT_RETENTION_CONFIRMATION_REQUIRED", 400);
    const deleted = await this.repository.deleteOlderThan({ tenantId: input.principal.tenantId, cutoff });
    await this.repository.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "audit.retention.applied",
      resourceType: "AuditLogRetention",
      resourceId: null,
      metadata: { retentionDays: input.retentionDays, cutoff: cutoff.toISOString(), deleted },
      correlationId: input.principal.sessionId
    });
    return {
      dryRun: false,
      retentionDays: input.retentionDays,
      cutoff,
      matched,
      deleted,
      sample
    };
  }
}

function serializeLog(log: AuditLogEntry) {
  return {
    ...log,
    createdAt: log.createdAt.toISOString()
  };
}
