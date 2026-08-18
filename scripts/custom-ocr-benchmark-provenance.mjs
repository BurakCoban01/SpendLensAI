import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export function checkpointFingerprint(rootDir, checkpoint) {
  const normalized = normalizeProjectPath(checkpoint);
  if (!normalized) return null;
  const absolute = path.resolve(rootDir, normalized);
  const allowedRoot = path.resolve(rootDir);
  if (absolute !== allowedRoot && !absolute.startsWith(`${allowedRoot}${path.sep}`)) return null;
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    return { path: normalized, exists: false, sizeBytes: null, sha256: null };
  }
  return {
    path: normalized,
    exists: true,
    sizeBytes: statSync(absolute).size,
    sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex")
  };
}

export function benchmarkMatchesPipeline(report, expected) {
  const checkpoints = report?.provenance?.checkpoints;
  if (!isPlainObject(checkpoints)) return false;
  const implementation = report?.provenance?.implementation;
  return (
    isPlainObject(implementation) &&
    implementation.sha256 === expected.implementation?.sha256 &&
    ["recognizer", "numericCharacter", "characterLine"].every((key) =>
      checkpointMatches(checkpoints[key], expected[key])
    )
  );
}

export function pipelineFingerprint(expected) {
  const hash = createHash("sha256");
  for (const key of ["recognizer", "numericCharacter", "characterLine"]) {
    const checkpoint = expected[key];
    hash.update(`${key}:${checkpoint?.path ?? "none"}:${checkpoint?.sha256 ?? "missing"}\n`);
  }
  hash.update(`implementation:${expected.implementation?.sha256 ?? "missing"}\n`);
  return hash.digest("hex").slice(0, 16);
}

export function customOcrImplementationFingerprint(rootDir) {
  const customModelRoot = path.join(rootDir, "services", "ocr", "custom_model");
  const files = readdirSync(customModelRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
    .map((entry) => path.join(customModelRoot, entry.name));
  files.push(path.join(rootDir, "services", "ocr", "benchmarks", "ocr_benchmark.py"));
  const hash = createHash("sha256");
  const included = files
    .map((file) => ({ absolute: file, relative: path.relative(rootDir, file).replace(/\\/g, "/") }))
    .sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
  for (const file of included) {
    hash.update(`${file.relative}\n`);
    hash.update(readFileSync(file.absolute));
  }
  return { sha256: hash.digest("hex"), files: included.map((file) => file.relative) };
}

function checkpointMatches(actual, expected) {
  if (actual === null || actual === undefined) return expected === null || expected === undefined;
  if (!isPlainObject(actual) || !isPlainObject(expected)) return false;
  return (
    normalizeProjectPath(actual.path) === normalizeProjectPath(expected.path) &&
    actual.exists === true &&
    expected.exists === true &&
    typeof actual.sha256 === "string" &&
    actual.sha256 === expected.sha256
  );
}

function normalizeProjectPath(value) {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized || null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
