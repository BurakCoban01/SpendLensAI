import { PrismaClient } from "@prisma/client";
import { assertKafkaTopic, kafkaTopics, type KafkaTopic } from "@spendlens/shared";
import { Kafka, type Consumer, type EachMessagePayload } from "kafkajs";
import { z } from "zod";
import { loadConfig } from "./config";
import { PrismaEventInboxRepository } from "./modules/events/prisma-repository";
import type { EventEnvelope, EventInboxRepository, StoredInboxEvent } from "./modules/events/types";

type Logger = {
  info(message: unknown): void;
  error(message: unknown): void;
};

type KafkaMessageValue = Buffer | Uint8Array | string | null;

export type KafkaEventConsumerConfig = {
  brokers: string[];
  clientId: string;
  groupId: string;
  consumerName: string;
  topics: KafkaTopic[];
};

export type KafkaEventConsumerResult = {
  event: StoredInboxEvent;
  duplicate: boolean;
};

const EventEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    topic: z.string().min(1),
    tenantId: z.string().min(1),
    aggregateId: z.string().min(1),
    schemaVersion: z.number().int().positive().default(1),
    correlationId: z.string().min(1),
    payload: z.record(z.unknown()).default({})
  })
  .passthrough();

export function loadKafkaEventConsumerConfig(env: NodeJS.ProcessEnv = process.env): KafkaEventConsumerConfig {
  const brokers = parseCsv(env.KAFKA_BROKERS);
  if (brokers.length === 0) throw new Error("EVENT_CONSUMER_KAFKA_BROKERS_REQUIRED");

  return {
    brokers,
    clientId: normalizeRuntimeId(env.EVENT_CONSUMER_CLIENT_ID?.trim() || "spendlens-event-consumer"),
    groupId: normalizeRuntimeId(env.EVENT_CONSUMER_GROUP_ID?.trim() || "spendlens-event-consumers"),
    consumerName: normalizeRuntimeId(env.EVENT_CONSUMER_NAME?.trim() || "spendlens-event-consumer"),
    topics: parseTopics(env.EVENT_CONSUMER_TOPICS)
  };
}

export function parseKafkaEventEnvelope(value: KafkaMessageValue): EventEnvelope {
  const text = messageValueToString(value);
  if (!text) throw new Error("EVENT_CONSUMER_EMPTY_MESSAGE");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("EVENT_CONSUMER_INVALID_JSON");
  }

  const envelope = EventEnvelopeSchema.parse(parsed);
  return {
    id: envelope.id,
    topic: assertKafkaTopic(envelope.topic),
    tenantId: envelope.tenantId,
    aggregateId: envelope.aggregateId,
    schemaVersion: envelope.schemaVersion,
    correlationId: envelope.correlationId,
    payload: envelope.payload
  };
}

export async function recordKafkaEvent(input: {
  inboxRepository: EventInboxRepository;
  consumerName: string;
  event: EventEnvelope;
}): Promise<KafkaEventConsumerResult> {
  return input.inboxRepository.record({
    tenantId: input.event.tenantId,
    consumerName: normalizeRuntimeId(input.consumerName),
    event: input.event,
    status: "processed"
  });
}

export class KafkaEventConsumerRunner {
  private consumer: Consumer | null = null;

  constructor(
    private readonly config: KafkaEventConsumerConfig,
    private readonly inboxRepository: EventInboxRepository,
    private readonly logger: Logger = console
  ) {}

  async start(): Promise<void> {
    const kafka = new Kafka({ clientId: this.config.clientId, brokers: this.config.brokers });
    this.consumer = kafka.consumer({ groupId: this.config.groupId, allowAutoTopicCreation: false });
    await this.consumer.connect();
    for (const topic of this.config.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }
    await this.consumer.run({
      eachMessage: async (payload) => {
        await this.handleMessage(payload);
      }
    });
    this.logger.info(
      JSON.stringify({
        level: "info",
        msg: "event_consumer_started",
        groupId: this.config.groupId,
        consumerName: this.config.consumerName,
        topics: this.config.topics
      })
    );
  }

  async stop(): Promise<void> {
    await this.consumer?.disconnect();
    this.consumer = null;
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    let event: EventEnvelope;
    try {
      event = parseKafkaEventEnvelope(payload.message.value);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          level: "error",
          msg: "event_consumer_invalid_message",
          topic: payload.topic,
          partition: payload.partition,
          offset: payload.message.offset,
          error: error instanceof Error ? error.message : "EVENT_CONSUMER_PARSE_FAILED"
        })
      );
      return;
    }

    const result = await recordKafkaEvent({
      inboxRepository: this.inboxRepository,
      consumerName: this.config.consumerName,
      event
    });
    this.logger.info(
      JSON.stringify({
        level: "info",
        msg: "event_consumer_inbox_recorded",
        topic: event.topic,
        tenantId: event.tenantId,
        eventId: event.id,
        duplicate: result.duplicate,
        inboxEventId: result.event.id
      })
    );
  }
}

async function main(): Promise<void> {
  loadConfig();
  const config = loadKafkaEventConsumerConfig();
  const prisma = new PrismaClient();
  const runner = new KafkaEventConsumerRunner(config, new PrismaEventInboxRepository(prisma));

  const stop = waitForStopSignal();
  await runner.start();
  await stop;
  await runner.stop();
  await prisma.$disconnect();
}

function parseTopics(value: string | undefined): KafkaTopic[] {
  const topics = parseCsv(value);
  if (topics.length === 0) return [...kafkaTopics];
  return [...new Set(topics.map((topic) => assertKafkaTopic(topic)))];
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function messageValueToString(value: KafkaMessageValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value.trim();
  return Buffer.from(value).toString("utf8").trim();
}

function normalizeRuntimeId(value: string): string {
  if (!/^[a-zA-Z0-9._:-]{2,120}$/.test(value)) throw new Error("INVALID_EVENT_CONSUMER_RUNTIME_ID");
  return value;
}

function waitForStopSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "event_consumer_failed",
        error: error instanceof Error ? error.message : "UNKNOWN_EVENT_CONSUMER_ERROR"
      })
    );
    process.exitCode = 1;
  });
}
