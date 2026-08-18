import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { InMemoryDocumentRepository } from "../documents/memory-repository";
import { InMemoryDocumentStorage } from "../documents/storage";
import { InMemoryJobRepository } from "../jobs/memory-repository";
import { InMemoryOcrComparisonRepository } from "./memory-repository";

describe("OCR comparison routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let tenantId: string;
  let documentId: string;
  let repository: InMemoryOcrComparisonRepository;
  let jobRepository: InMemoryJobRepository;

  beforeAll(async () => {
    const documentRepository = new InMemoryDocumentRepository();
    repository = new InMemoryOcrComparisonRepository();
    jobRepository = new InMemoryJobRepository();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      documentRepository,
      documentStorage: new InMemoryDocumentStorage(),
      ocrComparisonRepository: repository,
      jobRepository
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "OCR Tenant",
        tenantSlug: "ocr-tenant",
        workspaceName: "Finance",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    const body = register.json();
    tenantId = body.tenant.id;
    accessToken = body.tokens.accessToken;
    documentRepository.addWorkspace(body.tenant.id, "workspace_1");

    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "multipart/form-data; boundary=boundary"
      },
      payload: multipartBody("boundary", "receipt.png", "image/png", pngBytes())
    });
    documentId = upload.json().document.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("persists OCR candidate runs and ensemble provenance for a document", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/ocr-runs/compare`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-ocr-ensemble" },
      payload: {
        runs: [
          {
            engine: "TESSERACT",
            text: ["MAVI MARKET", "TARIH 12.05.2026", "TOPLAM 72,05 TL"].join("\n"),
            confidence: 0.86,
            tokens: [{ text: "TOPLAM", confidence: 0.91, bbox: [18, 140, 76, 20], pageNumber: 1 }],
            latencyMs: 420
          },
          {
            engine: "CUSTOM_CRNN",
            text: ["MAVI MARKET", "TARIH 12.05.2026", "TOPLAM 79,05 TL"].join("\n"),
            confidence: 0.61,
            latencyMs: 180
          }
        ],
        groundTruthText: "MAVI MARKET TARIH 12.05.2026 TOPLAM 72,05 TL"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.comparison.selectedEngine).toBe("TESSERACT");
    expect(body.comparison.conflictFields).toContain("total");
    expect(body.chainedExtractionJob.jobType).toBe("extraction.from_text");
    expect(body.chainedExtractionJob.payload.text).toContain("TOPLAM 72,05 TL");
    expect(body.runs.map((run: { engine: string }) => run.engine)).toEqual(["TESSERACT", "CUSTOM_CRNN", "ENSEMBLE"]);
    expect(repository.comparisons).toHaveLength(1);
    const queuedExtractionJobs = await jobRepository.list({ tenantId, queue: "extraction", status: "QUEUED" });
    expect(queuedExtractionJobs).toHaveLength(1);
    expect(queuedExtractionJobs[0]?.dedupeKey).toBe(`extraction:${documentId}:${body.job.id}`);

    const list = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/ocr-runs`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().jobs[0].runs).toHaveLength(3);
    expect(list.json().jobs[0].runs[0].normalizedJson.tokens[0]).toMatchObject({
      text: "TOPLAM",
      bbox: [18, 140, 76, 20],
      pageNumber: 1
    });

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=ocr.ensemble.completed&resourceType=OCRJob&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "ocr.ensemble.completed",
          resourceId: body.job.id,
          correlationId: "corr-ocr-ensemble",
          metadata: expect.objectContaining({
            documentFileId: documentId,
            selectedEngine: "TESSERACT",
            candidateEngineCount: 2,
            runCount: 3,
            conflictFieldCount: 1,
            conflictFields: ["total"],
            failedRunCount: 0
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("MAVI MARKET");
    expect(serializedAudit).not.toContain("TOPLAM 72,05 TL");
    expect(serializedAudit).not.toContain("TOPLAM");
  });

  it("records failed OCR engine summary in audit metadata without failure reason or OCR text leakage", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/ocr-runs/compare`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-ocr-failed-engine" },
      payload: {
        runs: [
          {
            engine: "TESSERACT",
            text: "",
            confidence: 0,
            latencyMs: 5000,
            failed: true,
            failureReason: "raw timeout objectKey=tenants/ocr/private.tsv text=TOPLAM 999,99 TL"
          },
          {
            engine: "CUSTOM_CRNN",
            text: ["BASAR MARKET", "TARIH 13.05.2026", "TOPLAM 42,10 TL"].join("\n"),
            confidence: 0.74,
            latencyMs: 190
          }
        ]
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.comparison.selectedEngine).toBe("CUSTOM_CRNN");
    expect(body.comparison.failureRate).toBe(0.5);
    expect(body.runs.find((run: { engine: string }) => run.engine === "TESSERACT")).toMatchObject({
      status: "FAILED",
      failureReason: "raw timeout objectKey=tenants/ocr/private.tsv text=TOPLAM 999,99 TL"
    });

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=ocr.ensemble.completed&resourceType=OCRJob&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "ocr.ensemble.completed",
          resourceId: body.job.id,
          correlationId: "corr-ocr-failed-engine",
          metadata: expect.objectContaining({
            documentFileId: documentId,
            selectedEngine: "CUSTOM_CRNN",
            candidateEngineCount: 2,
            failedRunCount: 1,
            failedEngines: ["TESSERACT"],
            failureRate: 0.5
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs.find((log: { resourceId: string }) => log.resourceId === body.job.id));
    expect(serializedAudit).not.toContain("failureReason");
    expect(serializedAudit).not.toContain("tenants/ocr/private.tsv");
    expect(serializedAudit).not.toContain("TOPLAM 999,99 TL");
    expect(serializedAudit).not.toContain("BASAR MARKET");
    expect(serializedAudit).not.toContain("TOPLAM 42,10 TL");
  });

  it("rejects OCR comparison for missing documents", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/documents/missing/ocr-runs/compare",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        runs: [{ engine: "TESSERACT", text: "TOPLAM 10,00", confidence: 0.7 }]
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("DOCUMENT_NOT_FOUND");
  });
});

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
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
