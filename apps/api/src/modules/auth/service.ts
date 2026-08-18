import { randomBytes, randomUUID } from "node:crypto";
import { rolePermissions, type PermissionCode } from "@spendlens/shared";
import type { AuditRepository, SeedAuditLogInput } from "../audit/types";
import { createSignedToken, hashOpaqueToken, hashPassword, verifyPassword, verifySignedToken } from "./crypto";
import type { AuthPrincipal, AuthRepository, AuthSession, AuthTokens } from "./types";

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export type AuthServiceOptions = {
  repository: AuthRepository;
  accessTokenSecret: string;
  refreshTokenSecret: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  auditRepository?: AuditRepository;
};

export class AuthService {
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;

  constructor(private readonly options: AuthServiceOptions) {
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 15 * 60;
    this.refreshTokenTtlSeconds = options.refreshTokenTtlSeconds ?? 30 * 24 * 60 * 60;
  }

  async register(input: {
    tenantName: string;
    tenantSlug: string;
    workspaceName: string;
    email: string;
    displayName: string;
    password: string;
    userAgent: string | null;
    ipHash: string | null;
    correlationId?: string | null;
  }) {
    const slug = normalizeSlug(input.tenantSlug);
    if (await this.options.repository.findTenantBySlug(slug)) {
      throw new AuthError("TENANT_SLUG_TAKEN", 409);
    }

    const passwordHash = await hashPassword(input.password);
    const created = await this.options.repository.createTenantWithOwner({
      tenantName: input.tenantName.trim(),
      tenantSlug: slug,
      workspaceName: input.workspaceName.trim(),
      email: normalizeEmail(input.email),
      displayName: input.displayName.trim(),
      passwordHash
    });
    const roles = await this.options.repository.getUserRoles(created.tenant.id, created.user.id);
    const tokens = await this.issueSessionTokens({
      tenantId: created.tenant.id,
      userId: created.user.id,
      email: created.user.email,
      displayName: created.user.displayName,
      roles,
      userAgent: input.userAgent,
      ipHash: input.ipHash
    });
    await this.writeAuditLog({
      tenantId: created.tenant.id,
      actorUserId: created.user.id,
      action: "auth.register",
      resourceType: "User",
      resourceId: created.user.id,
      metadata: { tenantSlug: slug },
      correlationId: input.correlationId ?? null
    });
    await this.writeAuditLog({
      tenantId: created.tenant.id,
      actorUserId: created.user.id,
      action: "tenant.created",
      resourceType: "Tenant",
      resourceId: created.tenant.id,
      metadata: {
        tenantSlug: slug,
        ownerUserId: created.user.id,
        initialWorkspaceId: created.workspace.id
      },
      correlationId: input.correlationId ?? null
    });
    await this.writeAuditLog({
      tenantId: created.tenant.id,
      actorUserId: created.user.id,
      action: "workspace.created",
      resourceType: "Workspace",
      resourceId: created.workspace.id,
      metadata: {
        tenantSlug: slug,
        workspaceKind: created.workspace.kind,
        ownerUserId: created.user.id,
        source: "auth.register"
      },
      correlationId: input.correlationId ?? null
    });
    return { ...created, roles, permissions: permissionsForRoles(roles), tokens };
  }

  async login(input: {
    tenantSlug: string;
    email: string;
    password: string;
    userAgent: string | null;
    ipHash: string | null;
    correlationId?: string | null;
  }) {
    const tenant = await this.options.repository.findTenantBySlug(normalizeSlug(input.tenantSlug));
    if (!tenant) throw new AuthError("INVALID_CREDENTIALS", 401);
    const user = await this.options.repository.findUserByEmail(tenant.id, normalizeEmail(input.email));
    if (!user || user.disabledAt || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new AuthError("INVALID_CREDENTIALS", 401);
    }
    const roles = await this.options.repository.getUserRoles(tenant.id, user.id);
    const tokens = await this.issueSessionTokens({
      tenantId: tenant.id,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      roles,
      userAgent: input.userAgent,
      ipHash: input.ipHash
    });
    const refreshPayload = verifySignedToken<Record<string, unknown>>(tokens.refreshToken, this.options.refreshTokenSecret);
    const sessionId = decodeRefreshPayload(refreshPayload).sessionId;
    await this.writeAuditLog({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: "auth.login",
      resourceType: "Session",
      resourceId: sessionId,
      correlationId: input.correlationId ?? null
    });
    return { tenant, user, roles, permissions: permissionsForRoles(roles), tokens };
  }

  async refresh(refreshToken: string, options: { correlationId?: string | null } = {}): Promise<AuthTokens> {
    const payload = decodeRefreshPayload(this.verifyRefreshToken(refreshToken));
    const nextSessionId = randomUUID();
    const nextRefreshToken = this.createRefreshToken({
      tenantId: payload.tenantId,
      userId: payload.userId,
      sessionId: nextSessionId
    });
    const session = await this.rotateRefreshSession({
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
      expectedRefreshTokenHash: hashOpaqueToken(refreshToken),
      nextSessionId,
      nextRefreshTokenHash: hashOpaqueToken(nextRefreshToken),
      nextExpiresAt: new Date(Date.now() + this.refreshTokenTtlSeconds * 1000)
    });
    const user = await this.options.repository.findUserById(payload.tenantId, payload.userId);
    if (!user || user.disabledAt) throw new AuthError("INVALID_REFRESH_SESSION", 401);
    const roles = await this.options.repository.getUserRoles(payload.tenantId, payload.userId);
    await this.writeAuditLog({
      tenantId: payload.tenantId,
      actorUserId: payload.userId,
      action: "auth.refresh_rotated",
      resourceType: "Session",
      resourceId: session.id,
      metadata: {
        previousSessionId: payload.sessionId,
        rotated: true
      },
      correlationId: options.correlationId ?? null
    });
    return this.issueTokensForExistingSession(session, nextRefreshToken, {
      tenantId: payload.tenantId,
      userId: user.id,
      sessionId: session.id,
      email: user.email,
      displayName: user.displayName,
      roles
    });
  }

  async logout(refreshToken: string, options: { correlationId?: string | null } = {}): Promise<void> {
    const payload = decodeRefreshPayload(this.verifyRefreshToken(refreshToken));
    await this.options.repository.revokeSession(payload.tenantId, payload.sessionId);
    await this.writeAuditLog({
      tenantId: payload.tenantId,
      actorUserId: payload.userId,
      action: "auth.logout",
      resourceType: "Session",
      resourceId: payload.sessionId,
      correlationId: options.correlationId ?? null
    });
  }

  async logoutAll(principal: AuthPrincipal, options: { correlationId?: string | null } = {}): Promise<void> {
    await this.options.repository.revokeAllUserSessions(principal.tenantId, principal.userId);
    await this.writeAuditLog({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action: "auth.logout_all",
      resourceType: "User",
      resourceId: principal.userId,
      correlationId: options.correlationId ?? null
    });
  }

  async authenticateAccessToken(accessToken: string): Promise<AuthPrincipal> {
    const payload = this.verifyAccessToken(accessToken);
    if (payload.typ !== "access") throw new AuthError("INVALID_TOKEN", 401);
    const session = await this.options.repository.findSession(payload.tenantId, payload.sessionId);
    if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
      throw new AuthError("SESSION_REVOKED", 401);
    }
    return {
      tenantId: payload.tenantId,
      userId: payload.sub,
      sessionId: payload.sessionId,
      email: payload.email,
      displayName: payload.displayName,
      roles: payload.roles as AuthPrincipal["roles"],
      permissions: payload.permissions as AuthPrincipal["permissions"]
    };
  }

  private verifyAccessToken(accessToken: string): {
      typ: string;
      sub: string;
      tenantId: string;
      sessionId: string;
      email: string;
      displayName: string;
      roles: string[];
      permissions: string[];
    } {
    try {
      return verifySignedToken(accessToken, this.options.accessTokenSecret);
    } catch {
      throw new AuthError("INVALID_TOKEN", 401);
    }
  }

  private verifyRefreshToken(refreshToken: string): Record<string, unknown> {
    try {
      return verifySignedToken(refreshToken, this.options.refreshTokenSecret);
    } catch {
      throw new AuthError("INVALID_REFRESH_TOKEN", 401);
    }
  }

  async listSessions(principal: AuthPrincipal, options: { page?: number; limit?: number; correlationId?: string | null } = {}) {
    const sessions = await this.options.repository.listUserSessions(principal.tenantId, principal.userId);
    const now = Date.now();
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const summary = {
      active: sessions.filter((session) => !session.revokedAt && session.expiresAt.getTime() >= now).length,
      revoked: sessions.filter((session) => Boolean(session.revokedAt)).length,
      expired: sessions.filter((session) => !session.revokedAt && session.expiresAt.getTime() < now).length
    };
    await this.writeAuditLog({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action: "auth.sessions_listed",
      resourceType: "User",
      resourceId: principal.userId,
      metadata: {
        sessionCount: sessions.length,
        activeSessionCount: summary.active,
        revokedSessionCount: summary.revoked,
        expiredSessionCount: summary.expired,
        currentSessionIncluded: sessions.some((session) => session.id === principal.sessionId)
      },
      correlationId: options.correlationId ?? null
    });
    const ordered = [...sessions].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return {
      sessions: ordered.slice((page - 1) * limit, page * limit).map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        revokedAt: session.revokedAt?.toISOString() ?? null,
        userAgent: session.userAgent
      })),
      pagination: {
        page,
        limit,
        total: sessions.length,
        pageCount: Math.max(1, Math.ceil(sessions.length / limit))
      },
      summary
    };
  }

  requirePermission(principal: AuthPrincipal, permission: PermissionCode): void {
    if (!principal.permissions.includes(permission)) {
      throw new AuthError("PERMISSION_DENIED", 403);
    }
  }

  private async issueSessionTokens(input: {
    tenantId: string;
    userId: string;
    email: string;
    displayName: string;
    roles: AuthPrincipal["roles"];
    userAgent: string | null;
    ipHash: string | null;
  }): Promise<AuthTokens> {
    const sessionId = randomUUID();
    const refreshToken = this.createRefreshToken({
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId
    });
    const session = await this.options.repository.createSession({
      id: sessionId,
      tenantId: input.tenantId,
      userId: input.userId,
      refreshTokenHash: hashOpaqueToken(refreshToken),
      userAgent: input.userAgent,
      ipHash: input.ipHash,
      expiresAt: new Date(Date.now() + this.refreshTokenTtlSeconds * 1000)
    });
    return this.issueTokensForExistingSession(session, refreshToken, {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: session.id,
      email: input.email,
      displayName: input.displayName,
      roles: input.roles
    });
  }

  private async rotateRefreshSession(input: {
    tenantId: string;
    sessionId: string;
    expectedRefreshTokenHash: string;
    nextSessionId: string;
    nextRefreshTokenHash: string;
    nextExpiresAt: Date;
  }): Promise<AuthSession> {
    try {
      return await this.options.repository.rotateSession(input);
    } catch {
      throw new AuthError("INVALID_REFRESH_SESSION", 401);
    }
  }

  private issueTokensForExistingSession(
    session: AuthSession,
    refreshToken: string,
    principal: Omit<AuthPrincipal, "permissions">
  ): AuthTokens {
    const permissions = permissionsForRoles(principal.roles);
    const accessToken = createSignedToken(
      {
        typ: "access",
        sub: principal.userId,
        tenantId: principal.tenantId,
        sessionId: principal.sessionId,
        email: principal.email,
        displayName: principal.displayName,
        roles: principal.roles,
        permissions
      },
      this.options.accessTokenSecret,
      this.accessTokenTtlSeconds
    );
    return { accessToken, refreshToken, expiresInSeconds: this.accessTokenTtlSeconds };
  }

  private createRefreshToken(payload: { tenantId: string; userId: string; sessionId: string }): string {
    return createSignedToken(
      {
        typ: "refresh",
        jti: randomUUID(),
        nonce: randomBytes(16).toString("base64url"),
        tenantId: payload.tenantId,
        userId: payload.userId,
        sessionId: payload.sessionId
      },
      this.options.refreshTokenSecret,
      this.refreshTokenTtlSeconds
    );
  }

  private async writeAuditLog(input: SeedAuditLogInput): Promise<void> {
    await this.options.auditRepository?.create(input);
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function permissionsForRoles(roles: readonly AuthPrincipal["roles"][number][]) {
  return [...new Set(roles.flatMap((role) => rolePermissions[role]))];
}

function decodeRefreshPayload(payload: Record<string, unknown>) {
  if (
    payload.typ !== "refresh" ||
    typeof payload.tenantId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.sessionId !== "string"
  ) {
    throw new AuthError("INVALID_REFRESH_TOKEN", 401);
  }
  return { tenantId: payload.tenantId, userId: payload.userId, sessionId: payload.sessionId };
}
