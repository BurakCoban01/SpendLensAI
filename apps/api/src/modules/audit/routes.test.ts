import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { InMemoryAuditRepository } from "./memory-repository";

describe("audit admin routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let tenantId: string;
  let secondTenantId: string;
  let auditRepository: InMemoryAuditRepository;

  beforeAll(async () => {
    const recentAuditDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    auditRepository = new InMemoryAuditRepository();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      auditRepository
    });

    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Audit Tenant",
        tenantSlug: "audit",
        workspaceName: "Audit",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    accessToken = register.json().tokens.accessToken;
    tenantId = register.json().tenant.id;

    const other = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Other Audit Tenant",
        tenantSlug: "audit-other",
        workspaceName: "Other",
        email: "owner@example.com",
        displayName: "Other Owner",
        password: "very-secure-password"
      }
    });
    secondTenantId = other.json().tenant.id;

    await auditRepository.create({
      tenantId,
      actorUserId: "user_1",
      action: "expense.approved",
      resourceType: "Expense",
      resourceId: "expense_1",
      metadata: { status: "APPROVED" },
      correlationId: "corr-audit-1",
      createdAt: recentAuditDate
    });
    await auditRepository.create({
      tenantId,
      actorUserId: "user_2",
      action: "document.uploaded",
      resourceType: "DocumentFile",
      resourceId: "document_1",
      metadata: { kind: "RECEIPT" },
      correlationId: "corr-audit-2",
      createdAt: recentAuditDate
    });
    await auditRepository.create({
      tenantId: secondTenantId,
      actorUserId: "other_user",
      action: "expense.approved",
      resourceType: "Expense",
      resourceId: "expense_other",
      createdAt: recentAuditDate
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires authentication before listing audit logs", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/audit" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("MISSING_BEARER_TOKEN");
  });

  it("lists tenant-scoped audit logs with summaries", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().summary.total).toBe(5);
    expect(response.json().summary.actions).toEqual(
      expect.arrayContaining([
        { action: "auth.register", count: 1 },
        { action: "tenant.created", count: 1 },
        { action: "workspace.created", count: 1 },
        { action: "document.uploaded", count: 1 },
        { action: "expense.approved", count: 1 }
      ])
    );
    expect(response.json().logs).toHaveLength(5);
    expect(response.json().logs.map((log: { tenantId: string }) => log.tenantId)).toEqual([
      tenantId,
      tenantId,
      tenantId,
      tenantId,
      tenantId
    ]);
    expect(response.json().logs.map((log: { resourceType: string }) => log.resourceType)).toEqual(
      expect.arrayContaining(["DocumentFile", "Expense", "Tenant", "User", "Workspace"])
    );
  });

  it("filters by action and resource type", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.approved&resourceType=Expense",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().logs).toHaveLength(1);
    expect(response.json().logs[0]).toMatchObject({
      tenantId,
      action: "expense.approved",
      resourceType: "Expense",
      resourceId: "expense_1"
    });
  });

  it("exports filtered audit logs as tenant-scoped JSONL", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/audit/export",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { action: "document.uploaded", limit: 10 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      format: "jsonl",
      count: 1,
      filename: expect.stringContaining("spendlens-audit")
    });
    const rows = response
      .json()
      .content.split("\n")
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId,
      action: "document.uploaded",
      resourceType: "DocumentFile",
      resourceId: "document_1"
    });

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=audit.export.created&resourceType=AuditLogExport&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId,
          actorUserId: expect.any(String),
          action: "audit.export.created",
          resourceType: "AuditLogExport",
          resourceId: null,
          metadata: expect.objectContaining({
            format: "jsonl",
            exportedLogCount: 1,
            limit: 10,
            actionFilter: "document.uploaded",
            resourceTypeFilter: null,
            actorUserFilterPresent: false
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("document_1");
    expect(serializedAudit).not.toContain("corr-audit-2");
    expect(serializedAudit).not.toContain("spendlens-audit");
    expect(serializedAudit).not.toContain(response.json().content);
  });

  it("previews and applies tenant-scoped audit retention", async () => {
    const stale = await auditRepository.create({
      tenantId,
      actorUserId: "user_1",
      action: "audit.stale",
      resourceType: "AuditLog",
      resourceId: "audit_old",
      createdAt: new Date("2026-04-01T00:00:00.000Z")
    });
    const otherStale = await auditRepository.create({
      tenantId: secondTenantId,
      actorUserId: "other_user",
      action: "audit.stale",
      resourceType: "AuditLog",
      resourceId: "audit_other_old",
      createdAt: new Date("2026-04-01T00:00:00.000Z")
    });

    const preview = await app.inject({
      method: "POST",
      url: "/admin/audit/retention",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { retentionDays: 30, dryRun: true }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      dryRun: true,
      retentionDays: 30,
      matched: 1,
      deleted: 0
    });
    expect(preview.json().sample[0].id).toBe(stale.id);

    const previewAudit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=audit.retention.previewed&resourceType=AuditLogRetention&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(previewAudit.statusCode).toBe(200);
    expect(previewAudit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId,
          actorUserId: expect.any(String),
          action: "audit.retention.previewed",
          resourceType: "AuditLogRetention",
          resourceId: null,
          metadata: expect.objectContaining({
            retentionDays: 30,
            matched: 1,
            sampleCount: 1
          })
        })
      ])
    );
    const serializedPreviewAudit = JSON.stringify(previewAudit.json().logs);
    expect(serializedPreviewAudit).not.toContain(stale.id);
    expect(serializedPreviewAudit).not.toContain(otherStale.id);
    expect(serializedPreviewAudit).not.toContain("audit_old");
    expect(serializedPreviewAudit).not.toContain("audit_other_old");

    const missingConfirmation = await app.inject({
      method: "POST",
      url: "/admin/audit/retention",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { retentionDays: 30, dryRun: false }
    });
    expect(missingConfirmation.statusCode).toBe(400);
    expect(missingConfirmation.json().error.code).toBe("AUDIT_RETENTION_CONFIRMATION_REQUIRED");

    const applied = await app.inject({
      method: "POST",
      url: "/admin/audit/retention",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { retentionDays: 30, dryRun: false, confirm: true }
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ dryRun: false, matched: 1, deleted: 1 });

    const remainingTenantLogs = await auditRepository.list({ tenantId, limit: 20 });
    expect(remainingTenantLogs.some((log) => log.id === stale.id)).toBe(false);
    expect(
      remainingTenantLogs.some(
        (log) => log.action === "audit.retention.applied" && log.resourceType === "AuditLogRetention"
      )
    ).toBe(true);
    const otherTenantLogs = await auditRepository.list({ tenantId: secondTenantId, limit: 20 });
    expect(otherTenantLogs.some((log) => log.id === otherStale.id)).toBe(true);

    const appliedAudit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=audit.retention.applied&resourceType=AuditLogRetention&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(appliedAudit.statusCode).toBe(200);
    expect(appliedAudit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId,
          actorUserId: expect.any(String),
          action: "audit.retention.applied",
          resourceType: "AuditLogRetention",
          resourceId: null,
          metadata: expect.objectContaining({
            retentionDays: 30,
            deleted: 1
          })
        })
      ])
    );
    const serializedAppliedAudit = JSON.stringify(appliedAudit.json().logs);
    expect(serializedAppliedAudit).not.toContain(stale.id);
    expect(serializedAppliedAudit).not.toContain(otherStale.id);
    expect(serializedAppliedAudit).not.toContain("audit_old");
    expect(serializedAppliedAudit).not.toContain("audit_other_old");
  });
});
