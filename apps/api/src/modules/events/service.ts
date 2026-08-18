import { randomUUID } from "node:crypto";
import { assertKafkaTopic, eventCatalog, type KafkaTopic } from "@spendlens/shared";
import type { AuditRepository } from "../audit/types";
import type { AuthPrincipal } from "../auth/types";
import type {
  EventDlqReplayResult,
  EventDrainResult,
  EventEnvelope,
  EventInboxRepository,
  KafkaConsumerLagProvider,
  EventProducer,
  EventRepository,
  InboxEventStatus,
  OutboxEventState,
  StoredInboxEvent,
  StoredOutboxEvent
} from "./types";

export class EventError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class EventService {
  constructor(
    private readonly repository: EventRepository,
    private readonly inboxRepository?: EventInboxRepository,
    private readonly producer?: EventProducer,
    private readonly lagProvider?: KafkaConsumerLagProvider,
    private readonly audit?: AuditRepository
  ) {}

  catalog() {
    return eventCatalog;
  }

  async publish(input: {
    tenantId: string;
    topic: KafkaTopic;
    aggregateId: string;
    payload: Record<string, unknown>;
    correlationId?: string | null;
    schemaVersion?: number;
  }) {
    return this.repository.create({
      tenantId: input.tenantId,
      topic: input.topic,
      aggregateId: input.aggregateId,
      payload: input.payload,
      schemaVersion: input.schemaVersion ?? 1,
      correlationId: input.correlationId ?? randomUUID()
    });
  }

  async publishForPrincipal(input: {
    principal: AuthPrincipal;
    topic: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    correlationId?: string | null;
    schemaVersion?: number;
  }) {
    const topic = assertKafkaTopic(input.topic);
    const event = await this.publish({
      tenantId: input.principal.tenantId,
      topic,
      aggregateId: input.aggregateId,
      payload: input.payload,
      correlationId: input.correlationId ?? null,
      schemaVersion: input.schemaVersion ?? 1
    });
    await this.auditEventAdmin(input.principal, "event.outbox.published", event, {
      schemaVersion: event.schemaVersion,
      payloadKeyCount: Object.keys(input.payload).length
    });
    return event;
  }

  async list(input: { principal: AuthPrincipal; topic?: string; state?: OutboxEventState; limit?: number }) {
    return {
      backlog: await this.repository.backlog(input.principal.tenantId),
      events: await this.repository.list({
        tenantId: input.principal.tenantId,
        ...(input.topic ? { topic: assertKafkaTopic(input.topic) } : {}),
        ...(input.state ? { state: input.state } : {}),
        ...(input.limit ? { limit: input.limit } : {})
      })
    };
  }

  async markPublished(input: { principal: AuthPrincipal; id: string }) {
    const event = await this.repository.markPublished({ tenantId: input.principal.tenantId, id: input.id });
    if (!event) throw new EventError("OUTBOX_EVENT_NOT_FOUND", 404);
    await this.auditEventAdmin(input.principal, "event.outbox.mark_published", event);
    return event;
  }

  async markFailed(input: { principal: AuthPrincipal; id: string; failureReason: string }) {
    const event = await this.repository.markFailed({
      tenantId: input.principal.tenantId,
      id: input.id,
      failureReason: input.failureReason
    });
    if (!event) throw new EventError("OUTBOX_EVENT_NOT_FOUND", 404);
    await this.auditEventAdmin(input.principal, "event.outbox.mark_failed", event, { failureReasonPresent: true });
    return event;
  }

  async requeueFailed(input: { principal: AuthPrincipal; id: string }) {
    const event = await this.repository.requeueFailed({ tenantId: input.principal.tenantId, id: input.id });
    if (!event) throw new EventError("OUTBOX_FAILED_EVENT_NOT_FOUND", 404);
    await this.auditEventAdmin(input.principal, "event.outbox.requeued", event);
    return event;
  }

  async listDlq(input: { principal: AuthPrincipal; topic?: string; limit?: number }) {
    const failed = await this.repository.list({
      tenantId: input.principal.tenantId,
      state: "failed",
      ...(input.topic ? { topic: assertKafkaTopic(input.topic) } : {}),
      limit: input.limit ?? 50
    });
    return failed.filter((event) => event.failureReason?.startsWith("DLQ:"));
  }

  async replayDlq(input: {
    principal: AuthPrincipal;
    topic?: string;
    reasonContains?: string | null;
    limit?: number;
    dryRun?: boolean;
  }): Promise<EventDlqReplayResult> {
    const topic = input.topic ? assertKafkaTopic(input.topic) : null;
    const limit = input.limit ?? 25;
    const dryRun = input.dryRun ?? false;
    const reasonContains = input.reasonContains?.trim() || null;
    const failed = await this.repository.list({
      tenantId: input.principal.tenantId,
      state: "failed",
      ...(topic ? { topic } : {}),
      limit: Math.max(limit, 100)
    });
    const candidates = failed
      .filter((event) => event.failureReason?.startsWith("DLQ:"))
      .filter((event) => !reasonContains || event.failureReason?.toLowerCase().includes(reasonContains.toLowerCase()))
      .slice(0, limit);
    const result: EventDlqReplayResult = {
      dryRun,
      policy: { topic, reasonContains, limit },
      scanned: failed.length,
      replayed: 0,
      skipped: 0,
      events: []
    };

    for (const event of candidates) {
      if (dryRun) {
        result.events.push({
          id: event.id,
          topic: event.topic,
          aggregateId: event.aggregateId,
          action: "would_requeue",
          failureReason: event.failureReason,
          skipReason: null
        });
        continue;
      }
      const requeued = await this.repository.requeueFailed({ tenantId: input.principal.tenantId, id: event.id });
      if (!requeued) {
        result.skipped += 1;
        result.events.push({
          id: event.id,
          topic: event.topic,
          aggregateId: event.aggregateId,
          action: "skipped",
          failureReason: event.failureReason,
          skipReason: "EVENT_NO_LONGER_FAILED"
        });
        continue;
      }
      result.replayed += 1;
      result.events.push({
        id: requeued.id,
        topic: requeued.topic,
        aggregateId: requeued.aggregateId,
        action: "requeued",
        failureReason: null,
        skipReason: null
      });
    }

    await this.auditDlqReplay(input.principal, dryRun ? "event.dlq.replay_previewed" : "event.dlq.replayed", {
      topic,
      reasonFilterPresent: reasonContains !== null,
      limit,
      dryRun,
      scanned: result.scanned,
      replayed: result.replayed,
      skipped: result.skipped,
      eventCount: result.events.length
    });
    return result;
  }

  private async auditEventAdmin(
    principal: AuthPrincipal,
    action: string,
    event: StoredOutboxEvent,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      await this.audit?.create({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action,
        resourceType: "OutboxEvent",
        resourceId: event.id,
        metadata: {
          topic: event.topic,
          aggregateId: event.aggregateId,
          schemaVersion: event.schemaVersion,
          state: event.failureReason ? "failed" : event.publishedAt ? "published" : "pending",
          payloadPresent: true,
          failureReasonPresent: event.failureReason !== null,
          ...metadata
        },
        correlationId: event.correlationId ?? principal.sessionId
      });
    } catch {
      // Outbox state remains authoritative; audit failures should not break admin event recovery.
    }
  }

  private async auditDlqReplay(principal: AuthPrincipal, action: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await this.audit?.create({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action,
        resourceType: "EventDlqReplay",
        resourceId: null,
        metadata,
        correlationId: principal.sessionId
      });
    } catch {
      // Replay result remains authoritative; audit failures should not break recovery.
    }
  }

  async drain(input: { principal: AuthPrincipal; limit?: number; includeFailed?: boolean }): Promise<EventDrainResult> {
    if (!this.producer) throw new EventError("EVENT_PRODUCER_NOT_CONFIGURED", 503);
    const pending = await this.repository.list({
      tenantId: input.principal.tenantId,
      state: "pending",
      limit: input.limit ?? 25
    });
    const failed = input.includeFailed
      ? await this.repository.list({
          tenantId: input.principal.tenantId,
          state: "failed",
          limit: Math.max(0, (input.limit ?? 25) - pending.length)
        })
      : [];
    const candidates = [...pending, ...failed].slice(0, input.limit ?? 25);
    const result: EventDrainResult = { attempted: 0, published: 0, failed: 0, dlqPublished: 0, events: [] };

    for (const event of candidates) {
      result.attempted += 1;
      const delivery = await this.deliver(event);
      if (delivery.state === "published") result.published += 1;
      if (delivery.state === "failed") result.failed += 1;
      if (delivery.dlqPublished) result.dlqPublished += 1;
      result.events.push({
        id: event.id,
        topic: event.topic,
        state: delivery.state,
        failureReason: delivery.failureReason,
        dlqTopic: delivery.dlqTopic
      });
    }

    return result;
  }

  async recordInbox(input: {
    principal: AuthPrincipal;
    consumerName: string;
    event: Omit<EventEnvelope, "topic"> & { topic: string };
    status: InboxEventStatus;
    failureReason?: string | null;
  }) {
    if (!this.inboxRepository) throw new EventError("EVENT_INBOX_NOT_CONFIGURED", 503);
    if (input.event.tenantId !== input.principal.tenantId) throw new EventError("EVENT_TENANT_MISMATCH", 403);
    const topic = assertKafkaTopic(input.event.topic);
    const result = await this.inboxRepository.record({
      tenantId: input.principal.tenantId,
      consumerName: normalizeConsumerName(input.consumerName),
      event: { ...input.event, topic },
      status: input.status,
      failureReason: input.failureReason ?? null
    });
    await this.auditInboxAdmin(input.principal, result.event, result.duplicate);
    return result;
  }

  async listInbox(input: {
    principal: AuthPrincipal;
    consumerName?: string;
    topic?: string;
    status?: InboxEventStatus;
    limit?: number;
  }) {
    if (!this.inboxRepository) throw new EventError("EVENT_INBOX_NOT_CONFIGURED", 503);
    return this.inboxRepository.list({
      tenantId: input.principal.tenantId,
      ...(input.consumerName ? { consumerName: normalizeConsumerName(input.consumerName) } : {}),
      ...(input.topic ? { topic: assertKafkaTopic(input.topic) } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.limit ? { limit: input.limit } : {})
    });
  }

  async metrics() {
    const outbox = await this.repository.metrics();
    const inbox = this.inboxRepository
      ? await this.inboxRepository.metrics()
      : { inboxByStatus: [], inboxByTopicStatus: [] };
    const kafkaConsumerLag = this.lagProvider
      ? await this.lagProvider.metrics().catch(() => ({ samples: [] }))
      : { samples: [] };
    return { ...outbox, ...inbox, kafkaConsumerLag };
  }

  private async auditInboxAdmin(
    principal: AuthPrincipal,
    event: StoredInboxEvent,
    duplicate: boolean
  ): Promise<void> {
    try {
      await this.audit?.create({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action: "event.inbox.recorded",
        resourceType: "InboxEvent",
        resourceId: event.id,
        metadata: {
          consumerName: event.consumerName,
          eventId: event.eventId,
          topic: event.topic,
          aggregateId: event.aggregateId,
          schemaVersion: event.schemaVersion,
          status: event.status,
          duplicate,
          payloadPresent: true,
          payloadKeyCount: Object.keys(event.payload).length,
          failureReasonPresent: event.failureReason !== null
        },
        correlationId: event.correlationId ?? principal.sessionId
      });
    } catch {
      // Inbox checkpoint state remains authoritative; audit failures should not break event recovery operations.
    }
  }

  private async deliver(event: StoredOutboxEvent): Promise<{
    state: OutboxEventState;
    failureReason: string | null;
    dlqTopic: string | null;
    dlqPublished: boolean;
  }> {
    const catalogEntry = eventCatalog[event.topic];
    try {
      await this.producer?.send({
        topic: event.topic,
        key: event.aggregateId,
        value: eventEnvelope(event),
        headers: eventHeaders(event)
      });
      await this.repository.markPublished({ tenantId: event.tenantId, id: event.id });
      return { state: "published", failureReason: null, dlqTopic: null, dlqPublished: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "EVENT_DELIVERY_FAILED";
      let dlqPublished = false;
      try {
        await this.producer?.send({
          topic: catalogEntry.dlqTopic,
          key: event.aggregateId,
          value: {
            ...eventEnvelope(event),
            originalTopic: event.topic,
            failureReason: reason
          },
          headers: { ...eventHeaders(event), "x-spendlens-dlq": "true" }
        });
        dlqPublished = true;
      } catch {
        dlqPublished = false;
      }
      await this.repository.markFailed({
        tenantId: event.tenantId,
        id: event.id,
        failureReason: dlqPublished ? `DLQ:${catalogEntry.dlqTopic}:${reason}` : reason
      });
      return {
        state: "failed",
        failureReason: dlqPublished ? `DLQ:${catalogEntry.dlqTopic}:${reason}` : reason,
        dlqTopic: catalogEntry.dlqTopic,
        dlqPublished
      };
    }
  }
}

function normalizeConsumerName(value: string): string {
  return value.trim().toLowerCase();
}

function eventEnvelope(event: StoredOutboxEvent): Record<string, unknown> {
  return {
    id: event.id,
    topic: event.topic,
    schemaVersion: event.schemaVersion,
    tenantId: event.tenantId,
    aggregateId: event.aggregateId,
    occurredAt: event.createdAt.toISOString(),
    correlationId: event.correlationId,
    payload: event.payload
  };
}

function eventHeaders(event: StoredOutboxEvent): Record<string, string> {
  return {
    "x-spendlens-event-id": event.id,
    "x-spendlens-tenant-id": event.tenantId,
    "x-spendlens-correlation-id": event.correlationId,
    "x-spendlens-schema-version": String(event.schemaVersion)
  };
}
