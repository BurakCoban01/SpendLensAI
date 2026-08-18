import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CategoryEvaluationRunner, CategoryTrainingRunner, CustomOcrTrainingRunner, OcrBenchmarkRunner } from "./types";

const execFileAsync = promisify(execFile);
const projectRoot = findProjectRoot();
const defaultNumericCharacterCheckpoint = "artifacts/models/local-full-20260620-ocr/numeric-char-cnn-v1/char-cnn.pt";
const defaultCharacterLineCheckpoint = "artifacts/models/custom-char-cnn-project-real-v1/char-cnn.pt";

export function pythonExecOptions() {
  return {
    cwd: projectRoot,
    env: {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH ? `${projectRoot}${pathDelimiter()}${process.env.PYTHONPATH}` : projectRoot,
      PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
      OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "1",
      MKL_NUM_THREADS: process.env.MKL_NUM_THREADS ?? "1"
    }
  };
}

export const localCategoryTrainingRunner: CategoryTrainingRunner = async (input) => {
  const runKey = `${input.tenantId}-${input.trainingRunId}-${randomUUID()}`;
  const dataPath = join("data", "generated", "category-api", runKey, "expenses.csv");
  const artifactDir = join("artifacts", "models", "category-api", runKey);
  await execFileAsync(
    "python",
    [
      "-m",
      "services.ocr.category_model.train",
      "--data-path",
      dataPath,
      "--artifact-dir",
      artifactDir,
      "--samples-per-category",
      String(input.samplesPerCategory),
      "--seed",
      String(input.seed)
    ],
    pythonExecOptions()
  );
  const metrics = JSON.parse(await readFile(join(artifactDir, "metrics.json"), "utf8")) as Record<string, unknown>;
  return {
    metrics,
    artifactBucket: "local-artifacts",
    artifactKey: artifactDir.replace(/\\/g, "/"),
    reportKey: `${artifactDir.replace(/\\/g, "/")}/metrics.json`
  };
};

export const localCustomOcrTrainingRunner: CustomOcrTrainingRunner = async (input) => {
  const runKey = `${input.tenantId}-${input.trainingRunId}-${randomUUID()}`;
  const dataDir = join("data", "generated", "custom-ocr-api", runKey);
  const artifactDir = join("artifacts", "models", "custom-ocr-api", runKey);
  const isFull = input.profile === "custom-ocr-full-local";
  const fullDatasetArgs = fullCustomOcrDatasetArgs();
  const args = isFull
    ? [
        "-m",
        "services.ocr.custom_model.train_crnn",
        "--profile",
        "local_full",
        "--data-dir",
        dataDir,
        "--artifact-dir",
        artifactDir,
        "--samples",
        String(input.samples),
        "--epochs",
        String(input.epochs),
        "--seed",
        String(input.seed),
        "--batch-size",
        "8",
        "--early-stopping-patience",
        "2",
        ...fullDatasetArgs,
        "--field-oversample-factor",
        "3",
        "--blank-regularization",
        "0.05"
      ]
    : [
        "-m",
        "services.ocr.custom_model.train",
        "--data-dir",
        dataDir,
        "--artifact-dir",
        artifactDir,
        "--samples",
        String(input.samples),
        "--epochs",
        String(input.epochs),
        "--seed",
        String(input.seed)
      ];
  await execFileAsync("python", args, pythonExecOptions());
  const metrics = JSON.parse(await readFile(join(artifactDir, "metrics.json"), "utf8")) as Record<string, unknown>;
  return {
    metrics: {
      ...metrics,
      model: "custom-crnn-ctc",
      engine: "CUSTOM_CRNN",
      seed: input.seed,
      training_profile: input.profile ?? "custom-ocr-smoke",
      ...(input.datasetExport ? { dataset_export: input.datasetExport } : {})
    },
    artifactBucket: "local-artifacts",
    artifactKey: artifactDir.replace(/\\/g, "/"),
    reportKey: `${artifactDir.replace(/\\/g, "/")}/metrics.json`
  };
};

export function ocrServiceCustomOcrTrainingRunner(
  baseUrl: string,
  fallbackRunner: CustomOcrTrainingRunner = localCustomOcrTrainingRunner
): CustomOcrTrainingRunner {
  return async (input) => {
    if (!baseUrl) throw new Error("OCR_SERVICE_CUSTOM_OCR_TRAINING_NOT_CONFIGURED");
    const endpoint =
      input.profile === "custom-ocr-full-local" ? "/models/custom-ocr/full-train" : "/models/custom-ocr/smoke-train";
    const url = new URL(endpoint, baseUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenant_id: input.tenantId,
          training_run_id: input.trainingRunId,
          seed: input.seed,
          samples: input.samples,
          epochs: input.epochs,
          profile: input.profile,
          dataset_export: input.datasetExport
        })
      });
    } catch (error) {
      return withOcrServiceFallbackMetadata(
        await fallbackRunner(input),
        `OCR service training endpoint unavailable (${error instanceof Error ? error.message : "fetch failed"}); used local runner.`
      );
    }
    if (response.status === 404) {
      return withOcrServiceFallbackMetadata(
        await fallbackRunner(input),
        `OCR service training endpoint ${endpoint} returned 404; used local runner.`
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OCR_SERVICE_CUSTOM_OCR_TRAINING_FAILED:${response.status}${detail ? `:${detail.slice(0, 500)}` : ""}`);
    }
    const body = (await response.json()) as {
      metrics?: Record<string, unknown>;
      artifactBucket?: string;
      artifactKey?: string;
      reportKey?: string;
    };
    if (!body.artifactBucket || !body.artifactKey || !body.reportKey) {
      throw new Error("OCR_SERVICE_CUSTOM_OCR_TRAINING_INVALID_RESPONSE");
    }
    return {
      metrics: {
        ...(body.metrics ?? {}),
        model: "custom-crnn-ctc",
        engine: "CUSTOM_CRNN",
        seed: input.seed,
        training_profile: input.profile ?? "custom-ocr-smoke",
        ...(input.datasetExport ? { dataset_export: input.datasetExport } : {})
      },
      artifactBucket: body.artifactBucket,
      artifactKey: body.artifactKey,
      reportKey: body.reportKey
    };
  };
}

function withOcrServiceFallbackMetadata(result: Awaited<ReturnType<CustomOcrTrainingRunner>>, note: string): Awaited<ReturnType<CustomOcrTrainingRunner>> {
  return {
    ...result,
    metrics: {
      ...result.metrics,
      ocr_service_fallback: {
        used: true,
        note
      }
    }
  };
}

export const localCategoryEvaluationRunner: CategoryEvaluationRunner = async (input) => {
  const runKey = `${input.tenantId}-${input.modelVersionId}-${randomUUID()}`;
  const dataPath = join("data", "generated", "category-evaluation-api", runKey, "expenses.csv");
  const outputDir = join("artifacts", "evaluations", "category-api", runKey);
  const reportPath = join(outputDir, "evaluation.json");
  if (!input.modelPath) throw new Error("CATEGORY_MODEL_ARTIFACT_UNAVAILABLE");
  await execFileAsync(
    "python",
    [
      "-m",
      "services.ocr.category_model.evaluate",
      "--data-path",
      dataPath,
      "--model-path",
      input.modelPath,
      "--report-path",
      reportPath,
      "--split",
      input.split,
      "--generate-if-missing",
      "--samples-per-category",
      String(input.samplesPerCategory),
      "--seed",
      String(input.seed)
    ],
    pythonExecOptions()
  );
  const metrics = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
  return {
    metrics,
    artifactBucket: "local-artifacts",
    artifactKey: outputDir.replace(/\\/g, "/"),
    reportKey: reportPath.replace(/\\/g, "/")
  };
};

export const localOcrBenchmarkRunner: OcrBenchmarkRunner = async (input) => {
  const runKey = `${input.tenantId}-${input.modelVersionId}-${randomUUID()}`;
  const realFixtureDir = join("docs", "KullanilanDokumanlar", "tr");
  const usesRealFixtures = existsSync(join(projectRoot, realFixtureDir, "ground-truth"));
  const dataDir = usesRealFixtures ? realFixtureDir : join("data", "generated", "ocr-benchmark-api", runKey);
  const outputDir = join("artifacts", "benchmarks", "ocr-api", runKey);
  const args = [
    "-m",
    "services.ocr.benchmarks.ocr_benchmark",
    "--dataset-mode",
    usesRealFixtures ? "real_fixtures" : "golden",
    "--data-dir",
    dataDir,
    "--output-dir",
    outputDir,
    "--samples",
    String(input.samples),
    "--seed",
    String(input.seed),
    "--split",
    input.split
  ];
  if (input.skipTesseract) args.push("--skip-tesseract");
  if (input.checkpoint) args.push("--checkpoint", input.checkpoint);
  args.push(...customOcrHelperCheckpointArgs());

  await execFileAsync("python", args, pythonExecOptions());
  const reportKey = `${outputDir.replace(/\\/g, "/")}/benchmark-report.json`;
  const report = JSON.parse(await readFile(join(outputDir, "benchmark-report.json"), "utf8")) as Record<string, unknown>;
  return {
    metrics: report,
    artifactBucket: "local-artifacts",
    artifactKey: outputDir.replace(/\\/g, "/"),
    reportKey
  };
};

export function customOcrHelperCheckpointArgs(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync
): string[] {
  const numericCheckpoint = configuredHelperCheckpoint(
    env.CUSTOM_OCR_NUMERIC_CHAR_CHECKPOINT,
    defaultNumericCharacterCheckpoint,
    fileExists
  );
  const characterCheckpoint = configuredHelperCheckpoint(
    env.CUSTOM_OCR_CHARACTER_CHECKPOINT,
    defaultCharacterLineCheckpoint,
    fileExists
  );
  const challengerCheckpoint = env.CUSTOM_OCR_CRNN_CHALLENGER_CHECKPOINT?.trim() || null;
  const challengerMode = env.CUSTOM_OCR_CRNN_CHALLENGER_MODE?.trim() || "shadow";
  return [
    ...(numericCheckpoint ? ["--numeric-char-checkpoint", numericCheckpoint] : []),
    ...(characterCheckpoint ? ["--character-checkpoint", characterCheckpoint] : []),
    ...(challengerCheckpoint ? ["--challenger-checkpoint", challengerCheckpoint, "--challenger-mode", challengerMode] : [])
  ];
}

function configuredHelperCheckpoint(
  configured: string | undefined,
  fallback: string,
  fileExists: (path: string) => boolean
): string | null {
  const explicit = configured?.trim();
  if (explicit) return explicit;
  return fileExists(join(projectRoot, fallback)) ? fallback : null;
}

function findProjectRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function pathDelimiter(): string {
  return process.platform === "win32" ? ";" : ":";
}

export function fullCustomOcrDatasetArgs(): string[] {
  const manifestDir = join("artifacts", "datasets", "custom-ocr");
  return customOcrDatasetArgsForManifests(
    existsSync(join(projectRoot, manifestDir, "line_train.jsonl")) &&
      existsSync(join(projectRoot, manifestDir, "line_validation.jsonl")),
    manifestDir
  );
}

export function customOcrDatasetArgsForManifests(hasCombinedManifests: boolean, manifestDir = join("artifacts", "datasets", "custom-ocr")): string[] {
  return hasCombinedManifests
    ? ["--dataset-mode", "combined_manifest", "--combined-manifest-dir", manifestDir]
    : ["--dataset-mode", "document_lines"];
}
