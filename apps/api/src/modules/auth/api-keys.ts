import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { permissions, type PermissionCode } from "@spendlens/shared";
import type { AuditRepository, SeedAuditLogInput } from "../audit/types";
import { AuthError } from "./service";
import type { AuthPrincipal, AuthRepository } from "./types";

export class ApiKeyService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly pepper: string,
    private readonly audit?: AuditRepository
  ) {}

  async createApiKey(input: {
    principal: AuthPrincipal;
    name: string;
    scopes: PermissionCode[];
    expiresAt: Date | null;
    correlationId?: string | null;
  }) {
    const prefix = `sla_${randomBytes(6).toString("base64url")}`;
    const secret = randomBytes(32).toString("base64url");
    const rawKey = `${prefix}.${secret}`;
    const apiKey = await this.repository.createApiKey({
      tenantId: input.principal.tenantId,
      name: input.name,
      keyPrefix: prefix,
      keyHash: this.hashApiKey(rawKey),
      scopes: input.scopes,
      createdById: input.principal.userId,
      expiresAt: input.expiresAt
    });
    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "api_key.create",
      resourceType: "APIKey",
      resourceId: apiKey.id,
      metadata: {
        scopeCount: input.scopes.length,
        expiresAtPresent: Boolean(input.expiresAt),
        keyPrefixPresent: true
      },
      correlationId: input.correlationId ?? null
    });
    return {
      apiKey: sanitizeApiKey(apiKey),
      rawKey
    };
  }

  async listApiKeys(principal: AuthPrincipal, options: { correlationId?: string | null } = {}) {
    const apiKeys = await this.repository.listApiKeys(principal.tenantId);
    const now = Date.now();
    await this.writeAudit({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action: "api_key.list",
      resourceType: "APIKeyInventory",
      resourceId: null,
      metadata: {
        apiKeyCount: apiKeys.length,
        activeApiKeyCount: apiKeys.filter((apiKey) => !apiKey.revokedAt && (!apiKey.expiresAt || apiKey.expiresAt.getTime() >= now))
          .length,
        revokedApiKeyCount: apiKeys.filter((apiKey) => Boolean(apiKey.revokedAt)).length,
        expiredApiKeyCount: apiKeys.filter((apiKey) => !apiKey.revokedAt && apiKey.expiresAt && apiKey.expiresAt.getTime() < now)
          .length
      },
      correlationId: options.correlationId ?? null
    });
    return apiKeys.map(sanitizeApiKey);
  }

  async revokeApiKey(principal: AuthPrincipal, apiKeyId: string, options: { correlationId?: string | null } = {}): Promise<void> {
    await this.repository.revokeApiKey(principal.tenantId, apiKeyId);
    await this.writeAudit({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action: "api_key.revoke",
      resourceType: "APIKey",
      resourceId: apiKeyId,
      correlationId: options.correlationId ?? null
    });
  }

  async authenticate(rawKey: string, tenantId: string): Promise<AuthPrincipal> {
    const [prefix] = rawKey.split(".");
    if (!prefix) throw new AuthError("INVALID_API_KEY", 401);
    const apiKey = await this.repository.findApiKeyByPrefix(tenantId, prefix);
    if (!apiKey || apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now())) {
      throw new AuthError("INVALID_API_KEY", 401);
    }
    const expected = Buffer.from(apiKey.keyHash);
    const actual = Buffer.from(this.hashApiKey(rawKey));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new AuthError("INVALID_API_KEY", 401);
    }
    const user = await this.repository.findUserById(apiKey.tenantId, apiKey.createdById);
    if (!user || user.disabledAt) throw new AuthError("INVALID_API_KEY", 401);
    const scopedPermissions = apiKey.scopes.filter((scope): scope is PermissionCode =>
      permissions.includes(scope as PermissionCode)
    );
    return {
      tenantId: apiKey.tenantId,
      userId: user.id,
      sessionId: `api-key:${apiKey.id}`,
      email: user.email,
      displayName: user.displayName,
      roles: [],
      permissions: scopedPermissions
    };
  }

  private hashApiKey(rawKey: string): string {
    return createHash("sha256").update(`${this.pepper}:${rawKey}`).digest("base64url");
  }

  private async writeAudit(input: SeedAuditLogInput): Promise<void> {
    await this.audit?.create(input);
  }
}

function sanitizeApiKey(apiKey: {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    scopes: apiKey.scopes,
    createdAt: apiKey.createdAt.toISOString(),
    expiresAt: apiKey.expiresAt?.toISOString() ?? null,
    revokedAt: apiKey.revokedAt?.toISOString() ?? null
  };
}
