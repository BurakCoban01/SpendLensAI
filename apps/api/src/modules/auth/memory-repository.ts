import { rolePermissions, type RoleCode } from "@spendlens/shared";
import { randomUUID } from "node:crypto";
import type { AuthRepository, AuthSession, AuthTenant, AuthUser, AuthUserWithRoles, AuthWorkspace, AutomationApiKey } from "./types";

export class InMemoryAuthRepository implements AuthRepository {
  private tenants = new Map<string, AuthTenant>();
  private tenantSlugIndex = new Map<string, string>();
  private users = new Map<string, AuthUser>();
  private workspaces = new Map<string, AuthWorkspace>();
  private userEmailIndex = new Map<string, string>();
  private roles = new Map<string, RoleCode[]>();
  private sessions = new Map<string, AuthSession>();
  private apiKeys = new Map<string, AutomationApiKey>();

  async findTenantBySlug(slug: string): Promise<AuthTenant | null> {
    const id = this.tenantSlugIndex.get(slug);
    return id ? (this.tenants.get(id) ?? null) : null;
  }

  async findUserByEmail(tenantId: string, email: string): Promise<AuthUser | null> {
    const id = this.userEmailIndex.get(`${tenantId}:${email.toLowerCase()}`);
    return id ? (this.users.get(id) ?? null) : null;
  }

  async findUserById(tenantId: string, userId: string): Promise<AuthUser | null> {
    const user = this.users.get(userId);
    return user?.tenantId === tenantId ? user : null;
  }

  async listUsersWithRoles(tenantId: string): Promise<AuthUserWithRoles[]> {
    return [...this.users.values()]
      .filter((user) => user.tenantId === tenantId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((user) => ({ ...user, roles: [...(this.roles.get(`${tenantId}:${user.id}`) ?? [])] }));
  }

  async createTenantWithOwner(input: {
    tenantName: string;
    tenantSlug: string;
    workspaceName: string;
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<{ tenant: AuthTenant; workspace: AuthWorkspace; user: AuthUser }> {
    if (this.tenantSlugIndex.has(input.tenantSlug)) {
      throw new Error("TENANT_SLUG_TAKEN");
    }
    const tenant = { id: randomUUID(), name: input.tenantName, slug: input.tenantSlug };
    const workspace = { id: randomUUID(), tenantId: tenant.id, name: input.workspaceName, kind: "BUSINESS" };
    const user = {
      id: randomUUID(),
      tenantId: tenant.id,
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      disabledAt: null
    };
    this.tenants.set(tenant.id, tenant);
    this.workspaces.set(workspace.id, workspace);
    this.tenantSlugIndex.set(tenant.slug, tenant.id);
    this.users.set(user.id, user);
    this.userEmailIndex.set(`${tenant.id}:${user.email}`, user.id);
    this.roles.set(`${tenant.id}:${user.id}`, ["OWNER"]);
    return { tenant, workspace, user };
  }

  addUserWithRoles(input: {
    tenantId: string;
    email: string;
    displayName: string;
    roles: RoleCode[];
    passwordHash?: string;
    disabledAt?: Date | null;
  }): AuthUser {
    const user = {
      id: randomUUID(),
      tenantId: input.tenantId,
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      passwordHash: input.passwordHash ?? "test-only",
      disabledAt: input.disabledAt ?? null
    };
    this.users.set(user.id, user);
    this.userEmailIndex.set(`${user.tenantId}:${user.email}`, user.id);
    this.roles.set(`${user.tenantId}:${user.id}`, [...input.roles]);
    return user;
  }

  async listWorkspaces(tenantId: string): Promise<AuthWorkspace[]> {
    return [...this.workspaces.values()].filter((workspace) => workspace.tenantId === tenantId);
  }

  async getUserRoles(tenantId: string, userId: string): Promise<RoleCode[]> {
    return [...(this.roles.get(`${tenantId}:${userId}`) ?? [])];
  }

  async createSession(input: {
    id: string;
    tenantId: string;
    userId: string;
    refreshTokenHash: string;
    userAgent: string | null;
    ipHash: string | null;
    expiresAt: Date;
  }): Promise<AuthSession> {
    const session = {
      id: input.id,
      tenantId: input.tenantId,
      userId: input.userId,
      refreshTokenHash: input.refreshTokenHash,
      userAgent: input.userAgent,
      ipHash: input.ipHash,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      revokedAt: null,
      rotatedFromId: null
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findSession(tenantId: string, sessionId: string): Promise<AuthSession | null> {
    const session = this.sessions.get(sessionId);
    return session?.tenantId === tenantId ? session : null;
  }

  async rotateSession(input: {
    tenantId: string;
    sessionId: string;
    expectedRefreshTokenHash: string;
    nextSessionId: string;
    nextRefreshTokenHash: string;
    nextExpiresAt: Date;
  }): Promise<AuthSession> {
    const current = await this.findSession(input.tenantId, input.sessionId);
    if (!current || current.revokedAt || current.refreshTokenHash !== input.expectedRefreshTokenHash) {
      throw new Error("INVALID_REFRESH_SESSION");
    }
    const now = new Date();
    this.sessions.set(current.id, { ...current, revokedAt: now });
    const next = {
      ...current,
      id: input.nextSessionId,
      refreshTokenHash: input.nextRefreshTokenHash,
      createdAt: now,
      expiresAt: input.nextExpiresAt,
      revokedAt: null,
      rotatedFromId: current.id
    };
    this.sessions.set(next.id, next);
    return next;
  }

  async revokeSession(tenantId: string, sessionId: string): Promise<void> {
    const session = await this.findSession(tenantId, sessionId);
    if (session) this.sessions.set(session.id, { ...session, revokedAt: new Date() });
  }

  async revokeAllUserSessions(tenantId: string, userId: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.tenantId === tenantId && session.userId === userId && !session.revokedAt) {
        this.sessions.set(session.id, { ...session, revokedAt: new Date() });
      }
    }
  }

  async listUserSessions(tenantId: string, userId: string): Promise<AuthSession[]> {
    return [...this.sessions.values()].filter((session) => session.tenantId === tenantId && session.userId === userId);
  }

  async createApiKey(input: {
    tenantId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    createdById: string;
    expiresAt: Date | null;
  }): Promise<AutomationApiKey> {
    const apiKey = { ...input, id: randomUUID(), createdAt: new Date(), revokedAt: null };
    this.apiKeys.set(apiKey.id, apiKey);
    return apiKey;
  }

  async findApiKeyByPrefix(tenantId: string, keyPrefix: string): Promise<AutomationApiKey | null> {
    return (
      [...this.apiKeys.values()].find((apiKey) => apiKey.tenantId === tenantId && apiKey.keyPrefix === keyPrefix) ?? null
    );
  }

  async listApiKeys(tenantId: string): Promise<AutomationApiKey[]> {
    return [...this.apiKeys.values()].filter((apiKey) => apiKey.tenantId === tenantId);
  }

  async revokeApiKey(tenantId: string, apiKeyId: string): Promise<void> {
    const apiKey = this.apiKeys.get(apiKeyId);
    if (apiKey?.tenantId === tenantId) {
      this.apiKeys.set(apiKey.id, { ...apiKey, revokedAt: new Date() });
    }
  }
}

export function permissionsForRoles(userRoles: readonly RoleCode[]) {
  return [...new Set(userRoles.flatMap((role) => rolePermissions[role]))];
}
