import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { assertKafkaTopic } from "@spendlens/shared";
import type { AuditRepository } from "../audit/types";
import { hashOpaqueToken } from "../auth/crypto";
import type { AuthPrincipal } from "../auth/types";
import type { EventService } from "../events/service";
import type { StoredWebhookEndpoint, WebhookDeliveryClient, WebhookRepository, WebhookSignatureStatus } from "./types";

export class WebhookError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class WebhookService {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly deliveryClient: WebhookDeliveryClient = defaultWebhookDeliveryClient,
    private readonly events?: EventService,
    private readonly audit?: AuditRepository,
    private readonly secretEncryptionKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ??
      "development_webhook_secret_key_change_me"
  ) {}

  async createEndpoint(input: { principal: AuthPrincipal; url: string; eventTypes: string[] }) {
    const url = normalizeWebhookUrl(input.url);
    const eventTypes = [...new Set(input.eventTypes.map((eventType) => assertKafkaTopic(eventType)))];
    if (eventTypes.length === 0) throw new WebhookError("WEBHOOK_EVENT_TYPES_REQUIRED", 400);
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const endpoint = await this.repository.createEndpoint({
      tenantId: input.principal.tenantId,
      url,
      eventTypes,
      secretHash: hashOpaqueToken(secret),
      secretCiphertext: encryptWebhookSecret(secret, this.secretEncryptionKey)
    });
    await this.recordWebhookAudit(input.principal, {
      action: "webhook.endpoint.created",
      resourceId: endpoint.id,
      metadata: {
        endpointId: endpoint.id,
        url: endpoint.url,
        eventTypes: endpoint.eventTypes,
        enabled: endpoint.enabled
      }
    });
    return { endpoint: publicEndpoint(endpoint), secret };
  }

  async listEndpoints(input: { principal: AuthPrincipal; includeDisabled?: boolean }) {
    const endpoints = await this.repository.listEndpoints({
      tenantId: input.principal.tenantId,
      includeDisabled: input.includeDisabled ?? false
    });
    return endpoints.map(publicEndpoint);
  }

  async disableEndpoint(input: { principal: AuthPrincipal; id: string }) {
    const endpoint = await this.repository.setEnabled({
      tenantId: input.principal.tenantId,
      id: input.id,
      enabled: false
    });
    if (!endpoint) throw new WebhookError("WEBHOOK_ENDPOINT_NOT_FOUND", 404);
    await this.recordWebhookAudit(input.principal, {
      action: "webhook.endpoint.disabled",
      resourceId: endpoint.id,
      metadata: {
        endpointId: endpoint.id,
        eventTypes: endpoint.eventTypes,
        enabled: endpoint.enabled
      }
    });
    return publicEndpoint(endpoint);
  }

  async deliver(input: {
    principal: AuthPrincipal;
    endpointId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
    correlationId?: string | null;
  }) {
    const eventType = assertKafkaTopic(input.eventType);
    const endpoints = input.endpointId
      ? [await this.repository.findEndpoint({ tenantId: input.principal.tenantId, id: input.endpointId })]
      : (await this.repository.listEndpoints({ tenantId: input.principal.tenantId })).filter((endpoint) =>
          endpoint.eventTypes.includes(eventType)
        );
    const enabledEndpoints = endpoints.filter((endpoint): endpoint is StoredWebhookEndpoint => Boolean(endpoint?.enabled));
    if (input.endpointId && enabledEndpoints.length === 0) throw new WebhookError("WEBHOOK_ENDPOINT_NOT_FOUND", 404);

    const deliveries = [];
    for (const endpoint of enabledEndpoints) {
      const deliveryId = randomUUID();
      const request = buildWebhookDeliveryRequest({
        endpoint,
        eventType,
        payload: input.payload,
        correlationId: input.correlationId ?? null,
        deliveryId,
        secret: endpoint.secretCiphertext ? decryptWebhookSecret(endpoint.secretCiphertext, this.secretEncryptionKey) : null
      });
      const delivered = await this.deliveryClient({
        endpoint,
        eventType,
        payload: input.payload,
        correlationId: input.correlationId ?? null,
        deliveryId,
        body: request.body,
        headers: request.headers,
        signatureStatus: request.signatureStatus
      });
      const delivery = {
        deliveryId,
        endpointId: endpoint.id,
        eventType,
        ok: delivered.ok,
        statusCode: delivered.statusCode,
        responseBody: delivered.responseBody?.slice(0, 500) ?? null
      };
      deliveries.push(delivery);
      await this.recordWebhookAudit(input.principal, {
        action: "webhook.delivery.attempted",
        resourceId: endpoint.id,
        metadata: {
          endpointId: endpoint.id,
          eventType,
          ok: delivery.ok,
          statusCode: delivery.statusCode,
          deliveryId,
          signatureStatus: request.signatureStatus,
          correlationId: input.correlationId ?? null
        },
        correlationId: input.correlationId ?? null
      });
      await this.events?.publish({
        tenantId: input.principal.tenantId,
        topic: "webhook.delivery.requested",
        aggregateId: endpoint.id,
        correlationId: input.correlationId ?? randomUUID(),
        payload: {
          endpointId: endpoint.id,
          eventType,
          ok: delivery.ok,
          statusCode: delivery.statusCode
        }
      });
    }

    return {
      eventType,
      endpointCount: enabledEndpoints.length,
      deliveredCount: deliveries.filter((delivery) => delivery.ok).length,
      failedCount: deliveries.filter((delivery) => !delivery.ok).length,
      deliveries
    };
  }

  private async recordWebhookAudit(
    principal: AuthPrincipal,
    input: {
      action: string;
      resourceId: string;
      metadata: Record<string, unknown>;
      correlationId?: string | null;
    }
  ): Promise<void> {
    try {
      await this.audit?.create({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action: input.action,
        resourceType: "WebhookEndpoint",
        resourceId: input.resourceId,
        metadata: input.metadata,
        correlationId: input.correlationId ?? principal.sessionId
      });
    } catch {
      // Audit writes are operational evidence; webhook persistence/delivery remains authoritative.
    }
  }
}

export async function defaultWebhookDeliveryClient(input: Parameters<WebhookDeliveryClient>[0]) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(input.endpoint.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
      signal: controller.signal
    });
    return {
      ok: response.ok,
      statusCode: response.status,
      responseBody: (await response.text()).slice(0, 500)
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      responseBody: error instanceof Error ? error.message : "WEBHOOK_DELIVERY_FAILED"
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildWebhookDeliveryRequest(input: {
  endpoint: StoredWebhookEndpoint;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
  deliveryId: string;
  secret: string | null;
  timestamp?: string;
}): { body: string; headers: Record<string, string>; signatureStatus: WebhookSignatureStatus } {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    eventType: input.eventType,
    endpointId: input.endpoint.id,
    deliveryId: input.deliveryId,
    correlationId: input.correlationId,
    payload: input.payload
  });
  const payloadSha256 = createHash("sha256").update(body).digest("hex");
  const signatureStatus: WebhookSignatureStatus = input.secret ? "signed_hmac_sha256" : "unsigned_legacy_secret_hash_only";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "SpendLensAI-WebhookWorker/0.1",
    "x-spendlens-delivery-id": input.deliveryId,
    "x-spendlens-event-type": input.eventType,
    "x-spendlens-webhook-endpoint-id": input.endpoint.id,
    "x-spendlens-timestamp": timestamp,
    "x-spendlens-payload-sha256": payloadSha256,
    "x-spendlens-signature-status": signatureStatus
  };
  if (input.correlationId) headers["x-correlation-id"] = input.correlationId;
  if (input.secret) {
    const signedPayload = `${timestamp}.${input.deliveryId}.${body}`;
    headers["x-spendlens-signature-algorithm"] = "hmac-sha256";
    headers["x-spendlens-signature"] = `v1=${createHmac("sha256", input.secret).update(signedPayload).digest("hex")}`;
  }
  return { body, headers, signatureStatus };
}

function normalizeWebhookUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (!["http:", "https:"].includes(parsed.protocol)) throw new WebhookError("WEBHOOK_URL_UNSUPPORTED_PROTOCOL", 400);
  if (parsed.username || parsed.password) throw new WebhookError("WEBHOOK_URL_CREDENTIALS_NOT_ALLOWED", 400);
  return parsed.toString();
}

function publicEndpoint(endpoint: StoredWebhookEndpoint) {
  return {
    id: endpoint.id,
    tenantId: endpoint.tenantId,
    url: endpoint.url,
    eventTypes: endpoint.eventTypes,
    enabled: endpoint.enabled,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt
  };
}

function encryptWebhookSecret(secret: string, encryptionKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveWebhookEncryptionKey(encryptionKey), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

function decryptWebhookSecret(ciphertext: string, encryptionKey: string): string {
  const [version, iv, tag, encrypted] = ciphertext.split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new WebhookError("WEBHOOK_SECRET_CIPHERTEXT_INVALID", 500);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveWebhookEncryptionKey(encryptionKey),
    Buffer.from(iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

function deriveWebhookEncryptionKey(encryptionKey: string): Buffer {
  return createHash("sha256").update(encryptionKey).digest();
}
