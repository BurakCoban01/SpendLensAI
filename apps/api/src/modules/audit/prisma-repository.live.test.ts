import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaAuditRepository } from "./prisma-repository";

const runLivePostgresTests = process.env.SPENDLENS_LIVE_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDescribe = runLivePostgresTests ? describe : describe.skip;

liveDescribe("PrismaAuditRepository live PostgreSQL", () => {
  const prisma = new PrismaClient();
  const repository = new PrismaAuditRepository(prisma);
  const slugPrefix = `audit-live-${Date.now()}`;
  let tenantId = "";
  let otherTenantId = "";

  beforeAll(async () => {
    await prisma.$connect();
    const tenant = await prisma.tenant.create({
      data: {
        name: "Audit Live Tenant",
        slug: slugPrefix
      }
    });
    const otherTenant = await prisma.tenant.create({
      data: {
        name: "Audit Live Other Tenant",
        slug: `${slugPrefix}-other`
      }
    });
    tenantId = tenant.id;
    otherTenantId = otherTenant.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId].filter(Boolean) } } });
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: slugPrefix } } });
    await prisma.$disconnect();
  });

  it("creates, filters, summarizes and deletes only tenant-scoped audit rows", async () => {
    const recent = await repository.create({
      tenantId,
      actorUserId: "user_live_1",
      action: "live.audit.created",
      resourceType: "LiveAudit",
      resourceId: "live_audit_recent",
      metadata: { status: "created", nested: { source: "postgres" } },
      ipHash: "ip_hash",
      userAgent: "vitest-live",
      correlationId: "corr-live-recent",
      createdAt: new Date("2026-05-20T10:00:00.000Z")
    });
    const stale = await repository.create({
      tenantId,
      actorUserId: "user_live_1",
      action: "live.audit.stale",
      resourceType: "LiveAudit",
      resourceId: "live_audit_stale",
      createdAt: new Date("2026-04-01T10:00:00.000Z")
    });
    const otherTenantStale = await repository.create({
      tenantId: otherTenantId,
      action: "live.audit.stale",
      resourceType: "LiveAudit",
      resourceId: "live_audit_other_tenant",
      createdAt: new Date("2026-04-01T10:00:00.000Z")
    });

    const filtered = await repository.list({
      tenantId,
      action: "live.audit.created",
      resourceType: "LiveAudit",
      actorUserId: "user_live_1",
      limit: 10
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({
      id: recent.id,
      tenantId,
      action: "live.audit.created",
      resourceId: "live_audit_recent",
      metadata: { status: "created", nested: { source: "postgres" } },
      correlationId: "corr-live-recent"
    });

    const summary = await repository.summary(tenantId);
    expect(summary.total).toBe(2);
    expect(summary.actions).toEqual(
      expect.arrayContaining([
        { action: "live.audit.created", count: 1 },
        { action: "live.audit.stale", count: 1 }
      ])
    );

    const cutoff = new Date("2026-05-01T00:00:00.000Z");
    expect(await repository.countOlderThan({ tenantId, cutoff })).toBe(1);
    expect((await repository.listOlderThan({ tenantId, cutoff, limit: 10 })).map((log) => log.id)).toEqual([stale.id]);
    expect(await repository.deleteOlderThan({ tenantId, cutoff })).toBe(1);

    expect(await repository.countOlderThan({ tenantId, cutoff })).toBe(0);
    const otherTenantRows = await repository.list({ tenantId: otherTenantId, resourceType: "LiveAudit", limit: 10 });
    expect(otherTenantRows.map((log) => log.id)).toContain(otherTenantStale.id);
  });
});
