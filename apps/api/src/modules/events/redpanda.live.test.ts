import { randomUUID } from "node:crypto";
import { Kafka, type Consumer } from "kafkajs";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthPrincipal } from "../auth/types";
import { parseKafkaEventEnvelope, recordKafkaEvent } from "../../event-consumer";
import { InMemoryEventInboxRepository, InMemoryEventRepository } from "./memory-repository";
import { KafkaJsEventProducer } from "./producer";
import { EventService } from "./service";

const runLive = process.env.SPENDLENS_LIVE_REDIS_KAFKA_TESTS === "1" || process.env.SPENDLENS_LIVE_KAFKA_TESTS === "1";
const describeLive = runLive ? describe : describe.skip;
const brokers = (process.env.KAFKA_BROKERS || "localhost:19092")
  .split(",")
  .map((broker) => broker.trim())
  .filter(Boolean);

describeLive("Redpanda Kafka live integration", () => {
  const producers: KafkaJsEventProducer[] = [];
  const consumers: Consumer[] = [];

  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((consumer) => consumer.disconnect().catch(() => undefined)));
    await Promise.all(producers.splice(0).map((producer) => producer.close()));
  });

  it("drains durable outbox events to Redpanda and records an inbox checkpoint from the consumed envelope", async () => {
    const producer = new KafkaJsEventProducer(brokers, `spendlens-api-live-${randomUUID()}`);
    producers.push(producer);
    const outboxRepository = new InMemoryEventRepository();
    const inboxRepository = new InMemoryEventInboxRepository();
    const service = new EventService(outboxRepository, inboxRepository, producer);
    const principal = principalFor(`tenant-${randomUUID()}`);
    const event = await service.publish({
      tenantId: principal.tenantId,
      topic: "expense.created",
      aggregateId: `expense-${randomUUID()}`,
      correlationId: `corr-${randomUUID()}`,
      payload: {
        source: "redpanda-live-test",
        amountMinor: 12_345,
        currency: "TRY"
      }
    });

    const drain = await service.drain({ principal, limit: 1 });

    expect(drain).toMatchObject({
      attempted: 1,
      published: 1,
      failed: 0,
      dlqPublished: 0
    });

    const received = await consumeMatchingEvent(event.id);
    const recorded = await recordKafkaEvent({
      inboxRepository,
      consumerName: "redpanda-live-test",
      event: received
    });
    const duplicate = await recordKafkaEvent({
      inboxRepository,
      consumerName: "redpanda-live-test",
      event: received
    });

    expect(received).toMatchObject({
      id: event.id,
      topic: "expense.created",
      tenantId: principal.tenantId,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      payload: expect.objectContaining({
        source: "redpanda-live-test",
        amountMinor: 12_345,
        currency: "TRY"
      })
    });
    expect(recorded.duplicate).toBe(false);
    expect(recorded.event.status).toBe("processed");
    expect(duplicate.duplicate).toBe(true);
  });

  async function consumeMatchingEvent(eventId: string) {
    const kafka = new Kafka({ clientId: `spendlens-live-consumer-${randomUUID()}`, brokers });
    const consumer = kafka.consumer({ groupId: `spendlens-live-${randomUUID()}`, allowAutoTopicCreation: true });
    consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: "expense.created", fromBeginning: true });

    return new Promise<ReturnType<typeof parseKafkaEventEnvelope>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`LIVE_KAFKA_EVENT_NOT_CONSUMED:${eventId}`));
      }, 30_000);

      consumer
        .run({
          eachMessage: async ({ message }) => {
            const envelope = parseKafkaEventEnvelope(message.value);
            if (envelope.id !== eventId) return;
            clearTimeout(timeout);
            resolve(envelope);
          }
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }
});

function principalFor(tenantId: string): AuthPrincipal {
  return {
    tenantId,
    userId: `user-${tenantId}`,
    sessionId: `session-${tenantId}`,
    email: "redpanda-live@example.test",
    displayName: "Redpanda Live",
    roles: ["OWNER"],
    permissions: []
  };
}
