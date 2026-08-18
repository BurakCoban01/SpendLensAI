import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/memory-repository";
import { PrismaAuthRepository } from "./prisma-repository";
import { AuthService } from "./service";

const runLivePostgresTests = process.env.SPENDLENS_LIVE_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDescribe = runLivePostgresTests ? describe : describe.skip;

liveDescribe("PrismaAuthRepository live PostgreSQL tenant isolation", () => {
  const prisma = new PrismaClient();
  const repository = new PrismaAuthRepository(prisma);
  const service = new AuthService({
    repository,
    auditRepository: new InMemoryAuditRepository(),
    accessTokenSecret: "live_access_secret_at_least_16_chars",
    refreshTokenSecret: "live_refresh_secret_at_least_16_chars",
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 3600
  });
  const slugPrefix = `auth-live-${Date.now()}`;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    const ids = [...tenantIds];
    if (ids.length > 0) {
      await prisma.session.deleteMany({ where: { tenantId: { in: ids } } });
      await prisma.aPIKey.deleteMany({ where: { tenantId: { in: ids } } });
      await prisma.userRole.deleteMany({ where: { tenantId: { in: ids } } });
      await prisma.rolePermission.deleteMany({ where: { tenantId: { in: ids } } });
      await prisma.role.deleteMany({ where: { tenantId: { in: ids } } });
      await prisma.workspace.deleteMany({ where: { tenantId: { in: ids } } });
      await prisma.user.deleteMany({ where: { tenantId: { in: ids } } });
      await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: slugPrefix } } });
    await prisma.$disconnect();
  });

  it("keeps same-email users isolated across persisted tenants", async () => {
    const email = `${slugPrefix}@example.com`;
    const tenantA = await service.register({
      tenantName: "Live Tenant A",
      tenantSlug: `${slugPrefix}-a`,
      workspaceName: "Finance A",
      email,
      displayName: "Live Owner A",
      password: "very-secure-password-a",
      userAgent: "vitest-live",
      ipHash: "ip-a"
    });
    const tenantB = await service.register({
      tenantName: "Live Tenant B",
      tenantSlug: `${slugPrefix}-b`,
      workspaceName: "Finance B",
      email,
      displayName: "Live Owner B",
      password: "very-secure-password-b",
      userAgent: "vitest-live",
      ipHash: "ip-b"
    });
    tenantIds.push(tenantA.tenant.id, tenantB.tenant.id);

    expect(tenantA.user.id).not.toBe(tenantB.user.id);
    expect(tenantA.tenant.id).not.toBe(tenantB.tenant.id);

    await expect(
      service.login({
        tenantSlug: tenantB.tenant.slug,
        email,
        password: "very-secure-password-a",
        userAgent: null,
        ipHash: null
      })
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const loginA = await service.login({
      tenantSlug: tenantA.tenant.slug,
      email,
      password: "very-secure-password-a",
      userAgent: null,
      ipHash: null
    });
    const loginB = await service.login({
      tenantSlug: tenantB.tenant.slug,
      email,
      password: "very-secure-password-b",
      userAgent: null,
      ipHash: null
    });

    expect(loginA.tenant.id).toBe(tenantA.tenant.id);
    expect(loginB.tenant.id).toBe(tenantB.tenant.id);
    expect((await service.authenticateAccessToken(loginB.tokens.accessToken)).tenantId).toBe(tenantB.tenant.id);
    expect((await repository.listUsersWithRoles(tenantA.tenant.id)).map((user) => user.id)).toEqual([tenantA.user.id]);
    expect((await repository.listUsersWithRoles(tenantB.tenant.id)).map((user) => user.id)).toEqual([tenantB.user.id]);
  });
});
