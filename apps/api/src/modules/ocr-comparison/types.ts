import type { JobStatus, OCREngineCode } from "@prisma/client";
import type { OcrComparisonResult } from "@spendlens/shared";

export type OcrCandidateInput = {
  engine: Exclude<OCREngineCode, "ENSEMBLE">;
  text: string;
  confidence: number;
  tokens?: Array<{
    text: string;
    confidence: number;
    bbox: [number, number, number, number];
    pageNumber?: number | undefined;
  }>;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
  failed?: boolean;
  failureReason?: string;
};

export type StoredOcrJob = {
  id: string;
  tenantId: string;
  documentFileId: string;
  status: JobStatus;
  requestedEngines: string[];
  progress: number;
  failureReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type StoredOcrEngineRun = {
  id: string;
  tenantId: string;
  ocrJobId: string;
  engine: OCREngineCode;
  status: JobStatus;
  normalizedJson: unknown;
  confidence: string | null;
  latencyMs: number | null;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type PersistedOcrComparison = {
  job: StoredOcrJob;
  runs: StoredOcrEngineRun[];
  comparison: OcrComparisonResult;
};

export type OcrMetricSample = {
  engine?: OCREngineCode;
  status?: JobStatus;
  count?: number;
  averageConfidence?: number | null;
  averageLatencyMs?: number | null;
};

export type OcrMetricsSnapshot = {
  runsByEngineStatus: OcrMetricSample[];
  confidenceByEngine: OcrMetricSample[];
  latencyByEngine: OcrMetricSample[];
};

export type OcrComparisonRepository = {
  createComparison(input: {
    tenantId: string;
    documentFileId: string;
    candidates: OcrCandidateInput[];
    comparison: OcrComparisonResult;
  }): Promise<PersistedOcrComparison>;
  listByDocument(tenantId: string, documentFileId: string): Promise<Array<{ job: StoredOcrJob; runs: StoredOcrEngineRun[] }>>;
  metrics(): Promise<OcrMetricsSnapshot>;
};
