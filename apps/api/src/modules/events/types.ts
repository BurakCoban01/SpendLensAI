import type { KafkaTopic } from "@spendlens/shared";

export type OutboxEventState = "pending" | "published" | "failed";
export type InboxEventStatus = "processed" | "failed";

export type StoredOutboxEvent = {
  id: string;
  tenantId: string;
  topic: KafkaTopic;
  aggregateId: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  correlationId: string;
  createdAt: Date;
  publishedAt: Date | null;
  failureReason: string | null;
};

export type CreateOutboxEventInput = {
  tenantId: string;
  topic: KafkaTopic;
  aggregateId: string;
  schemaVersion?: number;
  payload: Record<string, unknown>;
  correlationId: string;
};

export type ListOutboxEventsInput = {
  tenantId: string;
  topic?: KafkaTopic;
  state?: OutboxEventState;
  limit?: number;
};

export type EventBacklogSummary = {
  pending: number;
  published: number;
  failed: number;
};

export type EventMetricSample = {
  topic?: KafkaTopic;
  state?: OutboxEventState;
  status?: InboxEventStatus;
  count: number;
};

export type EventMetricsSnapshot = {
  outboxByState: EventMetricSample[];
  outboxByTopicState: EventMetricSample[];
  inboxByStatus: EventMetricSample[];
  inboxByTopicStatus: EventMetricSample[];
  kafkaConsumerLag?: KafkaConsumerLagSnapshot;
};

export type EventRepository = {
  create(input: CreateOutboxEventInput): Promise<StoredOutboxEvent>;
  list(input: ListOutboxEventsInput): Promise<StoredOutboxEvent[]>;
  markPublished(input: { tenantId: string; id: string }): Promise<StoredOutboxEvent | null>;
  markFailed(input: { tenantId: string; id: string; failureReason: string }): Promise<StoredOutboxEvent | null>;
  requeueFailed(input: { tenantId: string; id: string }): Promise<StoredOutboxEvent | null>;
  backlog(tenantId: string): Promise<EventBacklogSummary>;
  metrics(): Promise<Pick<EventMetricsSnapshot, "outboxByState" | "outboxByTopicState">>;
};

export type EventEnvelope = {
  id: string;
  topic: KafkaTopic;
  tenantId: string;
  aggregateId: string;
  schemaVersion: number;
  correlationId: string;
  payload: Record<string, unknown>;
};

export type StoredInboxEvent = {
  id: string;
  tenantId: string;
  consumerName: string;
  eventId: string;
  topic: KafkaTopic;
  aggregateId: string;
  schemaVersion: number;
  correlationId: string;
  payload: Record<string, unknown>;
  status: InboxEventStatus;
  failureReason: string | null;
  receivedAt: Date;
  processedAt: Date | null;
};

export type RecordInboxEventInput = {
  tenantId: string;
  consumerName: string;
  event: EventEnvelope;
  status: InboxEventStatus;
  failureReason?: string | null;
};

export type ListInboxEventsInput = {
  tenantId: string;
  consumerName?: string;
  topic?: KafkaTopic;
  status?: InboxEventStatus;
  limit?: number;
};

export type EventInboxRepository = {
  record(input: RecordInboxEventInput): Promise<{ event: StoredInboxEvent; duplicate: boolean }>;
  list(input: ListInboxEventsInput): Promise<StoredInboxEvent[]>;
  metrics(): Promise<Pick<EventMetricsSnapshot, "inboxByStatus" | "inboxByTopicStatus">>;
};

export type EventProducerMessage = {
  topic: string;
  key: string;
  value: Record<string, unknown>;
  headers: Record<string, string>;
};

export type EventProducer = {
  send(message: EventProducerMessage): Promise<void>;
  close?(): Promise<void>;
};

export type EventDrainResult = {
  attempted: number;
  published: number;
  failed: number;
  dlqPublished: number;
  events: Array<{
    id: string;
    topic: string;
    state: OutboxEventState;
    failureReason: string | null;
    dlqTopic: string | null;
  }>;
};

export type EventDlqReplayResult = {
  dryRun: boolean;
  policy: {
    topic: KafkaTopic | null;
    reasonContains: string | null;
    limit: number;
  };
  scanned: number;
  replayed: number;
  skipped: number;
  events: Array<{
    id: string;
    topic: KafkaTopic;
    aggregateId: string;
    action: "would_requeue" | "requeued" | "skipped";
    failureReason: string | null;
    skipReason: string | null;
  }>;
};

export type KafkaConsumerLagSample = {
  groupId: string;
  topic: string;
  partition: number;
  currentOffset: number;
  highWatermark: number;
  lag: number;
};

export type KafkaConsumerLagSnapshot = {
  samples: KafkaConsumerLagSample[];
};

export type KafkaConsumerLagProvider = {
  metrics(): Promise<KafkaConsumerLagSnapshot>;
  close?(): Promise<void>;
};
