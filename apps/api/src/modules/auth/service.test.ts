import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/memory-repository";
import { InMemoryAuthRepository } from "./memory-repository";
import { AuthError, AuthService } from "./service";

function createService(repository = new InMemoryAuthRepository(), accessTokenTtlSeconds = 60) {
  const auditRepository = new InMemoryAuditRepository();
  return {
    auditRepository,
    repository,
    service: new AuthService({
      repository,
      auditRepository,
      accessTokenSecret: "test_access_secret_at_least_16_chars",
      refreshTokenSecret: "test_refresh_secret_at_least_16_chars",
      accessTokenTtlSeconds,
      refreshTokenTtlSeconds: 3600
    })
  };
}

describe("AuthService", () => {
  it("registers an owner with hashed password, roles, tokens and audit log", async () => {
    const { auditRepository, service } = createService();
    const result = await service.register({
      tenantName: "Demo Tenant",
      tenantSlug: "Demo Tenant",
      workspaceName: "Finance",
      email: "OWNER@EXAMPLE.COM",
      displayName: "Owner User",
      password: "very-secure-password",
      userAgent: "vitest",
      ipHash: "ip",
      correlationId: "corr-1"
    });

    expect(result.tenant.slug).toBe("demo-tenant");
    expect(result.user.email).toBe("owner@example.com");
    expect(result.user.passwordHash).not.toContain("very-secure-password");
    expect(result.roles).toEqual(["OWNER"]);
    expect(result.permissions).toContain("tenant.manage");
    expect(result.tokens.accessToken).toBeTruthy();
    const auditLogs = await auditRepository.list({ tenantId: result.tenant.id, resourceType: "User", limit: 10 });
    expect(auditLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "auth.register",
          resourceId: result.user.id,
          correlationId: "corr-1",
          metadata: expect.objectContaining({
            tenantSlug: "demo-tenant"
          })
        })
      ])
    );
    const tenantAuditLogs = await auditRepository.list({ tenantId: result.tenant.id, resourceType: "Tenant", limit: 10 });
    expect(tenantAuditLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "tenant.created",
          resourceId: result.tenant.id,
          correlationId: "corr-1",
          metadata: expect.objectContaining({
            tenantSlug: "demo-tenant",
            ownerUserId: result.user.id,
            initialWorkspaceId: result.workspace.id
          })
        })
      ])
    );
    const workspaceAuditLogs = await auditRepository.list({ tenantId: result.tenant.id, resourceType: "Workspace", limit: 10 });
    expect(workspaceAuditLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "workspace.created",
          resourceId: result.workspace.id,
          correlationId: "corr-1",
          metadata: expect.objectContaining({
            tenantSlug: "demo-tenant",
            workspaceKind: "BUSINESS",
            ownerUserId: result.user.id,
            source: "auth.register"
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify([...auditLogs, ...tenantAuditLogs, ...workspaceAuditLogs]);
    expect(serializedAudit).not.toContain("Demo Tenant");
    expect(serializedAudit).not.toContain("Finance");
    expect(serializedAudit).not.toContain("OWNER@EXAMPLE.COM");
    expect(serializedAudit).not.toContain("very-secure-password");
  });

  it("isolates the same email across tenants", async () => {
    const { service } = createService();
    await service.register({
      tenantName: "Tenant A",
      tenantSlug: "tenant-a",
      workspaceName: "A",
      email: "person@example.com",
      displayName: "Person",
      password: "very-secure-password",
      userAgent: null,
      ipHash: null
    });
    await service.register({
      tenantName: "Tenant B",
      tenantSlug: "tenant-b",
      workspaceName: "B",
      email: "person@example.com",
      displayName: "Person",
      password: "very-secure-password",
      userAgent: null,
      ipHash: null
    });

    await expect(
      service.login({
        tenantSlug: "tenant-b",
        email: "person@example.com",
        password: "wrong-password",
        userAgent: null,
        ipHash: null
      })
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const login = await service.login({
      tenantSlug: "tenant-a",
      email: "person@example.com",
      password: "very-secure-password",
      userAgent: null,
      ipHash: null
    });
    expect(login.tenant.slug).toBe("tenant-a");
  });

  it("rotates refresh tokens and rejects reuse of the old token", async () => {
    const { service } = createService();
    const registered = await service.register({
      tenantName: "Demo Tenant",
      tenantSlug: "demo",
      workspaceName: "Finance",
      email: "owner@example.com",
      displayName: "Owner",
      password: "very-secure-password",
      userAgent: null,
      ipHash: null
    });

    const oldRefresh = registered.tokens.refreshToken;
    const refreshed = await service.refresh(oldRefresh);
    expect(refreshed.refreshToken).not.toBe(oldRefresh);
    await expect(service.refresh(oldRefresh)).rejects.toMatchObject({ code: "INVALID_REFRESH_SESSION" });
  });

  it("enforces permissions and revoked sessions", async () => {
    const { service } = createService();
    const registered = await service.register({
      tenantName: "Demo Tenant",
      tenantSlug: "demo",
      workspaceName: "Finance",
      email: "owner@example.com",
      displayName: "Owner",
      password: "very-secure-password",
      userAgent: null,
      ipHash: null
    });
    const principal = await service.authenticateAccessToken(registered.tokens.accessToken);
    expect(() => service.requirePermission(principal, "tenant.manage")).not.toThrow();

    await service.logoutAll(principal);
    await expect(service.authenticateAccessToken(registered.tokens.accessToken)).rejects.toMatchObject({
      code: "SESSION_REVOKED"
    });
  });

  it("returns typed auth errors for invalid and expired signed tokens", async () => {
    const { service } = createService();
    await expect(service.authenticateAccessToken("not-a-token")).rejects.toMatchObject({
      code: "INVALID_TOKEN",
      statusCode: 401
    });
    await expect(service.refresh("not-a-refresh-token")).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
      statusCode: 401
    });

    const { service: expiredService } = createService(new InMemoryAuthRepository(), -1);
    const registered = await expiredService.register({
      tenantName: "Expired Tenant",
      tenantSlug: "expired",
      workspaceName: "Finance",
      email: "expired@example.com",
      displayName: "Expired Owner",
      password: "very-secure-password",
      userAgent: null,
      ipHash: null
    });
    await expect(expiredService.authenticateAccessToken(registered.tokens.accessToken)).rejects.toMatchObject({
      code: "INVALID_TOKEN",
      statusCode: 401
    });
  });

  it("throws typed permission errors", async () => {
    const error = new AuthError("PERMISSION_DENIED", 403);
    expect(error.statusCode).toBe(403);
  });
});
