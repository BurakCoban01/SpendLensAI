import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  benchmarkMatchesPipeline,
  checkpointFingerprint,
  customOcrImplementationFingerprint,
  pipelineFingerprint
} from "./custom-ocr-benchmark-provenance.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromDbPackage = createRequire(path.join(rootDir, "packages", "db", "package.json"));
const { PrismaClient } = requireFromDbPackage("@prisma/client");
let Redis = null;
const args = new Set(process.argv.slice(2));
const options = parseArgs(process.argv.slice(2));
loadRootEnv();

const realFixtureDir = process.env.CUSTOM_OCR_FIXTURES_DIR?.trim() || "data/demo-fixtures";

const numericCharacterCheckpoint =
  process.env.CUSTOM_OCR_NUMERIC_CHAR_CHECKPOINT?.trim() ||
  "artifacts/models/local-full-20260620-ocr/numeric-char-cnn-v1/char-cnn.pt";
const characterLineCheckpoint =
  process.env.CUSTOM_OCR_CHARACTER_CHECKPOINT?.trim() ||
  "artifacts/models/custom-char-cnn-project-real-v1/char-cnn.pt";

const preferredArtifactDirs = [
  process.env.CUSTOM_OCR_LOCAL_FULL_ARTIFACT_DIR,
  artifactDirFromCheckpoint(process.env.CUSTOM_OCR_DEFAULT_CHECKPOINT),
  "artifacts/models/custom-crnn-local-full",
  "artifacts/models/local-full-20260618-ocr/crnn-length-aware-v3-continued",
  "artifacts/models/local-full-20260618-ocr/crnn-length-aware-v3",
  "artifacts/models/local-full-20260616-ocr/crnn-document-crop-field-v3",
  "artifacts/models/local-full-20260616-ocr/crnn-document-crop-field-oversampled"
].filter(Boolean);

console.log("Custom OCR local_full bootstrap started.");
console.log("Disk audit:");
console.log(runDiskAudit());

let candidate = selectCheckpointCandidate();
if (!candidate && args.has("--train-if-missing")) {
  trainLocalFullFallback();
  candidate = selectCheckpointCandidate();
}
if (!candidate) {
  const message = [
    "No reusable local_full Custom OCR checkpoint was found under artifacts/models.",
    "Run `pnpm custom-ocr:train:pilot` first for a bounded learning check, then `pnpm custom-ocr:train:local-full`,",
    "or pass CUSTOM_OCR_LOCAL_FULL_ARTIFACT_DIR to this command."
  ].join("\n");
  if (options.optional) {
    console.warn(message);
    console.warn("Custom OCR bootstrap skipped; no training was started.");
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}
candidate = ensureCurrentRealFixtureBenchmark(candidate);

let smoke;
try {
  smoke = validateBootstrapReadiness(candidate, loadReusableSmoke(candidate) ?? runInferenceSmokeOrSkip(candidate));
} catch (error) {
  const message = formatError(error);
  await markCandidateModelsBlocked(candidate, null, message);
  if (options.optional) {
    console.warn(`Custom OCR bootstrap safety gate blocked activation: ${message}`);
    console.warn("Custom OCR bootstrap is optional for this command; continuing without registering an unsafe active model.");
    process.exit(0);
  }
  throw error;
}
const manifest = writeBootstrapManifest(candidate, smoke);
const registered = await registerActiveModels(candidate, smoke, manifest);

console.log(
  JSON.stringify(
    [
      {
        status: "ACTIVE",
        tenantCount: registered.length,
        changedCount: registered.filter((entry) => entry.changed).length,
        models: (options.verbose ? registered : registered.slice(0, 12)).map((entry) => ({
          tenantId: entry.tenant.id,
          tenantSlug: entry.tenant.slug,
          tenantName: entry.tenant.name,
          modelId: entry.model.id,
          modelName: entry.model.name,
          modelVersion: candidate.modelVersion,
          artifactBucket: entry.model.artifactBucket,
          artifactKey: entry.model.artifactKey,
          changed: entry.changed
        })),
        outputNote:
          !options.verbose && registered.length > 12
            ? `Showing 12 of ${registered.length} tenant registrations. Pass --verbose to print every tenant.`
            : null,
        checkpoint: candidate.checkpoint,
        metrics: candidate.summary,
        inferenceSmoke: smoke,
        manifest
      }
    ][0],
    null,
    2
  )
);

function selectCheckpointCandidate() {
  const candidates = [];
  const explicitArtifact = normalizeArtifactDir(
    process.env.CUSTOM_OCR_LOCAL_FULL_ARTIFACT_DIR || artifactDirFromCheckpoint(process.env.CUSTOM_OCR_DEFAULT_CHECKPOINT) || ""
  )?.relative;
  for (const artifactDir of [...preferredArtifactDirs, ...scanLocalFullArtifactDirs()]) {
    const normalized = normalizeArtifactDir(artifactDir);
    if (!normalized) continue;
    const checkpoint = path.join(normalized.absolute, "model.pt");
    const metricsPath = path.join(normalized.absolute, "metrics.json");
    if (!existsSync(checkpoint) || !existsSync(metricsPath)) continue;
    const metrics = readJson(metricsPath);
    if (!metrics || metrics.profile !== "local_full" || metrics.datasetMode === "numeric_fields") continue;
    if (normalized.relative.includes("field-specialist")) continue;
    const vocabVersion = String(metrics.vocab_version ?? metrics.vocabVersion ?? "");
    if (!vocabVersion) continue;
    candidates.push({
      artifactDir: normalized.relative,
      artifactDirAbsolute: normalized.absolute,
      releaseVersion: path.basename(normalized.relative),
      checkpoint: `${normalized.relative}/model.pt`.replace(/\\/g, "/"),
      metricsPath: `${normalized.relative}/metrics.json`.replace(/\\/g, "/"),
      modelVersion: String(metrics.model_version ?? `custom-crnn-${path.basename(normalized.relative)}`),
      vocabVersion,
      metrics,
      summary: summarizeMetrics(metrics),
      score: Number(metrics.bestValidationCer ?? metrics.finalValidation?.averageCer ?? 999),
      mtimeMs: statSync(checkpoint).mtimeMs,
      explicitlySelected: normalized.relative === explicitArtifact,
      benchmarkVerified: false
    });
  }
  candidates.sort(
    (left, right) =>
      Number(right.explicitlySelected) - Number(left.explicitlySelected) ||
      left.score - right.score ||
      right.mtimeMs - left.mtimeMs
  );
  return candidates[0] ? attachMatchingRealFixtureBenchmark(candidates[0]) : null;
}

function artifactDirFromCheckpoint(value) {
  const checkpoint = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!checkpoint.endsWith("/model.pt")) return null;
  return checkpoint.slice(0, -"/model.pt".length);
}

function findLatestRealFixtureBenchmarkReport(expectedPipeline) {
  const benchmarksRoot = path.join(rootDir, "artifacts", "benchmarks");
  const reports = [];
  for (const entry of safeReadDir(benchmarksRoot)) {
    if (!entry.isDirectory() || !entry.name.startsWith("custom-ocr-real-fixtures")) continue;
    const reportPath = path.join(benchmarksRoot, entry.name, "benchmark-report.json");
    if (!existsSync(reportPath)) continue;
    const report = readJson(reportPath);
    if (!isPlainObject(report) || !isPlainObject(report.dataset) || report.dataset.mode !== "real_fixtures") continue;
    if (!isPlainObject(report.engines) || !isPlainObject(report.engines.CUSTOM_CRNN)) continue;
    if (!benchmarkMatchesPipeline(report, expectedPipeline)) continue;
    reports.push({ report, reportPath, mtimeMs: statSync(reportPath).mtimeMs });
  }
  reports.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = reports[0];
  if (!latest) return null;
  return {
    ...latest.report,
    reportPath: path.relative(rootDir, latest.reportPath).replace(/\\/g, "/")
  };
}

function candidatePipeline(candidate) {
  return {
    implementation: customOcrImplementationFingerprint(rootDir),
    recognizer: checkpointFingerprint(rootDir, candidate.checkpoint),
    numericCharacter: checkpointFingerprint(rootDir, numericCharacterCheckpoint),
    characterLine: checkpointFingerprint(rootDir, characterLineCheckpoint)
  };
}

function attachMatchingRealFixtureBenchmark(candidate) {
  const report = findLatestRealFixtureBenchmarkReport(candidatePipeline(candidate));
  if (!report) return { ...candidate, benchmarkVerified: false };
  const metrics = mergeLatestRealFixtureBenchmark(candidate.metrics, report);
  return {
    ...candidate,
    metrics,
    summary: summarizeMetrics(metrics),
    benchmarkVerified: true
  };
}

function ensureCurrentRealFixtureBenchmark(candidate) {
  if (candidate.benchmarkVerified) {
    console.log(`Using current full-pipeline real fixture benchmark: ${candidate.metrics.benchmarkReportPath}`);
    return candidate;
  }
  if (!options.benchmark) {
    console.warn("No matching real-fixture benchmark was found; startup will not run one automatically.");
    console.warn("Run `pnpm custom-ocr:bootstrap -- --benchmark` for an explicit one-time verification.");
    return candidate;
  }
  const pipeline = candidatePipeline(candidate);
  const missing = Object.entries(pipeline)
    .filter(([key, checkpoint]) => key !== "implementation" && checkpoint?.exists !== true)
    .map(([key, checkpoint]) => `${key}:${checkpoint?.path ?? "not-configured"}`);
  if (missing.length > 0) {
    console.warn(`Custom OCR bootstrap benchmark prerequisites are missing: ${missing.join(", ")}`);
    return candidate;
  }
  const outputDir = `artifacts/benchmarks/custom-ocr-real-fixtures-bootstrap-${pipelineFingerprint(pipeline)}`;
  const reportPath = path.join(rootDir, outputDir, "benchmark-report.json");
  if (!existsSync(reportPath)) {
    console.log("No current full-pipeline real fixture report was found; running the bounded bootstrap benchmark.");
    try {
      execFileSync(
        process.env.PYTHON || "python",
        [
          "-m",
          "services.ocr.benchmarks.ocr_benchmark",
          "--dataset-mode",
          "real_fixtures",
          "--data-dir",
          realFixtureDir,
          "--output-dir",
          outputDir,
          "--checkpoint",
          candidate.checkpoint,
          "--numeric-char-checkpoint",
          numericCharacterCheckpoint,
          "--character-checkpoint",
          characterLineCheckpoint,
          "--split",
          "all",
          "--skip-tesseract"
        ],
        {
          cwd: rootDir,
          stdio: "inherit",
          env: {
            ...process.env,
            PYTHONPATH: process.env.PYTHONPATH ? `${rootDir}${path.delimiter}${process.env.PYTHONPATH}` : rootDir,
            PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
            OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "1",
            MKL_NUM_THREADS: process.env.MKL_NUM_THREADS ?? "1"
          }
        }
      );
    } catch (error) {
      console.warn(`Custom OCR bootstrap real fixture benchmark failed: ${formatError(error)}`);
    }
  }
  return attachMatchingRealFixtureBenchmark(candidate);
}

function mergeLatestRealFixtureBenchmark(metrics, report) {
  if (!isPlainObject(report) || !isPlainObject(report.engines) || !isPlainObject(report.engines.CUSTOM_CRNN)) return metrics;
  const customEngine = report.engines.CUSTOM_CRNN;
  return {
    ...metrics,
    latestOcrBenchmark: report,
    benchmarkDataset: report.dataset ?? null,
    benchmarkReportPath: report.reportPath ?? null,
    validatedOnRealFixtures: customEngine.qualityGateStatus === "passed",
    realFixtureBenchmarkStatus: typeof customEngine.qualityGateStatus === "string" ? customEngine.qualityGateStatus : "unknown",
    qualityGatePassed: customEngine.qualityGatePassed === true,
    highConfidenceWrongCount: numberOrNull(customEngine.highConfidenceWrongCount) ?? metrics.highConfidenceWrongCount ?? null,
    engines: {
      ...(isPlainObject(metrics.engines) ? metrics.engines : {}),
      ...report.engines
    }
  };
}

function scanLocalFullArtifactDirs() {
  const modelsRoot = path.join(rootDir, "artifacts", "models");
  const found = [];
  if (!existsSync(modelsRoot)) return found;
  for (const first of safeReadDir(modelsRoot)) {
    if (!first.name.startsWith("local-full-")) continue;
    const firstPath = path.join(modelsRoot, first.name);
    if (!first.isDirectory()) continue;
    for (const second of safeReadDir(firstPath)) {
      if (!second.isDirectory()) continue;
      found.push(path.relative(rootDir, path.join(firstPath, second.name)).replace(/\\/g, "/"));
    }
  }
  return found;
}

function normalizeArtifactDir(value) {
  const relative = String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!relative.startsWith("artifacts/models/") || relative.includes("../") || path.isAbsolute(relative)) return null;
  const absolute = path.resolve(rootDir, relative);
  const allowed = path.resolve(rootDir, "artifacts", "models");
  if (!absolute.startsWith(`${allowed}${path.sep}`)) return null;
  return { relative, absolute };
}

function runInferenceSmoke(candidate) {
  const validationDir = path.join(rootDir, "artifacts", "models", "custom-ocr-bootstrap-validation");
  mkdirSync(validationDir, { recursive: true });
  const validationImage = path.join(validationDir, "turkish-line-smoke.png");
  const code = String.raw`
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from services.ocr.custom_model.infer import infer_document

image_path = Path(r"${validationImage.replace(/\\/g, "\\\\")}")
checkpoint = Path(r"${path.join(rootDir, candidate.checkpoint).replace(/\\/g, "\\\\")}")
numeric_checkpoint = Path(r"${path.resolve(rootDir, numericCharacterCheckpoint).replace(/\\/g, "\\\\")}")
character_checkpoint = Path(r"${path.resolve(rootDir, characterLineCheckpoint).replace(/\\/g, "\\\\")}")
image = Image.new("RGB", (720, 96), "white")
draw = ImageDraw.Draw(image)
try:
    font = ImageFont.truetype("arial.ttf", 36)
except Exception:
    font = ImageFont.load_default()
draw.text((24, 24), "İŞLEM NO 12345 TOPLAM 245,90 TL", fill="black", font=font)
image.save(image_path)
prediction = infer_document(
    checkpoint,
    image_path,
    source_mime_type="image/png",
    decoder_method="greedy",
    beam_width=1,
    numeric_char_checkpoint=numeric_checkpoint,
    character_checkpoint=character_checkpoint,
)
print(json.dumps({
    "text": prediction.normalized_text,
    "confidence": prediction.confidence,
    "model_version": "${candidate.modelVersion}",
    "vocab_version": "${candidate.vocabVersion}",
    "validation_image": str(image_path)
}, ensure_ascii=False))
`;
  const output = execFileSync(process.env.PYTHON || "python", ["-c", code], {
    cwd: rootDir,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
      OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "1",
      MKL_NUM_THREADS: process.env.MKL_NUM_THREADS ?? "1"
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.smokeTimeoutMs
  });
  const smoke = JSON.parse(output.trim().split(/\r?\n/).at(-1));
  return smoke;
}

function runInferenceSmokeOrSkip(candidate) {
  try {
    return runInferenceSmoke(candidate);
  } catch (error) {
    const message = `Custom OCR bootstrap inference smoke failed: ${formatError(error)}`;
    if (options.optional) {
      console.warn(message);
      console.warn(
        "Custom OCR bootstrap is optional for `pnpm dev`; keeping the existing registry state and continuing without blocking the dev server."
      );
      process.exit(0);
    }
    throw error;
  }
}

function loadReusableSmoke(candidate) {
  if (options.forceSmoke) return null;
  const manifestPath = path.join(rootDir, "artifacts", "models", "custom-ocr-bootstrap", "active-local-full-model.json");
  const manifest = readJson(manifestPath);
  if (!manifest || typeof manifest !== "object") return null;
  const matchesCandidate =
    manifest.artifactDir === candidate.artifactDir &&
    manifest.checkpoint === candidate.checkpoint &&
    manifest.metricsPath === candidate.metricsPath &&
    manifest.modelVersion === candidate.modelVersion &&
    manifest.vocabVersion === candidate.vocabVersion;
  const smoke = manifest.inferenceSmoke;
  const reusableSmoke =
    smoke &&
    typeof smoke === "object" &&
    typeof smoke.text === "string" &&
    smoke.vocab_version === candidate.vocabVersion &&
    smoke.model_version === candidate.modelVersion;
  if (!matchesCandidate || !reusableSmoke) return null;
  try {
    validateBootstrapReadiness(candidate, smoke);
  } catch (error) {
    console.warn(`Existing Custom OCR bootstrap smoke is not reusable: ${formatError(error)}`);
    return null;
  }
  console.log("Reusing existing Custom OCR bootstrap inference smoke from active-local-full-model.json.");
  return smoke;
}

function validateBootstrapReadiness(candidate, smoke) {
  if (!smoke || typeof smoke !== "object" || typeof smoke.text !== "string") {
    throw new Error("CUSTOM_OCR_BOOTSTRAP_INFERENCE_SMOKE_INVALID");
  }
  if (smoke.vocab_version && smoke.vocab_version !== candidate.vocabVersion) {
    throw new Error(`CUSTOM_OCR_BOOTSTRAP_VOCAB_MISMATCH:${smoke.vocab_version}:${candidate.vocabVersion}`);
  }
  const quality = calculateSmokeQuality(smoke.text);
  if (!quality.passed) {
    throw new Error(`CUSTOM_OCR_BOOTSTRAP_INFERENCE_SMOKE_FAILED:${JSON.stringify(quality)}`);
  }
  if (!candidateHasRealFixtureValidation(candidate)) {
    throw new Error("CUSTOM_OCR_BOOTSTRAP_REQUIRES_REAL_FIXTURE_BENCHMARK");
  }
  return {
    ...smoke,
    text: repairMojibake(smoke.text),
    quality
  };
}

function calculateSmokeQuality(text) {
  const normalized = normalizeForSnippet(text);
  const snippets = ["İŞLEM", "NO", "12345", "TOPLAM", "245,90", "TL"];
  const matched = snippets.filter((snippet) => normalized.includes(normalizeForSnippet(snippet)));
  const hasExpectedAmount = /245[,.]90/.test(normalized);
  const hasTotalToken = normalized.includes(normalizeForSnippet("TOPLAM"));
  const snippetRecall = matched.length / snippets.length;
  return {
    expectedSnippets: snippets,
    matchedSnippets: matched,
    snippetRecall,
    hasExpectedAmount,
    hasTotalToken,
    passed: snippetRecall >= 0.5 && hasExpectedAmount && hasTotalToken
  };
}

function normalizeForSnippet(value) {
  return foldTurkish(repairMojibake(value))
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^\p{L}\p{N},.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function foldTurkish(value) {
  return value
    .replace(/[İIı]/g, "I")
    .replace(/[Şş]/g, "S")
    .replace(/[Ğğ]/g, "G")
    .replace(/[Üü]/g, "U")
    .replace(/[Öö]/g, "O")
    .replace(/[Çç]/g, "C");
}

function repairMojibake(value) {
  return String(value)
    .replaceAll("Ä°", "İ")
    .replaceAll("Ä±", "ı")
    .replaceAll("Å", "Ş")
    .replaceAll("ÅŸ", "ş")
    .replaceAll("ÄŸ", "ğ")
    .replaceAll("Ã¼", "ü")
    .replaceAll("Ãœ", "Ü")
    .replaceAll("Ã¶", "ö")
    .replaceAll("Ã–", "Ö")
    .replaceAll("Ã§", "ç")
    .replaceAll("Ã‡", "Ç")
    .replaceAll("MasaÃ¼stÃ¼", "Masaüstü");
}

function candidateHasRealFixtureValidation(candidate) {
  if (candidate.benchmarkVerified !== true) return false;
  const metrics = candidate.metrics ?? {};
  const summary = candidate.summary ?? {};
  const customEngineMetrics = isPlainObject(metrics.engines) && isPlainObject(metrics.engines.CUSTOM_CRNN) ? metrics.engines.CUSTOM_CRNN : {};
  const summaryEngineMetrics = isPlainObject(summary.engines) && isPlainObject(summary.engines.CUSTOM_CRNN) ? summary.engines.CUSTOM_CRNN : {};
  const qualityGatePassed =
    metrics.qualityGatePassed === true ||
    customEngineMetrics.qualityGatePassed === true ||
    summary.qualityGatePassed === true ||
    summaryEngineMetrics.qualityGatePassed === true;
  const realFixtureStatus =
    metrics.realFixtureBenchmarkStatus ??
    metrics.real_fixture_benchmark_status ??
    customEngineMetrics.qualityGateStatus ??
    summary.realFixtureBenchmarkStatus ??
    summary.real_fixture_benchmark_status ??
    summaryEngineMetrics.qualityGateStatus;
  const highConfidenceWrongCount =
    numberOrNull(metrics.highConfidenceWrongCount) ??
    numberOrNull(customEngineMetrics.highConfidenceWrongCount) ??
    numberOrNull(summary.highConfidenceWrongCount) ??
    numberOrNull(summaryEngineMetrics.highConfidenceWrongCount) ??
    0;
  const hasRealFixtureEvidence =
    metrics.validatedOnRealFixtures === true ||
    metrics.validated_on_real_fixtures === true ||
    summary.validatedOnRealFixtures === true ||
    summary.validated_on_real_fixtures === true ||
    realFixtureStatus === "passed";
  return hasRealFixtureEvidence && qualityGatePassed && highConfidenceWrongCount === 0;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function writeBootstrapManifest(candidate, smoke) {
  const manifestDir = path.join(rootDir, "artifacts", "models", "custom-ocr-bootstrap");
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, "active-local-full-model.json");
  const payload = {
    generatedAt: new Date().toISOString(),
    artifactDir: candidate.artifactDir,
    checkpoint: candidate.checkpoint,
    metricsPath: candidate.metricsPath,
    modelVersion: candidate.modelVersion,
    vocabVersion: candidate.vocabVersion,
    metrics: candidate.summary,
    inferenceSmoke: smoke,
    note: "Local bootstrap manifest for registering the project-owned Custom OCR CRNN model as ACTIVE in the local demo database."
  };
  writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path.relative(rootDir, manifestPath).replace(/\\/g, "/");
}

async function registerActiveModels(candidate, smoke, manifest) {
  const prisma = new PrismaClient();
  try {
    const tenants = await selectTargetTenants(prisma);
    if (tenants.length === 0) {
      if (options.optional) return [];
      throw new Error("CUSTOM_OCR_BOOTSTRAP_TENANT_NOT_FOUND_RUN_PNPM_DB_SEED");
    }

    const metrics = {
      ...candidate.summary,
      model: "custom-crnn-ctc",
      engine: "CUSTOM_CRNN",
      profile: "local_full",
      model_version: candidate.modelVersion,
      release_version: candidate.releaseVersion,
      vocab_version: candidate.vocabVersion,
      artifact_key: candidate.artifactDir,
      checkpoint: candidate.checkpoint,
      metrics_path: candidate.metricsPath,
      bootstrap_manifest: manifest,
      bootstrap_inference_smoke: smoke,
      accuracy_note:
        candidate.metrics.accuracy_note ??
        "Local full synthetic Custom OCR model. Metrics are synthetic validation metrics and must be interpreted honestly."
    };
    const name = `custom-crnn-local-full-${candidate.releaseVersion}`;
    const results = [];
    for (const tenant of tenants) {
      const existing = await prisma.modelVersion.findFirst({
        where: { tenantId: tenant.id, engine: "CUSTOM_CRNN", name }
      });
      const activeBefore = await prisma.modelVersion.findFirst({
        where: { tenantId: tenant.id, engine: "CUSTOM_CRNN", status: "ACTIVE" }
      });
      const alreadyActive =
        activeBefore?.id === existing?.id &&
        activeBefore?.artifactBucket === "local-artifacts" &&
        activeBefore?.artifactKey === candidate.artifactDir;
      if (alreadyActive && existing) {
        results.push({ tenant, model: existing, changed: false });
        continue;
      }
      await prisma.modelVersion.updateMany({
        where: {
          tenantId: tenant.id,
          engine: "CUSTOM_CRNN",
          status: "ACTIVE",
          ...(existing ? { id: { not: existing.id } } : {})
        },
        data: { status: "ARCHIVED" }
      });
      const active = existing
        ? await prisma.modelVersion.update({
            where: { id: existing.id },
            data: {
              status: "ACTIVE",
              artifactBucket: "local-artifacts",
              artifactKey: candidate.artifactDir,
              metrics,
              promotedAt: activeBefore?.id === existing.id && existing.promotedAt ? existing.promotedAt : new Date()
            }
          })
        : await prisma.modelVersion.create({
            data: {
              tenantId: tenant.id,
              name,
              engine: "CUSTOM_CRNN",
              status: "ACTIVE",
              artifactBucket: "local-artifacts",
              artifactKey: candidate.artifactDir,
              metrics,
              promotedAt: new Date()
            }
          });
      const existingEvaluation = await prisma.modelEvaluationRun.findFirst({
        where: { tenantId: tenant.id, modelVersionId: active.id, reportKey: manifest }
      });
      if (!existingEvaluation) {
        await prisma.modelEvaluationRun.create({
          data: {
            tenantId: tenant.id,
            modelVersionId: active.id,
            status: "SUCCEEDED",
            metrics,
            reportKey: manifest,
            completedAt: new Date()
          }
        });
      }
      await bumpModelRegistryCacheVersion(tenant.id);
      results.push({ tenant, model: active, changed: !alreadyActive });
    }
    return results;
  } finally {
    await prisma.$disconnect();
  }
}

async function markCandidateModelsBlocked(candidate, smoke, reason) {
  const prisma = new PrismaClient();
  try {
    const unsafeModels = await prisma.modelVersion.findMany({
      where: {
        engine: "CUSTOM_CRNN",
        status: { in: ["ACTIVE", "FAILED"] },
        artifactBucket: "local-artifacts",
        artifactKey: candidate.artifactDir
      }
    });
    const touchedTenants = new Set();
    for (const model of unsafeModels) {
      await prisma.modelVersion.update({
        where: { id: model.id },
        data: {
          status: "FAILED",
          metrics: {
            ...(isPlainObject(model.metrics) ? model.metrics : {}),
            profile: "local_full",
            validatedOnRealFixtures: false,
            realFixtureBenchmarkStatus: "failed",
            qualityGatePassed: false,
            promotionBlockedReason: reason,
            bootstrap_inference_smoke: smoke,
            blockedAt: new Date().toISOString()
          }
        }
      });
      touchedTenants.add(model.tenantId);
    }
    for (const tenantId of touchedTenants) {
      await bumpModelRegistryCacheVersion(tenantId);
    }
  } catch (error) {
    console.warn(`Unsafe Custom OCR active model could not be marked FAILED: ${formatError(error)}`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function selectTargetTenants(prisma) {
  if (options.tenantId) {
    const tenant = await prisma.tenant.findUnique({ where: { id: options.tenantId } });
    return tenant ? [tenant] : [];
  }
  if (options.tenantSlug) {
    const tenant = await prisma.tenant.findUnique({ where: { slug: options.tenantSlug } });
    return tenant ? [tenant] : [];
  }
  if (options.allTenants) return prisma.tenant.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "asc" } });
  const demoTenant = await prisma.tenant.findUnique({ where: { slug: "demo" } });
  return demoTenant ? [demoTenant] : prisma.tenant.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "asc" }, take: 1 });
}

async function bumpModelRegistryCacheVersion(tenantId) {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  try {
    Redis ??= createRequire(path.join(rootDir, "apps", "api", "package.json"))("ioredis");
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    try {
      await redis.connect();
      await redis.set(`model-registry:${tenantId}:overview-version`, `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, "EX", 24 * 60 * 60);
    } finally {
      await redis.quit().catch(() => redis.disconnect());
    }
  } catch (error) {
    console.warn(`Model registry cache version could not be bumped for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trainLocalFullFallback() {
  const datasetArgs = localFullTrainingDatasetArgs();
  execFileSync(
    process.env.PYTHON || "python",
    [
      "-m",
      "services.ocr.custom_model.train_crnn",
      "--profile",
      "local_full",
      "--artifact-dir",
      "artifacts/models/custom-crnn-local-full",
      "--data-dir",
      "data/generated/ocr-local-full-document-lines",
      "--samples",
      process.env.CUSTOM_OCR_LOCAL_FULL_SAMPLES ?? "2048",
      "--epochs",
      process.env.CUSTOM_OCR_LOCAL_FULL_EPOCHS ?? "5",
      "--batch-size",
      process.env.CUSTOM_OCR_LOCAL_FULL_BATCH_SIZE ?? "8",
      "--early-stopping-patience",
      "2",
      ...datasetArgs,
      "--field-oversample-factor",
      "3",
      "--blank-regularization",
      "0.05"
    ],
    {
      cwd: rootDir,
      stdio: "inherit",
      env: {
        ...process.env,
        PYTHONPATH: process.env.PYTHONPATH ? `${rootDir}${path.delimiter}${process.env.PYTHONPATH}` : rootDir,
        PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "1",
        MKL_NUM_THREADS: process.env.MKL_NUM_THREADS ?? "1"
      }
    }
  );
}

function localFullTrainingDatasetArgs() {
  const manifestDir = path.join("artifacts", "datasets", "custom-ocr");
  if (
    existsSync(path.join(rootDir, manifestDir, "line_train.jsonl")) &&
    existsSync(path.join(rootDir, manifestDir, "line_validation.jsonl"))
  ) {
    return ["--dataset-mode", "combined_manifest", "--combined-manifest-dir", manifestDir];
  }
  return ["--dataset-mode", "document_lines"];
}

function summarizeMetrics(metrics) {
  const customEngine = isPlainObject(metrics.engines) && isPlainObject(metrics.engines.CUSTOM_CRNN) ? metrics.engines.CUSTOM_CRNN : {};
  return {
    samples: metrics.samples ?? null,
    trainSamples: metrics.trainSamples ?? null,
    validationSamples: metrics.validationSamples ?? null,
    completedEpochs: metrics.completedEpochs ?? null,
    bestValidationCer: metrics.bestValidationCer ?? metrics.finalValidation?.averageCer ?? null,
    finalCer: metrics.finalValidation?.averageCer ?? null,
    finalWer: metrics.finalValidation?.averageWer ?? null,
    exactMatchRate: metrics.finalValidation?.exactMatchRate ?? null,
    averageConfidence: metrics.finalValidation?.averageConfidence ?? null,
    turkishSpecialCharacterAccuracy: metrics.finalValidation?.turkishSpecialCharacterAccuracy ?? null,
    turkishSpecialCharacterSupport: metrics.finalValidation?.turkishSpecialCharacterSupport ?? null,
    datasetMode: metrics.datasetMode ?? null,
    model_version: metrics.model_version ?? null,
    vocab_version: metrics.vocab_version ?? null,
    validatedOnRealFixtures: metrics.validatedOnRealFixtures === true || customEngine.qualityGateStatus === "passed",
    realFixtureBenchmarkStatus: metrics.realFixtureBenchmarkStatus ?? customEngine.qualityGateStatus ?? null,
    qualityGatePassed: metrics.qualityGatePassed === true || customEngine.qualityGatePassed === true,
    highConfidenceWrongCount: metrics.highConfidenceWrongCount ?? customEngine.highConfidenceWrongCount ?? null,
    engines: metrics.engines ?? null,
    numericCharacterCheckpoint,
    characterCheckpoint: characterLineCheckpoint
  };
}

function runDiskAudit() {
  try {
    const stats = statfsSync(rootDir);
    const size = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = size - free;
    return `filesystem=${path.parse(rootDir).root} size=${formatBytes(size)} used=${formatBytes(used)} free=${formatBytes(free)}`;
  } catch {
    // Fall through to platform commands.
  }
  try {
    if (process.platform === "win32") {
      return execFileSync("wmic", ["logicaldisk", "get", "size,freespace,caption"], { encoding: "utf8", timeout: 5_000 }).trim();
    }
  } catch {
    // Fall through; WMIC can be unavailable, slow or cancelled on some Windows installations.
  }
  try {
    if (process.platform === "win32") {
      return execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-PSDrive -PSProvider FileSystem | Select-Object Name,Free,Used,Root | ConvertTo-Json -Compress"
        ],
        { encoding: "utf8", timeout: 5_000 }
      ).trim();
    }
  }
  catch {
    // Fall through to df for Git Bash/Linux/macOS environments.
  }
  try {
    return execFileSync("df", ["-h", "."], { cwd: rootDir, encoding: "utf8" }).trim();
  } catch (error) {
    return `DISK_AUDIT_UNAVAILABLE:${error instanceof Error ? error.message : String(error)}`;
  }
}

function formatBytes(value) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let normalized = Number(value);
  let unit = 0;
  while (normalized >= 1024 && unit < units.length - 1) {
    normalized /= 1024;
    unit += 1;
  }
  return `${normalized.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function loadRootEnv() {
  const envPath = path.join(rootDir, ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(rawArgs) {
  const parsed = {
    allTenants: rawArgs.includes("--all-tenants"),
    optional: rawArgs.includes("--optional"),
    verbose: rawArgs.includes("--verbose"),
    forceSmoke: rawArgs.includes("--force-smoke"),
    benchmark:
      rawArgs.includes("--benchmark") ||
      String(process.env.CUSTOM_OCR_BOOTSTRAP_BENCHMARK ?? "false").trim().toLowerCase() === "true",
    smokeTimeoutMs: Number(process.env.CUSTOM_OCR_BOOTSTRAP_SMOKE_TIMEOUT_MS ?? 120_000),
    tenantId: null,
    tenantSlug: null
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--tenant-id") parsed.tenantId = rawArgs[index + 1] ?? null;
    if (arg.startsWith("--tenant-id=")) parsed.tenantId = arg.slice("--tenant-id=".length);
    if (arg === "--tenant-slug") parsed.tenantSlug = rawArgs[index + 1] ?? null;
    if (arg.startsWith("--tenant-slug=")) parsed.tenantSlug = arg.slice("--tenant-slug=".length);
    if (arg === "--smoke-timeout-ms") parsed.smokeTimeoutMs = Number(rawArgs[index + 1] ?? parsed.smokeTimeoutMs);
    if (arg.startsWith("--smoke-timeout-ms=")) parsed.smokeTimeoutMs = Number(arg.slice("--smoke-timeout-ms=".length));
  }
  if (!Number.isFinite(parsed.smokeTimeoutMs) || parsed.smokeTimeoutMs < 1_000) parsed.smokeTimeoutMs = 120_000;
  return parsed;
}

function formatError(error) {
  if (!error || typeof error !== "object") return String(error);
  const parts = [];
  if ("code" in error && error.code) parts.push(String(error.code));
  if ("signal" in error && error.signal) parts.push(`signal ${String(error.signal)}`);
  if ("message" in error && error.message) parts.push(String(error.message));
  return parts.join(" - ") || String(error);
}
