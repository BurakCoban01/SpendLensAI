import { Kafka, type Producer } from "kafkajs";
import type { EventProducer, EventProducerMessage } from "./types";

export class KafkaJsEventProducer implements EventProducer {
  private producer: Producer | null = null;

  constructor(
    private readonly brokers: string[],
    private readonly clientId = "spendlens-api"
  ) {}

  async send(message: EventProducerMessage): Promise<void> {
    const producer = await this.getProducer();
    await producer.send({
      topic: message.topic,
      messages: [
        {
          key: message.key,
          value: JSON.stringify(message.value),
          headers: message.headers
        }
      ]
    });
  }

  async close(): Promise<void> {
    await this.producer?.disconnect();
    this.producer = null;
  }

  private async getProducer(): Promise<Producer> {
    if (this.producer) return this.producer;
    const kafka = new Kafka({ clientId: this.clientId, brokers: this.brokers });
    this.producer = kafka.producer({ allowAutoTopicCreation: true, idempotent: false });
    await this.producer.connect();
    return this.producer;
  }
}

export class RecordingEventProducer implements EventProducer {
  readonly messages: EventProducerMessage[] = [];
  failTopics = new Set<string>();

  async send(message: EventProducerMessage): Promise<void> {
    this.messages.push(message);
    if (this.failTopics.has(message.topic)) throw new Error(`PRODUCER_FAILED:${message.topic}`);
  }
}
