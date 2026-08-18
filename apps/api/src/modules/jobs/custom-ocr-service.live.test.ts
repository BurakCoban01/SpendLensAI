import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Client as MinioClient } from "minio";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";

const runLiveCustomOcrDockerTests =
  process.env.SPENDLENS_LIVE_CUSTOM_OCR_DOCKER_TESTS === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.MINIO_ENDPOINT) &&
  Boolean(process.env.OCR_SERVICE_URL);
const liveDescribe = runLiveCustomOcrDockerTests ? describe : describe.skip;

liveDescribe("custom OCR live Docker service integration", () => {
  const prisma = new PrismaClient();
  const slug = `custom-ocr-live-${Date.now()}`;
  const bucket = process.env.MINIO_BUCKET_DOCUMENTS || "spendlens-documents";
  const artifactBucket = process.env.MINIO_BUCKET_ARTIFACTS || "spendlens-artifacts";
  const artifactKeys = new Set<string>();
  let app: FastifyInstance;
  let tenantId = "";
  let accessToken = "";

  beforeAll(async () => {
    await expectOcrServiceReady();
    app = await buildApp();
    await prisma.$connect();
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Live Custom OCR Tenant",
        tenantSlug: slug,
        workspaceName: "ML Lab",
        email: `${slug}@example.com`,
        displayName: "Live Custom OCR Owner",
        password: "very-secure-password"
      }
    });
    expect(register.statusCode).toBe(201);
    const body = register.json();
    tenantId = body.tenant.id;
    accessToken = body.tokens.accessToken;
  }, 120_000);

  afterAll(async () => {
    await removeTenantObjects(bucket, tenantId);
    await removeTenantObjects(artifactBucket, tenantId);
    await Promise.all([...artifactKeys].map((artifactKey) => removeLocalTrainingArtifacts(artifactKey)));
    await removeGeneratedTrainingArtifactsForTenant(tenantId);
    await rm(path.resolve("artifacts", "models", "cache", tenantId), { recursive: true, force: true });
    if (tenantId) {
      await prisma.auditLog.deleteMany({ where: { tenantId } });
      await prisma.workerJob.deleteMany({ where: { tenantId } });
      await prisma.outboxEvent.deleteMany({ where: { tenantId } });
      await prisma.oCRConfidenceScore.deleteMany({ where: { tenantId } });
      await prisma.oCRToken.deleteMany({ where: { tenantId } });
      await prisma.oCRLine.deleteMany({ where: { tenantId } });
      await prisma.oCRTextBlock.deleteMany({ where: { tenantId } });
      await prisma.oCREngineRun.deleteMany({ where: { tenantId } });
      await prisma.oCRJob.deleteMany({ where: { tenantId } });
      await prisma.modelEvaluationRun.deleteMany({ where: { tenantId } });
      await prisma.modelTrainingRun.deleteMany({ where: { tenantId } });
      await prisma.modelVersion.deleteMany({ where: { tenantId } });
      await prisma.documentPage.deleteMany({ where: { tenantId } });
      await prisma.documentFile.deleteMany({ where: { tenantId } });
      await prisma.receiptDocument.deleteMany({ where: { tenantId } });
      await prisma.invoiceDocument.deleteMany({ where: { tenantId } });
      await prisma.session.deleteMany({ where: { tenantId } });
      await prisma.aPIKey.deleteMany({ where: { tenantId } });
      await prisma.userRole.deleteMany({ where: { tenantId } });
      await prisma.rolePermission.deleteMany({ where: { tenantId } });
      await prisma.role.deleteMany({ where: { tenantId } });
      await prisma.workspace.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
    await app?.close();
  });

  it("trains a CRNN checkpoint in the Docker OCR service and uses it through the worker", async () => {
    const trained = await app.inject({
      method: "POST",
      url: "/models/custom-ocr/smoke-train",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-live-custom-ocr-train" },
      payload: { seed: 31, samples: 8, epochs: 1 }
    });
    expect(trained.statusCode).toBe(201);
    const trainedBody = trained.json();
    const modelVersion = trainedBody.modelVersion as {
      id: string;
      engine: string;
      status: string;
      artifactBucket: string;
      artifactKey: string;
      metrics: Record<string, unknown>;
    };
    artifactKeys.add(modelVersion.artifactKey);
    expect(modelVersion).toMatchObject({
      engine: "CUSTOM_CRNN",
      status: "CANDIDATE",
      artifactBucket
    });
    expect(modelVersion.artifactKey).toMatch(new RegExp(`^tenants/${tenantId}/models/custom-crnn/`));
    expect(modelVersion.metrics).toMatchObject({
      engine: "CUSTOM_CRNN",
      model: "custom-crnn-ctc",
      seed: 31,
      artifact_storage: {
        backend: "object-storage",
        bucket: artifactBucket,
        artifactKey: modelVersion.artifactKey,
        checkpointKey: `${modelVersion.artifactKey}/model.pt`,
        reportKey: `${modelVersion.artifactKey}/metrics.json`
      }
    });
    expect(trainedBody.trainingRun.status).toBe("SUCCEEDED");
    expect(trainedBody.trainingRun.logsKey).toBe(`${modelVersion.artifactKey}/metrics.json`);
    expect(trainedBody.evaluationRun.status).toBe("SUCCEEDED");
    expect(trainedBody.evaluationRun.reportKey).toBe(`${modelVersion.artifactKey}/metrics.json`);

    const promoted = await app.inject({
      method: "POST",
      url: `/models/${modelVersion.id}/promote`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().status).toBe("ACTIVE");

    const workspace = await prisma.workspace.findFirstOrThrow({ where: { tenantId, name: "ML Lab" } });
    const upload = await app.inject({
      method: "POST",
      url: `/documents/upload?workspaceId=${workspace.id}&kind=RECEIPT`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-correlation-id": "corr-live-custom-ocr-upload",
        ...multipartHeaders("boundary-live-custom-ocr")
      },
      payload: multipartBody("boundary-live-custom-ocr", "custom-ocr-live-receipt.pdf", "application/pdf", pdfReceiptBytes())
    });
    expect(upload.statusCode).toBe(201);
    const documentId = upload.json().document.id as string;

    const customJob = await app.inject({
      method: "POST",
      url: "/admin/jobs",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        queue: "ocr",
        jobType: "ocr.custom_crnn",
        dedupeKey: `live-custom-crnn:${documentId}`,
        payload: { documentFileId: documentId }
      }
    });
    expect(customJob.statusCode).toBe(201);

    const customRun = await app.inject({
      method: "POST",
      url: "/admin/jobs/run-next",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { queue: "ocr", workerId: "live-custom-crnn-worker" }
    });
    expect(customRun.statusCode).toBe(200);
    const customRunJob = customRun.json().job;
    if (customRunJob.status !== "SUCCEEDED") {
      throw new Error(`Live custom OCR worker failed: ${JSON.stringify(customRunJob)}`);
    }
    expect(customRunJob).toMatchObject({
      status: "SUCCEEDED",
      jobType: "ocr.custom_crnn",
      result: {
        documentFileId: documentId,
        modelVersionId: modelVersion.id,
        pageCount: 1,
        warningCount: 1,
        cacheHit: false,
        checkpoint: expect.stringMatching(/^artifacts\/models\/cache\//)
      }
    });
    expect(["CUSTOM_CRNN", "NONE"]).toContain(customRunJob.result.selectedEngine);

    const engineRun = await prisma.oCREngineRun.findFirstOrThrow({
      where: { tenantId, engine: "CUSTOM_CRNN", ocrJobId: customRunJob.result.ocrJobId },
      orderBy: { createdAt: "desc" }
    });
    expect(engineRun.status).toBe("SUCCEEDED");
    expect(Number(engineRun.confidence)).toBeGreaterThanOrEqual(0);
    expect(engineRun.normalizedJson).toEqual(
      expect.objectContaining({
        text: expect.any(String),
        tokens: expect.any(Array)
      })
    );
  }, 180_000);
});

async function expectOcrServiceReady(): Promise<void> {
  const response = await fetch(new URL("/health/ready", process.env.OCR_SERVICE_URL).toString());
  expect(response.status).toBe(200);
  const body = (await response.json()) as { checks?: { tesseract?: { available?: boolean; languages?: string[] } } };
  expect(body.checks?.tesseract?.available).toBe(true);
  expect(body.checks?.tesseract?.languages).toEqual(expect.arrayContaining(["eng", "tur"]));
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

function pdfReceiptBytes(): Buffer {
  const lines = [
    "%PDF-1.4\n",
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
  ];
  const stream = [
    "BT",
    "/F1 30 Tf",
    "90 700 Td",
    "(SPENDLENS MARKET) Tj",
    "0 -54 Td",
    "(TARIH 12.05.2026) Tj",
    "0 -54 Td",
    "(EKMEK 20,00) Tj",
    "0 -54 Td",
    "(KDV 6,55) Tj",
    "0 -54 Td",
    "(TOPLAM 72,05) Tj",
    "ET"
  ].join("\n");
  lines.push(`5 0 obj\n<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream\nendobj\n`);

  let offset = 0;
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  for (const line of lines) {
    offsets.push(offset);
    const chunk = Buffer.from(line, "ascii");
    chunks.push(chunk);
    offset += chunk.byteLength;
  }
  const xrefOffset = offset;
  const xref = [
    "xref\n",
    "0 6\n",
    "0000000000 65535 f \n",
    ...offsets.map((entry) => `${entry.toString().padStart(10, "0")} 00000 n \n`),
    "trailer\n<< /Size 6 /Root 1 0 R >>\n",
    "startxref\n",
    `${xrefOffset}\n`,
    "%%EOF\n"
  ].join("");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

async function removeTenantObjects(bucket: string, tenantId: string): Promise<void> {
  if (!tenantId || !process.env.MINIO_ENDPOINT) return;
  const client = minioClient();
  try {
    if (!(await client.bucketExists(bucket))) return;
    const prefix = `tenants/${tenantId}/`;
    const objects: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = client.listObjects(bucket, prefix, true);
      stream.on("data", (object) => {
        if (object.name) objects.push(object.name);
      });
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    if (objects.length > 0) await client.removeObjects(bucket, objects);
  } catch {
    // Best-effort cleanup; assertions above prove the live MinIO path.
  }
}

function minioClient(): MinioClient {
  const endpoint = new URL(process.env.MINIO_ENDPOINT ?? "http://localhost:19002");
  return new MinioClient({
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80,
    useSSL: endpoint.protocol === "https:",
    accessKey: process.env.MINIO_ROOT_USER || "spendlens",
    secretKey: process.env.MINIO_ROOT_PASSWORD || "spendlens_local_minio_password"
  });
}

async function removeLocalTrainingArtifacts(artifactKey: string): Promise<void> {
  await removeWithin("artifacts/models/custom-ocr-api", artifactKey);
  await removeWithin("data/generated/custom-ocr-api", artifactKey.replace("artifacts/models/custom-ocr-api/", "data/generated/custom-ocr-api/"));
}

async function removeGeneratedTrainingArtifactsForTenant(tenantId: string): Promise<void> {
  if (!tenantId) return;
  await Promise.all([
    removeChildrenStartingWith("artifacts/models/custom-ocr-api", tenantId),
    removeChildrenStartingWith("data/generated/custom-ocr-api", tenantId)
  ]);
}

async function removeChildrenStartingWith(root: string, prefix: string): Promise<void> {
  try {
    const rootPath = path.resolve(root);
    const entries = await readdir(rootPath, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) => rm(path.join(rootPath, entry.name), { recursive: true, force: true }))
    );
  } catch {
    // Local artifact cleanup is best effort for opt-in live tests.
  }
}

async function removeWithin(root: string, target: string): Promise<void> {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  if (!targetPath.startsWith(`${rootPath}${path.sep}`)) return;
  await rm(targetPath, { recursive: true, force: true });
}
