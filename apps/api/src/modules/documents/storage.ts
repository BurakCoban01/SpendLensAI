import { Client as MinioClient, CopyDestinationOptions, CopySourceOptions } from "minio";
import type { ComposeObjectInput, DocumentStorage, DocumentStorageMetrics, PutObjectInput } from "./types";

export class InMemoryDocumentStorage implements DocumentStorage {
  private objects = new Map<string, { body: Buffer; mimeType: string; metadata: Record<string, string> }>();

  async putObject(input: PutObjectInput): Promise<void> {
    this.objects.set(storageKey(input.bucket, input.objectKey), {
      body: Buffer.from(input.body),
      mimeType: input.mimeType,
      metadata: input.metadata
    });
  }

  async composeObject(input: ComposeObjectInput): Promise<void> {
    const parts = input.sources.map((source) => {
      const object = this.objects.get(storageKey(source.bucket, source.objectKey));
      if (!object) throw new Error("OBJECT_NOT_FOUND");
      return object.body;
    });
    this.objects.set(storageKey(input.bucket, input.objectKey), {
      body: Buffer.concat(parts),
      mimeType: input.mimeType,
      metadata: input.metadata
    });
  }

  async createSignedGetUrl(input: { bucket: string; objectKey: string; expiresInSeconds: number }): Promise<string> {
    if (!this.objects.has(storageKey(input.bucket, input.objectKey))) {
      throw new Error("OBJECT_NOT_FOUND");
    }
    return `memory://${input.bucket}/${encodeURIComponent(input.objectKey)}?expiresIn=${input.expiresInSeconds}`;
  }

  async getObject(input: { bucket: string; objectKey: string }): Promise<Buffer> {
    const object = this.objects.get(storageKey(input.bucket, input.objectKey));
    if (!object) throw new Error("OBJECT_NOT_FOUND");
    return Buffer.from(object.body);
  }

  async removeObject(input: { bucket: string; objectKey: string }): Promise<void> {
    this.objects.delete(storageKey(input.bucket, input.objectKey));
  }

  async metrics(): Promise<DocumentStorageMetrics> {
    return {
      health: { backend: "memory", connected: true },
      storedObjectCount: this.objects.size,
      operationErrors: []
    };
  }

  hasObject(bucket: string, objectKey: string): boolean {
    return this.objects.has(storageKey(bucket, objectKey));
  }

  readObject(bucket: string, objectKey: string): Buffer | null {
    return this.objects.get(storageKey(bucket, objectKey))?.body ?? null;
  }

  readObjectMetadata(bucket: string, objectKey: string): Record<string, string> | null {
    const metadata = this.objects.get(storageKey(bucket, objectKey))?.metadata;
    return metadata ? { ...metadata } : null;
  }
}

export class MinioDocumentStorage implements DocumentStorage {
  private readonly operationErrors = new Map<string, number>();

  constructor(private readonly client: MinioClient) {}

  static fromEndpoint(input: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
  }): MinioDocumentStorage {
    const url = new URL(input.endpoint);
    return new MinioDocumentStorage(
      new MinioClient({
        endPoint: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
        useSSL: url.protocol === "https:",
        accessKey: input.accessKey,
        secretKey: input.secretKey
      })
    );
  }

  async putObject(input: PutObjectInput): Promise<void> {
    await this.trackOperation("put_object", async () => {
      await this.ensureBucket(input.bucket);
      await this.client.putObject(input.bucket, input.objectKey, input.body, input.body.byteLength, {
        "Content-Type": input.mimeType,
        ...input.metadata
      });
    });
  }

  async composeObject(input: ComposeObjectInput): Promise<void> {
    await this.trackOperation("compose_object", async () => {
      await this.ensureBucket(input.bucket);
      await this.client.composeObject(
        new CopyDestinationOptions({
          Bucket: input.bucket,
          Object: input.objectKey,
          UserMetadata: {
            "Content-Type": input.mimeType,
            ...input.metadata
          },
          MetadataDirective: "REPLACE"
        }),
        input.sources.map(
          (source) =>
            new CopySourceOptions({
              Bucket: source.bucket,
              Object: source.objectKey
            })
        )
      );
    });
  }

  async createSignedGetUrl(input: { bucket: string; objectKey: string; expiresInSeconds: number }): Promise<string> {
    return this.trackOperation("signed_get_url", () =>
      this.client.presignedGetObject(input.bucket, input.objectKey, input.expiresInSeconds)
    );
  }

  async getObject(input: { bucket: string; objectKey: string }): Promise<Buffer> {
    return this.trackOperation("get_object", async () => {
      const stream = await this.client.getObject(input.bucket, input.objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    });
  }

  async removeObject(input: { bucket: string; objectKey: string }): Promise<void> {
    await this.trackOperation("remove_object", () => this.client.removeObject(input.bucket, input.objectKey));
  }

  async metrics(): Promise<DocumentStorageMetrics> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.client.listBuckets();
        return {
          health: { backend: "minio", connected: true },
          operationErrors: this.operationErrorCounts()
        };
      } catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(50 * (attempt + 1));
      }
    }
    this.recordOperationError("health");
    return {
      health: {
        backend: "minio",
        connected: false,
        detail: lastError instanceof Error ? lastError.message : "MINIO_UNAVAILABLE"
      },
      operationErrors: this.operationErrorCounts()
    };
  }

  private async ensureBucket(bucket: string): Promise<void> {
    if (!(await this.client.bucketExists(bucket))) {
      await this.client.makeBucket(bucket);
    }
  }

  private async trackOperation<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.recordOperationError(operation);
      throw error;
    }
  }

  private recordOperationError(operation: string): void {
    this.operationErrors.set(operation, (this.operationErrors.get(operation) ?? 0) + 1);
  }

  private operationErrorCounts(): Array<{ operation: string; count: number }> {
    return [...this.operationErrors.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([operation, count]) => ({ operation, count }));
  }
}

function storageKey(bucket: string, objectKey: string): string {
  return `${bucket}:${objectKey}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
