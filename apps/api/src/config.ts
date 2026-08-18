import { z } from "zod";

const EnvBoolean = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  API_PORT: z.coerce.number().int().positive().default(18621),
  SPENDLENS_USE_MEMORY_ADAPTERS: EnvBoolean.default(false),
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:18620,http://127.0.0.1:18620"),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_TIME_WINDOW: z.string().default("1 minute"),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().optional(),
  KAFKA_BROKERS: z.string().optional(),
  KAFKA_LAG_CONSUMER_GROUPS: z.string().default(""),
  MINIO_ENDPOINT: z.string().optional(),
  MINIO_ROOT_USER: z.string().default("spendlens"),
  MINIO_ROOT_PASSWORD: z.string().default("spendlens_local_minio_password"),
  MINIO_BUCKET_DOCUMENTS: z.string().default("spendlens-documents"),
  MINIO_BUCKET_ARTIFACTS: z.string().default("spendlens-artifacts"),
  DOCUMENT_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  TENANT_STORAGE_SOFT_LIMIT_BYTES: z.coerce.number().int().positive().default(512 * 1024 * 1024),
  OCR_SERVICE_URL: z.string().url().optional(),
  CUSTOM_OCR_ALLOW_UNREGISTERED_CHECKPOINT: EnvBoolean.default(false),
  LLM_ENABLED: EnvBoolean.default(false),
  LLM_PROVIDER: z.enum(["disabled", "gemini", "zai"]).default("disabled"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-lite"),
  GEMINI_THINKING_MODE: z.string().default("high"),
  GEMINI_API_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com"),
  ZAI_API_KEY: z.string().optional(),
  ZAI_MODEL: z.string().default("glm-5.1"),
  ZAI_THINKING_ENABLED: EnvBoolean.default(true),
  ZAI_API_BASE_URL: z.string().url().default("https://api.z.ai"),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  LLM_STORE_RAW_INPUTS: EnvBoolean.default(false),
  JWT_ACCESS_SECRET: z.string().min(16).default("development_access_secret_change_me"),
  JWT_REFRESH_SECRET: z.string().min(16).default("development_refresh_secret_change_me"),
  API_KEY_PEPPER: z.string().min(16).default("development_api_key_pepper_change_me"),
  WEBHOOK_SECRET_ENCRYPTION_KEY: z.string().min(24).default("development_webhook_secret_key_change_me")
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse(env);
}
