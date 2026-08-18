import { randomUUID } from "node:crypto";
import type { ExtractionRepository, PersistedExtraction, StoredExtractionJob } from "./types";
import { toPersistedFields } from "./persistence";

export class InMemoryExtractionRepository implements ExtractionRepository {
  public readonly extractions: PersistedExtraction[] = [];

  async createFromReceiptFields(input: Parameters<ExtractionRepository["createFromReceiptFields"]>[0]): Promise<PersistedExtraction> {
    const now = new Date();
    const job: StoredExtractionJob = {
      id: randomUUID(),
      tenantId: input.tenantId,
      documentFileId: input.documentFileId,
      ocrJobId: null,
      status: "SUCCEEDED",
      confidence: input.extracted.confidence.toFixed(4),
      failureReason: null,
      createdAt: now,
      completedAt: now
    };
    const persisted = {
      job,
      fields: toPersistedFields(input.extracted, input.sourceEngine, input.reviewState ?? null),
      issues: input.extracted.validationIssues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message
      })),
      extracted: input.extracted,
      reviewState: input.reviewState ?? null
    };
    this.extractions.push(persisted);
    return persisted;
  }

  async findLatestByDocument(tenantId: string, documentFileId: string): Promise<PersistedExtraction | null> {
    return (
      [...this.extractions]
        .reverse()
        .find((extraction) => extraction.job.tenantId === tenantId && extraction.job.documentFileId === documentFileId) ?? null
    );
  }
}
