import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/memory-repository";
import type { AuthPrincipal } from "../auth/types";
import { InMemoryDocumentStorage } from "../documents/storage";
import { EventService } from "../events/service";
import { InMemoryEventRepository } from "../events/memory-repository";
import { ModelService } from "./service";
import { InMemoryModelRepository } from "./memory-repository";

const principal: AuthPrincipal = {
  tenantId: "tenant_model_failure",
  userId: "user_model_failure",
  sessionId: "session_model_failure",
  email: "model-failure@example.com",
  displayName: "Model Failure",
  roles: ["OWNER"],
  permissions: ["models.train", "admin.audit.read"]
};

describe("ModelService audit hardening", () => {
  it("returns a minimal active Custom OCR capability without registry artifacts", async () => {
    const repository = new InMemoryModelRepository();
    const service = new ModelService(repository, async () => successfulArtifact("category"), async () => successfulArtifact("custom"));
    const active = await repository.createModelVersion({
      tenantId: principal.tenantId,
      name: "custom-crnn-active",
      engine: "CUSTOM_CRNN",
      status: "ACTIVE",
      artifactBucket: "private-artifacts",
      artifactKey: "artifacts/models/private/model.pt",
      metrics: { engines: { CUSTOM_CRNN: { qualityGateStatus: "passed", averageCer: 0.08 } } }
    });

    const capabilities = await service.ocrCapabilities(principal, { tesseract: true, customOcr: true });

    expect(capabilities).toMatchObject({
      tesseract: { configured: true },
      customOcr: {
        configured: true,
        available: true,
        activeModel: { id: active.id, name: active.name, status: "ACTIVE" }
      }
    });
    expect(capabilities.customOcr.activeModel).not.toHaveProperty("artifactKey");
    expect(capabilities.customOcr.activeModel).not.toHaveProperty("tenantId");
  });

  it("hydrates object-storage custom OCR checkpoints before direct benchmark runs", async () => {
    const repository = new InMemoryModelRepository();
    const artifactStorage = new InMemoryDocumentStorage();
    const artifactPrefix = `tenants/${principal.tenantId}/models/custom-crnn/object-benchmark`;
    await artifactStorage.putObject({
      bucket: "spendlens-artifacts",
      objectKey: `${artifactPrefix}/model.pt`,
      body: Buffer.from("object-storage-checkpoint"),
      mimeType: "application/octet-stream",
      metadata: { "artifact-kind": "custom-crnn-checkpoint" }
    });

    let capturedCheckpoint: string | null = null;
    const service = new ModelService(
      repository,
      async () => successfulArtifact("category"),
      async () => successfulArtifact("custom"),
      async (input) => {
        capturedCheckpoint = input.checkpoint;
        return {
          artifactBucket: "local-artifacts",
          artifactKey: `artifacts/benchmarks/ocr-api/${input.modelVersionId}`,
          reportKey: `artifacts/benchmarks/ocr-api/${input.modelVersionId}/benchmark-report.json`,
          metrics: { engines: { CUSTOM_CRNN: { status: "ok", averageCer: 0.2 } } }
        };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      artifactStorage,
      "spendlens-artifacts"
    );
    const modelVersion = await repository.createModelVersion({
      tenantId: principal.tenantId,
      name: "custom-crnn-object-benchmark",
      engine: "CUSTOM_CRNN",
      status: "ACTIVE",
      artifactBucket: "spendlens-artifacts",
      artifactKey: artifactPrefix,
      metrics: {}
    });

    try {
      const result = await service.benchmarkCustomOcr({
        principal,
        modelVersionId: modelVersion.id,
        seed: 21,
        samples: 3,
        split: "test",
        skipTesseract: true
      });

      expect(result.evaluationRun.reportKey).toContain("benchmark-report.json");
      expect(capturedCheckpoint).toMatch(
        new RegExp(`^artifacts/models/cache/benchmarks/${principal.tenantId}/${modelVersion.id}/model\\.pt$`)
      );
      const cachedCheckpoint = path.resolve(findProjectRoot(), capturedCheckpoint!);
      expect(await readFile(cachedCheckpoint, "utf8")).toBe("object-storage-checkpoint");
    } finally {
      await rm(path.resolve(findProjectRoot(), "artifacts", "models", "cache", "benchmarks", principal.tenantId), {
        recursive: true,
        force: true
      });
    }
  });

  it("records failed OCR benchmark and category evaluation audits without raw runner failure text", async () => {
    const repository = new InMemoryModelRepository();
    const auditRepository = new InMemoryAuditRepository();
    const eventRepository = new InMemoryEventRepository();
    const service = new ModelService(
      repository,
      async () => successfulArtifact("category"),
      async () => successfulArtifact("custom"),
      async () => {
        throw new Error("raw benchmark failure checkpoint=/tmp/private/model.pt objectKey=tenants/model/benchmark.json text=TOTAL 999,99");
      },
      async () => {
        throw new Error("raw category evaluation failure modelPath=C:\\private\\category_model.joblib merchant=Acme Market");
      },
      new EventService(eventRepository),
      undefined,
      undefined,
      auditRepository
    );

    const customModel = await repository.createModelVersion({
      tenantId: principal.tenantId,
      name: "custom-crnn-active",
      engine: "CUSTOM_CRNN",
      status: "ACTIVE",
      artifactBucket: "local-artifacts",
      artifactKey: "artifacts/private/custom-crnn",
      metrics: {}
    });
    const categoryModel = await repository.createModelVersion({
      tenantId: principal.tenantId,
      name: "category-ml-active",
      engine: "CATEGORY_ML",
      status: "ACTIVE",
      artifactBucket: "local-artifacts",
      artifactKey: "artifacts/private/category-ml",
      metrics: {}
    });

    await expect(
      service.benchmarkCustomOcr({
        principal,
        modelVersionId: customModel.id,
        seed: 12,
        samples: 3,
        split: "test",
        skipTesseract: false
      })
    ).rejects.toMatchObject({ code: "OCR_BENCHMARK_FAILED", statusCode: 500 });
    await expect(
      service.evaluateCategoryModel({
        principal,
        modelVersionId: categoryModel.id,
        seed: 13,
        samplesPerCategory: 4,
        split: "validation"
      })
    ).rejects.toMatchObject({ code: "CATEGORY_EVALUATION_FAILED", statusCode: 500 });

    const auditLogs = await auditRepository.list({ tenantId: principal.tenantId, resourceType: "ModelVersion", limit: 10 });
    expect(auditLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "model.ocr_benchmark.failed",
          resourceId: customModel.id,
          metadata: expect.objectContaining({
            failureCode: "OCR_BENCHMARK_FAILED",
            profile: "custom-ocr-benchmark",
            samples: 3,
            split: "test"
          })
        }),
        expect.objectContaining({
          action: "model.category_evaluation.failed",
          resourceId: categoryModel.id,
          metadata: expect.objectContaining({
            failureCode: "CATEGORY_EVALUATION_FAILED",
            profile: "category-evaluation",
            samplesPerCategory: 4,
            split: "validation"
          })
        })
      ])
    );

    const events = await eventRepository.list({ tenantId: principal.tenantId, topic: "model.evaluation.completed", limit: 10 });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aggregateId: customModel.id,
          payload: expect.objectContaining({ status: "FAILED", failureCode: "OCR_BENCHMARK_FAILED" })
        }),
        expect.objectContaining({
          aggregateId: categoryModel.id,
          payload: expect.objectContaining({ status: "FAILED", failureCode: "CATEGORY_EVALUATION_FAILED" })
        })
      ])
    );

    const serializedEvidence = JSON.stringify({ auditLogs, events });
    expect(serializedEvidence).not.toContain("checkpoint=");
    expect(serializedEvidence).not.toContain("tenants/model/benchmark.json");
    expect(serializedEvidence).not.toContain("TOTAL 999,99");
    expect(serializedEvidence).not.toContain("category_model.joblib");
    expect(serializedEvidence).not.toContain("Acme Market");
  });
});

function successfulArtifact(kind: string) {
  return {
    artifactBucket: "local-artifacts",
    artifactKey: `artifacts/${kind}/unused`,
    reportKey: `artifacts/${kind}/unused/metrics.json`,
    metrics: { ok: true }
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
