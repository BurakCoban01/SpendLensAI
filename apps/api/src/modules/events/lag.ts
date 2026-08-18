import { Kafka, type Admin } from "kafkajs";
import type { KafkaConsumerLagProvider, KafkaConsumerLagSample } from "./types";

type TopicOffset = {
  partition: number;
  offset: string;
};

type GroupOffset = {
  topic: string;
  partitions: Array<{
    partition: number;
    offset: string;
  }>;
};

export class KafkaJsConsumerLagProvider implements KafkaConsumerLagProvider {
  private admin: Admin | null = null;

  constructor(
    private readonly brokers: string[],
    private readonly groupIds: string[],
    private readonly topics: string[],
    private readonly clientId = "spendlens-api-lag"
  ) {}

  async metrics() {
    if (this.groupIds.length === 0 || this.topics.length === 0) return { samples: [] };
    const admin = await this.getAdmin();
    const topicOffsets = new Map<string, TopicOffset[]>();
    for (const topic of this.topics) {
      topicOffsets.set(topic, await admin.fetchTopicOffsets(topic));
    }

    const samples: KafkaConsumerLagSample[] = [];
    for (const groupId of this.groupIds) {
      const offsets = (await admin.fetchOffsets({
        groupId,
        topics: this.topics
      })) as GroupOffset[];
      for (const groupTopic of offsets) {
        const highWatermarks = new Map(
          (topicOffsets.get(groupTopic.topic) ?? []).map((offset) => [offset.partition, parseOffset(offset.offset)])
        );
        for (const partition of groupTopic.partitions) {
          const currentOffset = parseOffset(partition.offset);
          const highWatermark = highWatermarks.get(partition.partition) ?? currentOffset;
          samples.push({
            groupId,
            topic: groupTopic.topic,
            partition: partition.partition,
            currentOffset,
            highWatermark,
            lag: Math.max(0, highWatermark - currentOffset)
          });
        }
      }
    }

    return { samples: samples.sort(compareSamples) };
  }

  async close(): Promise<void> {
    await this.admin?.disconnect();
    this.admin = null;
  }

  private async getAdmin(): Promise<Admin> {
    if (this.admin) return this.admin;
    const kafka = new Kafka({ clientId: this.clientId, brokers: this.brokers });
    this.admin = kafka.admin();
    await this.admin.connect();
    return this.admin;
  }
}

export function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOffset(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function compareSamples(left: KafkaConsumerLagSample, right: KafkaConsumerLagSample): number {
  return `${left.groupId}:${left.topic}:${left.partition}`.localeCompare(`${right.groupId}:${right.topic}:${right.partition}`);
}
