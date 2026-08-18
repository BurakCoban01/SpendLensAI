import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import { resolvePnpmInvocation } from "./pnpm-invocation.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadRootEnv();

if (isTruthy(env.SPENDLENS_SKIP_DEV_DB_SYNC) || isTruthy(env.SPENDLENS_USE_MEMORY_ADAPTERS) || !env.DATABASE_URL) {
  console.log("[dev-db] Skipping local database sync.");
  process.exit(0);
}

const databaseEndpoint = parseDatabaseEndpoint(env.DATABASE_URL);
if (databaseEndpoint) {
  await waitForTcp(databaseEndpoint.host, databaseEndpoint.port, Number(env.SPENDLENS_DEV_DB_WAIT_MS ?? 90000));
}

const pnpm = resolvePnpmInvocation(env);
let result = await runPrisma(["migrate", "deploy"]);

if (result.code !== 0 && /P3005/.test(result.output)) {
  console.warn("[dev-db] Existing push-managed schema detected. Verifying an exact schema match before migration baseline.");
  const diff = await runPrisma([
    "migrate",
    "diff",
    "--from-schema-datasource",
    "prisma/schema.prisma",
    "--to-schema-datamodel",
    "prisma/schema.prisma",
    "--exit-code"
  ]);
  if (diff.code !== 0) {
    console.error("[dev-db] Existing schema differs from the current Prisma datamodel; automatic baseline was refused.");
    process.exit(diff.code ?? 1);
  }

  const migrations = readdirSync(resolve(rootDir, "packages/db/prisma/migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const migration of migrations) {
    const baseline = await runPrisma(["migrate", "resolve", "--applied", migration]);
    if (baseline.code !== 0) process.exit(baseline.code ?? 1);
  }
  result = await runPrisma(["migrate", "deploy"]);
}

if (result.code !== 0) {
  if (/Command ["']?prisma["']? not found|not found: prisma|Cannot find module/i.test(result.output)) {
    console.error("[dev-db] Prisma CLI could not be resolved. Run `pnpm install` from the repository root, then rerun `pnpm dev`.");
  }
  console.error("[dev-db] Database migration failed. For OCR work, start local services with `pnpm dev:ocr`, then rerun `pnpm dev`.");
  console.error("[dev-db] For non-OCR work, `pnpm dev:up` starts only PostgreSQL, Redis, Redpanda and MinIO.");
  console.error("[dev-db] Set SPENDLENS_SKIP_DEV_DB_SYNC=true only if the database schema is already managed externally.");
  process.exit(result.code ?? 1);
}

function runPrisma(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(pnpm.command, [...pnpm.args, "--dir", resolve(rootDir, "packages/db"), "exec", "prisma", ...args], {
      cwd: rootDir,
      env,
      stdio: ["inherit", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolveRun({ code, output });
    });
  });
}

function loadRootEnv() {
  const env = { ...process.env };
  const envPath = resolve(rootDir, ".env");
  try {
    const text = readFileSync(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && env[key] === undefined) env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return env;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function parseDatabaseEndpoint(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    if (!parsed.hostname) return null;
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 5432)
    };
  } catch {
    return null;
  }
}

async function waitForTcp(host, port, timeoutMs) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await connectOnce(host, port);
      if (Date.now() - startedAt > 1000) {
        console.log(`[dev-db] Database port ${host}:${port} is reachable.`);
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(1500);
    }
  }
  console.error(`[dev-db] Database at ${host}:${port} did not become reachable within ${Math.round(timeoutMs / 1000)}s.`);
  console.error("[dev-db] Start local services with `pnpm dev:ocr` for OCR work, or `pnpm dev:up` for non-OCR work, then rerun `pnpm dev`.");
  if (lastError) console.error(`[dev-db] Last connection error: ${lastError}`);
  process.exit(1);
}

function connectOnce(host, port) {
  return new Promise((resolveConnection, rejectConnection) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectConnection(new Error("connection timed out"));
    }, 1500);
    socket.on("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolveConnection();
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      rejectConnection(error);
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
