import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuditRepository } from "../audit/memory-repository";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { InMemoryDocumentRepository } from "../documents/memory-repository";
import { InMemoryDocumentStorage } from "../documents/storage";
import { InMemoryExtractionRepository } from "./memory-repository";

describe("extraction routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let documentId: string;
  let extractionRepository: InMemoryExtractionRepository;
  let auditRepository: InMemoryAuditRepository;

  beforeAll(async () => {
    const documentRepository = new InMemoryDocumentRepository();
    extractionRepository = new InMemoryExtractionRepository();
    auditRepository = new InMemoryAuditRepository();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      documentRepository,
      documentStorage: new InMemoryDocumentStorage(),
      extractionRepository,
      auditRepository
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Extraction Tenant",
        tenantSlug: "extract",
        workspaceName: "Finance",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    const body = register.json();
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

  it("extracts and persists structured fields for a tenant document", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/extraction`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-extraction-text" },
      payload: {
        sourceEngine: "TESSERACT",
        text: [
          "MAVI MARKET",
          "FIS NO: TR-12345",
          "TARIH: 12.05.2026 SAAT 14:35",
          "EKMEK 20,00 TL",
          "SUT 45,50 TL",
          "KDV 6,55 TL",
          "TOPLAM 72,05 TL",
          "KREDI KARTI **** 1234"
        ].join("\n")
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.extracted.total.amountMinor).toBe("7205");
    expect(body.extracted.cardLast4).toBe("1234");
    expect(body.fields.some((field: { fieldName: string; value: string }) => field.fieldName === "total" && field.value === "7205")).toBe(true);
    expect(body.fields.find((field: { fieldName: string }) => field.fieldName === "total").confidence).not.toBeNull();
    expect(body.extracted.normalizedText).toContain("TOPLAM 72,05 TL");
    expect(body.extracted.fieldEvidence.find((field: { fieldName: string }) => field.fieldName === "total")).toMatchObject({
      source: "normalized_ocr_text",
      normalizedEvidence: "TOPLAM 72,05 TL"
    });
    expect(body.issues).toEqual([]);
    expect(extractionRepository.extractions).toHaveLength(1);

    const latest = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/extraction`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().job.id).toBe(body.job.id);
    expect(latest.json().extracted.lineItems).toHaveLength(2);

    const reconciled = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/extraction/line-items`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-extraction-reconcile" },
      payload: {
        lineItems: [
          { name: "EKMEK TAM BUGDAY", quantity: "1", total: { amountMinor: "2200", currency: "TRY" }, confidence: 1 },
          { name: "SUT", quantity: "1", total: { amountMinor: "4350", currency: "TRY" }, confidence: 1 }
        ]
      }
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().job.id).not.toBe(body.job.id);
    expect(reconciled.json().extracted.lineItems[0].name).toBe("EKMEK TAM BUGDAY");
    expect(reconciled.json().issues).toEqual([]);

    const latestReconciled = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/extraction`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(latestReconciled.json().job.id).toBe(reconciled.json().job.id);
    expect(latestReconciled.json().extracted.lineItems[0].total.amountMinor).toBe("2200");

    const fieldReconciled = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/extraction/fields`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-extraction-field-review" },
      payload: {
        reviewStatus: "APPROVED",
        fields: [
          { fieldName: "merchantName", value: "MAVI GIDA" },
          { fieldName: "receiptNumber", value: "TR-12345-REVIEWED" },
          { fieldName: "total", value: { amountMinor: "7205", currency: "TRY" } }
        ]
      }
    });
    expect(fieldReconciled.statusCode).toBe(200);
    expect(fieldReconciled.json().job.id).not.toBe(reconciled.json().job.id);
    expect(fieldReconciled.json().extracted.merchantName).toBe("MAVI GIDA");
    expect(fieldReconciled.json().extracted.receiptNumber).toBe("TR-12345-REVIEWED");
    expect(fieldReconciled.json().reviewState).toMatchObject({
      status: "APPROVED",
      correctedFields: ["merchantName", "receiptNumber", "total"],
      reasonPresent: false
    });
    expect(fieldReconciled.json().issues).toEqual([]);

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=extraction.completed&resourceType=ExtractionJob&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const logs = audit.json().logs as Array<{ resourceId: string; correlationId: string | null; metadata: Record<string, unknown> }>;
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: body.job.id,
          correlationId: "corr-extraction-text",
          metadata: expect.objectContaining({
            documentFileId: documentId,
            source: "ocr_text",
            sourceEngine: "TESSERACT",
            fieldCount: expect.any(Number),
            issueCount: 0,
            lineItemCount: 2,
            totalPresent: true,
            merchantPresent: true
          })
        }),
        expect.objectContaining({
          resourceId: reconciled.json().job.id,
          correlationId: "corr-extraction-reconcile",
          metadata: expect.objectContaining({
            documentFileId: documentId,
            source: "line_item_reconciliation",
            fieldCount: expect.any(Number),
            issueCount: 0,
            lineItemCount: 2,
            totalPresent: true,
            merchantPresent: true
          })
        }),
        expect.objectContaining({
          resourceId: fieldReconciled.json().job.id,
          correlationId: "corr-extraction-field-review",
          metadata: expect.objectContaining({
            documentFileId: documentId,
            source: "field_reconciliation",
            reviewStatus: "APPROVED",
            correctedFields: ["merchantName", "receiptNumber", "total"],
            reasonPresent: false,
            issueCount: 0
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(
      logs.map((log) => {
        const metadata = (log.metadata ?? {}) as Record<string, unknown>;
        const metadataWithoutIds = { ...metadata };
        delete metadataWithoutIds.documentFileId;
        return metadataWithoutIds;
      })
    );
    expect(serializedAudit).not.toContain("MAVI MARKET");
    expect(serializedAudit).not.toContain("7205");
    expect(serializedAudit).not.toContain("1234");
    expect(serializedAudit).not.toContain("EKMEK TAM BUGDAY");
    expect(serializedAudit).not.toContain("MAVI GIDA");
    expect(serializedAudit).not.toContain("TR-12345-REVIEWED");
  });

  it("requires a reason when field reconciliation rejects an extraction", async () => {
    const rejectedWithoutReason = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/extraction/fields`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reviewStatus: "REJECTED", fields: [{ fieldName: "merchantName", value: "Rejected Merchant" }] }
    });
    expect(rejectedWithoutReason.statusCode).toBe(400);
    expect(rejectedWithoutReason.json().error.code).toBe("REJECTION_REASON_REQUIRED");
  });

  it("rejects extraction for missing documents before parsing text", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/documents/missing/extraction",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { text: "TOPLAM 10,00" }
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
