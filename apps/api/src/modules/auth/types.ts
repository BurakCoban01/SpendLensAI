import type { PermissionCode, RoleCode } from "@spendlens/shared";

export type AuthTenant = {
  id: string;
  name: string;
  slug: string;
};

export type AuthWorkspace = {
  id: string;
  tenantId: string;
  name: string;
  kind: string;
};

export type AuthUser = {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  passwordHash: string;
  disabledAt: Date | null;
};

export type AuthUserWithRoles = AuthUser & {
  roles: RoleCode[];
};

export type AuthSession = {
  id: string;
  tenantId: string;
  userId: string;
  refreshTokenHash: string;
  userAgent: string | null;
  ipHash: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedFromId: string | null;
};

export type AutomationApiKey = {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  createdById: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export type AuthPrincipal = {
  tenantId: string;
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  roles: RoleCode[];
  permissions: PermissionCode[];
};

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
};

export type AuthRepository = {
  findTenantBySlug(slug: string): Promise<AuthTenant | null>;
  findUserByEmail(tenantId: string, email: string): Promise<AuthUser | null>;
  findUserById(tenantId: string, userId: string): Promise<AuthUser | null>;
  listUsersWithRoles(tenantId: string): Promise<AuthUserWithRoles[]>;
  createTenantWithOwner(input: {
    tenantName: string;
    tenantSlug: string;
    workspaceName: string;
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<{ tenant: AuthTenant; workspace: AuthWorkspace; user: AuthUser }>;
  listWorkspaces(tenantId: string): Promise<AuthWorkspace[]>;
  getUserRoles(tenantId: string, userId: string): Promise<RoleCode[]>;
  createSession(input: {
    id: string;
    tenantId: string;
    userId: string;
    refreshTokenHash: string;
    userAgent: string | null;
    ipHash: string | null;
    expiresAt: Date;
  }): Promise<AuthSession>;
  findSession(tenantId: string, sessionId: string): Promise<AuthSession | null>;
  rotateSession(input: {
    tenantId: string;
    sessionId: string;
    expectedRefreshTokenHash: string;
    nextSessionId: string;
    nextRefreshTokenHash: string;
    nextExpiresAt: Date;
  }): Promise<AuthSession>;
  revokeSession(tenantId: string, sessionId: string): Promise<void>;
  revokeAllUserSessions(tenantId: string, userId: string): Promise<void>;
  listUserSessions(tenantId: string, userId: string): Promise<AuthSession[]>;
  createApiKey(input: {
    tenantId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    createdById: string;
    expiresAt: Date | null;
  }): Promise<AutomationApiKey>;
  findApiKeyByPrefix(tenantId: string, keyPrefix: string): Promise<AutomationApiKey | null>;
  listApiKeys(tenantId: string): Promise<AutomationApiKey[]>;
  revokeApiKey(tenantId: string, apiKeyId: string): Promise<void>;
};
