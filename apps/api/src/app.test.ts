import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app";
import { InMemoryCacheStore } from "./modules/cache/memory-store";
import type { CacheHealth, CacheKeySummary, CacheStore } from "./modules/cache/types";
import { InMemoryDocumentStorage } from "./modules/documents/storage";
import type { DocumentStorage, DocumentStorageMetrics } from "./modules/documents/types";
import type { KafkaConsumerLagProvider, KafkaConsumerLagSnapshot } from "./modules/events/types";

describe("api app", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("returns liveness", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "api" });
  });

  it("sets baseline security headers", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["referrer-policy"]).toBeDefined();
  });

  it("allows configured local CORS origins and suppresses untrusted origins", async () => {
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/health/live",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET"
      }
    });
    const denied = await app.inject({
      method: "OPTIONS",
      url: "/health/live",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "GET"
      }
    });

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("exposes product catalogs without dead-coded constants", async () => {
    const response = await app.inject({ method: "GET", url: "/catalog" });
    const body = response.json();
    expect(body.roles).toContain("OWNER");
    expect(body.kafkaTopics).toContain("document.uploaded");
    expect(body.supportedUploadMimeTypes).toContain("application/pdf");
  });

  it("publishes OpenAPI with complete route coverage, auth schemes and examples", async () => {
    const response = await app.inject({ method: "GET", url: "/docs/json" });
    const spec = response.json();
    const operations = collectOpenApiOperations(spec);

    expect(response.statusCode).toBe(200);
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    expect(spec.components.securitySchemes.apiKeyAuth.name).toBe("Authorization");
    expect(spec.components.examples.RegisterRequest.value.tenantSlug).toBe("demo-tenant");
    expect(spec.components.examples.ExpenseCreateRequest.value.totalAmountMinor).toBe(18550);
    expect(spec.components.schemas.MoneyMinorUnit.properties.amountMinor.pattern).toBe("^-?[0-9]+$");

    const sourceRoutes = collectSourceRoutes();
    const missing = [...sourceRoutes].filter((route) => !operations.has(route)).sort();
    expect(missing).toEqual([]);
    expect(operations.size).toBeGreaterThanOrEqual(sourceRoutes.size);
  });

  it("exposes Prometheus metrics with HTTP counters and latency buckets", async () => {
    await app.inject({ method: "GET", url: "/health/live" });

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("spendlens_api_info");
    expect(response.body).toContain("spendlens_process_uptime_seconds");
    expect(response.body).toContain(
      'spendlens_http_requests_total{method="GET",route="/health/live",status_code="200"}'
    );
    expect(response.body).toContain(
      'spendlens_http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/health/live",status_code="200"}'
    );
  });

  it("exposes event, worker, cache, storage, OCR and review gauges without tenant labels", async () => {
    const memoryApp = await buildApp({
      config: {
        SPENDLENS_USE_MEMORY_ADAPTERS: true
      }
    });
    try {
      const register = await memoryApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Metrics Tenant",
          tenantSlug: "metrics-events",
          workspaceName: "Metrics",
          email: "metrics@example.com",
          displayName: "Metrics Owner",
          password: "very-secure-password"
        }
      });
      const token = register.json().tokens.accessToken;
      const me = await memoryApp.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
      const tenantId = me.json().principal.tenantId;
      const workspaces = await memoryApp.inject({ method: "GET", url: "/workspaces", headers: { authorization: `Bearer ${token}` } });
      const workspaceId = workspaces.json().workspaces[0].id;
      const upload = await memoryApp.inject({
        method: "POST",
        url: `/documents/upload?workspaceId=${workspaceId}&kind=RECEIPT`,
        headers: {
          authorization: `Bearer ${token}`,
          ...multipartHeaders("metrics-boundary")
        },
        payload: multipartBody("metrics-boundary", "metrics-receipt.png", "image/png", pngBytes())
      });
      const documentId = upload.json().document.id;
      await memoryApp.inject({
        method: "POST",
        url: "/admin/events/outbox",
        headers: { authorization: `Bearer ${token}` },
        payload: { topic: "expense.created", aggregateId: "expense_metrics_1", payload: { amountMinor: "1200" } }
      });
      await memoryApp.inject({
        method: "POST",
        url: "/admin/events/inbox/record",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          consumerName: "metrics-consumer",
          event: {
            id: "event-metrics-1",
            topic: "expense.created",
            tenantId,
            aggregateId: "expense_metrics_1",
            schemaVersion: 1,
            correlationId: "corr-metrics",
            payload: { amountMinor: "1200" }
          }
        }
      });
      await memoryApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.compare",
          dedupeKey: "metrics-job-1",
          payload: { documentFileId: "doc_metrics_1" }
        }
      });
      await memoryApp.inject({
        method: "POST",
        url: `/documents/${documentId}/ocr-runs/compare`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          runs: [
            { engine: "TESSERACT", text: "MARKET\nTOPLAM 12,00 TL", confidence: 0.8, latencyMs: 120 },
            { engine: "CUSTOM_CRNN", text: "MARKET\nTOPLAM 12,00 TL", confidence: 0.6, latencyMs: 240 }
          ]
        }
      });
      const reviewTask = await memoryApp.inject({
        method: "POST",
        url: `/documents/${documentId}/review-tasks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reasonCodes: ["LOW_CONFIDENCE"] }
      });
      await memoryApp.inject({
        method: "POST",
        url: `/review/tasks/${reviewTask.json().id}/complete`,
        headers: { authorization: `Bearer ${token}` }
      });
      await memoryApp.inject({
        method: "POST",
        url: `/documents/${documentId}/corrections`,
        headers: { authorization: `Bearer ${token}` },
        payload: { fieldName: "total", beforeValue: "11,00", afterValue: "12,00", createAnnotation: true }
      });

      const response = await memoryApp.inject({ method: "GET", url: "/metrics" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('spendlens_event_outbox_events{state="pending"} 3');
      expect(response.body).toContain('spendlens_event_outbox_topic_events{state="pending",topic="document.uploaded"} 1');
      expect(response.body).toContain('spendlens_event_outbox_topic_events{state="pending",topic="ocr.job.created"} 1');
      expect(response.body).toContain('spendlens_event_outbox_topic_events{state="pending",topic="expense.created"} 1');
      expect(response.body).toContain('spendlens_event_inbox_events{status="processed"} 1');
      expect(response.body).toContain('spendlens_event_inbox_topic_events{status="processed",topic="expense.created"} 1');
      expect(response.body).toContain('spendlens_worker_jobs{status="QUEUED"} 3');
      expect(response.body).toContain('spendlens_worker_queue_jobs{queue="ocr",status="QUEUED"} 1');
      expect(response.body).toContain('spendlens_worker_queue_jobs{queue="preprocessing",status="QUEUED"} 1');
      expect(response.body).toContain('spendlens_cache_connected{backend="memory"} 1');
      expect(response.body).toContain('spendlens_cache_worker_hot_state_keys{backend="memory"} 3');
      expect(response.body).toContain('spendlens_storage_connected{backend="memory"} 1');
      expect(response.body).toContain('spendlens_storage_objects{backend="memory"} 1');
      expect(response.body).toContain('spendlens_ocr_engine_runs{engine="TESSERACT",status="SUCCEEDED"} 1');
      expect(response.body).toContain('spendlens_ocr_engine_confidence_average{engine="TESSERACT"} 0.800000');
      expect(response.body).toContain('spendlens_ocr_engine_latency_ms_average{engine="TESSERACT"} 120');
      expect(response.body).toContain('spendlens_review_tasks{status="SUCCEEDED"} 1');
      expect(response.body).toContain("spendlens_review_corrections 1");
      expect(response.body).toContain("spendlens_review_annotations 1");
      expect(response.body).toContain("spendlens_review_active_learning_suggestions 1");
      expect(response.body).toContain("spendlens_review_correction_rate 1");
      expect(response.body).not.toContain(tenantId);
    } finally {
      await memoryApp.close();
    }
  });

  it("keeps metrics scrapeable while exposing cache and storage operation errors", async () => {
    const degradedApp = await buildApp({
      config: {
        SPENDLENS_USE_MEMORY_ADAPTERS: true
      },
      cacheStore: new DegradedCacheStore(),
      documentStorage: new DegradedDocumentStorage()
    });
    try {
      const response = await degradedApp.inject({ method: "GET", url: "/metrics" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('spendlens_cache_connected{backend="redis"} 0');
      expect(response.body).toContain('spendlens_cache_operation_errors_total{backend="redis",operation="health"} 1');
      expect(response.body).toContain('spendlens_cache_operation_errors_total{backend="redis",operation="list_keys"} 1');
      expect(response.body).toContain('spendlens_storage_connected{backend="minio"} 0');
      expect(response.body).toContain('spendlens_storage_operation_errors_total{backend="minio",operation="health"} 1');
      expect(response.body).toContain('spendlens_http_requests_total');
    } finally {
      await degradedApp.close();
    }
  });

  it("exposes failed worker job gauges by queue and last processing worker", async () => {
    const memoryApp = await buildApp({
      config: {
        SPENDLENS_USE_MEMORY_ADAPTERS: true
      }
    });
    try {
      const register = await memoryApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Worker Metrics Tenant",
          tenantSlug: "worker-metrics",
          workspaceName: "Worker Metrics",
          email: "worker-metrics@example.com",
          displayName: "Worker Metrics Owner",
          password: "very-secure-password"
        }
      });
      const token = register.json().tokens.accessToken;
      const me = await memoryApp.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
      const tenantId = me.json().principal.tenantId;
      const enqueue = await memoryApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.compare",
          dedupeKey: "worker-failure-metric-1",
          payload: { documentFileId: "doc_failure_metric_1" }
        }
      });
      const jobId = enqueue.json().job.id;
      await memoryApp.inject({
        method: "POST",
        url: `/admin/jobs/${jobId}/start`,
        headers: { authorization: `Bearer ${token}` },
        payload: { workerId: "metrics-worker-1" }
      });
      await memoryApp.inject({
        method: "POST",
        url: `/admin/jobs/${jobId}/fail`,
        headers: { authorization: `Bearer ${token}` },
        payload: { failureReason: "Synthetic worker failure for metrics" }
      });

      const response = await memoryApp.inject({ method: "GET", url: "/metrics" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('spendlens_worker_jobs{status="FAILED"} 1');
      expect(response.body).toContain('spendlens_worker_queue_jobs{queue="ocr",status="FAILED"} 1');
      expect(response.body).toContain('spendlens_worker_failed_jobs{queue="ocr",worker="metrics-worker-1"} 1');
      expect(response.body).not.toContain(tenantId);
      expect(response.body).not.toContain("Synthetic worker failure for metrics");
    } finally {
      await memoryApp.close();
    }
  });

  it("exposes Kafka consumer lag gauges from the configured lag provider without tenant labels", async () => {
    const lagProvider = new FakeKafkaLagProvider();
    const memoryApp = await buildApp({
      config: {
        SPENDLENS_USE_MEMORY_ADAPTERS: true
      },
      eventLagProvider: lagProvider
    });
    try {
      const response = await memoryApp.inject({ method: "GET", url: "/metrics" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        'spendlens_kafka_consumer_lag{group="spendlens-workers",partition="0",topic="document.uploaded"} 7'
      );
      expect(response.body).toContain(
        'spendlens_kafka_consumer_committed_offset{group="spendlens-workers",partition="0",topic="document.uploaded"} 13'
      );
      expect(response.body).toContain(
        'spendlens_kafka_topic_high_watermark{group="spendlens-workers",partition="0",topic="document.uploaded"} 20'
      );
      expect(response.body).not.toContain("tenant_");
    } finally {
      await memoryApp.close();
    }
    expect(lagProvider.closed).toBe(true);
  });

  it("keeps event metrics scrapeable when Kafka lag collection is degraded", async () => {
    const lagProvider = new FailingKafkaLagProvider();
    const memoryApp = await buildApp({
      config: {
        SPENDLENS_USE_MEMORY_ADAPTERS: true
      },
      eventLagProvider: lagProvider
    });
    try {
      const register = await memoryApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Kafka Lag Degraded Tenant",
          tenantSlug: "kafka-lag-degraded",
          workspaceName: "Ops",
          email: "kafka-lag-degraded@example.com",
          displayName: "Kafka Lag Owner",
          password: "very-secure-password"
        }
      });
      const token = register.json().tokens.accessToken;
      await memoryApp.inject({
        method: "POST",
        url: "/admin/events/outbox",
        headers: { authorization: `Bearer ${token}` },
        payload: { topic: "expense.updated", aggregateId: "expense_lag_degraded_1", payload: { status: "approved" } }
      });

      const response = await memoryApp.inject({ method: "GET", url: "/metrics" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('spendlens_event_outbox_events{state="pending"} 1');
      expect(response.body).toContain('spendlens_event_outbox_topic_events{state="pending",topic="expense.updated"} 1');
      expect(response.body).not.toContain("spendlens_kafka_consumer_lag{");
    } finally {
      await memoryApp.close();
    }
  });
});

function collectOpenApiOperations(spec: {
  paths: Record<string, Record<string, unknown>>;
}): Set<string> {
  const operations = new Set<string>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      if (["get", "post", "patch", "put", "delete"].includes(method)) {
        operations.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return operations;
}

function collectSourceRoutes(): Set<string> {
  const sourceRoot = join(process.cwd(), "src");
  const routePattern = /app\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  const routes = new Set<string>();
  for (const file of listSourceFiles(sourceRoot)) {
    const text = readFileSync(file, "utf8");
    for (const route of text.matchAll(routePattern)) {
      const method = String(route[1]).toUpperCase();
      const path = String(route[2]).replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      routes.add(`${method} ${path}`);
    }
  }
  return routes;
}

function* listSourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist" || entry.endsWith(".test.ts")) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* listSourceFiles(path);
      continue;
    }
    if (stat.isFile() && path.endsWith(".ts")) yield path;
  }
}

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}

function multipartHeaders(boundary: string) {
  return { "content-type": `multipart/form-data; boundary=${boundary}` };
}

function multipartBody(boundary: string, filename: string, mimeType: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        `Content-Type: ${mimeType}`,
        "",
        ""
      ].join("\r\n")
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

describe("api app rate limiting", () => {
  it("returns 429 and rate-limit headers after the configured request budget is exhausted", async () => {
    const limitedApp = await buildApp({
      config: {
        RATE_LIMIT_MAX: 2,
        RATE_LIMIT_TIME_WINDOW: "1 minute"
      }
    });
    try {
      await limitedApp.inject({ method: "GET", url: "/health/live" });
      await limitedApp.inject({ method: "GET", url: "/health/live" });
      const response = await limitedApp.inject({ method: "GET", url: "/health/live" });

      expect(response.statusCode).toBe(429);
      expect(response.headers["x-ratelimit-limit"]).toBe("2");
      expect(response.headers["retry-after"]).toBeDefined();
    } finally {
      await limitedApp.close();
    }
  });

  it("can enforce request budgets through the Redis-backed rate-limit store", async () => {
    const redis = new FakeRateLimitRedisClient();
    const limitedApp = await buildApp({
      rateLimitRedisClient: redis,
      config: {
        SPENDLENS_USE_MEMORY_ADAPTERS: true,
        RATE_LIMIT_MAX: 2,
        RATE_LIMIT_TIME_WINDOW: "1 minute"
      }
    });
    try {
      await limitedApp.inject({ method: "GET", url: "/health/live" });
      await limitedApp.inject({ method: "GET", url: "/health/live" });
      const response = await limitedApp.inject({ method: "GET", url: "/health/live" });

      expect(response.statusCode).toBe(429);
      expect(response.headers["x-ratelimit-limit"]).toBe("2");
      expect(redis.keys()).toContain("spendlens-rate-limit-127.0.0.1");
    } finally {
      await limitedApp.close();
    }
  });
});

describe("api app memory adapters", () => {
  it("can run auth flows without external PostgreSQL or object storage", async () => {
    const memoryApp = await buildApp({
      config: {
        SPENDLENS_USE_MEMORY_ADAPTERS: true
      }
    });
    try {
      const response = await memoryApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "E2E Tenant",
          tenantSlug: "e2e",
          workspaceName: "Finance",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().tokens.accessToken).toEqual(expect.any(String));
    } finally {
      await memoryApp.close();
    }
  });
});

describe("admin health route", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let tenantId: string;
  let cacheStore: InMemoryCacheStore;
  let documentStorage: CountingDocumentStorage;

  beforeAll(async () => {
    cacheStore = new InMemoryCacheStore();
    documentStorage = new CountingDocumentStorage();
    app = await buildApp({
      config: {
        SPENDLENS_USE_MEMORY_ADAPTERS: true
      },
      cacheStore,
      documentStorage
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Ops Tenant",
        tenantSlug: "ops",
        workspaceName: "Ops",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    accessToken = register.json().tokens.accessToken;
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${accessToken}` } });
    tenantId = me.json().principal.tenantId;
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires authentication for admin health", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/health" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("MISSING_BEARER_TOKEN");
  });

  it("returns dependency status to authorized users", async () => {
    const workspaces = await app.inject({
      method: "GET",
      url: "/workspaces",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const workspaceId = workspaces.json().workspaces[0].id;
    const upload = await app.inject({
      method: "POST",
      url: `/documents/upload?workspaceId=${workspaceId}&kind=RECEIPT`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("health-boundary")
      },
      payload: multipartBody("health-boundary", "health-receipt.png", "image/png", pngBytes())
    });
    expect([200, 201]).toContain(upload.statusCode);
    const createdExpense = await app.inject({
      method: "POST",
      url: "/expenses",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId,
        title: "Ops health lunch",
        currency: "TRY",
        amountMinor: "12345",
        taxMinor: "0",
        occurredAt: "2026-05-14T09:00:00.000Z"
      }
    });
    expect(createdExpense.statusCode).toBe(201);

    const response = await app.inject({
      method: "GET",
      url: "/admin/health",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.checks).toHaveProperty("postgres");
    expect(body.checks).toHaveProperty("workers");
    expect(body.operations.tenantUsage.workspaceCount).toBe(1);
    expect(body.operations.tenantUsage.documentCount).toBe(1);
    expect(body.operations.tenantUsage.activeExpenseCount).toBe(1);
    expect(body.operations.tenantUsage.totalExpenseMinorByCurrency.TRY).toBe("12345");
    expect(body.operations.storageUsage.documentBytes).toBe(String(pngBytes().length));
    expect(body.operations.storageUsage.quota.usedBytes).toBe(String(pngBytes().length));
    expect(body.operations.storageUsage.quota.softLimitBytes).toEqual(expect.any(String));
    expect(body.operations.storageUsage.quota.status).toBe("ok");
    expect(body.operations.rateLimit.max).toEqual(expect.any(Number));
    expect(body.operations.featureFlags.some((flag: { key: string }) => flag.key === "memoryAdapters")).toBe(true);
    expect(
      body.operations.featureFlags.find((flag: { key: string }) => flag.key === "customOcrUnregisteredCheckpoint")
    ).toMatchObject({ enabled: false });
    expect(body.operations.runbooks.some((runbook: { path: string }) => runbook.path === "docs/runbooks/dependency-degraded.md")).toBe(true);

    const metricsCallsAfterFirstHealthCheck = documentStorage.metricsCalls;
    expect(metricsCallsAfterFirstHealthCheck).toBeGreaterThan(0);
    const cacheKeys = await cacheStore.listKeys(`dashboard:${tenantId}:admin-health:`, 10);
    expect(cacheKeys).toHaveLength(1);

    const cachedResponse = await app.inject({
      method: "GET",
      url: "/admin/health",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(cachedResponse.statusCode).toBe(200);
    expect(cachedResponse.json().operations).toEqual(body.operations);
    expect(documentStorage.metricsCalls).toBe(metricsCallsAfterFirstHealthCheck);
  });

  it("queues document reprocess jobs from the admin operations endpoint", async () => {
    const workspaces = await app.inject({
      method: "GET",
      url: "/workspaces",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const workspaceId = workspaces.json().workspaces[0].id;
    const upload = await app.inject({
      method: "POST",
      url: `/documents/upload?workspaceId=${workspaceId}&kind=RECEIPT`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("reprocess-boundary")
      },
      payload: multipartBody("reprocess-boundary", "reprocess.png", "image/png", pngBytes())
    });
    expect([200, 201]).toContain(upload.statusCode);
    const documentFileId = upload.json().document.id;

    const blockedCheckpoint = await app.inject({
      method: "POST",
      url: `/admin/operations/documents/${documentFileId}/reprocess`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        stages: ["preprocess", "tesseract", "custom_crnn"],
        preprocessingProfile: "TESSERACT_OPTIMIZED",
        language: "tur+eng",
        checkpoint: "C:/private/checkpoints/custom-crnn.pt"
      }
    });
    expect(blockedCheckpoint.statusCode).toBe(400);
    expect(blockedCheckpoint.json().error.code).toBe("CUSTOM_OCR_UNREGISTERED_CHECKPOINT_DISABLED");

    const response = await app.inject({
      method: "POST",
      url: `/admin/operations/documents/${documentFileId}/reprocess`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        stages: ["preprocess", "tesseract", "custom_crnn"],
        preprocessingProfile: "TESSERACT_OPTIMIZED",
        language: "tur+eng"
      }
    });

    expect(response.statusCode).toBe(202);
    const reprocess = response.json().reprocess;
    expect(reprocess.documentFileId).toBe(documentFileId);
    expect(reprocess.workspaceId).toBe(workspaceId);
    expect(reprocess.requestedStages).toEqual(["preprocess", "tesseract", "custom_crnn"]);
    expect(reprocess.enqueued.map((item: { stage: string }) => item.stage)).toEqual(["preprocess", "tesseract", "custom_crnn"]);
    expect(reprocess.enqueued.every((item: { job: { status: string } }) => item.job.status === "QUEUED")).toBe(true);
    expect(
      reprocess.enqueued
        .filter((item: { deduped: boolean }) => !item.deduped)
        .every((item: { job: { payload: { source?: string } } }) => item.job.payload.source === "admin_reprocess")
    ).toBe(true);

    const repeated = await app.inject({
      method: "POST",
      url: `/admin/operations/documents/${documentFileId}/reprocess`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        stages: ["preprocess", "tesseract", "custom_crnn"],
        preprocessingProfile: "TESSERACT_OPTIMIZED",
        language: "tur+eng"
      }
    });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json().reprocess.enqueued.every((item: { deduped: boolean }) => item.deduped)).toBe(true);
    expect(repeated.json().reprocess.enqueued.map((item: { job: { id: string } }) => item.job.id)).toEqual(
      reprocess.enqueued.map((item: { job: { id: string } }) => item.job.id)
    );

    const customReprocessJob = reprocess.enqueued.find((item: { stage: string }) => item.stage === "custom_crnn").job;
    const startedCustomJob = await app.inject({
      method: "POST",
      url: `/admin/jobs/${customReprocessJob.id}/start`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { workerId: "reprocess-custom-ocr-retry-test" }
    });
    expect(startedCustomJob.statusCode).toBe(200);
    const failedCustomJob = await app.inject({
      method: "POST",
      url: `/admin/jobs/${customReprocessJob.id}/fail`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { failureReason: "OCR_SERVICE_UNAVAILABLE:fetch failed" }
    });
    expect(failedCustomJob.statusCode).toBe(200);
    expect(failedCustomJob.json().job.status).toBe("FAILED");

    const retried = await app.inject({
      method: "POST",
      url: `/admin/operations/documents/${documentFileId}/reprocess`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        stages: ["custom_crnn"],
        preprocessingProfile: "TESSERACT_OPTIMIZED",
        language: "tur+eng"
      }
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().reprocess.enqueued).toHaveLength(1);
    expect(retried.json().reprocess.enqueued[0]).toMatchObject({
      stage: "custom_crnn",
      deduped: false,
      retried: true,
      job: {
        id: customReprocessJob.id,
        status: "QUEUED",
        failureReason: null
      }
    });

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=admin.document_reprocess.requested&resourceType=AdminOperation&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const reprocessAudit = audit
      .json()
      .logs.find(
        (log: { resourceId: string; metadata?: { enqueuedJobCount?: number } }) =>
          log.resourceId === documentFileId && log.metadata?.enqueuedJobCount === 3
      );
    expect(reprocessAudit).toMatchObject({
      action: "admin.document_reprocess.requested",
      resourceType: "AdminOperation",
      resourceId: documentFileId,
      metadata: {
        operation: "document_reprocess",
        documentFileId,
        workspaceId,
        requestedStages: ["preprocess", "tesseract", "custom_crnn"],
        enqueuedStages: ["preprocess", "tesseract", "custom_crnn"],
        enqueuedJobCount: 3,
        enqueuedQueues: ["preprocessing", "ocr"],
        preprocessingProfile: "TESSERACT_OPTIMIZED",
        language: "tur+eng",
        checkpointProvided: false
      }
    });
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("C:/private/checkpoints/custom-crnn.pt");
    expect(serializedAudit).not.toContain("reprocess.png");

    const missing = await app.inject({
      method: "POST",
      url: "/admin/operations/documents/missing/reprocess",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { stages: ["preprocess"] }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("DOCUMENT_NOT_FOUND");
  });
});

class CountingDocumentStorage extends InMemoryDocumentStorage {
  metricsCalls = 0;

  override async metrics(): Promise<DocumentStorageMetrics> {
    this.metricsCalls += 1;
    return super.metrics();
  }
}

class DegradedCacheStore implements CacheStore {
  readonly backend = "redis" as const;

  async getJson<T extends Record<string, unknown>>(): Promise<T | null> {
    return null;
  }

  async setJson(): Promise<void> {}

  async delete(): Promise<void> {}

  async listKeys(): Promise<CacheKeySummary[]> {
    throw new Error("REDIS_SCAN_FAILED");
  }

  async acquireLock(): Promise<boolean> {
    return false;
  }

  async releaseLock(): Promise<boolean> {
    return false;
  }

  async health(): Promise<CacheHealth> {
    return { backend: this.backend, connected: false, detail: "REDIS_UNAVAILABLE" };
  }

  async operationErrorCounts() {
    return [
      { operation: "health", count: 1 },
      { operation: "list_keys", count: 1 }
    ];
  }
}

class FakeRateLimitRedisClient {
  private readonly counters = new Map<string, { current: number; expiresAt: number }>();
  rateLimit?: (
    key: string,
    timeWindow: number,
    max: number,
    ban: number,
    continueExceeding: boolean,
    callback: (error: Error | null, result?: [number, number, boolean]) => void
  ) => void;

  defineCommand(name: string): void {
    if (name !== "rateLimit") return;
    this.rateLimit = (key, timeWindow, max, ban, continueExceeding, callback) => {
      const now = Date.now();
      const existing = this.counters.get(key);
      const currentWindow = existing && existing.expiresAt > now ? existing : { current: 0, expiresAt: now + timeWindow };
      const current = currentWindow.current + 1;
      const expiresAt = continueExceeding && current > max ? now + timeWindow : currentWindow.expiresAt;
      this.counters.set(key, { current, expiresAt });
      callback(null, [current, Math.max(0, expiresAt - now), ban !== -1 && current - max > ban]);
    };
  }

  keys(): string[] {
    return [...this.counters.keys()].sort();
  }
}

class DegradedDocumentStorage implements DocumentStorage {
  async putObject(): Promise<void> {
    throw new Error("MINIO_PUT_FAILED");
  }

  async composeObject(): Promise<void> {
    throw new Error("MINIO_COMPOSE_FAILED");
  }

  async getObject(): Promise<Buffer> {
    throw new Error("MINIO_GET_FAILED");
  }

  async createSignedGetUrl(): Promise<string> {
    throw new Error("MINIO_SIGN_FAILED");
  }

  async removeObject(): Promise<void> {
    throw new Error("MINIO_REMOVE_FAILED");
  }

  async metrics(): Promise<DocumentStorageMetrics> {
    return {
      health: { backend: "minio", connected: false, detail: "MINIO_UNAVAILABLE" },
      operationErrors: [{ operation: "health", count: 1 }]
    };
  }
}

class FakeKafkaLagProvider implements KafkaConsumerLagProvider {
  closed = false;

  async metrics() {
    return {
      samples: [
        {
          groupId: "spendlens-workers",
          topic: "document.uploaded",
          partition: 0,
          currentOffset: 13,
          highWatermark: 20,
          lag: 7
        }
      ]
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FailingKafkaLagProvider implements KafkaConsumerLagProvider {
  async metrics(): Promise<KafkaConsumerLagSnapshot> {
    throw new Error("KAFKA_LAG_UNAVAILABLE");
  }
}
