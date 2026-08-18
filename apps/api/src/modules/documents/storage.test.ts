import { describe, expect, it, vi } from "vitest";
import { MinioDocumentStorage } from "./storage";

describe("MinioDocumentStorage", () => {
  it("retries transient health check failures before reporting disconnected", async () => {
    const client = {
      listBuckets: vi.fn().mockRejectedValueOnce(new Error("read ECONNRESET")).mockResolvedValueOnce([])
    };
    const storage = new MinioDocumentStorage(client as never);

    const metrics = await storage.metrics();

    expect(metrics.health).toEqual({ backend: "minio", connected: true });
    expect(metrics.operationErrors).toEqual([]);
    expect(client.listBuckets).toHaveBeenCalledTimes(2);
  });

  it("reports MinIO disconnected after retry attempts are exhausted", async () => {
    const client = {
      listBuckets: vi.fn().mockRejectedValue(new Error("MINIO_DOWN"))
    };
    const storage = new MinioDocumentStorage(client as never);

    const metrics = await storage.metrics();

    expect(metrics.health).toEqual({ backend: "minio", connected: false, detail: "MINIO_DOWN" });
    expect(metrics.operationErrors).toEqual([{ operation: "health", count: 1 }]);
    expect(client.listBuckets).toHaveBeenCalledTimes(3);
  });
});
