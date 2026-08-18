import { describe, expect, it } from "vitest";
import {
  loadKafkaEventConsumerConfig,
  parseKafkaEventEnvelope,
  recordKafkaEvent
} from "./event-consumer";
import { InMemoryEventInboxRepository } from "./modules/events/memory-repository";
import type { EventEnvelope } from "./modules/events/types";

describe("Kafka event consumer entrypoint", () => {
  it("loads bounded broker, identity and topic configuration", () => {
    const config = loadKafkaEventConsumerConfig({
      KAFKA_BROKERS: "redpanda:9092, localhost:19092",
      EVENT_CONSUMER_CLIENT_ID: "events-client",
      EVENT_CONSUMER_GROUP_ID: "events-group",
      EVENT_CONSUMER_NAME: "events-inbox",
      EVENT_CONSUMER_TOPICS: "document.uploaded,expense.created,document.uploaded"
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      brokers: ["redpanda:9092", "localhost:19092"],
      clientId: "events-client",
      groupId: "events-group",
      consumerName: "events-inbox",
      topics: ["document.uploaded", "expense.created"]
    });
  });

  it("requires Kafka brokers for the standalone runtime", () => {
    expect(() => loadKafkaEventConsumerConfig({} as NodeJS.ProcessEnv)).toThrow(
      "EVENT_CONSUMER_KAFKA_BROKERS_REQUIRED"
    );
  });

  it("parses producer envelopes and rejects unknown topics", () => {
    const envelope = parseKafkaEventEnvelope(
      Buffer.from(
        JSON.stringify({
          id: "event_1",
          topic: "document.uploaded",
          tenantId: "tenant_1",
          aggregateId: "document_1",
          schemaVersion: 1,
          occurredAt: "2026-05-14T00:00:00.000Z",
          correlationId: "corr_1",
          payload: { documentId: "document_1" }
        })
      )
    );

    expect(envelope).toEqual({
      id: "event_1",
      topic: "document.uploaded",
      tenantId: "tenant_1",
      aggregateId: "document_1",
      schemaVersion: 1,
      correlationId: "corr_1",
      payload: { documentId: "document_1" }
    });
    expect(() => parseKafkaEventEnvelope(JSON.stringify({ ...envelope, topic: "expense.deleted" }))).toThrow(
      "UNKNOWN_KAFKA_TOPIC"
    );
  });

  it("records consumed events in the inbox idempotently", async () => {
    const inboxRepository = new InMemoryEventInboxRepository();
    const event: EventEnvelope = {
      id: "event_2",
      topic: "expense.created",
      tenantId: "tenant_1",
      aggregateId: "expense_1",
      schemaVersion: 1,
      correlationId: "corr_2",
      payload: { expenseId: "expense_1" }
    };

    const first = await recordKafkaEvent({ inboxRepository, consumerName: "event-consumer", event });
    const second = await recordKafkaEvent({ inboxRepository, consumerName: "event-consumer", event });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(await inboxRepository.list({ tenantId: "tenant_1", consumerName: "event-consumer" })).toHaveLength(1);
  });
});
