import { randomUUID } from "node:crypto";
import type { StoredWebhookEndpoint, WebhookRepository } from "./types";

export class InMemoryWebhookRepository implements WebhookRepository {
  private readonly endpoints = new Map<string, StoredWebhookEndpoint>();

  async createEndpoint(input: Parameters<WebhookRepository["createEndpoint"]>[0]): Promise<StoredWebhookEndpoint> {
    const now = new Date();
    const endpoint: StoredWebhookEndpoint = {
      id: randomUUID(),
      tenantId: input.tenantId,
      url: input.url,
      eventTypes: input.eventTypes,
      secretHash: input.secretHash,
      secretCiphertext: input.secretCiphertext ?? null,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  async listEndpoints(input: Parameters<WebhookRepository["listEndpoints"]>[0]): Promise<StoredWebhookEndpoint[]> {
    return [...this.endpoints.values()]
      .filter((endpoint) => endpoint.tenantId === input.tenantId)
      .filter((endpoint) => input.includeDisabled || endpoint.enabled)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async findEndpoint(input: Parameters<WebhookRepository["findEndpoint"]>[0]): Promise<StoredWebhookEndpoint | null> {
    const endpoint = this.endpoints.get(input.id);
    if (!endpoint || endpoint.tenantId !== input.tenantId) return null;
    return endpoint;
  }

  async setEnabled(input: Parameters<WebhookRepository["setEnabled"]>[0]): Promise<StoredWebhookEndpoint | null> {
    const endpoint = await this.findEndpoint(input);
    if (!endpoint) return null;
    const updated = { ...endpoint, enabled: input.enabled, updatedAt: new Date() };
    this.endpoints.set(updated.id, updated);
    return updated;
  }
}
