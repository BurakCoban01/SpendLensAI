import { Client as MinioClient } from "minio";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";

const runLiveOcrDockerTests =
  process.env.SPENDLENS_LIVE_OCR_DOCKER_TESTS === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.MINIO_ENDPOINT) &&
  Boolean(process.env.OCR_SERVICE_URL);
const liveDescribe = runLiveOcrDockerTests ? describe : describe.skip;

liveDescribe("document worker live OCR service integration", () => {
  const prisma = new PrismaClient();
  const slug = `ocr-live-${Date.now()}`;
  const bucket = process.env.MINIO_BUCKET_DOCUMENTS || "spendlens-documents";
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
        tenantName: "Live OCR Tenant",
        tenantSlug: slug,
        workspaceName: "Finance",
        email: `${slug}@example.com`,
        displayName: "Live OCR Owner",
        password: "very-secure-password"
      }
    });
    expect(register.statusCode).toBe(201);
    const body = register.json();
    tenantId = body.tenant.id;
    accessToken = body.tokens.accessToken;
  }, 60_000);

  afterAll(async () => {
    await removeTenantObjects(bucket, tenantId);
    if (tenantId) {
      await prisma.auditLog.deleteMany({ where: { tenantId } });
      await prisma.workerJob.deleteMany({ where: { tenantId } });
      await prisma.outboxEvent.deleteMany({ where: { tenantId } });
      await prisma.oCRConfidenceScore.deleteMany({ where: { tenantId } });
      await prisma.oCREngineRun.deleteMany({ where: { tenantId } });
      await prisma.oCRJob.deleteMany({ where: { tenantId } });
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

  it("preprocesses a stored document through Docker OCR service and persists Tesseract OCR output", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { tenantId, name: "Finance" } });
    const content = pdfReceiptBytes();
    const upload = await app.inject({
      method: "POST",
      url: `/documents/upload?workspaceId=${workspace.id}&kind=RECEIPT`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-correlation-id": "corr-live-ocr-upload",
        ...multipartHeaders("boundary-live-ocr")
      },
      payload: multipartBody("boundary-live-ocr", "live-ocr-receipt.pdf", "application/pdf", content)
    });
    expect(upload.statusCode).toBe(201);
    const documentId = upload.json().document.id as string;

    const preprocessingRun = await runNext("preprocessing");
    expect(preprocessingRun.statusCode).toBe(200);
    expect(preprocessingRun.json().job).toMatchObject({ status: "SUCCEEDED", jobType: "document.preprocess" });
    expect(preprocessingRun.json().job.result).toMatchObject({
      documentFileId: documentId,
      profile: "TESSERACT_OPTIMIZED",
      pageCount: 1
    });
    expect(preprocessingRun.json().job.result.chainedOcrJobId).toBeTruthy();

    const pages = await prisma.documentPage.findMany({ where: { tenantId, documentFileId: documentId } });
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page).toBeDefined();
    expect(page?.processedBucket).toBe(bucket);
    expect(page?.processedKey).toMatch(
      new RegExp(
        `^tenants/${tenantId}/workspaces/${workspace.id}/documents/${documentId}/preprocessing/tesseract-optimized/page-0001\\.png$`
      )
    );
    expect(page?.preprocessingProfile).toBe("TESSERACT_OPTIMIZED");

    const signedPages = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/pages`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(signedPages.statusCode).toBe(200);
    const processedDownload = await fetch(signedPages.json().pages[0].processedImageUrl);
    expect(processedDownload.status).toBe(200);
    expect(Buffer.from(await processedDownload.arrayBuffer()).byteLength).toBeGreaterThan(100);

    const ocrRun = await runNext("ocr");
    expect(ocrRun.statusCode).toBe(200);
    const ocrJob = ocrRun.json().job;
    if (ocrJob.status !== "SUCCEEDED") {
      throw new Error(`Live OCR worker failed: ${JSON.stringify(ocrJob)}`);
    }
    expect(ocrJob).toMatchObject({ status: "SUCCEEDED", jobType: "ocr.tesseract" });
    expect(ocrJob.result).toMatchObject({
      documentFileId: documentId,
      selectedEngine: "TESSERACT",
      pageCount: 1,
      chainedExtractionJobId: expect.any(String)
    });

    const engineRun = await prisma.oCREngineRun.findFirstOrThrow({
      where: { tenantId, engine: "TESSERACT" },
      orderBy: { createdAt: "desc" }
    });
    expect(engineRun.status).toBe("SUCCEEDED");
    expect(Number(engineRun.confidence)).toBeGreaterThanOrEqual(0);
    expect(engineRun.normalizedJson).toEqual(
      expect.objectContaining({
        text: expect.stringMatching(/SPENDLENS|MARKET|TOPLAM/i)
      })
    );
  }, 90_000);

  async function runNext(queue: string) {
    return app.inject({
      method: "POST",
      url: "/admin/jobs/run-next",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { queue, workerId: `live-ocr-${queue}` }
    });
  }
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
    // Cleanup is best effort; test assertions prove the live storage and OCR path.
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
