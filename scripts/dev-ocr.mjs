import { spawnSync } from "node:child_process";
import { inspectDockerRuntime, printDockerRuntimeGuidance } from "./docker-runtime-utils.mjs";

const dockerRuntime = inspectDockerRuntime();
if (!dockerRuntime.available) {
  printDockerRuntimeGuidance(dockerRuntime);
  process.exit(1);
}

const services = ["postgres", "redis", "redpanda", "minio", "ocr-service"];
const rebuildRequested = process.argv.includes("--build");

const composeArgs = [
  "compose",
  "--profile",
  "app",
  "up",
  "-d",
  ...(rebuildRequested ? ["--build"] : []),
  "--wait",
  "--wait-timeout",
  process.env.SPENDLENS_DEV_OCR_WAIT_SECONDS ?? "180",
  ...services
];

let result = runDocker(composeArgs);
writeResult(result);
if (result.status !== 0 && /network .* not found/i.test(`${result.stdout}\n${result.stderr}`)) {
  console.warn("[dev:ocr] Docker reported a stale network while starting services. Retrying once without changing volumes.");
  result = runDocker(composeArgs);
  writeResult(result);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("[dev:ocr] PostgreSQL, Redis, Redpanda, MinIO and OCR service are running and ready.");

function runDocker(args) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    shell: true,
    stdio: ["inherit", "pipe", "pipe"]
  });
}

function writeResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
