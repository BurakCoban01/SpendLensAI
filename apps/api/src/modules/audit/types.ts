export type AuditLogEntry = {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  ipHash: string | null;
  userAgent: string | null;
  correlationId: string | null;
  createdAt: Date;
};

export type AuditActionSummary = {
  action: string;
  count: number;
};

export type AuditResourceSummary = {
  resourceType: string;
  count: number;
};

export type AuditSummary = {
  total: number;
  actions: AuditActionSummary[];
  resources: AuditResourceSummary[];
};

export type ListAuditLogsInput = {
  tenantId: string;
  action?: string;
  resourceType?: string;
  actorUserId?: string;
  limit?: number;
};

export type SeedAuditLogInput = {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipHash?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  createdAt?: Date;
};

export type AuditRetentionPreview = {
  cutoff: Date;
  matched: number;
  sample: AuditLogEntry[];
};

export type AuditRepository = {
  list(input: ListAuditLogsInput): Promise<AuditLogEntry[]>;
  summary(tenantId: string): Promise<AuditSummary>;
  listOlderThan(input: { tenantId: string; cutoff: Date; limit?: number }): Promise<AuditLogEntry[]>;
  countOlderThan(input: { tenantId: string; cutoff: Date }): Promise<number>;
  deleteOlderThan(input: { tenantId: string; cutoff: Date }): Promise<number>;
  create(input: SeedAuditLogInput): Promise<AuditLogEntry>;
};
