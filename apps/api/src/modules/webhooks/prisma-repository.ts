import { PrismaClient } from "@prisma/client";
import type { WebhookRepository } from "./types";

export class PrismaWebhookRepository implements WebhookRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createEndpoint(input: Parameters<WebhookRepository["createEndpoint"]>[0]) {
    return this.prisma.webhookEndpoint.create({
      data: {
        tenantId: input.tenantId,
        url: input.url,
        eventTypes: input.eventTypes,
        secretHash: input.secretHash,
        secretCiphertext: input.secretCiphertext ?? null,
        enabled: true
      }
    });
  }

  async listEndpoints(input: Parameters<WebhookRepository["listEndpoints"]>[0]) {
    return this.prisma.webhookEndpoint.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.includeDisabled ? {} : { enabled: true })
      },
      orderBy: { createdAt: "desc" }
    });
  }

  async findEndpoint(input: Parameters<WebhookRepository["findEndpoint"]>[0]) {
    return this.prisma.webhookEndpoint.findFirst({
      where: { tenantId: input.tenantId, id: input.id }
    });
  }

  async setEnabled(input: Parameters<WebhookRepository["setEnabled"]>[0]) {
    const existing = await this.findEndpoint(input);
    if (!existing) return null;
    return this.prisma.webhookEndpoint.update({
      where: { id: existing.id },
      data: { enabled: input.enabled }
    });
  }
}
