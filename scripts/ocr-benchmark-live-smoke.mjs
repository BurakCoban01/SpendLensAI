import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = "data/generated/ocr-benchmark-live/golden";
const outputDir = "artifacts/benchmarks/live-tesseract-golden";
const reportPath = resolve(projectRoot, outputDir, "benchmark-report.json");
const predictionsPath = resolve(projectRoot, outputDir, "predictions.jsonl");

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function requireNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${name} to be a finite number.`);
  }
}

await run("docker", [
  "compose",
  "run",
  "--rm",
  "ocr-service",
  "python",
  "-m",
  "services.ocr.benchmarks.ocr_benchmark",
  "--dataset-mode",
  "golden",
  "--samples",
  "6",
  "--lang",
  "tur+eng",
  "--data-dir",
  dataDir,
  "--output-dir",
  outputDir
]);

const report = JSON.parse(await readFile(reportPath, "utf8"));
const tesseract = report?.engines?.TESSERACT;
if (!tesseract || tesseract.status !== "ok") {
  throw new Error(`Expected live Tesseract benchmark status ok, got ${JSON.stringify(tesseract)}`);
}
if (tesseract.attempted !== 6 || tesseract.succeeded < 1) {
  throw new Error(`Expected Tesseract to attempt 6 golden samples and succeed at least once, got ${JSON.stringify(tesseract)}`);
}
for (const metric of ["failureRate", "averageCer", "averageWer", "averageLatencyMs", "averageConfidence"]) {
  requireNumber(tesseract[metric], `TESSERACT.${metric}`);
}
if (report.dataset?.documentTypes?.receipt !== 3 || report.dataset?.documentTypes?.invoice !== 3) {
  throw new Error(`Expected three receipt and three invoice golden samples, got ${JSON.stringify(report.dataset?.documentTypes)}`);
}

const predictionLines = (await readFile(predictionsPath, "utf8")).split(/\r?\n/).filter(Boolean);
if (predictionLines.filter((line) => JSON.parse(line).engine === "TESSERACT").length !== 6) {
  throw new Error("Expected six Tesseract prediction rows in predictions.jsonl.");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      reportPath: outputDir.replace(/\\/g, "/") + "/benchmark-report.json",
      predictionsPath: outputDir.replace(/\\/g, "/") + "/predictions.jsonl",
      tesseract: {
        attempted: tesseract.attempted,
        succeeded: tesseract.succeeded,
        failureRate: tesseract.failureRate,
        averageCer: tesseract.averageCer,
        averageWer: tesseract.averageWer,
        averageLatencyMs: tesseract.averageLatencyMs,
        averageConfidence: tesseract.averageConfidence
      }
    },
    null,
    2
  )
);
