import type { KafkaTopic } from "@spendlens/shared";

export type StoredWebhookEndpoint = {
  id: string;
  tenantId: string;
  url: string;
  eventTypes: string[];
  secretHash: string;
  secretCiphertext?: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type WebhookRepository = {
  createEndpoint(input: {
    tenantId: string;
    url: string;
    eventTypes: KafkaTopic[];
    secretHash: string;
    secretCiphertext?: string | null;
  }): Promise<StoredWebhookEndpoint>;
  listEndpoints(input: { tenantId: string; includeDisabled?: boolean }): Promise<StoredWebhookEndpoint[]>;
  findEndpoint(input: { tenantId: string; id: string }): Promise<StoredWebhookEndpoint | null>;
  setEnabled(input: { tenantId: string; id: string; enabled: boolean }): Promise<StoredWebhookEndpoint | null>;
};

export type WebhookDeliveryClient = (input: {
  endpoint: StoredWebhookEndpoint;
  eventType: KafkaTopic;
  payload: Record<string, unknown>;
  correlationId: string | null;
  deliveryId: string;
  body: string;
  headers: Record<string, string>;
  signatureStatus: WebhookSignatureStatus;
}) => Promise<{
  ok: boolean;
  statusCode: number;
  responseBody?: string | null;
}>;

export type WebhookSignatureStatus = "signed_hmac_sha256" | "unsigned_legacy_secret_hash_only";
