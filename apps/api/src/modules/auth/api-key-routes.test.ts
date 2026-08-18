import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuthRepository } from "./memory-repository";

describe("api key routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let tenantId: string;

  beforeAll(async () => {
    app = await buildApp({ authRepository: new InMemoryAuthRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Automation Tenant",
        tenantSlug: "automation",
        workspaceName: "Ops",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    const body = registered.json();
    accessToken = body.tokens.accessToken;
    tenantId = body.tenant.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates scoped API keys, never lists raw key values, and authenticates automation requests", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-api-key-create" },
      payload: {
        name: "OCR automation",
        scopes: ["documents.read", "documents.upload"]
      }
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.rawKey).toMatch(/^sla_/);
    expect(body.apiKey.keyHash).toBeUndefined();

    const listed = await app.inject({
      method: "GET",
      url: "/api-keys",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-api-key-list" }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().apiKeys[0].keyHash).toBeUndefined();
    expect(listed.json().apiKeys[0].keyPrefix).toBe(body.apiKey.keyPrefix);

    const automation = await app.inject({
      method: "GET",
      url: "/api-keys/automation-check",
      headers: {
        authorization: `ApiKey ${body.rawKey}`,
        "x-tenant-id": tenantId
      }
    });
    expect(automation.statusCode).toBe(200);
    expect(automation.json().principal.permissions).toContain("documents.read");

    const audit = await app.inject({
      method: "GET",
      url: `/admin/audit?action=api_key.create&resourceType=APIKey&limit=10`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const createLog = audit.json().logs.find((log: { resourceId: string }) => log.resourceId === body.apiKey.id);
    expect(createLog).toMatchObject({
      action: "api_key.create",
      resourceType: "APIKey",
      resourceId: body.apiKey.id,
      correlationId: "corr-api-key-create",
      metadata: {
        scopeCount: 2,
        expiresAtPresent: false,
        keyPrefixPresent: true
      }
    });
    const serializedAudit = JSON.stringify(createLog);
    expect(serializedAudit).not.toContain(body.rawKey);
    expect(serializedAudit).not.toContain(body.rawKey.split(".")[1]);
    expect(serializedAudit).not.toContain(body.apiKey.keyPrefix);
    expect(serializedAudit).not.toContain("OCR automation");
    expect(serializedAudit).not.toContain("documents.upload");
    expect(serializedAudit).not.toContain("keyHash");

    const listAudit = await app.inject({
      method: "GET",
      url: `/admin/audit?action=api_key.list&resourceType=APIKeyInventory&limit=10`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(listAudit.statusCode).toBe(200);
    expect(listAudit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId,
          action: "api_key.list",
          resourceType: "APIKeyInventory",
          resourceId: null,
          correlationId: "corr-api-key-list",
          metadata: expect.objectContaining({
            apiKeyCount: expect.any(Number),
            activeApiKeyCount: expect.any(Number),
            revokedApiKeyCount: expect.any(Number),
            expiredApiKeyCount: expect.any(Number)
          })
        })
      ])
    );
    const serializedListAudit = JSON.stringify(listAudit.json().logs);
    expect(serializedListAudit).not.toContain(body.rawKey);
    expect(serializedListAudit).not.toContain(body.rawKey.split(".")[1]);
    expect(serializedListAudit).not.toContain(body.apiKey.keyPrefix);
    expect(serializedListAudit).not.toContain("OCR automation");
    expect(serializedListAudit).not.toContain("keyHash");
  });

  it("revokes API keys", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: "Temporary automation",
        scopes: ["documents.read"]
      }
    });
    const body = created.json();
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api-keys/${body.apiKey.id}`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-api-key-revoke" }
    });
    expect(revoked.statusCode).toBe(204);

    const automation = await app.inject({
      method: "GET",
      url: "/api-keys/automation-check",
      headers: {
        authorization: `ApiKey ${body.rawKey}`,
        "x-tenant-id": tenantId
      }
    });
    expect(automation.statusCode).toBe(401);

    const audit = await app.inject({
      method: "GET",
      url: `/admin/audit?action=api_key.revoke&resourceType=APIKey&limit=10`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "api_key.revoke",
          resourceType: "APIKey",
          resourceId: body.apiKey.id,
          correlationId: "corr-api-key-revoke"
        })
      ])
    );
    expect(JSON.stringify(audit.json().logs)).not.toContain(body.rawKey);
    expect(JSON.stringify(audit.json().logs)).not.toContain("Temporary automation");
  });
});
