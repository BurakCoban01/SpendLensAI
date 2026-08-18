import { spawn } from "node:child_process";

const apiPort = process.env.SPENDLENS_E2E_API_PORT ?? "4100";
const webPort = process.env.SPENDLENS_E2E_WEB_PORT ?? "3000";
const useMemoryAdapters = process.env.SPENDLENS_E2E_MEMORY_ADAPTERS ?? process.env.SPENDLENS_USE_MEMORY_ADAPTERS ?? "true";
const webOrigins =
  process.env.CORS_ALLOWED_ORIGINS ?? `http://localhost:${webPort},http://127.0.0.1:${webPort}`;

const child = spawn("node", ["apps/api/dist/main.js"], {
  env: {
    ...process.env,
    API_PORT: apiPort,
    CORS_ALLOWED_ORIGINS: webOrigins,
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
    LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
    RATE_LIMIT_MAX: "2000",
    SPENDLENS_USE_MEMORY_ADAPTERS: useMemoryAdapters
  },
  shell: true,
  stdio: "inherit"
});

function stop(signal) {
  child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
