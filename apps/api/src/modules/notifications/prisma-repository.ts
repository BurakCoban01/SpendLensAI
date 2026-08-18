import { Prisma, PrismaClient } from "@prisma/client";
import type { NotificationRepository } from "./types";

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: Parameters<NotificationRepository["create"]>[0]) {
    return this.prisma.notification.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        payload: input.payload === undefined ? Prisma.JsonNull : (input.payload as Prisma.InputJsonValue)
      }
    });
  }

  async list(input: Parameters<NotificationRepository["list"]>[0]) {
    return this.prisma.notification.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.unreadOnly ? { readAt: null } : {})
      },
      orderBy: { createdAt: "desc" },
      take: input.limit ?? 50
    });
  }

  async markRead(input: Parameters<NotificationRepository["markRead"]>[0]) {
    const existing = await this.prisma.notification.findFirst({
      where: { id: input.id, tenantId: input.tenantId, userId: input.userId }
    });
    if (!existing) return null;
    return this.prisma.notification.update({
      where: { id: existing.id },
      data: { readAt: new Date() }
    });
  }
}
