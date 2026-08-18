import type { JobStatus, ModelStatus, OCREngineCode } from "@prisma/client";

export type StoredModelVersion = {
  id: string;
  tenantId: string;
  name: string;
  engine: OCREngineCode;
  status: ModelStatus;
  artifactBucket: string | null;
  artifactKey: string | null;
  metrics: unknown;
  promotedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredModelTrainingRun = {
  id: string;
  tenantId: string;
  modelVersionId: string | null;
  datasetId: string | null;
  status: JobStatus;
  profile: string;
  seed: number;
  metrics: unknown;
  logsKey: string | null;
  failureReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type StoredModelEvaluationRun = {
  id: string;
  tenantId: string;
  modelVersionId: string | null;
  datasetId: string | null;
  status: JobStatus;
  metrics: unknown;
  reportKey: string | null;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type CreateModelVersionInput = {
  tenantId: string;
  name: string;
  engine: OCREngineCode;
  status?: ModelStatus;
  artifactBucket?: string | null;
  artifactKey?: string | null;
  metrics?: unknown;
};

export type ModelRepository = {
  listModelVersions(input: { tenantId: string }): Promise<StoredModelVersion[]>;
  findModelVersion(input: { tenantId: string; modelVersionId: string }): Promise<StoredModelVersion | null>;
  createModelVersion(input: CreateModelVersionInput): Promise<StoredModelVersion>;
  updateModelVersionMetrics(input: { tenantId: string; modelVersionId: string; metrics: unknown }): Promise<StoredModelVersion | null>;
  promoteModelVersion(input: { tenantId: string; modelVersionId: string }): Promise<StoredModelVersion | null>;
  createTrainingRun(input: { tenantId: string; profile: string; seed: number; datasetId?: string | null }): Promise<StoredModelTrainingRun>;
  completeTrainingRun(input: {
    tenantId: string;
    trainingRunId: string;
    modelVersionId: string;
    metrics: unknown;
    logsKey?: string | null;
  }): Promise<StoredModelTrainingRun | null>;
  failTrainingRun(input: { tenantId: string; trainingRunId: string; failureReason: string }): Promise<StoredModelTrainingRun | null>;
  listTrainingRuns(input: { tenantId: string }): Promise<StoredModelTrainingRun[]>;
  createEvaluationRun(input: {
    tenantId: string;
    modelVersionId: string;
    metrics: unknown;
    reportKey?: string | null;
  }): Promise<StoredModelEvaluationRun>;
  listEvaluationRuns(input: { tenantId: string; modelVersionId?: string }): Promise<StoredModelEvaluationRun[]>;
};

export type CategoryTrainingResult = {
  metrics: Record<string, unknown>;
  artifactBucket: string;
  artifactKey: string;
  reportKey: string;
};

export type CategoryTrainingRunner = (input: {
  tenantId: string;
  trainingRunId: string;
  seed: number;
  samplesPerCategory: number;
}) => Promise<CategoryTrainingResult>;

export type CustomOcrTrainingRunner = (input: {
  tenantId: string;
  trainingRunId: string;
  seed: number;
  samples: number;
  epochs: number;
  profile?: string;
  datasetExport?: {
    exportJobId: string;
    workspaceId: string;
    bucket: string | null;
    objectKey: string;
  };
}) => Promise<CategoryTrainingResult>;

export type CategoryEvaluationResult = {
  metrics: Record<string, unknown>;
  artifactBucket: string;
  artifactKey: string;
  reportKey: string;
};

export type CategoryEvaluationRunner = (input: {
  tenantId: string;
  modelVersionId: string;
  artifactKey: string | null;
  modelPath: string | null;
  samplesPerCategory: number;
  seed: number;
  split: "all" | "train" | "validation" | "test";
}) => Promise<CategoryEvaluationResult>;

export type OcrBenchmarkResult = {
  metrics: Record<string, unknown>;
  artifactBucket: string;
  artifactKey: string;
  reportKey: string;
};

export type OcrBenchmarkRunner = (input: {
  tenantId: string;
  modelVersionId: string;
  artifactKey: string | null;
  checkpoint: string | null;
  samples: number;
  seed: number;
  split: "all" | "train" | "validation" | "test";
  skipTesseract: boolean;
}) => Promise<OcrBenchmarkResult>;
