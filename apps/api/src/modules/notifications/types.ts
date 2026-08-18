export type StoredNotification = {
  id: string;
  tenantId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
};

export type NotificationRepository = {
  create(input: {
    tenantId: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    payload?: unknown;
  }): Promise<StoredNotification>;
  list(input: { tenantId: string; userId?: string; unreadOnly?: boolean; limit?: number }): Promise<StoredNotification[]>;
  markRead(input: { tenantId: string; userId: string; id: string }): Promise<StoredNotification | null>;
};
