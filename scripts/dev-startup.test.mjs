import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectDockerRuntime } from "./docker-runtime-utils.mjs";
import { annotateComposeListeners, parseComposePsOutput } from "./dev-port-utils.mjs";
import { benchmarkMatchesPipeline, pipelineFingerprint } from "./custom-ocr-benchmark-provenance.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Docker runtime preflight distinguishes a stopped engine from a missing CLI", () => {
  const stopped = inspectDockerRuntime(() => ({ status: 1, stdout: "", stderr: "open //./pipe/dockerDesktopLinuxEngine" }));
  const missing = inspectDockerRuntime(() => ({ status: null, error: { code: "ENOENT" } }));

  assert.equal(stopped.available, false);
  assert.equal(stopped.reason, "engine_unavailable");
  assert.match(stopped.detail, /dockerDesktopLinuxEngine/);
  assert.equal(missing.reason, "cli_missing");
});

test("Compose ps JSON identifies Docker-published web and API ports", () => {
  const records = parseComposePsOutput(
    JSON.stringify([
      { Service: "web", State: "running", Publishers: [{ PublishedPort: 18620 }] },
      { Service: "api", State: "running", Publishers: [{ PublishedPort: 18621 }] }
    ])
  );
  const owners = new Map();
  for (const record of records) {
    for (const publisher of record.Publishers) owners.set(Number(publisher.PublishedPort), record.Service);
  }
  const listeners = annotateComposeListeners(
    [
      { label: "web", port: 18620, pid: "15448" },
      { label: "api", port: 18621, pid: "15448" }
    ],
    owners
  );

  assert.deepEqual(
    listeners.map(({ port, composeService }) => ({ port, composeService })),
    [
      { port: 18620, composeService: "web" },
      { port: 18621, composeService: "api" }
    ]
  );
});

test("Compose ps parser accepts newline-delimited JSON emitted by older Compose versions", () => {
  const records = parseComposePsOutput(
    '{"Service":"web","State":"running","Publishers":[]}\n{"Service":"api","State":"running","Publishers":[]}'
  );
  assert.deepEqual(
    records.map((record) => record.Service),
    ["web", "api"]
  );
});

test("Custom OCR bootstrap accepts only a benchmark from the exact model pipeline", () => {
  const expected = {
    implementation: { sha256: "e".repeat(64), files: ["services/ocr/custom_model/infer.py"] },
    recognizer: { path: "artifacts/models/crnn/model.pt", exists: true, sha256: "a".repeat(64) },
    numericCharacter: { path: "artifacts/models/numeric/model.pt", exists: true, sha256: "b".repeat(64) },
    characterLine: { path: "artifacts/models/character/model.pt", exists: true, sha256: "c".repeat(64) }
  };
  const report = {
    provenance: {
      implementation: structuredClone(expected.implementation),
      checkpoints: {
        recognizer: structuredClone(expected.recognizer),
        numericCharacter: structuredClone(expected.numericCharacter),
        characterLine: structuredClone(expected.characterLine)
      }
    }
  };

  assert.equal(benchmarkMatchesPipeline(report, expected), true);
  report.provenance.checkpoints.characterLine.sha256 = "d".repeat(64);
  assert.equal(benchmarkMatchesPipeline(report, expected), false);
  assert.equal(pipelineFingerprint(expected).length, 16);
});

test("warm OCR startup reuses the existing image and keeps rebuild explicit", () => {
  const source = readFileSync(resolve(rootDir, "scripts", "dev-ocr.mjs"), "utf8");
  const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

  assert.match(source, /rebuildRequested = process\.argv\.includes\("--build"\)/);
  assert.doesNotMatch(source, /"-d",\s*"--build"/);
  assert.equal(packageJson.scripts["dev:ocr"], "node scripts/dev-ocr.mjs");
  assert.equal(packageJson.scripts["dev:ocr:rebuild"], "node scripts/dev-ocr.mjs --build");
});

test("normal Custom OCR bootstrap does not benchmark unless explicitly requested", () => {
  const source = readFileSync(resolve(rootDir, "scripts", "custom-ocr-bootstrap-local-full.mjs"), "utf8");

  assert.match(source, /if \(!options\.benchmark\)/);
  assert.match(source, /rawArgs\.includes\("--benchmark"\)/);
  assert.match(source, /CUSTOM_OCR_BOOTSTRAP_BENCHMARK \?\? "false"/);
});

test("normal development startup scopes Custom OCR registration to the demo tenant", () => {
  const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

  assert.match(packageJson.scripts.dev, /custom-ocr-bootstrap-local-full\.mjs --optional/);
  assert.doesNotMatch(packageJson.scripts.dev, /--all-tenants/);
});

test("database migration launches the pnpm module without a Windows shell and safely baselines matching push schemas", () => {
  const source = readFileSync(resolve(rootDir, "scripts", "ensure-local-db.mjs"), "utf8");

  assert.match(source, /resolvePnpmInvocation\(env\)/);
  assert.match(source, /spawn\(pnpm\.command/);
  assert.match(source, /\["migrate", "deploy"\]/);
  assert.match(source, /P3005/);
  assert.match(source, /"migrate",\s*"diff"/);
  assert.match(source, /--exit-code/);
  assert.doesNotMatch(source, /"db", "push"/);
  assert.doesNotMatch(source, /shell: process\.platform === "win32"/);
});

test("root environment runner launches the pnpm module without a Windows shell", () => {
  const source = readFileSync(resolve(rootDir, "scripts", "run-with-root-env.mjs"), "utf8");

  assert.match(source, /resolvePnpmInvocation\(env\)/);
  assert.match(source, /spawn\(pnpm\.command/);
  assert.doesNotMatch(source, /pnpm\.cmd/);
});

test("shared Windows pnpm resolver prefers the project-aware Corepack entrypoint", () => {
  const source = readFileSync(resolve(rootDir, "scripts", "pnpm-invocation.mjs"), "utf8");

  assert.match(source, /command: process\.execPath/);
  assert.match(source, /node_modules", "corepack", "dist", "pnpm\.js"/);
  assert.match(source, /node_modules", "pnpm", "bin", "pnpm\.mjs"/);
});

test("web launcher uses the shared shell-free pnpm invocation", () => {
  const source = readFileSync(resolve(rootDir, "scripts", "next-web.mjs"), "utf8");

  assert.match(source, /resolvePnpmInvocation\(env\)/);
  assert.match(source, /spawn\(pnpm\.command/);
  assert.doesNotMatch(source, /pnpm\.cmd/);
});
