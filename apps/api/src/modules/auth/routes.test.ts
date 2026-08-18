import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuthRepository } from "./memory-repository";

describe("auth routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ authRepository: new InMemoryAuthRepository() });
  });

  afterAll(async () => {
    await app.close();
  });

  it("registers, returns current principal and lists sessions", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Demo Tenant",
        tenantSlug: "demo",
        workspaceName: "Finance",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    expect(register.statusCode).toBe(201);
    const body = register.json();
    expect(body.permissions).toContain("tenant.manage");

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().principal.email).toBe("owner@example.com");

    const sessions = await app.inject({
      method: "GET",
      url: "/auth/sessions",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` }
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().sessions).toHaveLength(1);
    expect(sessions.json()).toMatchObject({
      pagination: { page: 1, limit: 20, total: 1, pageCount: 1 },
      summary: { active: 1, revoked: 0, expired: 0 }
    });

    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { tenantSlug: "demo", email: "owner@example.com", password: "very-secure-password" }
    });
    const pagedSessions = await app.inject({
      method: "GET",
      url: "/auth/sessions?limit=1&page=2",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` }
    });
    expect(pagedSessions.statusCode).toBe(200);
    expect(pagedSessions.json().sessions).toHaveLength(1);
    expect(pagedSessions.json()).toMatchObject({
      pagination: { page: 2, limit: 1, total: 2, pageCount: 2 },
      summary: { active: 2, revoked: 0, expired: 0 }
    });

    const workspaces = await app.inject({
      method: "GET",
      url: "/workspaces",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` }
    });
    expect(workspaces.statusCode).toBe(200);
    expect(workspaces.json().workspaces[0]).toMatchObject({ name: "Finance", kind: "BUSINESS" });
  });

  it("rejects invalid login and duplicate tenant slugs", async () => {
    const duplicate = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Other Tenant",
        tenantSlug: "demo",
        workspaceName: "Finance",
        email: "owner2@example.com",
        displayName: "Owner Two",
        password: "very-secure-password"
      }
    });
    expect(duplicate.statusCode).toBe(409);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        tenantSlug: "demo",
        email: "owner@example.com",
        password: "wrong-password"
      }
    });
    expect(login.statusCode).toBe(401);
  });

  it("enforces server-side permissions on admin guarded routes", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        tenantSlug: "demo",
        email: "owner@example.com",
        password: "very-secure-password"
      }
    });
    const token = login.json().tokens.accessToken;
    const guarded = await app.inject({
      method: "GET",
      url: "/admin/auth-check",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(guarded.statusCode).toBe(200);
  });

  it("writes central audit evidence for auth session lifecycle without token leakage", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { "x-correlation-id": "corr-auth-register" },
      payload: {
        tenantName: "Audit Tenant",
        tenantSlug: "audit-auth",
        workspaceName: "Audit",
        email: "auditor@example.com",
        displayName: "Audit Owner",
        password: "very-secure-password"
      }
    });
    expect(register.statusCode).toBe(201);
    const registered = register.json();

    const refresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { "x-correlation-id": "corr-auth-refresh" },
      payload: { refreshToken: registered.tokens.refreshToken }
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().tokens.refreshToken).not.toBe(registered.tokens.refreshToken);

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { "x-correlation-id": "corr-auth-logout" },
      payload: { refreshToken: refresh.json().tokens.refreshToken }
    });
    expect(logout.statusCode).toBe(204);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-correlation-id": "corr-auth-login", "user-agent": "SensitiveBrowser/1.0" },
      payload: {
        tenantSlug: "audit-auth",
        email: "auditor@example.com",
        password: "very-secure-password"
      }
    });
    expect(login.statusCode).toBe(200);

    const sessionList = await app.inject({
      method: "GET",
      url: "/auth/sessions",
      headers: { authorization: `Bearer ${login.json().tokens.accessToken}`, "x-correlation-id": "corr-auth-sessions" }
    });
    expect(sessionList.statusCode).toBe(200);
    expect(sessionList.json().sessions.length).toBeGreaterThanOrEqual(1);

    const logoutAll = await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: { authorization: `Bearer ${login.json().tokens.accessToken}`, "x-correlation-id": "corr-auth-logout-all" }
    });
    expect(logoutAll.statusCode).toBe(204);

    const finalLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        tenantSlug: "audit-auth",
        email: "auditor@example.com",
        password: "very-secure-password"
      }
    });
    expect(finalLogin.statusCode).toBe(200);
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?limit=20",
      headers: { authorization: `Bearer ${finalLogin.json().tokens.accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const actions = audit.json().logs.map((log: { action: string }) => log.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "auth.register",
        "tenant.created",
        "workspace.created",
        "auth.refresh_rotated",
        "auth.logout",
        "auth.login",
        "auth.sessions_listed",
        "auth.logout_all"
      ])
    );
    expect(
      audit
        .json()
        .logs.find((log: { action: string; correlationId: string | null }) => log.action === "auth.register")?.correlationId
    ).toBe("corr-auth-register");
    expect(
      audit
        .json()
        .logs.find((log: { action: string; correlationId: string | null }) => log.action === "auth.logout_all")?.correlationId
    ).toBe("corr-auth-logout-all");
    const refreshLog = audit.json().logs.find((log: { action: string }) => log.action === "auth.refresh_rotated");
    expect(refreshLog.metadata).toMatchObject({ rotated: true });
    const sessionsAudit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=auth.sessions_listed&resourceType=User&limit=10",
      headers: { authorization: `Bearer ${finalLogin.json().tokens.accessToken}` }
    });
    expect(sessionsAudit.statusCode).toBe(200);
    expect(sessionsAudit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "auth.sessions_listed",
          resourceType: "User",
          resourceId: registered.user.id,
          correlationId: "corr-auth-sessions",
          metadata: expect.objectContaining({
            sessionCount: expect.any(Number),
            activeSessionCount: expect.any(Number),
            revokedSessionCount: expect.any(Number),
            expiredSessionCount: expect.any(Number),
            currentSessionIncluded: true
          })
        })
      ])
    );
    const serializedSessionAudit = JSON.stringify(sessionsAudit.json().logs);
    for (const session of sessionList.json().sessions) {
      expect(serializedSessionAudit).not.toContain(session.id);
    }
    expect(serializedSessionAudit).not.toContain("SensitiveBrowser/1.0");
    const workspaceLog = audit.json().logs.find((log: { action: string }) => log.action === "workspace.created");
    expect(workspaceLog).toMatchObject({
      resourceType: "Workspace",
      metadata: {
        tenantSlug: "audit-auth",
        workspaceKind: "BUSINESS",
        source: "auth.register"
      }
    });
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain(registered.tokens.refreshToken);
    expect(serializedAudit).not.toContain(refresh.json().tokens.refreshToken);
    expect(serializedAudit).not.toContain(login.json().tokens.refreshToken);
    expect(serializedAudit).not.toContain(finalLogin.json().tokens.accessToken);
    expect(serializedAudit).not.toContain("SensitiveBrowser/1.0");
    expect(serializedAudit).not.toContain("Audit Tenant");
    expect(serializedAudit).not.toContain("Audit Owner");
    expect(serializedAudit).not.toContain("auditor@example.com");
    expect(serializedAudit).not.toContain("very-secure-password");
  });
});
