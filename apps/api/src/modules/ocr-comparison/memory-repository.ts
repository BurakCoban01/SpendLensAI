import { randomUUID } from "node:crypto";
import type { OcrComparisonRepository, OcrMetricSample, PersistedOcrComparison, StoredOcrEngineRun, StoredOcrJob } from "./types";

export class InMemoryOcrComparisonRepository implements OcrComparisonRepository {
  public readonly comparisons: PersistedOcrComparison[] = [];

  async createComparison(input: Parameters<OcrComparisonRepository["createComparison"]>[0]): Promise<PersistedOcrComparison> {
    const now = new Date();
    const job: StoredOcrJob = {
      id: randomUUID(),
      tenantId: input.tenantId,
      documentFileId: input.documentFileId,
      status: "SUCCEEDED",
      requestedEngines: input.candidates.map((candidate) => candidate.engine),
      progress: 100,
      failureReason: null,
      createdAt: now,
      startedAt: now,
      completedAt: now
    };
    const candidateRuns = input.candidates.map((candidate): StoredOcrEngineRun => ({
      id: randomUUID(),
      tenantId: input.tenantId,
      ocrJobId: job.id,
      engine: candidate.engine,
      status: candidate.failed ? "FAILED" : "SUCCEEDED",
      normalizedJson: toJsonSafe({ text: candidate.text, tokens: candidate.tokens ?? [], metadata: candidate.metadata ?? {} }),
      confidence: candidate.failed ? null : candidate.confidence.toFixed(4),
      latencyMs: candidate.latencyMs ?? null,
      failureReason: candidate.failureReason ?? null,
      createdAt: now,
      completedAt: now
    }));
    const ensembleRun: StoredOcrEngineRun = {
      id: randomUUID(),
      tenantId: input.tenantId,
      ocrJobId: job.id,
      engine: "ENSEMBLE",
      status: "SUCCEEDED",
      normalizedJson: toJsonSafe(input.comparison),
      confidence: input.comparison.averageConfidence.toFixed(4),
      latencyMs: null,
      failureReason: null,
      createdAt: now,
      completedAt: now
    };
    const persisted = { job, runs: [...candidateRuns, ensembleRun], comparison: input.comparison };
    this.comparisons.push(persisted);
    return persisted;
  }

  async listByDocument(tenantId: string, documentFileId: string): Promise<Array<{ job: StoredOcrJob; runs: StoredOcrEngineRun[] }>> {
    return this.comparisons
      .filter((comparison) => comparison.job.tenantId === tenantId && comparison.job.documentFileId === documentFileId)
      .map((comparison) => ({ job: comparison.job, runs: comparison.runs }));
  }

  async metrics(): Promise<{
    runsByEngineStatus: OcrMetricSample[];
    confidenceByEngine: OcrMetricSample[];
    latencyByEngine: OcrMetricSample[];
  }> {
    const runs = this.comparisons.flatMap((comparison) => comparison.runs);
    const byEngineStatus = new Map<string, OcrMetricSample>();
    const confidence = new Map<string, { count: number; sum: number; sample: OcrMetricSample }>();
    const latency = new Map<string, { count: number; sum: number; sample: OcrMetricSample }>();
    for (const run of runs) {
      const statusKey = `${run.engine}:${run.status}`;
      const statusSample = byEngineStatus.get(statusKey);
      if (statusSample) {
        statusSample.count = (statusSample.count ?? 0) + 1;
      } else {
        byEngineStatus.set(statusKey, { engine: run.engine, status: run.status, count: 1 });
      }
      if (run.confidence !== null) {
        const existing = confidence.get(run.engine) ?? { count: 0, sum: 0, sample: { engine: run.engine, averageConfidence: 0 } };
        existing.count += 1;
        existing.sum += Number(run.confidence);
        existing.sample.averageConfidence = existing.sum / existing.count;
        confidence.set(run.engine, existing);
      }
      if (run.latencyMs !== null) {
        const existing = latency.get(run.engine) ?? { count: 0, sum: 0, sample: { engine: run.engine, averageLatencyMs: 0 } };
        existing.count += 1;
        existing.sum += run.latencyMs;
        existing.sample.averageLatencyMs = existing.sum / existing.count;
        latency.set(run.engine, existing);
      }
    }
    return {
      runsByEngineStatus: [...byEngineStatus.values()].sort(compareOcrMetricSamples),
      confidenceByEngine: [...confidence.values()].map((row) => row.sample).sort(compareOcrMetricSamples),
      latencyByEngine: [...latency.values()].map((row) => row.sample).sort(compareOcrMetricSamples)
    };
  }
}

function toJsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested)));
}

function compareOcrMetricSamples(left: OcrMetricSample, right: OcrMetricSample): number {
  return `${left.engine ?? ""}:${left.status ?? ""}`.localeCompare(`${right.engine ?? ""}:${right.status ?? ""}`);
}
