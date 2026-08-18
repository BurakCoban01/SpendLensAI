import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuditRepository } from "../audit/memory-repository";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import type { AuthPrincipal } from "../auth/types";
import { InMemoryWebhookRepository } from "./memory-repository";
import { WebhookService } from "./service";

describe("webhook routes and audit evidence", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let tenantId: string;
  let userId: string;
  let auditRepository: InMemoryAuditRepository;
  let webhookRepository: InMemoryWebhookRepository;

  beforeAll(async () => {
    auditRepository = new InMemoryAuditRepository();
    webhookRepository = new InMemoryWebhookRepository();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      auditRepository,
      webhookRepository
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Webhook Tenant",
        tenantSlug: "webhooks",
        workspaceName: "Automation",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    const body = register.json();
    accessToken = body.tokens.accessToken;
    tenantId = body.tenant.id;
    userId = body.user.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates and disables webhook endpoints with tenant-scoped audit evidence", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        url: "https://example.test/spendlens-webhook",
        eventTypes: ["expense.created", "report.generated"]
      }
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.endpoint.enabled).toBe(true);
    const storedEndpoint = await webhookRepository.findEndpoint({ tenantId, id: body.endpoint.id });
    expect(storedEndpoint?.secretHash).toBeDefined();
    expect(storedEndpoint?.secretCiphertext).toMatch(/^v1:/);
    expect(storedEndpoint?.secretCiphertext).not.toContain(body.secret);

    const creationAudit = await auditRepository.list({
      tenantId,
      action: "webhook.endpoint.created",
      resourceType: "WebhookEndpoint",
      limit: 10
    });
    expect(creationAudit).toHaveLength(1);
    expect(creationAudit[0]).toMatchObject({
      actorUserId: userId,
      resourceId: body.endpoint.id
    });
    expect(creationAudit[0]?.metadata).toMatchObject({
      endpointId: body.endpoint.id,
      url: "https://example.test/spendlens-webhook",
      eventTypes: ["expense.created", "report.generated"],
      enabled: true
    });
    expect(JSON.stringify(creationAudit[0]?.metadata)).not.toContain("whsec_");

    const disabled = await app.inject({
      method: "DELETE",
      url: `/webhooks/${body.endpoint.id}`,
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().endpoint.enabled).toBe(false);

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?resourceType=WebhookEndpoint",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs.map((log: { action: string }) => log.action)).toEqual(
      expect.arrayContaining(["webhook.endpoint.created", "webhook.endpoint.disabled"])
    );
  });

  it("records webhook delivery attempts without storing endpoint secrets", async () => {
    const deliveredInputs: Array<{
      body: string;
      deliveryId: string;
      headers: Record<string, string>;
      signatureStatus: string;
    }> = [];
    const deliveryService = new WebhookService(
      webhookRepository,
      async (input) => {
        deliveredInputs.push({
          body: input.body,
          deliveryId: input.deliveryId,
          headers: input.headers,
          signatureStatus: input.signatureStatus
        });
        return { ok: true, statusCode: 202, responseBody: "accepted" };
      },
      undefined,
      auditRepository
    );
    const principal: AuthPrincipal = {
      tenantId,
      userId,
      sessionId: "corr-webhook-test",
      email: "owner@example.com",
      displayName: "Owner",
      roles: ["OWNER"],
      permissions: ["webhooks.manage"]
    };
    const { endpoint, secret } = await deliveryService.createEndpoint({
      principal,
      url: "https://example.test/delivery",
      eventTypes: ["expense.created"]
    });

    const result = await deliveryService.deliver({
      principal,
      endpointId: endpoint.id,
      eventType: "expense.created",
      payload: { expenseId: "expense_1" },
      correlationId: "corr-delivery-1"
    });

    expect(result.deliveredCount).toBe(1);
    const [delivery] = result.deliveries;
    expect(delivery).toBeDefined();
    expect(delivery!.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(deliveredInputs[0]?.deliveryId).toBe(delivery!.deliveryId);
    expect(deliveredInputs[0]?.signatureStatus).toBe("signed_hmac_sha256");
    expect(deliveredInputs[0]?.headers["x-spendlens-signature-status"]).toBe("signed_hmac_sha256");
    expect(deliveredInputs[0]?.headers["x-spendlens-signature-algorithm"]).toBe("hmac-sha256");
    const signedPayload = `${deliveredInputs[0]?.headers["x-spendlens-timestamp"]}.${delivery!.deliveryId}.${deliveredInputs[0]?.body}`;
    const expectedSignature = `v1=${createHmac("sha256", secret).update(signedPayload).digest("hex")}`;
    expect(deliveredInputs[0]?.headers["x-spendlens-signature"]).toBe(expectedSignature);
    const deliveries = await auditRepository.list({
      tenantId,
      action: "webhook.delivery.attempted",
      resourceType: "WebhookEndpoint",
      limit: 10
    });
    expect(deliveries[0]).toMatchObject({
      actorUserId: userId,
      resourceId: endpoint.id,
      correlationId: "corr-delivery-1"
    });
    expect(deliveries[0]?.metadata).toMatchObject({
      endpointId: endpoint.id,
      eventType: "expense.created",
      ok: true,
      statusCode: 202,
      deliveryId: delivery!.deliveryId,
      signatureStatus: "signed_hmac_sha256",
      correlationId: "corr-delivery-1"
    });
    expect(JSON.stringify(deliveries[0]?.metadata)).not.toContain("secretHash");
    expect(JSON.stringify(deliveries[0]?.metadata)).not.toContain(secret);
  });

  it("labels legacy endpoints without encrypted signing material as unsigned instead of pretending they are signed", async () => {
    const legacyEndpoint = await webhookRepository.createEndpoint({
      tenantId,
      url: "https://example.test/legacy",
      eventTypes: ["expense.created"],
      secretHash: "legacy_hash_without_plain_secret"
    });
    const deliveredInputs: Array<{ headers: Record<string, string>; signatureStatus: string }> = [];
    const deliveryService = new WebhookService(
      webhookRepository,
      async (input) => {
        deliveredInputs.push({ headers: input.headers, signatureStatus: input.signatureStatus });
        return { ok: true, statusCode: 200, responseBody: "ok" };
      },
      undefined,
      auditRepository
    );
    const principal: AuthPrincipal = {
      tenantId,
      userId,
      sessionId: "corr-webhook-legacy",
      email: "owner@example.com",
      displayName: "Owner",
      roles: ["OWNER"],
      permissions: ["webhooks.manage"]
    };

    await deliveryService.deliver({
      principal,
      endpointId: legacyEndpoint.id,
      eventType: "expense.created",
      payload: { expenseId: "expense_legacy" },
      correlationId: "corr-delivery-legacy"
    });

    expect(deliveredInputs[0]?.signatureStatus).toBe("unsigned_legacy_secret_hash_only");
    expect(deliveredInputs[0]?.headers["x-spendlens-signature-status"]).toBe("unsigned_legacy_secret_hash_only");
    expect(deliveredInputs[0]?.headers["x-spendlens-signature"]).toBeUndefined();
    const deliveries = await auditRepository.list({
      tenantId,
      action: "webhook.delivery.attempted",
      resourceType: "WebhookEndpoint",
      limit: 10
    });
    expect(deliveries[0]?.metadata).toMatchObject({
      endpointId: legacyEndpoint.id,
      signatureStatus: "unsigned_legacy_secret_hash_only"
    });
  });
});
