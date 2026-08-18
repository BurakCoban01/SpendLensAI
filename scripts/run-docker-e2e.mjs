import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  SPENDLENS_E2E_DOCKER: "1",
  SPENDLENS_E2E_MEMORY_ADAPTERS: "false",
  SPENDLENS_E2E_API_PORT: process.env.SPENDLENS_E2E_API_PORT ?? "4101",
  SPENDLENS_E2E_WEB_PORT: process.env.SPENDLENS_E2E_WEB_PORT ?? "3001",
  OCR_SERVICE_URL: process.env.OCR_SERVICE_URL ?? "http://127.0.0.1:18622",
  SPENDLENS_E2E_NEXT_DIST_DIR: process.env.SPENDLENS_E2E_NEXT_DIST_DIR ?? ".next-e2e-docker",
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://spendlens:spendlens_local_password@127.0.0.1:15433/spendlens?schema=public",
  REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:16380",
  KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? "127.0.0.1:19092",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:19002",
  MINIO_ROOT_USER: process.env.MINIO_ROOT_USER ?? "spendlens",
  MINIO_ROOT_PASSWORD: process.env.MINIO_ROOT_PASSWORD ?? "spendlens_local_minio_password",
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? "e2e_access_secret_at_least_16_chars",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? "e2e_refresh_secret_at_least_16_chars",
  API_KEY_PEPPER: process.env.API_KEY_PEPPER ?? "e2e_api_key_pepper_at_least_16_chars",
  RATE_LIMIT_MAX: "2000",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "silent"
};

env.SPENDLENS_E2E_API_BASE_URL =
  process.env.SPENDLENS_E2E_API_BASE_URL ?? `http://127.0.0.1:${env.SPENDLENS_E2E_API_PORT}`;
env.SPENDLENS_E2E_WEB_BASE_URL =
  process.env.SPENDLENS_E2E_WEB_BASE_URL ?? `http://127.0.0.1:${env.SPENDLENS_E2E_WEB_PORT}`;
env.CORS_ALLOWED_ORIGINS =
  process.env.CORS_ALLOWED_ORIGINS ??
  `http://localhost:${env.SPENDLENS_E2E_WEB_PORT},http://127.0.0.1:${env.SPENDLENS_E2E_WEB_PORT}`;

run("docker", [
  "compose",
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  "180",
  "postgres",
  "redis",
  "redpanda",
  "minio",
  "ocr-service"
], env);
run("pnpm", ["db:migrate"], env);
run("pnpm", ["exec", "playwright", "test", "e2e/docker-backed.spec.ts"], env);

function run(command, args, childEnv) {
  const result = spawnSync(command, args, {
    env: childEnv,
    shell: true,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
