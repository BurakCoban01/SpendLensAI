import { PrismaClient } from "@prisma/client";
import { permissions, rolePermissions, roles, type RoleCode } from "@spendlens/shared";
import type { AuthRepository, AuthSession, AuthTenant, AuthUser, AuthWorkspace, AutomationApiKey } from "./types";

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findTenantBySlug(slug: string): Promise<AuthTenant | null> {
    return this.prisma.tenant.findUnique({ where: { slug }, select: { id: true, name: true, slug: true } });
  }

  async findUserByEmail(tenantId: string, email: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: email.toLowerCase() } },
      select: { id: true, tenantId: true, email: true, displayName: true, passwordHash: true, disabledAt: true }
    });
  }

  async findUserById(tenantId: string, userId: string): Promise<AuthUser | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, tenantId: true, email: true, displayName: true, passwordHash: true, disabledAt: true }
    });
  }

  async listUsersWithRoles(tenantId: string) {
    const users = await this.prisma.user.findMany({
      where: { tenantId },
      select: { id: true, tenantId: true, email: true, displayName: true, passwordHash: true, disabledAt: true },
      orderBy: [{ displayName: "asc" }, { email: "asc" }]
    });
    if (users.length === 0) return [];
    const userRoles = await this.prisma.userRole.findMany({
      where: { tenantId, userId: { in: users.map((user) => user.id) } },
      select: { userId: true, roleId: true }
    });
    const roleRows = await this.prisma.role.findMany({
      where: { tenantId, id: { in: [...new Set(userRoles.map((row) => row.roleId))] } },
      select: { id: true, code: true }
    });
    const roleCodeById = new Map(roleRows.map((role) => [role.id, role.code as RoleCode]));
    const rolesByUserId = new Map<string, RoleCode[]>();
    for (const row of userRoles) {
      const role = roleCodeById.get(row.roleId);
      if (!role) continue;
      rolesByUserId.set(row.userId, [...(rolesByUserId.get(row.userId) ?? []), role]);
    }
    return users.map((user) => ({ ...user, roles: rolesByUserId.get(user.id) ?? [] }));
  }

  async createTenantWithOwner(input: {
    tenantName: string;
    tenantSlug: string;
    workspaceName: string;
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<{ tenant: AuthTenant; workspace: AuthWorkspace; user: AuthUser }> {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: input.tenantName, slug: input.tenantSlug },
        select: { id: true, name: true, slug: true }
      });
      const workspace = await tx.workspace.create({
        data: { tenantId: tenant.id, name: input.workspaceName, kind: "BUSINESS" },
        select: { id: true, tenantId: true, name: true, kind: true }
      });
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: input.email.toLowerCase(),
          displayName: input.displayName,
          passwordHash: input.passwordHash
        },
        select: { id: true, tenantId: true, email: true, displayName: true, passwordHash: true, disabledAt: true }
      });

      await tx.permission.createMany({
        data: permissions.map((code) => ({ code, description: code })),
        skipDuplicates: true
      });

      const createdRoles = new Map<RoleCode, string>();
      for (const role of roles) {
        const created = await tx.role.create({
          data: { tenantId: tenant.id, code: role, name: humanizeRole(role) },
          select: { id: true, code: true }
        });
        createdRoles.set(created.code as RoleCode, created.id);
      }

      const permissionRows = await tx.permission.findMany({
        where: { code: { in: [...permissions] } },
        select: { id: true, code: true }
      });
      const permissionIdByCode = new Map(permissionRows.map((permission) => [permission.code, permission.id]));
      for (const role of roles) {
        const roleId = createdRoles.get(role);
        if (!roleId) continue;
        await tx.rolePermission.createMany({
          data: rolePermissions[role]
            .map((permission) => permissionIdByCode.get(permission))
            .filter((permissionId): permissionId is string => Boolean(permissionId))
            .map((permissionId) => ({ tenantId: tenant.id, roleId, permissionId })),
          skipDuplicates: true
        });
      }

      const ownerRoleId = createdRoles.get("OWNER");
      if (!ownerRoleId) throw new Error("OWNER_ROLE_NOT_CREATED");
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: ownerRoleId } });

      return { tenant, workspace, user };
    });
  }

  async getUserRoles(tenantId: string, userId: string): Promise<RoleCode[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { tenantId, userId },
      select: { roleId: true }
    });
    if (rows.length === 0) return [];
    const roleRows = await this.prisma.role.findMany({
      where: { tenantId, id: { in: rows.map((row) => row.roleId) } },
      select: { code: true }
    });
    return roleRows.map((role) => role.code as RoleCode);
  }

  async listWorkspaces(tenantId: string): Promise<AuthWorkspace[]> {
    return this.prisma.workspace.findMany({
      where: { tenantId, archivedAt: null },
      select: { id: true, tenantId: true, name: true, kind: true },
      orderBy: { createdAt: "asc" }
    });
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
    return this.prisma.session.create({ data: input });
  }

  async findSession(tenantId: string, sessionId: string): Promise<AuthSession | null> {
    return this.prisma.session.findFirst({ where: { id: sessionId, tenantId } });
  }

  async rotateSession(input: {
    tenantId: string;
    sessionId: string;
    expectedRefreshTokenHash: string;
    nextSessionId: string;
    nextRefreshTokenHash: string;
    nextExpiresAt: Date;
  }): Promise<AuthSession> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.session.findFirst({ where: { id: input.sessionId, tenantId: input.tenantId } });
      if (!current || current.revokedAt || current.refreshTokenHash !== input.expectedRefreshTokenHash) {
        throw new Error("INVALID_REFRESH_SESSION");
      }
      await tx.session.update({ where: { id: current.id }, data: { revokedAt: new Date() } });
      return tx.session.create({
        data: {
          tenantId: current.tenantId,
          id: input.nextSessionId,
          userId: current.userId,
          refreshTokenHash: input.nextRefreshTokenHash,
          userAgent: current.userAgent,
          ipHash: current.ipHash,
          expiresAt: input.nextExpiresAt,
          rotatedFromId: current.id
        }
      });
    });
  }

  async revokeSession(tenantId: string, sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { tenantId, id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async revokeAllUserSessions(tenantId: string, userId: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { tenantId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async listUserSessions(tenantId: string, userId: string): Promise<AuthSession[]> {
    return this.prisma.session.findMany({ where: { tenantId, userId }, orderBy: { createdAt: "desc" } });
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
    return this.prisma.aPIKey.create({ data: input });
  }

  async findApiKeyByPrefix(tenantId: string, keyPrefix: string): Promise<AutomationApiKey | null> {
    return this.prisma.aPIKey.findUnique({ where: { tenantId_keyPrefix: { tenantId, keyPrefix } } });
  }

  async listApiKeys(tenantId: string): Promise<AutomationApiKey[]> {
    return this.prisma.aPIKey.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
  }

  async revokeApiKey(tenantId: string, apiKeyId: string): Promise<void> {
    await this.prisma.aPIKey.updateMany({ where: { tenantId, id: apiKeyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}

function humanizeRole(role: string): string {
  return role
    .toLowerCase()
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
