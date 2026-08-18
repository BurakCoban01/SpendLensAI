import type { StoredModelVersion } from "./types";

export type CustomOcrPromotionBlockCode =
  | "CUSTOM_OCR_PROMOTION_ARTIFACT_REQUIRED"
  | "CUSTOM_OCR_PROMOTION_SMOKE_MODEL_BLOCKED"
  | "CUSTOM_OCR_PROMOTION_REAL_FIXTURE_GATE_FAILED"
  | "CUSTOM_OCR_PROMOTION_REQUIRES_REAL_FIXTURE_VALIDATION";

export function getCustomOcrPromotionBlockCode(modelVersion: StoredModelVersion): CustomOcrPromotionBlockCode | null {
  if (modelVersion.engine !== "CUSTOM_CRNN") return null;
  if (!modelVersion.artifactBucket || !modelVersion.artifactKey) {
    return "CUSTOM_OCR_PROMOTION_ARTIFACT_REQUIRED";
  }
  const metrics = isRecord(modelVersion.metrics) ? modelVersion.metrics : {};
  const trainingProfile = stringMetric(metrics, "training_profile") ?? stringMetric(metrics, "profile");
  if (!trainingProfile || trainingProfile.includes("smoke")) {
    return "CUSTOM_OCR_PROMOTION_SMOKE_MODEL_BLOCKED";
  }
  const realFixtureStatus =
    stringMetric(metrics, "realFixtureBenchmarkStatus") ??
    stringMetric(metrics, "real_fixture_benchmark_status") ??
    nestedStringMetric(metrics, ["engines", "CUSTOM_CRNN", "qualityGateStatus"]);
  const qualityGatePassed = booleanMetric(metrics, "qualityGatePassed") ?? nestedBooleanMetric(metrics, ["engines", "CUSTOM_CRNN", "qualityGatePassed"]);
  const highConfidenceWrongCount =
    numberMetric(metrics, "highConfidenceWrongCount") ?? nestedNumberMetric(metrics, ["engines", "CUSTOM_CRNN", "highConfidenceWrongCount"]);
  if (realFixtureStatus === "failed" || qualityGatePassed === false || (highConfidenceWrongCount ?? 0) > 0) {
    return "CUSTOM_OCR_PROMOTION_REAL_FIXTURE_GATE_FAILED";
  }
  const validatedOnRealFixtures =
    (realFixtureStatus === "passed" || metrics.validatedOnRealFixtures === true || metrics.validated_on_real_fixtures === true) &&
    qualityGatePassed === true;
  if (!validatedOnRealFixtures) {
    return "CUSTOM_OCR_PROMOTION_REQUIRES_REAL_FIXTURE_VALIDATION";
  }
  return null;
}

function booleanMetric(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function numberMetric(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringMetric(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function nestedStringMetric(record: Record<string, unknown>, pathParts: string[]): string | null {
  let current: unknown = record;
  for (const part of pathParts) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return typeof current === "string" ? current : null;
}

function nestedBooleanMetric(record: Record<string, unknown>, pathParts: string[]): boolean | null {
  let current: unknown = record;
  for (const part of pathParts) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return typeof current === "boolean" ? current : null;
}

function nestedNumberMetric(record: Record<string, unknown>, pathParts: string[]): number | null {
  let current: unknown = record;
  for (const part of pathParts) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
