import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "node_modules",
  "test-results",
  "playwright-report",
  "coverage",
  "dist",
  "build",
  "data",
  "artifacts"
]);

const ignoredFiles = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  ".env.example"
]);

const scannedExtensions = new Set([
  ".cmd",
  ".env",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".prisma",
  ".py",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

const patterns = [
  { name: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: "openai-api-key", regex: /sk-[A-Za-z0-9]{32,}/g },
  { name: "private-key-block", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: "slack-token", regex: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
  { name: "stripe-secret-key", regex: /sk_live_[A-Za-z0-9]{24,}/g },
  { name: "webhook-secret", regex: /whsec_[A-Za-z0-9]{20,}/g },
  {
    name: "hardcoded-secret-assignment",
    regex: /\b(?:JWT_ACCESS_SECRET|JWT_REFRESH_SECRET|SESSION_COOKIE_SECRET|API_KEY_PEPPER|MINIO_ROOT_PASSWORD|POSTGRES_PASSWORD)\s*=\s*(?!replace_|spendlens_local_|changeme|example|placeholder)[^\s#'"]{12,}/g
  }
];

const findings = [];

for (const file of listFiles(root)) {
  if (!shouldScan(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      findings.push({
        file: relative(root, file).replace(/\\/g, "/"),
        line: lineNumber(text, match.index ?? 0),
        pattern: pattern.name
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Secret scan failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} matched ${finding.pattern}`);
  }
  process.exit(1);
}

console.log("Secret scan passed.");

function* listFiles(directory) {
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* listFiles(path);
      continue;
    }
    if (stat.isFile()) yield path;
  }
}

function shouldScan(file) {
  const name = file.split(/[\\/]/).at(-1) ?? "";
  if (ignoredFiles.has(name)) return false;
  if (name.startsWith(".env.") && name !== ".env.local") return true;
  const extension = name.includes(".") ? `.${name.split(".").at(-1)}` : "";
  return scannedExtensions.has(extension);
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}
