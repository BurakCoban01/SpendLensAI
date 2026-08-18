import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuditRepository } from "../audit/memory-repository";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { hashPassword } from "../auth/crypto";
import { InMemoryCacheStore } from "../cache/memory-store";
import { InMemoryDocumentStorage } from "../documents/storage";
import { InMemoryEventRepository } from "../events/memory-repository";
import { InMemoryReportRepository } from "../reports/memory-repository";
import type { StoredModelEvaluationRun, StoredModelTrainingRun, StoredModelVersion } from "./types";
import { InMemoryModelRepository } from "./memory-repository";

describe("model routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let employeeAccessToken: string;
  let tenantId: string;
  let userId: string;
  let eventRepository: InMemoryEventRepository;
  let reportRepository: InMemoryReportRepository;
  let modelRepository: CountingModelRepository;
  let cacheStore: InMemoryCacheStore;
  let auditRepository: InMemoryAuditRepository;
  let authRepository: InMemoryAuthRepository;
  let benchmarkInputs: Array<{ modelVersionId: string; samples: number; seed: number; split: string; skipTesseract: boolean }>;
  let customTrainingInputs: Array<{
    seed: number;
    samples: number;
    epochs: number;
    datasetExport?: { exportJobId: string; workspaceId: string; bucket: string | null; objectKey: string };
  }>;

  beforeAll(async () => {
    eventRepository = new InMemoryEventRepository();
    reportRepository = new InMemoryReportRepository();
    modelRepository = new CountingModelRepository();
    cacheStore = new InMemoryCacheStore();
    auditRepository = new InMemoryAuditRepository();
    authRepository = new InMemoryAuthRepository();
    benchmarkInputs = [];
    customTrainingInputs = [];
    app = await buildApp({
      authRepository,
      auditRepository,
      modelRepository,
      cacheStore,
      reportRepository,
      eventRepository,
      categoryTrainingRunner: async ({ seed, samplesPerCategory }) => ({
        artifactBucket: "local-artifacts",
        artifactKey: `artifacts/models/category-api/test-${seed}`,
        reportKey: `artifacts/models/category-api/test-${seed}/metrics.json`,
        metrics: {
          model: "local-sklearn-tfidf-logistic-regression",
          version: "category-ml-v1",
          seed,
          samples: samplesPerCategory * 8,
          accuracy: 0.875,
          macro_f1: 0.86,
          confusion_matrix: [
            [2, 0],
            [0, 2]
          ],
          accuracy_note: "Synthetic smoke dataset only; not production accurate."
        }
      }),
      customOcrTrainingRunner: async (input) => {
        const { seed, samples, epochs, datasetExport } = input;
        customTrainingInputs.push({
          seed,
          samples,
          epochs,
          ...(datasetExport ? { datasetExport } : {})
        });
        return {
          artifactBucket: "local-artifacts",
          artifactKey: `artifacts/models/custom-ocr-api/test-${seed}`,
          reportKey: `artifacts/models/custom-ocr-api/test-${seed}/metrics.json`,
          metrics: {
            model: "custom-crnn-ctc",
            engine: "CUSTOM_CRNN",
            seed,
            samples,
            epochs,
            ...(seed === 909
              ? {
                  profile: "local_full",
                  engines: {
                    CUSTOM_CRNN: {
                      qualityGateStatus: "failed",
                      qualityGatePassed: false,
                      qualityGateReasons: ["CER_TOO_HIGH", "LOW_REAL_DOCUMENT_CONFIDENCE"]
                    }
                  }
                }
              : {}),
            ...(seed === 910
              ? {
                  profile: "local_full",
                  validatedOnRealFixtures: true,
                  realFixtureBenchmarkStatus: "passed"
                }
              : {}),
            ...(seed === 911
              ? {
                  profile: "local_full",
                  realFixtureBenchmarkStatus: "passed",
                  validatedOnRealFixtures: true,
                  highConfidenceWrongCount: 1,
                  engines: {
                    CUSTOM_CRNN: {
                      qualityGateStatus: "passed",
                      qualityGatePassed: true,
                      highConfidenceWrongCount: 1
                    }
                  }
                }
              : {}),
            dataset_export: datasetExport ?? null,
            loss: 12.5,
            accuracy_note: "Smoke training only; not production accurate."
          }
        };
      },
      ocrBenchmarkRunner: async ({ modelVersionId, samples, seed, split, skipTesseract }) => {
        benchmarkInputs.push({ modelVersionId, samples, seed, split, skipTesseract });
        return {
          artifactBucket: "local-artifacts",
          artifactKey: `artifacts/benchmarks/ocr-api/${modelVersionId}`,
          reportKey: `artifacts/benchmarks/ocr-api/${modelVersionId}/benchmark-report.json`,
          metrics: {
            generatedAt: "2026-05-15T00:00:00.000Z",
            dataset: { mode: "real_fixtures", samples, split, seed },
            engines: {
              TESSERACT: {
                status: skipTesseract ? "skipped" : "unavailable",
                samples: skipTesseract ? 0 : samples,
                attempted: 0,
                succeeded: 0,
                failed: 0,
                failureRate: 1,
                averageCer: null,
                averageWer: null,
                averageLatencyMs: null,
                averageConfidence: null
              },
              CUSTOM_CRNN: {
                status: "ok",
                samples,
                attempted: samples,
                succeeded: samples,
                failed: 0,
                failureRate: 0,
                averageCer: 0.125,
                averageWer: 0.25,
                averageLatencyMs: 14.5,
                averageConfidence: 0.72,
                highConfidenceWrongCount: 0,
                qualityGateStatus: "passed",
                qualityGatePassed: true,
                qualityGateReasons: []
              }
            },
            limitations: ["Synthetic smoke benchmark only; not production accuracy."]
          }
        };
      }
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Model Tenant",
        tenantSlug: "models",
        workspaceName: "ML Lab",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    const body = register.json();
    accessToken = body.tokens.accessToken;
    tenantId = body.tenant.id;
    userId = body.user.id;
    const employeePassword = "employee-secure-password";
    authRepository.addUserWithRoles({
      tenantId,
      email: "employee@example.com",
      displayName: "Employee",
      roles: ["EMPLOYEE"],
      passwordHash: await hashPassword(employeePassword)
    });
    const employeeLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { tenantSlug: "models", email: "employee@example.com", password: employeePassword }
    });
    employeeAccessToken = employeeLogin.json().tokens.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it("runs a local category smoke training record and exposes registry state", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/models/category/smoke-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 77, samplesPerCategory: 8 }
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.modelVersion.name).toContain("category-ml-v1");
    expect(body.modelVersion.engine).toBe("CATEGORY_ML");
    expect(body.modelVersion.status).toBe("CANDIDATE");
    expect(body.modelVersion.metrics.confusion_matrix).toEqual([
      [2, 0],
      [0, 2]
    ]);
    expect(body.trainingRun.status).toBe("SUCCEEDED");
    expect(body.evaluationRun.status).toBe("SUCCEEDED");

    const list = await app.inject({
      method: "GET",
      url: "/models",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().models).toHaveLength(1);
    expect(list.json().trainingRuns).toHaveLength(1);
    expect(list.json().evaluationRuns).toHaveLength(1);

    const promoted = await app.inject({
      method: "POST",
      url: `/models/${body.modelVersion.id}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().status).toBe("ACTIVE");

    const events = await eventRepository.list({ tenantId, limit: 10 });
    expect(events.map((event) => event.topic)).toEqual(
      expect.arrayContaining(["model.training.started", "model.training.completed", "model.evaluation.completed"])
    );

    const audit = await auditRepository.list({ tenantId, resourceType: "ModelVersion", limit: 20 });
    expect(audit.some((log) => log.action === "model.training.completed" && log.resourceId === body.modelVersion.id)).toBe(true);
    expect(audit.some((log) => log.action === "model.promoted" && log.resourceId === body.modelVersion.id)).toBe(true);
  });

  it("exposes OCR capability to OCR users while keeping the model registry private", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/models/ocr-capabilities",
      headers: { authorization: `Bearer ${employeeAccessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      customOcr: {
        activeModel: null
      }
    });
    expect(response.json().customOcr.available).toBe(false);
    expect(response.json()).not.toHaveProperty("trainingRuns");

    const registry = await app.inject({
      method: "GET",
      url: "/models",
      headers: { authorization: `Bearer ${employeeAccessToken}` }
    });
    expect(registry.statusCode).toBe(403);
  });

  it("caches model overview reads until registry mutations bump the cache version", async () => {
    const cachePrefix = `model-registry:${tenantId}:overview:`;
    const cacheKeyCountBefore = (await cacheStore.listKeys(cachePrefix, 50)).length;
    const created = await app.inject({
      method: "POST",
      url: "/models/category/smoke-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 88, samplesPerCategory: 4 }
    });
    expect(created.statusCode).toBe(201);

    const firstOverview = await app.inject({
      method: "GET",
      url: "/models",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(firstOverview.statusCode).toBe(200);
    expect(firstOverview.json().models.some((model: { id: string }) => model.id === created.json().modelVersion.id)).toBe(true);
    const overviewCacheKeys = await cacheStore.listKeys(cachePrefix, 50);
    expect(overviewCacheKeys).toHaveLength(cacheKeyCountBefore + 1);
    const countsAfterMiss = modelRepository.listCounts();

    const cachedOverview = await app.inject({
      method: "GET",
      url: "/models",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(cachedOverview.statusCode).toBe(200);
    expect(cachedOverview.json().models.length).toBe(firstOverview.json().models.length);
    expect(modelRepository.listCounts()).toEqual(countsAfterMiss);

    const promoted = await app.inject({
      method: "POST",
      url: `/models/${created.json().modelVersion.id}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(promoted.statusCode).toBe(200);

    const refreshedOverview = await app.inject({
      method: "GET",
      url: "/models",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(refreshedOverview.statusCode).toBe(200);
    expect(
      refreshedOverview
        .json()
        .models.find((model: { id: string; status: string }) => model.id === created.json().modelVersion.id).status
    ).toBe("ACTIVE");
    expect(modelRepository.listModelVersionsCount).toBe(countsAfterMiss.models + 1);
    expect(modelRepository.listTrainingRunsCount).toBe(countsAfterMiss.trainingRuns + 1);
    expect(modelRepository.listEvaluationRunsCount).toBe(countsAfterMiss.evaluationRuns + 1);
  });

  it("runs a custom OCR smoke training record and keeps engine-specific promotion isolated", async () => {
    const category = await app.inject({
      method: "POST",
      url: "/models/category/smoke-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 101, samplesPerCategory: 4 }
    });
    const categoryBody = category.json();
    const promotedCategory = await app.inject({
      method: "POST",
      url: `/models/${categoryBody.modelVersion.id}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(promotedCategory.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/models/custom-ocr/smoke-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 7, samples: 8, epochs: 1 }
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.modelVersion.name).toContain("custom-crnn-smoke");
    expect(body.modelVersion.engine).toBe("CUSTOM_CRNN");
    expect(body.modelVersion.status).toBe("CANDIDATE");
    expect(body.modelVersion.metrics.loss).toBe(12.5);

    const promotedCustom = await app.inject({
      method: "POST",
      url: `/models/${body.modelVersion.id}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(promotedCustom.statusCode).toBe(400);
    expect(promotedCustom.json().error.code).toBe("CUSTOM_OCR_PROMOTION_SMOKE_MODEL_BLOCKED");

    const list = await app.inject({
      method: "GET",
      url: "/models",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const activeModels = list.json().models.filter((model: { status: string }) => model.status === "ACTIVE");
    expect(activeModels.map((model: { engine: string }) => model.engine)).toEqual(expect.arrayContaining(["CATEGORY_ML"]));
    expect(activeModels.map((model: { engine: string }) => model.engine)).not.toContain("CUSTOM_CRNN");
  });

  it("blocks Custom OCR promotion when the real fixture quality gate failed", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/models/custom-ocr/full-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 909, samples: 128, epochs: 2 }
    });

    expect(created.statusCode).toBe(201);
    const promoted = await app.inject({
      method: "POST",
      url: `/models/${created.json().modelVersion.id}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(promoted.statusCode).toBe(400);
    expect(promoted.json().error.code).toBe("CUSTOM_OCR_PROMOTION_REAL_FIXTURE_GATE_FAILED");
  });

  it("blocks Custom OCR promotion when real fixture validation lacks a passed quality gate", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/models/custom-ocr/full-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 910, samples: 128, epochs: 2 }
    });

    expect(created.statusCode).toBe(201);
    const promoted = await app.inject({
      method: "POST",
      url: `/models/${created.json().modelVersion.id}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(promoted.statusCode).toBe(400);
    expect(promoted.json().error.code).toBe("CUSTOM_OCR_PROMOTION_REQUIRES_REAL_FIXTURE_VALIDATION");
  });

  it("blocks Custom OCR promotion when benchmark reports high-confidence wrong output", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/models/custom-ocr/full-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 911, samples: 128, epochs: 2 }
    });

    expect(created.statusCode).toBe(201);
    const promoted = await app.inject({
      method: "POST",
      url: `/models/${created.json().modelVersion.id}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(promoted.statusCode).toBe(400);
    expect(promoted.json().error.code).toBe("CUSTOM_OCR_PROMOTION_REAL_FIXTURE_GATE_FAILED");
  });

  it("registers custom OCR training artifacts in object storage when configured", async () => {
    const artifactStorage = new InMemoryDocumentStorage();
    const artifactKey = `artifacts/models/custom-ocr-api/object-storage-${Date.now()}`;
    const artifactDir = path.resolve(findProjectRoot(), artifactKey);
    await mkdir(artifactDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(artifactDir, "model.pt"), Buffer.from("fake-checkpoint")),
      writeFile(path.join(artifactDir, "metrics.json"), JSON.stringify({ loss: 4.2 }))
    ]);
    const artifactApp = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      auditRepository: new InMemoryAuditRepository(),
      eventRepository: new InMemoryEventRepository(),
      modelRepository: new InMemoryModelRepository(),
      modelArtifactStorage: artifactStorage,
      modelArtifactBucket: "spendlens-artifacts",
      customOcrTrainingRunner: async () => ({
        artifactBucket: "local-artifacts",
        artifactKey,
        reportKey: `${artifactKey}/metrics.json`,
        metrics: {
          model: "custom-crnn-ctc",
          engine: "CUSTOM_CRNN",
          loss: 4.2
        }
      })
    });
    try {
      const registered = await artifactApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Artifact Tenant",
          tenantSlug: "artifact-tenant",
          workspaceName: "ML Artifacts",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });
      const token = registered.json().tokens.accessToken;
      const trained = await artifactApp.inject({
        method: "POST",
        url: "/models/custom-ocr/smoke-train",
        headers: { authorization: `Bearer ${token}` },
        payload: { seed: 71, samples: 8, epochs: 1 }
      });

      expect(trained.statusCode).toBe(201);
      const body = trained.json();
      const prefix = `tenants/${registered.json().tenant.id}/models/custom-crnn/${body.trainingRun.id}`;
      expect(body.modelVersion).toMatchObject({
        engine: "CUSTOM_CRNN",
        artifactBucket: "spendlens-artifacts",
        artifactKey: prefix
      });
      expect(body.trainingRun.logsKey).toBe(`${prefix}/metrics.json`);
      expect(body.evaluationRun.reportKey).toBe(`${prefix}/metrics.json`);
      expect(body.modelVersion.metrics.artifact_storage).toMatchObject({
        backend: "object-storage",
        bucket: "spendlens-artifacts",
        artifactKey: prefix,
        checkpointKey: `${prefix}/model.pt`,
        reportKey: `${prefix}/metrics.json`
      });
      expect(artifactStorage.readObject("spendlens-artifacts", `${prefix}/model.pt`)?.toString()).toBe("fake-checkpoint");
      expect(artifactStorage.readObject("spendlens-artifacts", `${prefix}/metrics.json`)?.toString()).toContain("\"loss\":4.2");
    } finally {
      await artifactApp.close();
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("starts custom OCR training from a persisted dataset export job", async () => {
    const exportJob = await reportRepository.createExportJob({
      tenantId,
      workspaceId: "workspace_1",
      type: "dataset_export_jsonl",
      bucket: "spendlens-documents",
      objectKey: "tenants/model/workspaces/workspace_1/reports/dataset.jsonl",
      createdById: userId
    });

    const created = await app.inject({
      method: "POST",
      url: "/models/custom-ocr/train-from-dataset-export",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        exportJobId: exportJob.id,
        seed: 808,
        samples: 8,
        epochs: 1
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().trainingRun.profile).toBe("custom-ocr-dataset-export-smoke");
    expect(created.json().trainingRun.datasetId).toBe(exportJob.id);
    expect(created.json().modelVersion.metrics.dataset_export.exportJobId).toBe(exportJob.id);
    expect(created.json().modelVersion.metrics.dataset_export.objectKey).toBe(exportJob.objectKey);
    expect(customTrainingInputs).toContainEqual({
      seed: 808,
      samples: 8,
      epochs: 1,
      datasetExport: {
        exportJobId: exportJob.id,
        workspaceId: "workspace_1",
        bucket: "spendlens-documents",
        objectKey: exportJob.objectKey
      }
    });
  });

  it("runs bounded full local training profiles through the same persisted registry", async () => {
    const category = await app.inject({
      method: "POST",
      url: "/models/category/full-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 404, samplesPerCategory: 128 }
    });

    expect(category.statusCode).toBe(201);
    expect(category.json().modelVersion.name).toContain("category-ml-full");
    expect(category.json().modelVersion.engine).toBe("CATEGORY_ML");
    expect(category.json().trainingRun.profile).toBe("category-full-local");
    expect(category.json().trainingRun.status).toBe("SUCCEEDED");

    const custom = await app.inject({
      method: "POST",
      url: "/models/custom-ocr/full-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 405, samples: 128, epochs: 5 }
    });

    expect(custom.statusCode).toBe(201);
    expect(custom.json().modelVersion.name).toContain("custom-crnn-full");
    expect(custom.json().modelVersion.engine).toBe("CUSTOM_CRNN");
    expect(custom.json().trainingRun.profile).toBe("custom-ocr-full-local");
    expect(custom.json().trainingRun.status).toBe("SUCCEEDED");

    const list = await app.inject({
      method: "GET",
      url: "/models",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.json().models.some((model: { name: string }) => model.name.includes("category-ml-full"))).toBe(true);
    expect(list.json().models.some((model: { name: string }) => model.name.includes("custom-crnn-full"))).toBe(true);
  });

  it("runs a bounded OCR benchmark for a registered custom OCR model", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/models/custom-ocr/smoke-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 909, samples: 8, epochs: 1 }
    });
    const modelVersionId = created.json().modelVersion.id;

    const benchmark = await app.inject({
      method: "POST",
      url: `/models/${modelVersionId}/ocr-benchmark`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 910, samples: 3, split: "test", skipTesseract: false }
    });

    expect(benchmark.statusCode).toBe(201);
    expect(benchmark.json().modelVersion.id).toBe(modelVersionId);
    expect(benchmark.json().evaluationRun.status).toBe("SUCCEEDED");
    expect(benchmark.json().evaluationRun.metrics.engines.CUSTOM_CRNN.averageCer).toBe(0.125);
    expect(benchmark.json().modelVersion.metrics.validatedOnRealFixtures).toBe(true);
    expect(benchmark.json().modelVersion.metrics.realFixtureBenchmarkStatus).toBe("passed");
    expect(benchmark.json().modelVersion.metrics.qualityGatePassed).toBe(true);
    expect(benchmark.json().modelVersion.metrics.highConfidenceWrongCount).toBe(0);
    expect(benchmark.json().benchmark.reportKey).toContain("benchmark-report.json");
    expect(benchmarkInputs).toContainEqual({ modelVersionId, samples: 3, seed: 910, split: "test", skipTesseract: false });
    const benchmarkCacheKeys = await cacheStore.listKeys(`model-inference:${tenantId}:ocr-benchmark:${modelVersionId}:`, 10);
    expect(benchmarkCacheKeys).toHaveLength(1);
    const benchmarkRunnerCallCount = benchmarkInputs.length;

    const cachedBenchmark = await app.inject({
      method: "POST",
      url: `/models/${modelVersionId}/ocr-benchmark`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 910, samples: 3, split: "test", skipTesseract: false }
    });

    expect(cachedBenchmark.statusCode).toBe(201);
    expect(cachedBenchmark.json().cacheHit).toBe(true);
    expect(cachedBenchmark.json().evaluationRun.status).toBe("SUCCEEDED");
    expect(cachedBenchmark.json().evaluationRun.id).not.toBe(benchmark.json().evaluationRun.id);
    expect(cachedBenchmark.json().evaluationRun.metrics.engines.CUSTOM_CRNN.averageCer).toBe(0.125);
    expect(benchmarkInputs).toHaveLength(benchmarkRunnerCallCount);

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=model.ocr_benchmark.completed&resourceType=ModelEvaluationRun",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs.some((log: { resourceId: string; metadata: { modelVersionId: string } }) => log.metadata.modelVersionId === modelVersionId)).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/models",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(
      list
        .json()
        .evaluationRuns.some((run: { modelVersionId: string; metrics: { engines?: Record<string, unknown> } }) => run.modelVersionId === modelVersionId && run.metrics.engines)
    ).toBe(true);
  });

  it("allows full Custom OCR promotion only after a passing real fixture benchmark updates model metrics", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/models/custom-ocr/full-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 912, samples: 128, epochs: 2 }
    });
    const modelVersionId = created.json().modelVersion.id;

    const blockedBeforeBenchmark = await app.inject({
      method: "POST",
      url: `/models/${modelVersionId}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(blockedBeforeBenchmark.statusCode).toBe(400);
    expect(blockedBeforeBenchmark.json().error.code).toBe("CUSTOM_OCR_PROMOTION_REQUIRES_REAL_FIXTURE_VALIDATION");

    const benchmark = await app.inject({
      method: "POST",
      url: `/models/${modelVersionId}/ocr-benchmark`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 913, samples: 3, split: "test", skipTesseract: true }
    });
    expect(benchmark.statusCode).toBe(201);
    expect(benchmark.json().modelVersion.metrics.validatedOnRealFixtures).toBe(true);
    expect(benchmark.json().modelVersion.metrics.qualityGatePassed).toBe(true);

    const promoted = await app.inject({
      method: "POST",
      url: `/models/${modelVersionId}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().status).toBe("ACTIVE");
    expect(promoted.json().engine).toBe("CUSTOM_CRNN");
  });

  it("records failed model training audits without copying raw runner failure text", async () => {
    const failingAuditRepository = new InMemoryAuditRepository();
    const failingApp = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      auditRepository: failingAuditRepository,
      modelRepository: new InMemoryModelRepository(),
      eventRepository: new InMemoryEventRepository(),
      categoryTrainingRunner: async () => {
        throw new Error("raw category failure objectKey=tenants/leaky/report.json localPath=C:\\secret\\category_model.joblib");
      },
      customOcrTrainingRunner: async () => {
        throw new Error("raw custom OCR failure checkpoint=/tmp/private/model.pt text=receipt total 999,99");
      }
    });

    try {
      const registered = await failingApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Failing Model Tenant",
          tenantSlug: "failing-models",
          workspaceName: "ML Failure Lab",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });
      const failingAccessToken = registered.json().tokens.accessToken;

      const category = await failingApp.inject({
        method: "POST",
        url: "/models/category/smoke-train",
        headers: { authorization: `Bearer ${failingAccessToken}` },
        payload: { seed: 501, samplesPerCategory: 4 }
      });
      expect(category.statusCode).toBe(500);
      expect(category.json().error.code).toBe("CATEGORY_TRAINING_FAILED");

      const custom = await failingApp.inject({
        method: "POST",
        url: "/models/custom-ocr/smoke-train",
        headers: { authorization: `Bearer ${failingAccessToken}` },
        payload: { seed: 502, samples: 8, epochs: 1 }
      });
      expect(custom.statusCode).toBe(500);
      expect(custom.json().error.code).toBe("CUSTOM_OCR_TRAINING_FAILED");

      const audit = await failingApp.inject({
        method: "GET",
        url: "/admin/audit?action=model.training.failed&resourceType=ModelTrainingRun&limit=10",
        headers: { authorization: `Bearer ${failingAccessToken}` }
      });
      expect(audit.statusCode).toBe(200);
      expect(audit.json().logs).toHaveLength(2);
      expect(audit.json().logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "model.training.failed",
            resourceType: "ModelTrainingRun",
            metadata: expect.objectContaining({
              profile: "category-smoke",
              failureCode: "CATEGORY_TRAINING_FAILED"
            })
          }),
          expect.objectContaining({
            action: "model.training.failed",
            resourceType: "ModelTrainingRun",
            metadata: expect.objectContaining({
              profile: "custom-ocr-smoke",
              failureCode: "CUSTOM_OCR_TRAINING_FAILED"
            })
          })
        ])
      );

      const serializedAudit = JSON.stringify(audit.json());
      expect(serializedAudit).not.toContain("failureReason");
      expect(serializedAudit).not.toContain("tenants/leaky/report.json");
      expect(serializedAudit).not.toContain("category_model.joblib");
      expect(serializedAudit).not.toContain("/tmp/private/model.pt");
      expect(serializedAudit).not.toContain("receipt total 999,99");
    } finally {
      await failingApp.close();
    }
  });

  it("rejects missing model promotion", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/models/missing/promote",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MODEL_VERSION_NOT_FOUND");
  });

  it("rolls back an active model to an archived version for the same engine", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/models/category/smoke-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 202, samplesPerCategory: 4 }
    });
    const firstModel = first.json().modelVersion;
    const firstPromoted = await app.inject({
      method: "POST",
      url: `/models/${firstModel.id}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(firstPromoted.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/models/category/smoke-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 203, samplesPerCategory: 4 }
    });
    const secondModel = second.json().modelVersion;
    const secondPromoted = await app.inject({
      method: "POST",
      url: `/models/${secondModel.id}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(secondPromoted.statusCode).toBe(200);

    const rollback = await app.inject({
      method: "POST",
      url: `/models/${firstModel.id}/rollback`,
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().modelVersion.id).toBe(firstModel.id);
    expect(rollback.json().modelVersion.status).toBe("ACTIVE");
    expect(rollback.json().rolledBackFromModelVersionId).toBe(secondModel.id);

    const list = await app.inject({
      method: "GET",
      url: "/models",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const categoryModels = list.json().models.filter((model: { engine: string }) => model.engine === "CATEGORY_ML");
    expect(categoryModels.find((model: { id: string }) => model.id === firstModel.id).status).toBe("ACTIVE");
    expect(categoryModels.find((model: { id: string }) => model.id === secondModel.id).status).toBe("ARCHIVED");

    const activeCategoryModels = categoryModels.filter((model: { status: string }) => model.status === "ACTIVE");
    expect(activeCategoryModels).toHaveLength(1);
  });

  it("blocks Custom OCR rollback when the archived target fails real fixture gates", async () => {
    await modelRepository.createModelVersion({
      tenantId,
      name: "custom-crnn-current-safe",
      engine: "CUSTOM_CRNN",
      status: "ACTIVE",
      artifactBucket: "local-artifacts",
      artifactKey: "artifacts/models/custom-ocr-safe",
      metrics: validCustomOcrMetrics()
    });
    const unsafeArchived = await modelRepository.createModelVersion({
      tenantId,
      name: "custom-crnn-archived-unsafe",
      engine: "CUSTOM_CRNN",
      status: "ARCHIVED",
      artifactBucket: "local-artifacts",
      artifactKey: "artifacts/models/custom-ocr-unsafe",
      metrics: {
        profile: "local_full",
        engines: {
          CUSTOM_CRNN: {
            qualityGateStatus: "failed",
            qualityGatePassed: false,
            qualityGateReasons: ["CER_TOO_HIGH", "LOW_REAL_DOCUMENT_CONFIDENCE"]
          }
        }
      }
    });

    const rollback = await app.inject({
      method: "POST",
      url: `/models/${unsafeArchived.id}/rollback`,
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(rollback.statusCode).toBe(400);
    expect(rollback.json().error.code).toBe("CUSTOM_OCR_PROMOTION_REAL_FIXTURE_GATE_FAILED");
  });

  it("rejects rollback when the target model is not archived", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/models/custom-ocr/smoke-train",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { seed: 303, samples: 8, epochs: 1 }
    });

    const response = await app.inject({
      method: "POST",
      url: `/models/${created.json().modelVersion.id}/rollback`,
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("MODEL_ROLLBACK_TARGET_NOT_ARCHIVED");
  });
});

class CountingModelRepository extends InMemoryModelRepository {
  public listModelVersionsCount = 0;
  public listTrainingRunsCount = 0;
  public listEvaluationRunsCount = 0;

  override async listModelVersions(input: { tenantId: string }): Promise<StoredModelVersion[]> {
    this.listModelVersionsCount += 1;
    return super.listModelVersions(input);
  }

  override async listTrainingRuns(input: { tenantId: string }): Promise<StoredModelTrainingRun[]> {
    this.listTrainingRunsCount += 1;
    return super.listTrainingRuns(input);
  }

  override async listEvaluationRuns(input: { tenantId: string; modelVersionId?: string }): Promise<StoredModelEvaluationRun[]> {
    this.listEvaluationRunsCount += 1;
    return super.listEvaluationRuns(input);
  }

  listCounts() {
    return {
      models: this.listModelVersionsCount,
      trainingRuns: this.listTrainingRunsCount,
      evaluationRuns: this.listEvaluationRunsCount
    };
  }
}

function findProjectRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function validCustomOcrMetrics() {
  return {
    profile: "local_full",
    realFixtureBenchmarkStatus: "passed",
    validatedOnRealFixtures: true,
    engines: {
      CUSTOM_CRNN: {
        qualityGateStatus: "passed",
        qualityGatePassed: true,
        averageCer: 0.2,
        averageWer: 0.3,
        tokenF1: 0.75,
        fieldF1: 0.7,
        turkishSpecialCharacterF1: 0.8
      }
    }
  };
}
