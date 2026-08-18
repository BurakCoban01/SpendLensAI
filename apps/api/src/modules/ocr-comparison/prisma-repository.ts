import { Prisma, PrismaClient } from "@prisma/client";
import type { OcrComparisonRepository, OcrMetricSample, PersistedOcrComparison, StoredOcrEngineRun, StoredOcrJob } from "./types";

export class PrismaOcrComparisonRepository implements OcrComparisonRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createComparison(input: Parameters<OcrComparisonRepository["createComparison"]>[0]): Promise<PersistedOcrComparison> {
    const now = new Date();
    const candidatePayloads = input.candidates.map((candidate) => ({
      candidate,
      normalizedJson: toJsonSafe({ text: candidate.text, tokens: candidate.tokens ?? [], metadata: candidate.metadata ?? {} }),
      confidence: candidate.failed ? null : new Prisma.Decimal(candidate.confidence.toFixed(4))
    }));
    const ensemblePayload = {
      normalizedJson: toJsonSafe(input.comparison),
      confidence: new Prisma.Decimal(input.comparison.averageConfidence.toFixed(4))
    };

    return this.prisma.$transaction(async (tx) => {
      const job = await tx.oCRJob.create({
        data: {
          tenantId: input.tenantId,
          documentFileId: input.documentFileId,
          requestedEngines: input.candidates.map((candidate) => candidate.engine),
          status: "SUCCEEDED",
          progress: 100,
          startedAt: now,
          completedAt: now
        }
      });

      const candidateRuns = await Promise.all(
        candidatePayloads.map(({ candidate, normalizedJson, confidence }) =>
          tx.oCREngineRun.create({
            data: {
              tenantId: input.tenantId,
              ocrJobId: job.id,
              engine: candidate.engine,
              status: candidate.failed ? "FAILED" : "SUCCEEDED",
              normalizedJson,
              confidence,
              latencyMs: candidate.latencyMs ?? null,
              failureReason: candidate.failureReason ?? null,
              completedAt: now
            }
          })
        )
      );

      const ensembleRun = await tx.oCREngineRun.create({
        data: {
          tenantId: input.tenantId,
          ocrJobId: job.id,
          engine: "ENSEMBLE",
          status: "SUCCEEDED",
          normalizedJson: ensemblePayload.normalizedJson,
          confidence: ensemblePayload.confidence,
          completedAt: now
        }
      });

      await tx.oCRConfidenceScore.create({
        data: {
          tenantId: input.tenantId,
          engineRunId: ensembleRun.id,
          scope: "ensemble.average",
          score: new Prisma.Decimal(input.comparison.averageConfidence.toFixed(4)),
          reason: input.comparison.conflictFields.length > 0 ? `conflicts:${input.comparison.conflictFields.join(",")}` : "no-conflicts"
        }
      });

      return {
        job: serializeJob(job),
        runs: [...candidateRuns, ensembleRun].map(serializeRun),
        comparison: input.comparison
      };
    }, { timeout: 20_000 });
  }

  async listByDocument(tenantId: string, documentFileId: string): Promise<Array<{ job: StoredOcrJob; runs: StoredOcrEngineRun[] }>> {
    const jobs = await this.prisma.oCRJob.findMany({
      where: { tenantId, documentFileId },
      orderBy: { createdAt: "desc" }
    });
    if (jobs.length === 0) return [];
    const runs = await this.prisma.oCREngineRun.findMany({
      where: { tenantId, ocrJobId: { in: jobs.map((job) => job.id) } },
      orderBy: { createdAt: "asc" }
    });
    const runsByJob = new Map<string, StoredOcrEngineRun[]>();
    for (const run of runs) {
      runsByJob.set(run.ocrJobId, [...(runsByJob.get(run.ocrJobId) ?? []), serializeRun(run)]);
    }
    return jobs.map((job) => ({ job: serializeJob(job), runs: runsByJob.get(job.id) ?? [] }));
  }

  async metrics(): Promise<{
    runsByEngineStatus: OcrMetricSample[];
    confidenceByEngine: OcrMetricSample[];
    latencyByEngine: OcrMetricSample[];
  }> {
    const statusRows = await this.prisma.oCREngineRun.groupBy({
      by: ["engine", "status"],
      _count: { _all: true }
    });
    const confidenceRows = await this.prisma.oCREngineRun.groupBy({
      by: ["engine"],
      where: { confidence: { not: null } },
      _avg: { confidence: true }
    });
    const latencyRows = await this.prisma.oCREngineRun.groupBy({
      by: ["engine"],
      where: { latencyMs: { not: null } },
      _avg: { latencyMs: true }
    });
    return {
      runsByEngineStatus: statusRows
        .map((row) => ({ engine: row.engine, status: row.status, count: row._count._all }))
        .sort(compareOcrMetricSamples),
      confidenceByEngine: confidenceRows
        .map((row) => ({ engine: row.engine, averageConfidence: row._avg.confidence ? Number(row._avg.confidence.toString()) : null }))
        .sort(compareOcrMetricSamples),
      latencyByEngine: latencyRows
        .map((row) => ({ engine: row.engine, averageLatencyMs: row._avg.latencyMs }))
        .sort(compareOcrMetricSamples)
    };
  }
}

function serializeJob(job: {
  id: string;
  tenantId: string;
  documentFileId: string;
  status: StoredOcrJob["status"];
  requestedEngines: string[];
  progress: number;
  failureReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): StoredOcrJob {
  return job;
}

function serializeRun(run: {
  id: string;
  tenantId: string;
  ocrJobId: string;
  engine: StoredOcrEngineRun["engine"];
  status: StoredOcrEngineRun["status"];
  normalizedJson: unknown;
  confidence: Prisma.Decimal | null;
  latencyMs: number | null;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): StoredOcrEngineRun {
  return {
    ...run,
    confidence: run.confidence?.toString() ?? null
  };
}

function toJsonSafe(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested))) as Prisma.InputJsonValue;
}

function compareOcrMetricSamples(left: OcrMetricSample, right: OcrMetricSample): number {
  return `${left.engine ?? ""}:${left.status ?? ""}`.localeCompare(`${right.engine ?? ""}:${right.status ?? ""}`);
}
