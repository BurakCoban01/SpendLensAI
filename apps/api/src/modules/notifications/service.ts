import type { AuthPrincipal } from "../auth/types";
import type { AuditRepository } from "../audit/types";
import type { NotificationRepository } from "./types";

export class NotificationError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class NotificationService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly audit?: AuditRepository
  ) {}

  async create(input: {
    principal: AuthPrincipal;
    userId?: string | null;
    type: string;
    title: string;
    body: string;
    payload?: unknown;
  }) {
    const notification = await this.repository.create({
      tenantId: input.principal.tenantId,
      userId: input.userId ?? input.principal.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      payload: input.payload ?? null
    });
    await this.recordNotificationAudit(input.principal, {
      action: "notification.created",
      resourceId: notification.id,
      metadata: {
        notificationId: notification.id,
        userId: notification.userId,
        type: notification.type,
        title: notification.title,
        deliveredToActor: notification.userId === input.principal.userId
      }
    });
    return notification;
  }

  async list(input: { principal: AuthPrincipal; unreadOnly?: boolean; limit?: number }) {
    return this.repository.list({
      tenantId: input.principal.tenantId,
      userId: input.principal.userId,
      unreadOnly: input.unreadOnly ?? false,
      limit: input.limit ?? 50
    });
  }

  async markRead(input: { principal: AuthPrincipal; id: string }) {
    const notification = await this.repository.markRead({
      tenantId: input.principal.tenantId,
      userId: input.principal.userId,
      id: input.id
    });
    if (!notification) throw new NotificationError("NOTIFICATION_NOT_FOUND", 404);
    await this.recordNotificationAudit(input.principal, {
      action: "notification.read",
      resourceId: notification.id,
      metadata: {
        notificationId: notification.id,
        userId: notification.userId,
        type: notification.type,
        readAt: notification.readAt?.toISOString() ?? null
      }
    });
    return notification;
  }

  private async recordNotificationAudit(
    principal: AuthPrincipal,
    input: {
      action: string;
      resourceId: string;
      metadata: Record<string, unknown>;
    }
  ): Promise<void> {
    try {
      await this.audit?.create({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action: input.action,
        resourceType: "Notification",
        resourceId: input.resourceId,
        metadata: input.metadata,
        correlationId: principal.sessionId
      });
    } catch {
      // Audit writes are operational evidence; notification persistence remains authoritative.
    }
  }
}
