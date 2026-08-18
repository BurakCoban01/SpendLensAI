import { Prisma, PrismaClient } from "@prisma/client";
import type { KafkaTopic } from "@spendlens/shared";
import type {
  CreateOutboxEventInput,
  EventBacklogSummary,
  EventInboxRepository,
  EventMetricSample,
  EventRepository,
  InboxEventStatus,
  ListInboxEventsInput,
  ListOutboxEventsInput,
  OutboxEventState,
  RecordInboxEventInput,
  StoredInboxEvent,
  StoredOutboxEvent
} from "./types";

export class PrismaEventRepository implements EventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateOutboxEventInput): Promise<StoredOutboxEvent> {
    return serialize(
      await this.prisma.outboxEvent.create({
        data: {
          tenantId: input.tenantId,
          topic: input.topic,
          aggregateId: input.aggregateId,
          schemaVersion: input.schemaVersion ?? 1,
          payload: input.payload as Prisma.InputJsonObject,
          correlationId: input.correlationId
        }
      })
    );
  }

  async list(input: ListOutboxEventsInput): Promise<StoredOutboxEvent[]> {
    const where: Prisma.OutboxEventWhereInput = {
      tenantId: input.tenantId,
      ...(input.topic ? { topic: input.topic } : {}),
      ...(input.state === "pending" ? { publishedAt: null, failureReason: null } : {}),
      ...(input.state === "published" ? { publishedAt: { not: null }, failureReason: null } : {}),
      ...(input.state === "failed" ? { failureReason: { not: null } } : {})
    };
    const rows = await this.prisma.outboxEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: input.limit ?? 50
    });
    return rows.map(serialize);
  }

  async markPublished(input: { tenantId: string; id: string }): Promise<StoredOutboxEvent | null> {
    const result = await this.prisma.outboxEvent.updateMany({
      where: { tenantId: input.tenantId, id: input.id },
      data: { publishedAt: new Date(), failureReason: null }
    });
    if (result.count === 0) return null;
    const row = await this.prisma.outboxEvent.findFirst({ where: { tenantId: input.tenantId, id: input.id } });
    return row ? serialize(row) : null;
  }

  async markFailed(input: { tenantId: string; id: string; failureReason: string }): Promise<StoredOutboxEvent | null> {
    const result = await this.prisma.outboxEvent.updateMany({
      where: { tenantId: input.tenantId, id: input.id },
      data: { publishedAt: null, failureReason: input.failureReason }
    });
    if (result.count === 0) return null;
    const row = await this.prisma.outboxEvent.findFirst({ where: { tenantId: input.tenantId, id: input.id } });
    return row ? serialize(row) : null;
  }

  async requeueFailed(input: { tenantId: string; id: string }): Promise<StoredOutboxEvent | null> {
    const result = await this.prisma.outboxEvent.updateMany({
      where: { tenantId: input.tenantId, id: input.id, failureReason: { not: null } },
      data: { publishedAt: null, failureReason: null }
    });
    if (result.count === 0) return null;
    const row = await this.prisma.outboxEvent.findFirst({ where: { tenantId: input.tenantId, id: input.id } });
    return row ? serialize(row) : null;
  }

  async backlog(tenantId: string): Promise<EventBacklogSummary> {
    const [pending, published, failed] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { tenantId, publishedAt: null, failureReason: null } }),
      this.prisma.outboxEvent.count({ where: { tenantId, publishedAt: { not: null }, failureReason: null } }),
      this.prisma.outboxEvent.count({ where: { tenantId, failureReason: { not: null } } })
    ]);
    return { pending, published, failed };
  }

  async metrics(): Promise<{ outboxByState: EventMetricSample[]; outboxByTopicState: EventMetricSample[] }> {
    const [pending, published, failed, rows] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { publishedAt: null, failureReason: null } }),
      this.prisma.outboxEvent.count({ where: { publishedAt: { not: null }, failureReason: null } }),
      this.prisma.outboxEvent.count({ where: { failureReason: { not: null } } }),
      this.prisma.outboxEvent.findMany({
        select: { topic: true, publishedAt: true, failureReason: true }
      })
    ]);
    const byTopicState = new Map<string, { topic: KafkaTopic; state: OutboxEventState; count: number }>();
    for (const row of rows) {
      const state = stateOfRow(row);
      const topic = row.topic as KafkaTopic;
      const key = `${topic}:${state}`;
      const existing = byTopicState.get(key);
      if (existing) existing.count += 1;
      else byTopicState.set(key, { topic, state, count: 1 });
    }
    return {
      outboxByState: [
        { state: "pending", count: pending },
        { state: "published", count: published },
        { state: "failed", count: failed }
      ],
      outboxByTopicState: [...byTopicState.values()]
    };
  }
}

function serialize(row: {
  id: string;
  tenantId: string;
  topic: string;
  aggregateId: string;
  schemaVersion: number;
  payload: Prisma.JsonValue;
  correlationId: string;
  createdAt: Date;
  publishedAt: Date | null;
  failureReason: string | null;
}): StoredOutboxEvent {
  return {
    ...row,
    topic: row.topic as KafkaTopic,
    payload: normalizePayload(row.payload)
  };
}

function normalizePayload(value: Prisma.JsonValue): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

export class PrismaEventInboxRepository implements EventInboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: RecordInboxEventInput): Promise<{ event: StoredInboxEvent; duplicate: boolean }> {
    try {
      const event = await this.prisma.inboxEvent.create({
        data: {
          tenantId: input.tenantId,
          consumerName: input.consumerName,
          eventId: input.event.id,
          topic: input.event.topic,
          aggregateId: input.event.aggregateId,
          schemaVersion: input.event.schemaVersion,
          correlationId: input.event.correlationId,
          payload: input.event.payload as Prisma.InputJsonObject,
          status: input.status,
          failureReason: input.failureReason ?? null,
          processedAt: input.status === "processed" ? new Date() : null
        }
      });
      return { event: serializeInbox(event), duplicate: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.inboxEvent.findUnique({
          where: { consumerName_eventId: { consumerName: input.consumerName, eventId: input.event.id } }
        });
        if (existing) return { event: serializeInbox(existing), duplicate: true };
      }
      throw error;
    }
  }

  async list(input: ListInboxEventsInput): Promise<StoredInboxEvent[]> {
    const rows = await this.prisma.inboxEvent.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.consumerName ? { consumerName: input.consumerName } : {}),
        ...(input.topic ? { topic: input.topic } : {}),
        ...(input.status ? { status: input.status } : {})
      },
      orderBy: { receivedAt: "desc" },
      take: input.limit ?? 50
    });
    return rows.map(serializeInbox);
  }

  async metrics(): Promise<{ inboxByStatus: EventMetricSample[]; inboxByTopicStatus: EventMetricSample[] }> {
    const [processed, failed, rows] = await Promise.all([
      this.prisma.inboxEvent.count({ where: { status: "processed" } }),
      this.prisma.inboxEvent.count({ where: { status: "failed" } }),
      this.prisma.inboxEvent.findMany({ select: { topic: true, status: true } })
    ]);
    const byTopicStatus = new Map<string, { topic: KafkaTopic; status: InboxEventStatus; count: number }>();
    for (const row of rows) {
      const topic = row.topic as KafkaTopic;
      const status = row.status === "failed" ? "failed" : "processed";
      const key = `${topic}:${status}`;
      const existing = byTopicStatus.get(key);
      if (existing) existing.count += 1;
      else byTopicStatus.set(key, { topic, status, count: 1 });
    }
    return {
      inboxByStatus: [
        { status: "processed", count: processed },
        { status: "failed", count: failed }
      ],
      inboxByTopicStatus: [...byTopicStatus.values()]
    };
  }
}

function stateOfRow(row: { publishedAt: Date | null; failureReason: string | null }): OutboxEventState {
  if (row.failureReason) return "failed";
  if (row.publishedAt) return "published";
  return "pending";
}

function serializeInbox(row: {
  id: string;
  tenantId: string;
  consumerName: string;
  eventId: string;
  topic: string;
  aggregateId: string;
  schemaVersion: number;
  correlationId: string;
  payload: Prisma.JsonValue;
  status: string;
  failureReason: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}): StoredInboxEvent {
  return {
    ...row,
    topic: row.topic as KafkaTopic,
    status: row.status === "failed" ? "failed" : "processed",
    payload: normalizePayload(row.payload)
  };
}
