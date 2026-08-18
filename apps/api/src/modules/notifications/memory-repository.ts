import { randomUUID } from "node:crypto";
import type { NotificationRepository, StoredNotification } from "./types";

export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly notifications = new Map<string, StoredNotification>();

  async create(input: Parameters<NotificationRepository["create"]>[0]): Promise<StoredNotification> {
    const notification: StoredNotification = {
      id: randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      payload: input.payload ?? null,
      readAt: null,
      createdAt: new Date()
    };
    this.notifications.set(notification.id, notification);
    return notification;
  }

  async list(input: Parameters<NotificationRepository["list"]>[0]): Promise<StoredNotification[]> {
    return [...this.notifications.values()]
      .filter((notification) => notification.tenantId === input.tenantId)
      .filter((notification) => !input.userId || notification.userId === input.userId)
      .filter((notification) => !input.unreadOnly || notification.readAt === null)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, input.limit ?? 50);
  }

  async markRead(input: Parameters<NotificationRepository["markRead"]>[0]): Promise<StoredNotification | null> {
    const notification = this.notifications.get(input.id);
    if (!notification || notification.tenantId !== input.tenantId || notification.userId !== input.userId) return null;
    const updated = { ...notification, readAt: new Date() };
    this.notifications.set(updated.id, updated);
    return updated;
  }
}
