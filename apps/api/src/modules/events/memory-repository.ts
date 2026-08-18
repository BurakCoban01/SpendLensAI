import { randomUUID } from "node:crypto";
import type {
  CreateOutboxEventInput,
  EventBacklogSummary,
  EventInboxRepository,
  EventMetricSample,
  EventRepository,
  InboxEventStatus,
  ListInboxEventsInput,
  ListOutboxEventsInput,
  RecordInboxEventInput,
  StoredInboxEvent,
  StoredOutboxEvent
} from "./types";

export class InMemoryEventRepository implements EventRepository {
  private readonly events = new Map<string, StoredOutboxEvent>();

  async create(input: CreateOutboxEventInput): Promise<StoredOutboxEvent> {
    const event: StoredOutboxEvent = {
      id: randomUUID(),
      tenantId: input.tenantId,
      topic: input.topic,
      aggregateId: input.aggregateId,
      schemaVersion: input.schemaVersion ?? 1,
      payload: input.payload,
      correlationId: input.correlationId,
      createdAt: new Date(),
      publishedAt: null,
      failureReason: null
    };
    this.events.set(event.id, event);
    return event;
  }

  async list(input: ListOutboxEventsInput): Promise<StoredOutboxEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.tenantId === input.tenantId)
      .filter((event) => !input.topic || event.topic === input.topic)
      .filter((event) => !input.state || stateOf(event) === input.state)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, input.limit ?? 50);
  }

  async markPublished(input: { tenantId: string; id: string }): Promise<StoredOutboxEvent | null> {
    const event = this.events.get(input.id);
    if (!event || event.tenantId !== input.tenantId) return null;
    const updated = { ...event, publishedAt: new Date(), failureReason: null };
    this.events.set(updated.id, updated);
    return updated;
  }

  async markFailed(input: { tenantId: string; id: string; failureReason: string }): Promise<StoredOutboxEvent | null> {
    const event = this.events.get(input.id);
    if (!event || event.tenantId !== input.tenantId) return null;
    const updated = { ...event, publishedAt: null, failureReason: input.failureReason };
    this.events.set(updated.id, updated);
    return updated;
  }

  async requeueFailed(input: { tenantId: string; id: string }): Promise<StoredOutboxEvent | null> {
    const event = this.events.get(input.id);
    if (!event || event.tenantId !== input.tenantId || !event.failureReason) return null;
    const updated = { ...event, publishedAt: null, failureReason: null };
    this.events.set(updated.id, updated);
    return updated;
  }

  async backlog(tenantId: string): Promise<EventBacklogSummary> {
    const summary = { pending: 0, published: 0, failed: 0 };
    for (const event of this.events.values()) {
      if (event.tenantId === tenantId) summary[stateOf(event)] += 1;
    }
    return summary;
  }

  async metrics(): Promise<{ outboxByState: EventMetricSample[]; outboxByTopicState: EventMetricSample[] }> {
    const byState = new Map<string, number>();
    const byTopicState = new Map<string, { topic: StoredOutboxEvent["topic"]; state: ReturnType<typeof stateOf>; count: number }>();
    for (const event of this.events.values()) {
      const state = stateOf(event);
      byState.set(state, (byState.get(state) ?? 0) + 1);
      const topicStateKey = `${event.topic}:${state}`;
      const existing = byTopicState.get(topicStateKey);
      if (existing) existing.count += 1;
      else byTopicState.set(topicStateKey, { topic: event.topic, state, count: 1 });
    }
    return {
      outboxByState: ["pending", "published", "failed"].map((state) => ({ state: state as ReturnType<typeof stateOf>, count: byState.get(state) ?? 0 })),
      outboxByTopicState: [...byTopicState.values()]
    };
  }
}

function stateOf(event: StoredOutboxEvent) {
  if (event.failureReason) return "failed";
  if (event.publishedAt) return "published";
  return "pending";
}

export class InMemoryEventInboxRepository implements EventInboxRepository {
  private readonly events = new Map<string, StoredInboxEvent>();

  async record(input: RecordInboxEventInput): Promise<{ event: StoredInboxEvent; duplicate: boolean }> {
    const key = inboxKey(input.consumerName, input.event.id);
    const existing = this.events.get(key);
    if (existing) return { event: existing, duplicate: true };
    const event: StoredInboxEvent = {
      id: randomUUID(),
      tenantId: input.tenantId,
      consumerName: input.consumerName,
      eventId: input.event.id,
      topic: input.event.topic,
      aggregateId: input.event.aggregateId,
      schemaVersion: input.event.schemaVersion,
      correlationId: input.event.correlationId,
      payload: input.event.payload,
      status: input.status,
      failureReason: input.failureReason ?? null,
      receivedAt: new Date(),
      processedAt: input.status === "processed" ? new Date() : null
    };
    this.events.set(key, event);
    return { event, duplicate: false };
  }

  async list(input: ListInboxEventsInput): Promise<StoredInboxEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.tenantId === input.tenantId)
      .filter((event) => !input.consumerName || event.consumerName === input.consumerName)
      .filter((event) => !input.topic || event.topic === input.topic)
      .filter((event) => !input.status || event.status === input.status)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, input.limit ?? 50);
  }

  async metrics(): Promise<{ inboxByStatus: EventMetricSample[]; inboxByTopicStatus: EventMetricSample[] }> {
    const byStatus = new Map<InboxEventStatus, number>();
    const byTopicStatus = new Map<string, { topic: StoredInboxEvent["topic"]; status: InboxEventStatus; count: number }>();
    for (const event of this.events.values()) {
      byStatus.set(event.status, (byStatus.get(event.status) ?? 0) + 1);
      const topicStatusKey = `${event.topic}:${event.status}`;
      const existing = byTopicStatus.get(topicStatusKey);
      if (existing) existing.count += 1;
      else byTopicStatus.set(topicStatusKey, { topic: event.topic, status: event.status, count: 1 });
    }
    return {
      inboxByStatus: ["processed", "failed"].map((status) => ({ status: status as InboxEventStatus, count: byStatus.get(status as InboxEventStatus) ?? 0 })),
      inboxByTopicStatus: [...byTopicStatus.values()]
    };
  }
}

function inboxKey(consumerName: string, eventId: string): string {
  return `${consumerName}:${eventId}`;
}
