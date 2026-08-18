import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { InMemoryCacheStore } from "../cache/memory-store";
import { workerJobCacheKey } from "../cache/service";
import { InMemoryDocumentRepository } from "../documents/memory-repository";
import { InMemoryDocumentStorage } from "../documents/storage";
import { InMemoryEventRepository } from "../events/memory-repository";
import { InMemoryExpenseRepository } from "../expenses/memory-repository";
import { InMemoryModelRepository } from "../models/memory-repository";
import { InMemoryReportRepository } from "../reports/memory-repository";
import { InMemoryReviewRepository } from "../review/memory-repository";
import { InMemoryJobRepository } from "./memory-repository";
import { workerRunCoordinationKey } from "./service";
import { TempCleanupService } from "./temp-cleanup";

describe("worker job admin routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let tenantId: string;
  let cacheStore: InMemoryCacheStore;
  let documentRepository: InMemoryDocumentRepository;
  let documentStorage: InMemoryDocumentStorage;

  beforeAll(async () => {
    cacheStore = new InMemoryCacheStore();
    documentRepository = new InMemoryDocumentRepository();
    documentStorage = new InMemoryDocumentStorage();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      eventRepository: new InMemoryEventRepository(),
      jobRepository: new InMemoryJobRepository(),
      cacheStore,
      documentRepository,
      documentStorage,
      preprocessingClient: {
        async preprocess(input) {
          expect(input.profile).toBe("TESSERACT_OPTIMIZED");
          expect(input.buffer.byteLength).toBeGreaterThan(0);
          return {
            pages: [
              {
                pageNumber: 1,
                width: 420,
                height: 620,
                qualityScore: 0.91,
                mimeType: "image/png",
                processedImageBase64: pngBytes(91).toString("base64"),
                decisions: { profile: input.profile, blur_score: 120.5 }
              }
            ]
          };
        }
      }
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Jobs Tenant",
        tenantSlug: "jobs",
        workspaceName: "Jobs",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    accessToken = register.json().tokens.accessToken;
    tenantId = register.json().tenant.id;
    documentRepository.addWorkspace(tenantId, "workspace_1");
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires authentication before listing worker jobs", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/jobs" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("MISSING_BEARER_TOKEN");
  });

  it("enqueues, deduplicates and transitions worker jobs", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/jobs",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-jobs-test" },
      payload: {
        queue: "ocr",
        jobType: "ocr.tesseract",
        dedupeKey: "document_1:tesseract",
        eventTopic: "ocr.job.created",
        aggregateId: "document_1",
        payload: { documentFileId: "document_1", engine: "TESSERACT" }
      }
    });
    expect(created.statusCode).toBe(201);
    const job = created.json().job;
    expect(job.status).toBe("QUEUED");
    expect(job.correlationId).toBe("corr-jobs-test");

    const deduped = await app.inject({
      method: "POST",
      url: "/admin/jobs",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        queue: "ocr",
        jobType: "ocr.tesseract",
        dedupeKey: "document_1:tesseract",
        payload: { documentFileId: "document_1" }
      }
    });
    expect(deduped.statusCode).toBe(200);
    expect(deduped.json().deduped).toBe(true);
    expect(deduped.json().job.id).toBe(job.id);

    const started = await app.inject({
      method: "POST",
      url: `/admin/jobs/${job.id}/start`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { workerId: "worker-1" }
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().job.status).toBe("RUNNING");
    expect(started.json().job.attempts).toBe(1);

    const progress = await app.inject({
      method: "POST",
      url: `/admin/jobs/${job.id}/progress`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { progress: 45 }
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json().job.progress).toBe(45);

    const failed = await app.inject({
      method: "POST",
      url: `/admin/jobs/${job.id}/fail`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { failureReason: "Tesseract timeout" }
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().job.status).toBe("FAILED");

    const retried = await app.inject({
      method: "POST",
      url: `/admin/jobs/${job.id}/retry`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().job.status).toBe("QUEUED");

    const completed = await app.inject({
      method: "POST",
      url: `/admin/jobs/${job.id}/complete`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { result: { textBlocks: 12 } }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().job.status).toBe("SUCCEEDED");
    expect(completed.json().job.progress).toBe(100);
    const hotState = await cacheStore.getJson(workerJobCacheKey(tenantId, job.id));
    expect(hotState).toMatchObject({ status: "SUCCEEDED", progress: 100, attempts: 1 });

    const list = await app.inject({
      method: "GET",
      url: "/admin/jobs?queue=ocr",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().backlog.SUCCEEDED).toBe(1);
    expect(list.json().jobs[0].id).toBe(job.id);

    const events = await app.inject({
      method: "GET",
      url: "/admin/events?topic=ocr.job.created",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().events[0].topic).toBe("ocr.job.created");

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?resourceType=WorkerJob&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const jobAudit = audit.json().logs.filter((log: { resourceId: string }) => log.resourceId === job.id);
    expect(jobAudit.map((log: { action: string }) => log.action)).toEqual(
      expect.arrayContaining([
        "worker.job.enqueued",
        "worker.job.enqueue_deduped",
        "worker.job.started",
        "worker.job.failed",
        "worker.job.retried",
        "worker.job.completed"
      ])
    );
    expect(jobAudit.find((log: { action: string }) => log.action === "worker.job.enqueued").metadata).toMatchObject({
      queue: "ocr",
      jobType: "ocr.tesseract",
      dedupeKeyPresent: true,
      eventTopic: "ocr.job.created",
      aggregateId: "document_1"
    });
    const serializedAudit = JSON.stringify(jobAudit);
    expect(serializedAudit).not.toContain("documentFileId");
    expect(serializedAudit).not.toContain("textBlocks");
    expect(serializedAudit).not.toContain("Tesseract timeout");
  });

  it("rejects invalid event topics for job emission", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/jobs",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        queue: "ocr",
        jobType: "ocr.custom",
        eventTopic: "worker.job.created",
        payload: {}
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("UNKNOWN_KAFKA_TOPIC");
  });

  it("runs queued OCR comparison and extraction jobs through the local worker runner", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("worker-boundary")
      },
      payload: multipartBody("worker-boundary", "receipt.png", "image/png", pngBytes())
    });
    expect([200, 201]).toContain(upload.statusCode);
    const documentFileId = upload.json().document.id;

    const compareJob = await app.inject({
      method: "POST",
      url: "/admin/jobs",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        queue: "ocr",
        jobType: "ocr.compare",
        dedupeKey: `${documentFileId}:compare`,
        payload: {
          documentFileId,
          runs: [
            {
              engine: "TESSERACT",
              text: "KARADENIZ MARKET\nTOPLAM 72,05 TL\nTARIH 12.05.2026",
              confidence: 0.91,
              latencyMs: 210
            },
            {
              engine: "CUSTOM_CRNN",
              text: "KARADENIZ MARKET\nTOPLAM 79,05 TL\nTARIH 12.05.2026",
              confidence: 0.64,
              latencyMs: 80
            }
          ],
          groundTruthText: "KARADENIZ MARKET\nTOPLAM 72,05 TL\nTARIH 12.05.2026"
        }
      }
    });
    expect(compareJob.statusCode).toBe(201);

    const compareRun = await app.inject({
      method: "POST",
      url: "/admin/jobs/run-next",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { queue: "ocr", workerId: "worker-test" }
    });
    expect(compareRun.statusCode).toBe(200);
    expect(compareRun.json().processed).toBe(true);
    expect(compareRun.json().job.status).toBe("SUCCEEDED");
    expect(compareRun.json().job.result.selectedEngine).toBe("TESSERACT");
    expect(compareRun.json().job.result.conflictFields).toContain("total");
    expect(compareRun.json().job.result.chainedExtractionJobId).toBeTruthy();

    const extractionRun = await app.inject({
      method: "POST",
      url: "/admin/jobs/run-next",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { queue: "extraction", workerId: "worker-test" }
    });
    expect(extractionRun.statusCode).toBe(200);
    expect(extractionRun.json().processed).toBe(true);
    expect(extractionRun.json().job.status).toBe("SUCCEEDED");
    expect(extractionRun.json().job.result.extractionJobId).toBeTruthy();
    expect(extractionRun.json().job.result.fieldCount).toBeGreaterThan(0);

    const empty = await app.inject({
      method: "POST",
      url: "/admin/jobs/run-next",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { queue: "extraction", workerId: "worker-test" }
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ processed: false, job: null });

    const runnerAudit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=worker.run_next.completed&resourceType=WorkerQueue&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(runnerAudit.statusCode).toBe(200);
    expect(runnerAudit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: "ocr",
          metadata: expect.objectContaining({
            queue: "ocr",
            workerId: "worker-test",
            processed: true,
            jobType: "ocr.compare",
            jobStatus: "SUCCEEDED"
          })
        }),
      ])
    );
    expect(runnerAudit.json().logs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            workerId: "worker-test",
            processed: false,
            skippedReason: null
          })
        })
      ])
    );
    expect(JSON.stringify(runnerAudit.json().logs)).not.toContain("selectedEngine");
  });

  it("skips run-next when another worker holds the queue coordination lock", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/jobs",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        queue: "coordination",
        jobType: "coordination.noop",
        payload: {}
      }
    });
    expect(created.statusCode).toBe(201);
    const lockKey = `lock:${workerRunCoordinationKey(tenantId, "coordination")}`;
    const owner = `${tenantId}:other-worker`;
    expect(await cacheStore.acquireLock({ key: lockKey, owner, ttlMs: 30_000 })).toBe(true);

    const response = await app.inject({
      method: "POST",
      url: "/admin/jobs/run-next",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { queue: "coordination", workerId: "worker-test" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      processed: false,
      job: null,
      skippedReason: "WORKER_QUEUE_LOCKED",
      coordination: {
        lockAcquired: false,
        degraded: false,
        key: workerRunCoordinationKey(tenantId, "coordination")
      }
    });

    const queued = await app.inject({
      method: "GET",
      url: "/admin/jobs?queue=coordination&status=QUEUED",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(queued.statusCode).toBe(200);
    expect(queued.json().jobs.some((job: { id: string }) => job.id === created.json().job.id)).toBe(true);
    await cacheStore.releaseLock({ key: lockKey, owner });
  });

  it("automatically queues upload preprocessing and persists page artifacts through the worker runner", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("preprocess-worker-boundary")
      },
      payload: multipartBody("preprocess-worker-boundary", "preprocess-worker.png", "image/png", pngBytes(41))
    });
    expect(upload.statusCode).toBe(201);
    const documentFileId = upload.json().document.id;

    const preprocessingJobs = await app.inject({
      method: "GET",
      url: "/admin/jobs?queue=preprocessing&status=QUEUED",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(preprocessingJobs.statusCode).toBe(200);
    expect(
      preprocessingJobs.json().jobs.some((job: { jobType: string; payload: { documentFileId?: string } }) => {
        return job.jobType === "document.preprocess" && job.payload.documentFileId === documentFileId;
      })
    ).toBe(true);

    const run = await drainUntilJobResult("preprocessing", documentFileId);
    expect(run.job.status).toBe("SUCCEEDED");
    expect(run.job.result).toMatchObject({
      documentFileId,
      profile: "TESSERACT_OPTIMIZED",
      pageCount: 1
    });
    expect(run.job.result.manifestObjectKey).toContain("preprocessing-manifest.json");

    const pages = await app.inject({
      method: "GET",
      url: `/documents/${documentFileId}/pages`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(pages.statusCode).toBe(200);
    expect(pages.json().pages).toHaveLength(1);
    expect(pages.json().pages[0].processedImageUrl).toContain("memory://spendlens-documents/");
    expect(documentStorage.hasObject("spendlens-documents", pages.json().pages[0].processedKey)).toBe(true);
  });

  it("chains configured preprocessing jobs into Tesseract OCR comparison and extraction", async () => {
    const chainDocumentRepository = new InMemoryDocumentRepository();
    const chainDocumentStorage = new InMemoryDocumentStorage();
    let tesseractRecognizeCalls = 0;
    const chainApp = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      eventRepository: new InMemoryEventRepository(),
      jobRepository: new InMemoryJobRepository(),
      cacheStore: new InMemoryCacheStore(),
      documentRepository: chainDocumentRepository,
      documentStorage: chainDocumentStorage,
      preprocessingClient: {
        async preprocess(input) {
          return {
            pages: [
              {
                pageNumber: 1,
                width: 320,
                height: 520,
                qualityScore: 0.88,
                mimeType: "image/png",
                processedImageBase64: pngBytes(77).toString("base64"),
                decisions: { profile: input.profile, chain: true }
              }
            ]
          };
        }
      },
      tesseractClient: {
        async recognize(input) {
          tesseractRecognizeCalls += 1;
          expect(input.language).toBe("tur+eng");
          expect(input.buffer.byteLength).toBeGreaterThan(0);
          return {
            text: "ZINCIR MARKET\nTARIH 14.05.2026\nTOPLAM 98,45 TL",
            confidence: 0.93,
            latencyMs: 123,
            warnings: [],
            pageCount: 1
          };
        }
      }
    });
    try {
      const register = await chainApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "OCR Chain Tenant",
          tenantSlug: "ocr-chain",
          workspaceName: "OCR Chain",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });
      const chainToken = register.json().tokens.accessToken;
      chainDocumentRepository.addWorkspace(register.json().tenant.id, "workspace_1");

      const upload = await chainApp.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${chainToken}`,
          ...multipartHeaders("chain-boundary")
        },
        payload: multipartBody("chain-boundary", "chain-receipt.png", "image/png", pngBytes(66))
      });
      expect(upload.statusCode).toBe(201);
      const documentFileId = upload.json().document.id;

      const pipelineRun = await chainApp.inject({
        method: "POST",
        url: "/admin/jobs/run-document-ocr-pipeline",
        headers: { authorization: `Bearer ${chainToken}` },
        payload: {
          documentFileId,
          drainUntil: "ocr",
          maxSteps: 8,
          workerId: "document-scoped-ocr-test"
        }
      });
      expect(pipelineRun.statusCode).toBe(200);
      expect(pipelineRun.json()).toMatchObject({
        processed: true,
        documentFileId,
        latestStage: "ocr",
        latestStatus: "SUCCEEDED",
        rawOcrAvailable: true,
        canProceed: true
      });
      expect(pipelineRun.json().jobsProcessed.map((job: { jobType: string }) => job.jobType)).toEqual([
        "document.preprocess",
        "ocr.tesseract"
      ]);

      const preprocessingRun = pipelineRun.json().jobsProcessed.find((job: { jobType: string }) => job.jobType === "document.preprocess");
      expect(preprocessingRun.status).toBe("SUCCEEDED");
      expect(preprocessingRun.result.chainedOcrJobId).toBeTruthy();

      const tesseractRun = pipelineRun.json().jobsProcessed.find((job: { jobType: string }) => job.jobType === "ocr.tesseract");
      expect(tesseractRun.status).toBe("SUCCEEDED");
      expect(tesseractRun.jobType).toBe("ocr.tesseract");
      expect(tesseractRun.result).toMatchObject({
        documentFileId,
        selectedEngine: "TESSERACT",
        averageConfidence: 0.93,
        pageCount: 1,
        warningCount: 0,
        cacheHit: false
      });
      expect(tesseractRun.result.chainedExtractionJobId).toBeTruthy();

      const cachedTesseractJob = await chainApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${chainToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.tesseract",
          dedupeKey: `${documentFileId}:tesseract-cache-check`,
          payload: { documentFileId, language: "tur+eng" }
        }
      });
      expect(cachedTesseractJob.statusCode).toBe(201);
      const cachedTesseractRun = await drainUntilDocumentResult(chainApp, chainToken, "ocr", documentFileId);
      expect(cachedTesseractRun.job.result.cacheHit).toBe(true);
      expect(tesseractRecognizeCalls).toBe(1);

      const extractionRun = await drainUntilJobType(chainApp, chainToken, "extraction", "extraction.from_text");
      expect(extractionRun.job.status).toBe("SUCCEEDED");
      expect(extractionRun.job.result.merchantName).toBe("ZINCIR MARKET");
      expect(extractionRun.job.result.totalAmountMinor).toBe("9845");
    } finally {
      await chainApp.close();
    }
  });

  it("runs custom CRNN OCR with the active local model and chains extraction", async () => {
    const customDocumentRepository = new InMemoryDocumentRepository();
    const customModelRepository = new InMemoryModelRepository();
    let receivedCheckpoint: string | null = null;
    let customRecognizeCalls = 0;
    let customOcrText = "OZEL MODEL MARKET\nTARIH 14.05.2026\nTOPLAM 45,50 TL";
    let customOcrConfidence = 0.74;
    let customOcrWarnings = ["CUSTOM_MODEL_SMOKE_CONFIDENCE_UNCALIBRATED"];
    const customApp = await buildApp({
      config: { CUSTOM_OCR_ALLOW_UNREGISTERED_CHECKPOINT: true },
      authRepository: new InMemoryAuthRepository(),
      eventRepository: new InMemoryEventRepository(),
      jobRepository: new InMemoryJobRepository(),
      cacheStore: new InMemoryCacheStore(),
      documentRepository: customDocumentRepository,
      documentStorage: new InMemoryDocumentStorage(),
      modelRepository: customModelRepository,
      preprocessingClient: {
        async preprocess(input) {
          expect(input.buffer.byteLength).toBeGreaterThan(0);
          return {
            pages: [
              {
                pageNumber: 1,
                width: 320,
                height: 520,
                qualityScore: 0.88,
                mimeType: "image/png",
                processedImageBase64: pngBytes(78).toString("base64"),
                decisions: { profile: input.profile, custom: true }
              }
            ]
          };
        }
      },
      customOcrClient: {
        async recognize(input) {
          customRecognizeCalls += 1;
          receivedCheckpoint = input.checkpoint;
          expect(input.buffer.byteLength).toBeGreaterThan(0);
          return {
            text: customOcrText,
            confidence: customOcrConfidence,
            latencyMs: 88,
            warnings: customOcrWarnings,
            pageCount: 1
          };
        }
      }
    });
    try {
      const register = await customApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Custom OCR Tenant",
          tenantSlug: "custom-ocr",
          workspaceName: "Custom OCR",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });
      const customToken = register.json().tokens.accessToken;
      const customTenantId = register.json().tenant.id;
      customDocumentRepository.addWorkspace(customTenantId, "workspace_1");

      const explicitCheckpointUpload = await customApp.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${customToken}`,
          ...multipartHeaders("custom-explicit-checkpoint-boundary")
        },
        payload: multipartBody(
          "custom-explicit-checkpoint-boundary",
          "custom-explicit-checkpoint.png",
          "image/png",
          pngBytes(11)
        )
      });
      expect(explicitCheckpointUpload.statusCode).toBe(201);
      const explicitCheckpointDocumentId = explicitCheckpointUpload.json().document.id;
      await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${explicitCheckpointDocumentId}:custom-crnn:explicit-checkpoint`,
          payload: {
            documentFileId: explicitCheckpointDocumentId,
            checkpoint: "artifacts/models/local-smoke/model.pt"
          }
        }
      });
      const explicitCheckpointRun = await drainUntilDocumentResult(
        customApp,
        customToken,
        "ocr",
        explicitCheckpointDocumentId
      );
      expect(explicitCheckpointRun.job.status).toBe("SUCCEEDED");
      expect(explicitCheckpointRun.job.result).toMatchObject({
        checkpoint: "artifacts/models/local-smoke/model.pt",
        modelVersionId: null
      });

      const noModelUpload = await customApp.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${customToken}`,
          ...multipartHeaders("custom-no-model-boundary")
        },
        payload: multipartBody("custom-no-model-boundary", "custom-no-model.png", "image/png", pngBytes(12))
      });
      expect(noModelUpload.statusCode).toBe(201);
      const noModelDocumentFileId = noModelUpload.json().document.id;
      await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${noModelDocumentFileId}:custom-crnn:no-model`,
          payload: { documentFileId: noModelDocumentFileId }
        }
      });
      const failedRun = await drainUntilJobType(customApp, customToken, "ocr", "ocr.custom_crnn");
      expect(failedRun.job.status).toBe("FAILED");
      expect(failedRun.job.failureReason).toBe("CUSTOM_OCR_ACTIVE_MODEL_NOT_FOUND");

      await customModelRepository.createModelVersion({
        tenantId: customTenantId,
        name: "custom-crnn-unsafe-active-test",
        engine: "CUSTOM_CRNN",
        status: "ACTIVE",
        artifactBucket: "local-artifacts",
        artifactKey: "artifacts/models/custom-ocr-api/unsafe-active",
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
      const unsafeUpload = await customApp.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${customToken}`,
          ...multipartHeaders("custom-unsafe-boundary")
        },
        payload: multipartBody("custom-unsafe-boundary", "custom-unsafe.png", "image/png", pngBytes(16))
      });
      expect(unsafeUpload.statusCode).toBe(201);
      await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${unsafeUpload.json().document.id}:custom-crnn:unsafe-active`,
          payload: { documentFileId: unsafeUpload.json().document.id }
        }
      });
      const unsafeRun = await drainUntilJobType(customApp, customToken, "ocr", "ocr.custom_crnn");
      expect(unsafeRun.job.status).toBe("FAILED");
      expect(unsafeRun.job.failureReason).toBe("CUSTOM_OCR_REAL_FIXTURE_GATE_FAILED");

      const validActiveModel = await customModelRepository.createModelVersion({
        tenantId: customTenantId,
        name: "custom-crnn-active-test",
        engine: "CUSTOM_CRNN",
        status: "CANDIDATE",
        artifactBucket: "local-artifacts",
        artifactKey: "artifacts/models/custom-ocr-api/test-active",
        metrics: validCustomOcrMetrics()
      });
      await customModelRepository.promoteModelVersion({ tenantId: customTenantId, modelVersionId: validActiveModel.id });

      const upload = await customApp.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${customToken}`,
          ...multipartHeaders("custom-boundary")
        },
        payload: multipartBody("custom-boundary", "custom-receipt.png", "image/png", pngBytes(13))
      });
      expect(upload.statusCode).toBe(201);
      const documentFileId = upload.json().document.id;
      const preprocessRun = await drainUntilDocumentResult(customApp, customToken, "preprocessing", documentFileId);
      expect(preprocessRun.job.status).toBe("SUCCEEDED");

      const customJob = await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${documentFileId}:custom-crnn`,
          payload: { documentFileId }
        }
      });
      expect(customJob.statusCode).toBe(201);

      const customRun = await drainUntilDocumentResult(customApp, customToken, "ocr", documentFileId);
      expect(customRun.job.status).toBe("SUCCEEDED");
      expect(customRun.job.jobType).toBe("ocr.custom_crnn");
      expect(customRun.job.result).toMatchObject({
        documentFileId,
        selectedEngine: "CUSTOM_CRNN",
        averageConfidence: 0.74,
        pageCount: 1,
        warningCount: 1,
        cacheHit: false,
        checkpoint: "artifacts/models/custom-ocr-api/test-active/model.pt"
      });
      expect(receivedCheckpoint).toBe("artifacts/models/custom-ocr-api/test-active/model.pt");
      expect(customRun.job.result.chainedExtractionJobId).toBeTruthy();

      const cachedCustomJob = await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${documentFileId}:custom-crnn-cache-check`,
          payload: { documentFileId }
        }
      });
      expect(cachedCustomJob.statusCode).toBe(201);
      const cachedCustomRun = await drainUntilDocumentResult(customApp, customToken, "ocr", documentFileId);
      expect(cachedCustomRun.job.result.cacheHit).toBe(true);
      expect(customRecognizeCalls).toBe(2);

      customOcrText = [
        "KZV ATTII ARKET0 I",
        "KZV TTTII 1AIKII1",
        "MAVI KIR EMET TOPLAM 22,23 T TL",
        "KZV ATTII ARKET0 I",
        "KZV TTTII 1AIKII1"
      ].join("\n");
      customOcrConfidence = 0.8072;
      const garbageUpload = await customApp.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${customToken}`,
          ...multipartHeaders("custom-garbage-boundary")
        },
        payload: multipartBody("custom-garbage-boundary", "custom-garbage-receipt.png", "image/png", pngBytes(14))
      });
      expect(garbageUpload.statusCode).toBe(201);
      const garbageDocumentFileId = garbageUpload.json().document.id;
      await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${garbageDocumentFileId}:custom-crnn-garbage`,
          payload: { documentFileId: garbageDocumentFileId }
        }
      });
      const garbageRun = await drainUntilDocumentResult(customApp, customToken, "ocr", garbageDocumentFileId);
      expect(garbageRun.job.status).toBe("SUCCEEDED");
      expect(garbageRun.job.result).toMatchObject({
        selectedEngine: "CUSTOM_CRNN",
        averageConfidence: 0.8072,
        extractionSkippedReason: "CUSTOM_OCR_REQUIRES_REVIEW",
        chainedExtractionJobId: null
      });
      const queuedExtractionJobs = await customApp.inject({
        method: "GET",
        url: "/admin/jobs?queue=extraction&status=QUEUED",
        headers: { authorization: `Bearer ${customToken}` }
      });
      expect(queuedExtractionJobs.statusCode).toBe(200);
      expect(
        queuedExtractionJobs
          .json()
          .jobs.some((queued: { payload?: { documentFileId?: string } | null }) => queued.payload?.documentFileId === garbageDocumentFileId)
      ).toBe(false);

      customOcrText = "OZEL MODEL MARKET\nTARIH 14.05.2026\nTOPLAM 45,50 TL";
      customOcrConfidence = 0.41;
      customOcrWarnings = ["CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE"];
      const lowConfidenceUpload = await customApp.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${customToken}`,
          ...multipartHeaders("custom-low-confidence-boundary")
        },
        payload: multipartBody("custom-low-confidence-boundary", "custom-low-confidence-receipt.png", "image/png", pngBytes(15))
      });
      expect(lowConfidenceUpload.statusCode).toBe(201);
      const lowConfidenceDocumentFileId = lowConfidenceUpload.json().document.id;
      await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${lowConfidenceDocumentFileId}:custom-crnn-low-confidence`,
          payload: { documentFileId: lowConfidenceDocumentFileId }
        }
      });
      const lowConfidenceRun = await drainUntilDocumentResult(customApp, customToken, "ocr", lowConfidenceDocumentFileId);
      expect(lowConfidenceRun.job.status).toBe("SUCCEEDED");
      expect(lowConfidenceRun.job.result).toMatchObject({
        selectedEngine: "CUSTOM_CRNN",
        averageConfidence: 0.41,
        warningCount: 1,
        extractionSkippedReason: "CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE",
        chainedExtractionJobId: null
      });

      const staleCustomJob = await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${documentFileId}:custom-crnn-stale-recovery`,
          payload: { documentFileId }
        }
      });
      expect(staleCustomJob.statusCode).toBe(201);
      const staleJobId = staleCustomJob.json().job.id;
      await customApp.inject({
        method: "POST",
        url: `/admin/jobs/${staleJobId}/start`,
        headers: { authorization: `Bearer ${customToken}` },
        payload: { workerId: "interrupted-custom-ocr-worker" }
      });
      await customApp.inject({
        method: "POST",
        url: `/admin/jobs/${staleJobId}/progress`,
        headers: { authorization: `Bearer ${customToken}` },
        payload: { progress: 40 }
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const recoveredPipeline = await customApp.inject({
        method: "POST",
        url: "/admin/jobs/run-document-ocr-pipeline",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          documentFileId,
          drainUntil: "ocr",
          workerId: "custom-ocr-stale-recovery-test",
          maxSteps: 2
        }
      });
      expect(recoveredPipeline.statusCode).toBe(200);
      expect(recoveredPipeline.json()).toMatchObject({
        processed: true,
        latestStage: "ocr",
        latestStatus: "SUCCEEDED",
        rawOcrAvailable: true
      });
      expect(recoveredPipeline.json().jobsProcessed[0]).toMatchObject({
        id: staleJobId,
        jobType: "ocr.custom_crnn",
        status: "SUCCEEDED",
        attempts: 2,
        result: {
          selectedEngine: "CUSTOM_CRNN",
          cacheHit: true
        }
      });

      const failedCustomJob = await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${documentFileId}:custom-crnn-failed-recovery`,
          payload: { documentFileId }
        }
      });
      expect(failedCustomJob.statusCode).toBe(201);
      const failedJobId = failedCustomJob.json().job.id;
      await customApp.inject({
        method: "POST",
        url: `/admin/jobs/${failedJobId}/start`,
        headers: { authorization: `Bearer ${customToken}` },
        payload: { workerId: "failed-custom-ocr-worker" }
      });
      await customApp.inject({
        method: "POST",
        url: `/admin/jobs/${failedJobId}/progress`,
        headers: { authorization: `Bearer ${customToken}` },
        payload: { progress: 40 }
      });
      await customApp.inject({
        method: "POST",
        url: `/admin/jobs/${failedJobId}/fail`,
        headers: { authorization: `Bearer ${customToken}` },
        payload: { failureReason: "OCR_SERVICE_UNAVAILABLE:fetch failed" }
      });
      const recoveredFailedPipeline = await customApp.inject({
        method: "POST",
        url: "/admin/jobs/run-document-ocr-pipeline",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          documentFileId,
          drainUntil: "ocr",
          workerId: "custom-ocr-failed-recovery-test",
          maxSteps: 2
        }
      });
      expect(recoveredFailedPipeline.statusCode).toBe(200);
      expect(recoveredFailedPipeline.json().jobsProcessed[0]).toMatchObject({
        id: failedJobId,
        jobType: "ocr.custom_crnn",
        status: "SUCCEEDED",
        attempts: 2,
        result: {
          selectedEngine: "CUSTOM_CRNN",
          cacheHit: true
        }
      });

      const extractionRun = await drainUntilJobType(customApp, customToken, "extraction", "extraction.from_text");
      expect(extractionRun.job.status).toBe("SUCCEEDED");
      expect(extractionRun.job.result.merchantName).toBe("OZEL MODEL MARKET");
      expect(extractionRun.job.result.totalAmountMinor).toBe("4550");
    } finally {
      await customApp.close();
    }
  });

  it("downloads active custom CRNN object-storage artifacts into the local OCR cache", async () => {
    const customDocumentRepository = new InMemoryDocumentRepository();
    const customDocumentStorage = new InMemoryDocumentStorage();
    const customArtifactStorage = new InMemoryDocumentStorage();
    const customModelRepository = new InMemoryModelRepository();
    let receivedCheckpoint: string | null = null;
    const customApp = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      eventRepository: new InMemoryEventRepository(),
      jobRepository: new InMemoryJobRepository(),
      cacheStore: new InMemoryCacheStore(),
      documentRepository: customDocumentRepository,
      documentStorage: customDocumentStorage,
      modelRepository: customModelRepository,
      modelArtifactStorage: customArtifactStorage,
      customOcrClient: {
        async recognize(input) {
          receivedCheckpoint = input.checkpoint;
          expect(input.checkpoint).toMatch(/^artifacts\/models\/cache\//);
          return {
            text: "NESNE DEPO MARKET\nTOPLAM 31,25 TL",
            confidence: 0.61,
            latencyMs: 42,
            pageCount: 1
          };
        }
      }
    });
    try {
      const register = await customApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Custom OCR Object Tenant",
          tenantSlug: "custom-ocr-object",
          workspaceName: "Custom OCR",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });
      const customToken = register.json().tokens.accessToken;
      const customTenantId = register.json().tenant.id;
      customDocumentRepository.addWorkspace(customTenantId, "workspace_1");

      const blockedCheckpointUpload = await customApp.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${customToken}`,
          ...multipartHeaders("custom-blocked-checkpoint-boundary")
        },
        payload: multipartBody(
          "custom-blocked-checkpoint-boundary",
          "custom-blocked-checkpoint.png",
          "image/png",
          pngBytes(20)
        )
      });
      expect(blockedCheckpointUpload.statusCode).toBe(201);
      await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${blockedCheckpointUpload.json().document.id}:custom-crnn:blocked-checkpoint`,
          payload: {
            documentFileId: blockedCheckpointUpload.json().document.id,
            checkpoint: "artifacts/models/unregistered/model.pt"
          }
        }
      });
      const blockedCheckpointRun = await drainUntilJobType(customApp, customToken, "ocr", "ocr.custom_crnn");
      expect(blockedCheckpointRun.job.status).toBe("FAILED");
      expect(blockedCheckpointRun.job.failureReason).toBe("CUSTOM_OCR_UNREGISTERED_CHECKPOINT_DISABLED");
      expect(receivedCheckpoint).toBeNull();

      const artifactPrefix = `tenants/${customTenantId}/models/custom-crnn/model-object`;
      await customArtifactStorage.putObject({
        bucket: "spendlens-artifacts",
        objectKey: `${artifactPrefix}/model.pt`,
        body: Buffer.from("cached-checkpoint"),
        mimeType: "application/octet-stream",
        metadata: { "artifact-kind": "custom-crnn-checkpoint" }
      });
      const model = await customModelRepository.createModelVersion({
        tenantId: customTenantId,
        name: "custom-crnn-object-active-test",
        engine: "CUSTOM_CRNN",
        status: "ACTIVE",
        artifactBucket: "spendlens-artifacts",
        artifactKey: artifactPrefix,
        metrics: validCustomOcrMetrics()
      });

      const upload = await customApp.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${customToken}`,
          ...multipartHeaders("custom-object-boundary")
        },
        payload: multipartBody("custom-object-boundary", "custom-object-receipt.png", "image/png", pngBytes(21))
      });
      expect(upload.statusCode).toBe(201);
      const documentFileId = upload.json().document.id;
      const customJob = await customApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${customToken}` },
        payload: {
          queue: "ocr",
          jobType: "ocr.custom_crnn",
          dedupeKey: `${documentFileId}:custom-crnn-object`,
          payload: { documentFileId, modelVersionId: model.id }
        }
      });
      expect(customJob.statusCode).toBe(201);

      const customRun = await drainUntilDocumentResult(customApp, customToken, "ocr", documentFileId);
      expect(customRun.job.status).toBe("SUCCEEDED");
      expect(customRun.job.result).toMatchObject({
        documentFileId,
        modelVersionId: model.id,
        selectedEngine: "CUSTOM_CRNN",
        checkpoint: expect.stringMatching(/^artifacts\/models\/cache\//)
      });
      expect(receivedCheckpoint).toBe(customRun.job.result.checkpoint);
      expect(receivedCheckpoint).toBeTruthy();
      const cached = await lstat(path.resolve(findProjectRoot(), receivedCheckpoint!));
      expect(cached.size).toBe(Buffer.byteLength("cached-checkpoint"));
    } finally {
      if (receivedCheckpoint) {
        await rm(path.dirname(path.resolve(findProjectRoot(), receivedCheckpoint)), { recursive: true, force: true });
      }
      await customApp.close();
    }
  });

  it("runs model smoke training jobs through the worker runner", async () => {
    const modelRepository = new InMemoryModelRepository();
    const eventRepository = new InMemoryEventRepository();
    const benchmarkInputs: Array<{ modelVersionId: string; checkpoint: string | null; samples: number; seed: number }> = [];
    const categoryEvaluationInputs: Array<{ modelVersionId: string; modelPath: string | null; samplesPerCategory: number; seed: number }> =
      [];
    const modelWorkerApp = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      eventRepository,
      jobRepository: new InMemoryJobRepository(),
      cacheStore: new InMemoryCacheStore(),
      modelRepository,
      categoryTrainingRunner: async ({ seed, samplesPerCategory }) => ({
        artifactBucket: "local-artifacts",
        artifactKey: `artifacts/models/category-worker/${seed}`,
        reportKey: `artifacts/models/category-worker/${seed}/metrics.json`,
        metrics: {
          accuracy: 0.82,
          macro_f1: 0.8,
          samples: samplesPerCategory * 8
        }
      }),
      customOcrTrainingRunner: async ({ seed, samples, epochs }) => ({
        artifactBucket: "local-artifacts",
        artifactKey: `artifacts/models/custom-worker/${seed}`,
        reportKey: `artifacts/models/custom-worker/${seed}/metrics.json`,
        metrics: {
          loss: 4.2,
          samples,
          epochs
        }
      }),
      categoryEvaluationRunner: async ({ modelVersionId, modelPath, samplesPerCategory, seed }) => {
        categoryEvaluationInputs.push({ modelVersionId, modelPath, samplesPerCategory, seed });
        return {
          artifactBucket: "local-artifacts",
          artifactKey: `artifacts/evaluations/category-worker/${modelVersionId}`,
          reportKey: `artifacts/evaluations/category-worker/${modelVersionId}/evaluation.json`,
          metrics: {
            split: "test",
            samples: samplesPerCategory * 8,
            accuracy: 0.86,
            macro_f1: 0.84
          }
        };
      },
      ocrBenchmarkRunner: async ({ modelVersionId, checkpoint, samples, seed }) => {
        benchmarkInputs.push({ modelVersionId, checkpoint, samples, seed });
        return {
          artifactBucket: "local-artifacts",
          artifactKey: `artifacts/benchmarks/ocr-worker/${modelVersionId}`,
          reportKey: `artifacts/benchmarks/ocr-worker/${modelVersionId}/benchmark-report.json`,
          metrics: {
            dataset: { samples, seed },
            engines: {
              CUSTOM_CRNN: {
                status: "ok",
                samples,
                attempted: samples,
                succeeded: samples,
                failed: 0,
                failureRate: 0,
                averageCer: 0.25,
                averageWer: 0.4,
                averageLatencyMs: 12.5
              },
              TESSERACT: { status: "skipped" }
            }
          }
        };
      }
    });
    try {
      const register = await modelWorkerApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Model Worker Tenant",
          tenantSlug: "model-worker",
          workspaceName: "Model Worker",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });
      const modelToken = register.json().tokens.accessToken;
      const modelTenantId = register.json().tenant.id;

      const categoryJob = await modelWorkerApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${modelToken}` },
        payload: {
          queue: "models",
          jobType: "model.category_smoke_train",
          dedupeKey: "model-worker:category:11",
          payload: { seed: 11, samplesPerCategory: 4 }
        }
      });
      expect(categoryJob.statusCode).toBe(201);

      const categoryRun = await drainUntilJobType(modelWorkerApp, modelToken, "models", "model.category_smoke_train");
      expect(categoryRun.job.status).toBe("SUCCEEDED");
      expect(categoryRun.job.result).toMatchObject({
        engine: "CATEGORY_ML",
        modelStatus: "CANDIDATE",
        trainingStatus: "SUCCEEDED",
        artifactKey: "artifacts/models/category-worker/11"
      });
      expect(categoryRun.job.result.metricKeys).toContain("accuracy");

      const categoryEvalJob = await modelWorkerApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${modelToken}` },
        payload: {
          queue: "models",
          jobType: "model.category_evaluate",
          dedupeKey: "model-worker:category-evaluate:11",
          payload: {
            modelVersionId: categoryRun.job.result.modelVersionId,
            samplesPerCategory: 5,
            seed: 14,
            split: "test"
          }
        }
      });
      expect(categoryEvalJob.statusCode).toBe(201);

      const categoryEvalRun = await drainUntilJobType(modelWorkerApp, modelToken, "models", "model.category_evaluate");
      expect(categoryEvalRun.job.status).toBe("SUCCEEDED");
      expect(categoryEvalRun.job.result).toMatchObject({
        engine: "CATEGORY_ML",
        modelVersionId: categoryRun.job.result.modelVersionId,
        evaluationStatus: "SUCCEEDED",
        artifactKey: `artifacts/evaluations/category-worker/${categoryRun.job.result.modelVersionId}`
      });
      expect(categoryEvalRun.job.result.metricKeys).toEqual(expect.arrayContaining(["accuracy", "macro_f1"]));
      expect(categoryEvaluationInputs).toEqual([
        {
          modelVersionId: categoryRun.job.result.modelVersionId,
          modelPath: "artifacts/models/category-worker/11/category_model.joblib",
          samplesPerCategory: 5,
          seed: 14
        }
      ]);

      const customJob = await modelWorkerApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${modelToken}` },
        payload: {
          queue: "models",
          jobType: "model.custom_ocr_smoke_train",
          dedupeKey: "model-worker:custom-ocr:12",
          payload: { seed: 12, samples: 8, epochs: 1 }
        }
      });
      expect(customJob.statusCode).toBe(201);

      const customRun = await drainUntilJobType(modelWorkerApp, modelToken, "models", "model.custom_ocr_smoke_train");
      expect(customRun.job.status).toBe("SUCCEEDED");
      expect(customRun.job.result).toMatchObject({
        engine: "CUSTOM_CRNN",
        modelStatus: "CANDIDATE",
        trainingStatus: "SUCCEEDED",
        artifactKey: "artifacts/models/custom-worker/12"
      });
      expect(customRun.job.result.metricKeys).toContain("loss");

      const benchmarkJob = await modelWorkerApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${modelToken}` },
        payload: {
          queue: "models",
          jobType: "model.ocr_benchmark",
          dedupeKey: "model-worker:custom-ocr-benchmark:12",
          payload: {
            modelVersionId: customRun.job.result.modelVersionId,
            samples: 3,
            seed: 13,
            skipTesseract: true
          }
        }
      });
      expect(benchmarkJob.statusCode).toBe(201);

      const benchmarkRun = await drainUntilJobType(modelWorkerApp, modelToken, "models", "model.ocr_benchmark");
      expect(benchmarkRun.job.status).toBe("SUCCEEDED");
      expect(benchmarkRun.job.result).toMatchObject({
        engine: "CUSTOM_CRNN",
        modelVersionId: customRun.job.result.modelVersionId,
        evaluationStatus: "SUCCEEDED",
        artifactKey: `artifacts/benchmarks/ocr-worker/${customRun.job.result.modelVersionId}`
      });
      expect(benchmarkRun.job.result.metricKeys).toEqual(expect.arrayContaining(["dataset", "engines"]));
      expect(benchmarkInputs).toEqual([
        {
          modelVersionId: customRun.job.result.modelVersionId,
          checkpoint: "artifacts/models/custom-worker/12/model.pt",
          samples: 3,
          seed: 13
        }
      ]);

      const overview = await modelWorkerApp.inject({
        method: "GET",
        url: "/models",
        headers: { authorization: `Bearer ${modelToken}` }
      });
      expect(overview.statusCode).toBe(200);
      expect(overview.json().models.map((model: { engine: string }) => model.engine)).toEqual(
        expect.arrayContaining(["CATEGORY_ML", "CUSTOM_CRNN"])
      );
      expect(overview.json().trainingRuns).toHaveLength(2);
      expect(overview.json().evaluationRuns).toHaveLength(4);

      const events = await eventRepository.list({ tenantId: modelTenantId, limit: 20 });
      expect(events.map((event) => event.topic)).toEqual(
        expect.arrayContaining(["model.training.started", "model.training.completed", "model.evaluation.completed"])
      );
    } finally {
      await modelWorkerApp.close();
    }
  });

  it("runs report export jobs through the worker runner with persisted CSV output", async () => {
    const reportDocumentRepository = new InMemoryDocumentRepository();
    const reportDocumentStorage = new InMemoryDocumentStorage();
    const reportEventRepository = new InMemoryEventRepository();
    const reportWorkerApp = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      eventRepository: reportEventRepository,
      jobRepository: new InMemoryJobRepository(),
      cacheStore: new InMemoryCacheStore(),
      documentRepository: reportDocumentRepository,
      documentStorage: reportDocumentStorage,
      expenseRepository: new InMemoryExpenseRepository(),
      reportRepository: new InMemoryReportRepository()
    });
    try {
      const register = await reportWorkerApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Report Worker Tenant",
          tenantSlug: "report-worker",
          workspaceName: "Report Worker",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });
      const reportToken = register.json().tokens.accessToken;
      const reportTenantId = register.json().tenant.id;
      reportDocumentRepository.addWorkspace(reportTenantId, "workspace_1");

      const expense = await reportWorkerApp.inject({
        method: "POST",
        url: "/expenses",
        headers: { authorization: `Bearer ${reportToken}` },
        payload: {
          workspaceId: "workspace_1",
          title: "Worker market receipt",
          merchantName: "KARADENIZ MARKET",
          currency: "TRY",
          amountMinor: "7205",
          taxMinor: "655",
          occurredAt: "2026-05-12T14:35:00.000Z",
          reimbursable: true,
          businessExpense: false
        }
      });
      expect(expense.statusCode).toBe(201);

      const reportJob = await reportWorkerApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${reportToken}` },
        payload: {
          queue: "reports",
          jobType: "report.export",
          dedupeKey: "report-worker:merchant-spend:2026-05",
          payload: {
            workspaceId: "workspace_1",
            type: "merchant_spend_csv",
            month: "2026-05"
          }
        }
      });
      expect(reportJob.statusCode).toBe(201);

      const reportRun = await drainUntilJobType(reportWorkerApp, reportToken, "reports", "report.export");
      expect(reportRun.job.status).toBe("SUCCEEDED");
      expect(reportRun.job.result).toMatchObject({
        workspaceId: "workspace_1",
        reportType: "merchant_spend_csv",
        contentType: "text/csv",
        bucket: "spendlens-documents"
      });
      expect(reportRun.job.result.exportJobId).toBeTruthy();
      expect(reportRun.job.result.objectKey).toContain("/reports/");
      expect(reportRun.job.result.sha256).toMatch(/^[a-f0-9]{64}$/);

      const csv = reportDocumentStorage
        .readObject("spendlens-documents", reportRun.job.result.objectKey as string)
        ?.toString("utf8");
      expect(csv).toContain("merchant,currency,expense_count,total_minor,tax_minor");
      expect(csv).toContain("KARADENIZ MARKET,TRY,1,7205,655");

      const exportsList = await reportWorkerApp.inject({
        method: "GET",
        url: "/reports/exports?workspaceId=workspace_1",
        headers: { authorization: `Bearer ${reportToken}` }
      });
      expect(exportsList.statusCode).toBe(200);
      expect(exportsList.json().exportJobs.some((item: { id: string }) => item.id === reportRun.job.result.exportJobId)).toBe(true);

      const events = await reportEventRepository.list({ tenantId: reportTenantId, limit: 20 });
      expect(events.some((event) => event.topic === "report.generated" && event.payload.exportJobId === reportRun.job.result.exportJobId)).toBe(
        true
      );
    } finally {
      await reportWorkerApp.close();
    }
  });

  it("runs annotation dataset export jobs through the worker runner", async () => {
    const annotationDocumentRepository = new InMemoryDocumentRepository();
    const annotationStorage = new InMemoryDocumentStorage();
    const annotationApp = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      eventRepository: new InMemoryEventRepository(),
      jobRepository: new InMemoryJobRepository(),
      cacheStore: new InMemoryCacheStore(),
      documentRepository: annotationDocumentRepository,
      documentStorage: annotationStorage,
      reportRepository: new InMemoryReportRepository(),
      reviewRepository: new InMemoryReviewRepository()
    });
    try {
      const register = await annotationApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Annotation Export Tenant",
          tenantSlug: "annotation-export",
          workspaceName: "Annotation Export",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });
      const annotationToken = register.json().tokens.accessToken;
      annotationDocumentRepository.addWorkspace(register.json().tenant.id, "workspace_1");

      const upload = await annotationApp.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${annotationToken}`,
          ...multipartHeaders("annotation-export-boundary")
        },
        payload: multipartBody("annotation-export-boundary", "annotation-receipt.png", "image/png", pngBytes(27))
      });
      expect(upload.statusCode).toBe(201);
      const documentId = upload.json().document.id;

      const correction = await annotationApp.inject({
        method: "POST",
        url: `/documents/${documentId}/corrections`,
        headers: { authorization: `Bearer ${annotationToken}` },
        payload: {
          fieldName: "total",
          beforeValue: "95,00",
          afterValue: "100,00",
          createAnnotation: true,
          annotationLabel: "receipt_total",
          annotationPayload: { value: "100,00", currency: "TRY" }
        }
      });
      expect(correction.statusCode).toBe(201);

      const annotationJob = await annotationApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${annotationToken}` },
        payload: {
          queue: "annotations",
          jobType: "annotation.export_dataset",
          dedupeKey: "annotation-export:workspace_1",
          payload: { workspaceId: "workspace_1" }
        }
      });
      expect(annotationJob.statusCode).toBe(201);

      const annotationRun = await drainUntilJobType(annotationApp, annotationToken, "annotations", "annotation.export_dataset");
      expect(annotationRun.job.status).toBe("SUCCEEDED");
      expect(annotationRun.job.result).toMatchObject({
        workspaceId: "workspace_1",
        reportType: "dataset_export_jsonl",
        contentType: "application/x-ndjson",
        bucket: "spendlens-documents"
      });

      const stored = annotationStorage.readObject("spendlens-documents", annotationRun.job.result.objectKey as string);
      const lines = (stored?.toString("utf8") ?? "").trim().split("\n").filter(Boolean);
      const datasetLine = lines.map((line) => JSON.parse(line)).find((line) => line.document.id === documentId);
      expect(datasetLine).toBeTruthy();
      expect(datasetLine.labels[0]).toMatchObject({
        label: "receipt_total",
        payload: { value: "100,00", currency: "TRY" }
      });
      expect(datasetLine.corrections[0]).toMatchObject({
        fieldName: "total",
        beforeValue: "95,00",
        afterValue: "100,00"
      });
      expect(datasetLine.activeLearningSuggestions[0]).toMatchObject({ reasonCode: "HUMAN_CORRECTION" });
    } finally {
      await annotationApp.close();
    }
  });

  it("runs temp-file cleanup jobs inside the configured artifacts tmp root", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "spendlens-cleanup-"));
    const cleanupApp = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      eventRepository: new InMemoryEventRepository(),
      jobRepository: new InMemoryJobRepository(),
      cacheStore: new InMemoryCacheStore(),
      tempCleanupService: new TempCleanupService(tempRoot)
    });
    try {
      const register = await cleanupApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Cleanup Worker Tenant",
          tenantSlug: "cleanup-worker",
          workspaceName: "Cleanup Worker",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });
      const cleanupToken = register.json().tokens.accessToken;
      const targetDir = path.join(tempRoot, "worker-cache", "nested");
      await mkdir(targetDir, { recursive: true });
      const oldFile = path.join(targetDir, "old.tmp");
      const freshFile = path.join(targetDir, "fresh.tmp");
      await writeFile(oldFile, "stale artifact");
      await writeFile(freshFile, "fresh artifact");
      const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      await utimes(oldFile, oldDate, oldDate);

      await cleanupApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${cleanupToken}` },
        payload: {
          queue: "maintenance",
          jobType: "cleanup.temp_files",
          dedupeKey: "cleanup-worker:dry-run",
          payload: { subdir: "worker-cache", maxAgeMs: 24 * 60 * 60 * 1000, dryRun: true }
        }
      });
      const dryRun = await drainUntilJobType(cleanupApp, cleanupToken, "maintenance", "cleanup.temp_files");
      expect(dryRun.job.status).toBe("SUCCEEDED");
      expect(dryRun.job.result).toMatchObject({
        target: "worker-cache",
        dryRun: true,
        scannedFiles: 2,
        deletedFiles: 1,
        retainedFiles: 1
      });
      expect(await fileExists(oldFile)).toBe(true);

      await cleanupApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${cleanupToken}` },
        payload: {
          queue: "maintenance",
          jobType: "cleanup.temp_files",
          dedupeKey: "cleanup-worker:delete",
          payload: { subdir: "worker-cache", maxAgeMs: 24 * 60 * 60 * 1000 }
        }
      });
      const cleanupRun = await drainUntilJobType(cleanupApp, cleanupToken, "maintenance", "cleanup.temp_files");
      expect(cleanupRun.job.status).toBe("SUCCEEDED");
      expect(cleanupRun.job.result.deletedPaths).toContain("worker-cache/nested/old.tmp");
      expect(cleanupRun.job.result.deletedFiles).toBe(1);
      expect(await fileExists(oldFile)).toBe(false);
      expect(await fileExists(freshFile)).toBe(true);
    } finally {
      await cleanupApp.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs notification and webhook delivery jobs through persisted local services", async () => {
    const eventRepository = new InMemoryEventRepository();
    const delivered: Array<{ url: string; eventType: string; payload: Record<string, unknown>; correlationId: string | null }> = [];
    const operationsApp = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      eventRepository,
      jobRepository: new InMemoryJobRepository(),
      cacheStore: new InMemoryCacheStore(),
      webhookDeliveryClient: async ({ endpoint, eventType, payload, correlationId }) => {
        delivered.push({ url: endpoint.url, eventType, payload, correlationId });
        return { ok: true, statusCode: 202, responseBody: "accepted" };
      }
    });
    try {
      const register = await operationsApp.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          tenantName: "Operations Worker Tenant",
          tenantSlug: "operations-worker",
          workspaceName: "Operations Worker",
          email: "owner@example.com",
          displayName: "Owner",
          password: "very-secure-password"
        }
      });
      const operationsToken = register.json().tokens.accessToken;
      const operationsTenantId = register.json().tenant.id;
      const operationsUserId = register.json().user.id;

      const endpoint = await operationsApp.inject({
        method: "POST",
        url: "/webhooks",
        headers: { authorization: `Bearer ${operationsToken}` },
        payload: {
          url: "http://localhost:43111/spendlens-hook",
          eventTypes: ["expense.created"]
        }
      });
      expect(endpoint.statusCode).toBe(201);
      expect(endpoint.json().secret).toMatch(/^whsec_/);
      expect(endpoint.json().endpoint).toMatchObject({
        url: "http://localhost:43111/spendlens-hook",
        eventTypes: ["expense.created"],
        enabled: true
      });
      expect(endpoint.json().endpoint.secretHash).toBeUndefined();

      const notificationJob = await operationsApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${operationsToken}` },
        payload: {
          queue: "notifications",
          jobType: "notification.create",
          dedupeKey: "operations-worker:notification:1",
          payload: {
            userId: operationsUserId,
            type: "expense.approval",
            title: "Expense approved",
            body: "Your reimbursement claim was approved.",
            payload: { expenseId: "expense_1" }
          }
        }
      });
      expect(notificationJob.statusCode).toBe(201);
      const notificationRun = await drainUntilJobType(
        operationsApp,
        operationsToken,
        "notifications",
        "notification.create"
      );
      expect(notificationRun.job.status).toBe("SUCCEEDED");
      expect(notificationRun.job.result).toMatchObject({
        userId: operationsUserId,
        type: "expense.approval"
      });

      const notifications = await operationsApp.inject({
        method: "GET",
        url: "/notifications?unreadOnly=true",
        headers: { authorization: `Bearer ${operationsToken}` }
      });
      expect(notifications.statusCode).toBe(200);
      expect(notifications.json().notifications[0]).toMatchObject({
        id: notificationRun.job.result.notificationId,
        title: "Expense approved",
        readAt: null
      });

      const read = await operationsApp.inject({
        method: "POST",
        url: `/notifications/${notificationRun.job.result.notificationId}/read`,
        headers: { authorization: `Bearer ${operationsToken}` }
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().notification.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const webhookJob = await operationsApp.inject({
        method: "POST",
        url: "/admin/jobs",
        headers: { authorization: `Bearer ${operationsToken}`, "x-correlation-id": "corr-webhook-worker" },
        payload: {
          queue: "webhooks",
          jobType: "webhook.delivery",
          dedupeKey: "operations-worker:webhook:1",
          payload: {
            endpointId: endpoint.json().endpoint.id,
            eventType: "expense.created",
            payload: { expenseId: "expense_1", amountMinor: "1200" }
          }
        }
      });
      expect(webhookJob.statusCode).toBe(201);
      const webhookRun = await drainUntilJobType(operationsApp, operationsToken, "webhooks", "webhook.delivery");
      expect(webhookRun.job.status).toBe("SUCCEEDED");
      expect(webhookRun.job.result).toMatchObject({
        eventType: "expense.created",
        endpointCount: 1,
        deliveredCount: 1,
        failedCount: 0
      });
      expect(delivered).toEqual([
        {
          url: "http://localhost:43111/spendlens-hook",
          eventType: "expense.created",
          payload: { expenseId: "expense_1", amountMinor: "1200" },
          correlationId: "corr-webhook-worker"
        }
      ]);

      const events = await eventRepository.list({ tenantId: operationsTenantId, topic: "webhook.delivery.requested", limit: 10 });
      expect(events[0]).toMatchObject({
        topic: "webhook.delivery.requested",
        aggregateId: endpoint.json().endpoint.id,
        payload: {
          endpointId: endpoint.json().endpoint.id,
          eventType: "expense.created",
          ok: true,
          statusCode: 202
        }
      });
    } finally {
      await operationsApp.close();
    }
  });

  async function drainUntilJobResult(queue: string, documentFileId: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/admin/jobs/run-next",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { queue, workerId: "preprocess-worker-test" }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.processed).toBe(true);
      if (body.job?.result?.documentFileId === documentFileId) return body;
    }
    throw new Error("PREPROCESSING_JOB_NOT_DRAINED");
  }

  it("starts a local worker runtime that drains queued jobs and exposes heartbeat state", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("runtime-boundary")
      },
      payload: multipartBody("runtime-boundary", "runtime-receipt.png", "image/png", pngBytes())
    });
    expect([200, 201]).toContain(upload.statusCode);
    const documentFileId = upload.json().document.id;

    const compareJob = await app.inject({
      method: "POST",
      url: "/admin/jobs",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        queue: "ocr",
        jobType: "ocr.compare",
        dedupeKey: `${documentFileId}:runtime-compare`,
        payload: {
          documentFileId,
          runs: [
            {
              engine: "TESSERACT",
              text: "GUNES OFIS\nFIS NO: 45\nTOPLAM 132,40 TL\nTARIH 13.05.2026",
              confidence: 0.9,
              latencyMs: 190
            }
          ]
        }
      }
    });
    expect(compareJob.statusCode).toBe(201);

    const started = await app.inject({
      method: "POST",
      url: "/admin/jobs/workers/start",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { workerId: "runtime-test-worker", intervalMs: 100, maxJobsPerTick: 5 }
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().worker.status).toMatch(/IDLE|RUNNING/);

    await waitFor(async () => {
      const workers = await app.inject({
        method: "GET",
        url: "/admin/jobs/workers",
        headers: { authorization: `Bearer ${accessToken}` }
      });
      expect(workers.statusCode).toBe(200);
      const worker = workers.json().workers.find((item: { workerId: string }) => item.workerId === "runtime-test-worker");
      expect(worker?.processedJobs).toBeGreaterThanOrEqual(2);
      expect(worker?.lastHeartbeatAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    const extractionJobs = await app.inject({
      method: "GET",
      url: "/admin/jobs?queue=extraction&status=SUCCEEDED",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(extractionJobs.statusCode).toBe(200);
    expect(
      extractionJobs.json().jobs.some((job: { result: Record<string, unknown> | null }) => job.result?.merchantName === "GUNES OFIS")
    ).toBe(true);

    const health = await app.inject({
      method: "GET",
      url: "/admin/health",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().checks.workers.status).toBe("ok");

    const stopped = await app.inject({
      method: "POST",
      url: "/admin/jobs/workers/runtime-test-worker/stop",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().worker.status).toBe("STOPPED");
  });
});

function pngBytes(marker = 0): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]);
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

async function drainUntilDocumentResult(
  app: FastifyInstance,
  accessToken: string,
  queue: string,
  documentFileId: string
) {
  const attempts: unknown[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/admin/jobs/run-next",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { queue, workerId: `${queue}-chain-test` }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    attempts.push(body);
    if (body.job?.result?.documentFileId === documentFileId) return body;
    if (body.processed !== true) break;
  }
  throw new Error(`${queue.toUpperCase()}_DOCUMENT_JOB_NOT_DRAINED:${JSON.stringify(attempts)}`);
}

async function drainUntilJobType(app: FastifyInstance, accessToken: string, queue: string, jobType: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/admin/jobs/run-next",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { queue, workerId: `${queue}-chain-test` }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.processed).toBe(true);
    if (body.job?.jobType === jobType) return body;
  }
  throw new Error(`${queue.toUpperCase()}_${jobType}_JOB_NOT_DRAINED`);
}

async function waitFor(assertion: () => Promise<void>, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (lastError) throw lastError;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
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
