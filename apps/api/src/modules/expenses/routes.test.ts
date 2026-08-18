import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuditRepository } from "../audit/memory-repository";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { InMemoryCacheStore } from "../cache/memory-store";
import { InMemoryDocumentRepository } from "../documents/memory-repository";
import { InMemoryDocumentStorage } from "../documents/storage";
import { InMemoryEventRepository } from "../events/memory-repository";
import { InMemoryExtractionRepository } from "../extraction/memory-repository";
import { InMemoryReviewRepository } from "../review/memory-repository";
import { InMemoryExpenseRepository } from "./memory-repository";
import type { ApprovalSlaItem } from "./types";

describe("expense routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let tenantId: string;
  let documentId: string;
  let expenseRepository: CountingExpenseRepository;
  let eventRepository: InMemoryEventRepository;
  let cacheStore: InMemoryCacheStore;
  let auditRepository: InMemoryAuditRepository;
  let extractionRepository: InMemoryExtractionRepository;
  let reviewRepository: InMemoryReviewRepository;

  beforeAll(async () => {
    const documentRepository = new InMemoryDocumentRepository();
    extractionRepository = new InMemoryExtractionRepository();
    reviewRepository = new InMemoryReviewRepository();
    expenseRepository = new CountingExpenseRepository();
    eventRepository = new InMemoryEventRepository();
    cacheStore = new InMemoryCacheStore();
    auditRepository = new InMemoryAuditRepository();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      documentRepository,
      documentStorage: new InMemoryDocumentStorage(),
      extractionRepository,
      expenseRepository,
      eventRepository,
      cacheStore,
      auditRepository,
      reviewRepository
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Expense Tenant",
        tenantSlug: "expenses",
        workspaceName: "Finance",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    const body = register.json();
    accessToken = body.tokens.accessToken;
    tenantId = body.tenant.id;
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

    await app.inject({
      method: "POST",
      url: `/documents/${documentId}/extraction`,
      headers: { authorization: `Bearer ${accessToken}` },
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
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("creates and lists manual expenses with integer minor amounts", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/expenses",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-create-manual" },
      payload: {
        workspaceId: "workspace_1",
        title: "Manual taxi",
        currency: "TRY",
        amountMinor: "18550",
        taxMinor: "0",
        occurredAt: "2026-05-11T10:00:00.000Z",
        reimbursable: true,
        businessExpense: false
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().expense.amountMinor).toBe("18550");
    expect(created.json().expense.status).toBe("DRAFT");

    const list = await app.inject({
      method: "GET",
      url: "/expenses?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().expenses.some((expense: { title: string }) => expense.title === "Manual taxi")).toBe(true);
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.created&resourceType=Expense&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.created",
          resourceId: created.json().expense.id,
          correlationId: "corr-expense-create-manual",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            status: "DRAFT",
            amountMinor: "18550",
            currency: "TRY",
            source: "manual",
            documentLinked: false,
            reimbursable: true,
            businessExpense: false,
            duplicateGroupPresent: false
          })
        })
      ])
    );
    expect(JSON.stringify(audit.json().logs)).not.toContain("Manual taxi");
  });

  it("paginates, filters and searches expense lists without repeating cursor rows", async () => {
    await createManualExpense("Sayfalama Taksi 1", "1000");
    await createManualExpense("Sayfalama Taksi 2", "2000");
    await createManualExpense("Sayfalama Taksi 3", "3000");

    const firstPage = await app.inject({
      method: "GET",
      url: "/expenses?workspaceId=workspace_1&status=DRAFT&search=Sayfalama&limit=2",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().expenses).toHaveLength(2);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));

    const secondPage = await app.inject({
      method: "GET",
      url: `/expenses?workspaceId=workspace_1&status=DRAFT&search=Sayfalama&limit=2&cursor=${firstPage.json().nextCursor}`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().expenses).toHaveLength(1);
    expect(secondPage.json().nextCursor).toBeNull();
    expect(secondPage.json().expenses[0].id).not.toBe(firstPage.json().expenses[1].id);
  });

  it("imports expenses from CSV and records import batch status", async () => {
    const csvText = [
      "title,merchant,amount,occurred_at,currency,payment_method,business_expense,reimbursable,project_code,cost_center",
      "CSV taxi,City Taxi,\"185,50\",2026-05-14T10:00:00.000Z,TRY,Personal card,false,true,OPS,TRAVEL",
      "CSV office,Office Store,420.00,2026-05-15T10:00:00.000Z,TRY,Corporate card,true,false,OPS,OFFICE"
    ].join("\n");
    const imported = await app.inject({
      method: "POST",
      url: "/expenses/imports",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-import-success" },
      payload: {
        workspaceId: "workspace_1",
        source: "e2e-ledger.csv",
        csvText
      }
    });

    expect(imported.statusCode).toBe(201);
    expect(imported.json().importBatch.status).toBe("SUCCEEDED");
    expect(imported.json().importBatch.source).toBe("e2e-ledger.csv");
    expect(imported.json().importBatch.stats.importedRows).toBe(2);
    expect(imported.json().expenses.map((expense: { title: string }) => expense.title)).toEqual(["CSV taxi", "CSV office"]);
    expect(imported.json().expenses[0].amountMinor).toBe("18550");
    expect(imported.json().expenses[0].reimbursable).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/expenses?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.json().expenses.map((expense: { title: string }) => expense.title)).toEqual(
      expect.arrayContaining(["CSV taxi", "CSV office"])
    );
    const importBatches = await app.inject({
      method: "GET",
      url: "/expenses/imports?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(importBatches.statusCode).toBe(200);
    expect(importBatches.json().importBatches.some((batch: { id: string }) => batch.id === imported.json().importBatch.id)).toBe(true);
    const events = await eventRepository.list({ tenantId, limit: 100 });
    expect(events.some((event) => event.topic === "expense.created" && event.payload.source === "csv_import")).toBe(true);

    const invalid = await app.inject({
      method: "POST",
      url: "/expenses/imports",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-import-failed" },
      payload: {
        workspaceId: "workspace_1",
        source: "bad-ledger.csv",
        csvText: ["title,amount,occurred_at", "Bad row,not-money,2026-05-14T10:00:00.000Z"].join("\n")
      }
    });
    expect(invalid.statusCode).toBe(201);
    expect(invalid.json().importBatch.status).toBe("FAILED");
    expect(invalid.json().importBatch.stats.failedRows).toBe(1);
    expect(invalid.json().errors[0].code).toBe("VALID_AMOUNT_REQUIRED");
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.import_batch.created&resourceType=ImportBatch&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.import_batch.created",
          resourceId: imported.json().importBatch.id,
          correlationId: "corr-expense-import-success",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            status: "SUCCEEDED",
            sourcePresent: true,
            totalRows: 2,
            importedRows: 2,
            failedRows: 0,
            expenseCount: 2
          })
        }),
        expect.objectContaining({
          action: "expense.import_batch.created",
          resourceId: invalid.json().importBatch.id,
          correlationId: "corr-expense-import-failed",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            status: "FAILED",
            sourcePresent: true,
            totalRows: 1,
            importedRows: 0,
            failedRows: 1
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("e2e-ledger.csv");
    expect(serializedAudit).not.toContain("bad-ledger.csv");
    expect(serializedAudit).not.toContain("CSV taxi");
    expect(serializedAudit).not.toContain("not-money");
  });

  it("creates an extracted expense from the latest document extraction", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/expense`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-create-extraction" }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.expense.title).toBe("MAVI MARKET");
    expect(body.expense.amountMinor).toBe("7205");
    expect(body.expense.taxMinor).toBe("655");
    expect(body.expense.status).toBe("EXTRACTED");
    expect(body.lineItems.map((item: { name: string }) => item.name)).toEqual(["EKMEK", "SUT"]);
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.created&resourceType=Expense&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.created",
          resourceId: body.expense.id,
          correlationId: "corr-expense-create-extraction",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            status: "EXTRACTED",
            amountMinor: "7205",
            currency: "TRY",
            source: "extraction",
            documentLinked: true,
            documentId,
            lineItemCount: 2
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("MAVI MARKET");
    expect(serializedAudit).not.toContain("EKMEK");
    expect(serializedAudit).not.toContain("SUT");
  });

  it("routes low-confidence extracted expenses into review with a persisted task", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "multipart/form-data; boundary=low-confidence-boundary"
      },
      payload: multipartBody("low-confidence-boundary", "low-confidence.png", "image/png", Buffer.concat([pngBytes(), Buffer.from([0x02])]))
    });
    expect([200, 201]).toContain(upload.statusCode);
    const lowConfidenceDocumentId = upload.json().document.id;
    const baseline = extractionRepository.extractions[0]?.extracted;
    expect(baseline).toBeDefined();
    await extractionRepository.createFromReceiptFields({
      tenantId,
      documentFileId: lowConfidenceDocumentId,
      sourceEngine: "TESSERACT",
      extracted: {
        ...baseline!,
        fieldEvidence: baseline!.fieldEvidence.map((field) =>
          field.fieldName === "total" ? { ...field, confidence: 0.31 } : field
        )
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/documents/${lowConfidenceDocumentId}/expense`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().expense.status).toBe("NEEDS_REVIEW");
    const tasks = await reviewRepository.listReviewTasks({ tenantId });
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentFileId: lowConfidenceDocumentId,
          reasonCodes: expect.arrayContaining(["LOW_FIELD_CONFIDENCE_TOTAL"])
        })
      ])
    );
  });

  it("blocks normal expense creation from garbage Custom OCR extraction that needs review", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "multipart/form-data; boundary=garbage-custom-boundary"
      },
      payload: multipartBody("garbage-custom-boundary", "garbage-custom.png", "image/png", Buffer.concat([pngBytes(), Buffer.from([0x04])]))
    });
    expect([200, 201]).toContain(upload.statusCode);
    const garbageDocumentId = upload.json().document.id;

    const extraction = await app.inject({
      method: "POST",
      url: `/documents/${garbageDocumentId}/extraction`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        sourceEngine: "CUSTOM_CRNN",
        text: [
          "KZV ATTİİ ARKET0 İ",
          "KZV TTTİİ 1AIKIİ1",
          "ÖZŞ 0 AK KT1 İ",
          "KGL 20 1 NAKKETT1 Tİ",
          "MAVI KIR AEM TOPLAMMM 0,0 1L",
          "MAVI KI EMET TOPLAM 22,23 T TL",
          "MAVI KIR EMEM TOPLAM 00,0 TL",
          "BILG FIS ET TOPLAM 22,2 TL"
        ].join("\n")
      }
    });
    expect([200, 201]).toContain(extraction.statusCode);
    expect(extraction.json().extracted.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GARBAGE_OCR_TEXT", severity: "critical" }),
        expect.objectContaining({ code: "CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE", severity: "critical" })
      ])
    );

    const blocked = await app.inject({
      method: "POST",
      url: `/documents/${garbageDocumentId}/expense`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe("EXTRACTION_REQUIRES_REVIEW");
    expect(blocked.json().error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "GARBAGE_OCR_TEXT" }),
        expect.objectContaining({ code: "CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE" })
      ])
    );
  });

  it("requires confirmation before creating an expense from a bank transfer receipt", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "multipart/form-data; boundary=bank-boundary"
      },
      payload: multipartBody("bank-boundary", "ziraat-fast.png", "image/png", Buffer.concat([pngBytes(), Buffer.from([0x03])]))
    });
    expect([200, 201]).toContain(upload.statusCode);
    const bankDocumentId = upload.json().document.id;

    const extraction = await app.inject({
      method: "POST",
      url: `/documents/${bankDocumentId}/extraction`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        sourceEngine: "TESSERACT",
        text: [
          "Ziraat Bankasi",
          "HESAPTAN FAST",
          "Islem Yeri: Internet Subesi",
          "Islem Tarihi: 04042023.221613",
          "Islem Tutari: 640,00 TRY",
          "Komisyon: 0,00 TRY",
          "Alici IBAN: TR000000000000000000000000"
        ].join("\n")
      }
    });
    expect([200, 201]).toContain(extraction.statusCode);
    expect(extraction.json().extracted.documentType).toBe("bank_transfer_receipt");
    expect(extraction.json().extracted.total.amountMinor).toBe("64000");

    const blocked = await app.inject({
      method: "POST",
      url: `/documents/${bankDocumentId}/expense`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe("NON_EXPENSE_DOCUMENT_REQUIRES_CONFIRMATION");

    const forced = await app.inject({
      method: "POST",
      url: `/documents/${bankDocumentId}/expense`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { forceNonExpenseDocument: true }
    });
    expect(forced.statusCode).toBe(201);
    expect(forced.json().expense.amountMinor).toBe("64000");
    expect(forced.json().expense.documentId).toBe(bankDocumentId);

    const duplicate = await app.inject({
      method: "POST",
      url: `/documents/${bankDocumentId}/expense`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { forceNonExpenseDocument: true }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("DUPLICATE_EXPENSE_FOR_DOCUMENT");
  });

  it("blocks unknown documents from expense creation even when forced", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "multipart/form-data; boundary=unknown-boundary"
      },
      payload: multipartBody("unknown-boundary", "unknown-note.png", "image/png", Buffer.concat([pngBytes(), Buffer.from([0x02])]))
    });
    expect([200, 201]).toContain(upload.statusCode);
    const unknownDocumentId = upload.json().document.id;

    const extraction = await app.inject({
      method: "POST",
      url: `/documents/${unknownDocumentId}/extraction`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        sourceEngine: "TESSERACT",
        text: ["UNLABELED PAPER", "REFERENCE 20210600488120604", "TOTAL 10,00 TRY"].join("\n")
      }
    });
    expect([200, 201]).toContain(extraction.statusCode);
    expect(extraction.json().extracted.documentType).toBe("unknown_document");
    expect(extraction.json().extracted.total.amountMinor).toBe("1000");

    const forced = await app.inject({
      method: "POST",
      url: `/documents/${unknownDocumentId}/expense`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { forceNonExpenseDocument: true }
    });
    expect(forced.statusCode).toBe(422);
    expect(forced.json().error.code).toBe("UNSUPPORTED_DOCUMENT_TYPE_FOR_EXPENSE");
  });

  it("attaches and detaches a document from an expense with audit and outbox evidence", async () => {
    const expense = await createManualExpense("Attachment candidate", "12500");
    const supportUpload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "multipart/form-data; boundary=support-boundary"
      },
      payload: multipartBody("support-boundary", "support.png", "image/png", Buffer.concat([pngBytes(), Buffer.from([0x01])]))
    });
    expect(supportUpload.statusCode).toBe(201);
    const supportDocumentId = supportUpload.json().document.id;

    const empty = await app.inject({
      method: "GET",
      url: `/expenses/${expense.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().attachments).toEqual([]);

    const attached = await app.inject({
      method: "POST",
      url: `/expenses/${expense.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-attachment-attach" },
      payload: { documentFileId: documentId, label: "Receipt", note: "Primary dinner receipt", primary: true }
    });
    expect(attached.statusCode).toBe(201);
    expect(attached.json().expense.documentId).toBe(documentId);
    expect(attached.json().attachment.id).toBe(documentId);
    expect(attached.json().attachment.originalName).toBe("receipt.png");
    expect(attached.json().attachmentMetadata.label).toBe("Receipt");

    const attachedSupport = await app.inject({
      method: "POST",
      url: `/expenses/${expense.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { documentFileId: supportDocumentId, label: "Card slip", note: "Secondary proof" }
    });
    expect(attachedSupport.statusCode).toBe(201);
    expect(attachedSupport.json().expense.documentId).toBe(documentId);
    expect(attachedSupport.json().attachmentMetadata.label).toBe("Card slip");

    const listed = await app.inject({
      method: "GET",
      url: `/expenses/${expense.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().attachments.map((attachment: { id: string }) => attachment.id)).toEqual([documentId, supportDocumentId]);
    expect(listed.json().attachmentMetadata.map((attachment: { label: string }) => attachment.label)).toEqual(["Receipt", "Card slip"]);

    const detached = await app.inject({
      method: "DELETE",
      url: `/expenses/${expense.id}/attachments/${documentId}`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-attachment-detach" }
    });
    expect(detached.statusCode).toBe(200);
    expect(detached.json().expense.documentId).toBe(supportDocumentId);
    expect(detached.json().attachment.id).toBe(documentId);
    expect(detached.json().attachmentMetadata.detachedAt).toEqual(expect.any(String));
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?resourceType=Expense&limit=40",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.attachment.attached",
          resourceId: expense.id,
          correlationId: "corr-expense-attachment-attach",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            status: "DRAFT",
            previousDocumentId: null,
            documentFileId: documentId,
            attachmentId: attached.json().attachmentMetadata.id,
            labelPresent: true,
            notePresent: true,
            primary: true
          })
        }),
        expect.objectContaining({
          action: "expense.attachment.detached",
          resourceId: expense.id,
          correlationId: "corr-expense-attachment-detach",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            status: "DRAFT",
            previousDocumentId: documentId,
            documentFileId: documentId,
            attachmentId: detached.json().attachmentMetadata.id,
            nextPrimaryDocumentId: supportDocumentId,
            detachedAtPresent: true
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("Receipt");
    expect(serializedAudit).not.toContain("Primary dinner receipt");
    expect(serializedAudit).not.toContain("Card slip");
    expect(serializedAudit).not.toContain("Secondary proof");
    const events = await eventRepository.list({ tenantId, limit: 100 });
    expect(events.some((event) => event.topic === "expense.updated" && event.payload.lifecycleAction === "attachment_attached")).toBe(true);
    expect(events.some((event) => event.topic === "expense.updated" && event.payload.lifecycleAction === "attachment_detached")).toBe(true);
  });

  it("rejects manual expenses in missing workspaces", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/expenses",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "missing",
        title: "Invalid",
        amountMinor: "100",
        occurredAt: "2026-05-11T10:00:00.000Z"
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("updates tenant-scoped expenses and emits audit/outbox records", async () => {
    const original = await createManualExpense("Editable lunch", "2500", { merchantName: "Old Cafe" });
    const response = await app.inject({
      method: "PATCH",
      url: `/expenses/${original.id}`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-update" },
      payload: {
        title: "Updated team lunch",
        amountMinor: "4200",
        taxMinor: "400",
        occurredAt: "2026-05-13T12:30:00.000Z",
        merchantName: "Yeni Lokanta",
        paymentMethodName: "Corporate card",
        reimbursable: true,
        businessExpense: true,
        projectCode: "PRJ-42",
        costCenter: "FIN"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().expense.title).toBe("Updated team lunch");
    expect(response.json().expense.amountMinor).toBe("4200");
    expect(response.json().expense.taxMinor).toBe("400");
    expect(response.json().expense.merchantName).toBe("Yeni Lokanta");
    expect(response.json().expense.paymentMethodName).toBe("Corporate card");
    expect(response.json().expense.reimbursable).toBe(true);
    expect(response.json().expense.businessExpense).toBe(true);
    expect(response.json().expense.projectCode).toBe("PRJ-42");
    expect(response.json().expense.costCenter).toBe("FIN");

    const list = await app.inject({
      method: "GET",
      url: "/expenses?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const updated = list.json().expenses.find((expense: { id: string }) => expense.id === original.id);
    expect(updated.title).toBe("Updated team lunch");
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.updated&resourceType=Expense&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.updated",
          resourceId: original.id,
          correlationId: "corr-expense-update",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            previousStatus: "DRAFT",
            status: "DRAFT",
            changedFields: expect.arrayContaining([
              "title",
              "amountMinor",
              "taxMinor",
              "occurredAt",
              "merchantName",
              "paymentMethodName",
              "reimbursable",
              "businessExpense",
              "projectCode",
              "costCenter"
            ]),
            changedFieldCount: 10
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("Updated team lunch");
    expect(serializedAudit).not.toContain("Yeni Lokanta");
    expect(serializedAudit).not.toContain("Corporate card");
    expect(serializedAudit).not.toContain("PRJ-42");
    expect(serializedAudit).not.toContain("FIN");
    const events = await eventRepository.list({ tenantId, limit: 50 });
    expect(events.map((event) => event.topic)).toContain("expense.updated");

    const emptyPatch = await app.inject({
      method: "PATCH",
      url: `/expenses/${original.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {}
    });
    expect(emptyPatch.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PATCH",
      url: "/expenses/missing",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { title: "Missing" }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("EXPENSE_NOT_FOUND");
  });

  it("adds and lists expense comments with audit/outbox evidence", async () => {
    const expense = await createManualExpense("Comment candidate", "3150");
    const created = await app.inject({
      method: "POST",
      url: `/expenses/${expense.id}/comments`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-comment" },
      payload: { body: "Reviewed receipt against card statement." }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().comment.expenseId).toBe(expense.id);
    expect(created.json().comment.body).toBe("Reviewed receipt against card statement.");
    expect(created.json().comment.authorId).toEqual(expect.any(String));

    const listed = await app.inject({
      method: "GET",
      url: `/expenses/${expense.id}/comments`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().comments).toHaveLength(1);
    expect(listed.json().comments[0].body).toBe("Reviewed receipt against card statement.");
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.comment.created&resourceType=Expense&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.comment.created",
          resourceId: expense.id,
          correlationId: "corr-expense-comment",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            status: "DRAFT",
            commentId: created.json().comment.id,
            bodyPresent: true,
            bodyLength: "Reviewed receipt against card statement.".length
          })
        })
      ])
    );
    expect(JSON.stringify(audit.json().logs)).not.toContain("Reviewed receipt against card statement.");
    const events = await eventRepository.list({ tenantId, limit: 100 });
    expect(events.some((event) => event.topic === "expense.updated" && event.payload.lifecycleAction === "comment_created")).toBe(true);

    const invalid = await app.inject({
      method: "POST",
      url: `/expenses/${expense.id}/comments`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { body: " " }
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: "/expenses/missing/comments",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(missing.statusCode).toBe(404);
  });

  it("splits an expense into balanced child expenses and archives the source", async () => {
    const source = await createManualExpense("Split candidate", "10000", {
      merchantName: "Team Store",
      businessExpense: true
    });
    const split = await app.inject({
      method: "POST",
      url: `/expenses/${source.id}/split`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-split-archive" },
      payload: {
        allocations: [
          { title: "Split candidate - OPS", amountMinor: "6000", projectCode: "OPS", businessExpense: true },
          { title: "Split candidate - FIN", amountMinor: "4000", projectCode: "FIN", businessExpense: true }
        ]
      }
    });

    expect(split.statusCode).toBe(201);
    expect(split.json().sourceExpense.status).toBe("ARCHIVED");
    expect(split.json().expenses).toHaveLength(2);
    expect(split.json().expenses.map((expense: { amountMinor: string }) => expense.amountMinor)).toEqual(["6000", "4000"]);
    expect(split.json().expenses.every((expense: { duplicateGroup: string }) => expense.duplicateGroup === source.id)).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/expenses?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const ids = list.json().expenses.map((expense: { id: string }) => expense.id);
    expect(ids).not.toContain(source.id);
    for (const child of split.json().expenses as Array<{ id: string }>) {
      expect(ids).toContain(child.id);
    }
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.archived&resourceType=Expense&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.archived",
          resourceId: source.id,
          correlationId: "corr-expense-split-archive",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            previousStatus: "DRAFT",
            status: "ARCHIVED",
            reasonPresent: true,
            archivedAtPresent: true,
            lifecycleAction: "split_archived",
            childExpenseCount: 2
          })
        })
      ])
    );
    expect(JSON.stringify(audit.json().logs)).not.toContain("Split into 2 expenses");
    const events = await eventRepository.list({ tenantId, limit: 100 });
    expect(events.some((event) => event.topic === "expense.created" && event.payload.source === "split")).toBe(true);
    expect(events.some((event) => event.topic === "expense.updated" && event.payload.lifecycleAction === "split_archived")).toBe(true);

    const mismatch = await app.inject({
      method: "POST",
      url: `/expenses/${split.json().expenses[0].id}/split`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        allocations: [
          { title: "Bad split A", amountMinor: "100" },
          { title: "Bad split B", amountMinor: "100" }
        ]
      }
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe("EXPENSE_SPLIT_AMOUNT_MISMATCH");
  });

  it("detects repeated subscription-like expenses and persists subscription records", async () => {
    await createManualExpense("Streaming subscription April", "9999", {
      merchantName: "StreamBox",
      occurredAt: "2026-04-01T08:00:00.000Z"
    });
    const latest = await createManualExpense("Streaming subscription May", "9999", {
      merchantName: "StreamBox",
      occurredAt: "2026-05-01T08:00:00.000Z"
    });
    await createManualExpense("Different one-off", "9999", {
      merchantName: "Office Store",
      occurredAt: "2026-05-02T08:00:00.000Z"
    });

    const detected = await app.inject({
      method: "POST",
      url: "/subscriptions/detect?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-subscription-detect" }
    });

    expect(detected.statusCode).toBe(200);
    expect(detected.json().analyzedExpenseCount).toBeGreaterThanOrEqual(3);
    expect(detected.json().subscriptions).toHaveLength(1);
    expect(detected.json().subscriptions[0].name).toBe("StreamBox");
    expect(detected.json().subscriptions[0].amountMinor).toBe("9999");
    expect(detected.json().subscriptions[0].cadence).toBe("monthly");
    expect(detected.json().subscriptions[0].detectedFromExpenseId).toBe(latest.id);

    const listed = await app.inject({
      method: "GET",
      url: "/subscriptions?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().subscriptions.map((subscription: { name: string }) => subscription.name)).toContain("StreamBox");
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.subscription_detected&resourceType=Subscription&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.subscription_detected",
          resourceId: detected.json().subscriptions[0].id,
          correlationId: "corr-expense-subscription-detect",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            detectedFromExpenseId: latest.id,
            cadence: "monthly",
            amountMinor: "9999",
            currency: "TRY",
            nextDueAtPresent: true,
            merchantLinked: true
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("StreamBox");
    expect(serializedAudit).not.toContain("Streaming subscription");
    expect(serializedAudit).not.toContain("Office Store");
    const events = await eventRepository.list({ tenantId, limit: 100 });
    expect(events.some((event) => event.topic === "expense.updated" && event.payload.lifecycleAction === "subscription_detected")).toBe(true);

    const missingWorkspace = await app.inject({
      method: "POST",
      url: "/subscriptions/detect?workspaceId=missing",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(missingWorkspace.statusCode).toBe(404);
  });

  it("creates recurring rules and generates the next persisted expense", async () => {
    const source = await createManualExpense("Recurring office internet", "22000", {
      merchantName: "FiberNet",
      occurredAt: "2026-05-05T09:00:00.000Z"
    });

    const created = await app.inject({
      method: "POST",
      url: `/expenses/${source.id}/recurring`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-recurring-create" },
      payload: { cadence: "monthly", nextDueAt: "2026-06-05T09:00:00.000Z" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().recurringExpense.amountMinor).toBe("22000");
    expect(created.json().recurringExpense.cadence).toBe("monthly");
    expect(created.json().recurringExpense.merchantName).toBe("FiberNet");

    const listed = await app.inject({
      method: "GET",
      url: "/recurring-expenses?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().recurringExpenses.map((rule: { id: string }) => rule.id)).toContain(created.json().recurringExpense.id);

    const generated = await app.inject({
      method: "POST",
      url: `/recurring-expenses/${created.json().recurringExpense.id}/generate`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-recurring-generate" },
      payload: {}
    });
    expect(generated.statusCode).toBe(201);
    expect(generated.json().expense.title).toBe("Recurring: FiberNet");
    expect(generated.json().expense.amountMinor).toBe("22000");
    expect(generated.json().expense.occurredAt).toBe("2026-06-05T09:00:00.000Z");
    expect(generated.json().recurringExpense.nextDueAt).toBe("2026-07-05T09:00:00.000Z");
    const createdAudit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.recurring_created&resourceType=RecurringExpense&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(createdAudit.statusCode).toBe(200);
    expect(createdAudit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.recurring_created",
          resourceId: created.json().recurringExpense.id,
          correlationId: "corr-expense-recurring-create",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            sourceExpenseId: source.id,
            cadence: "monthly",
            amountMinor: "22000",
            currency: "TRY",
            nextDueAtPresent: true,
            merchantLinked: true
          })
        })
      ])
    );
    const generatedAudit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.recurring_generated&resourceType=Expense&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(generatedAudit.statusCode).toBe(200);
    expect(generatedAudit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.recurring_generated",
          resourceId: generated.json().expense.id,
          correlationId: "corr-expense-recurring-generate",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            recurringExpenseId: created.json().recurringExpense.id,
            generatedExpenseId: generated.json().expense.id,
            cadence: "monthly",
            amountMinor: "22000",
            currency: "TRY",
            previousNextDueAtPresent: true,
            nextDueAtPresent: true,
            merchantLinked: true
          })
        })
      ])
    );
    const serializedAudit = `${JSON.stringify(createdAudit.json().logs)} ${JSON.stringify(generatedAudit.json().logs)}`;
    expect(serializedAudit).not.toContain("FiberNet");
    expect(serializedAudit).not.toContain("Recurring office internet");
    expect(serializedAudit).not.toContain("Recurring: FiberNet");
    const events = await eventRepository.list({ tenantId, limit: 100 });
    expect(events.some((event) => event.topic === "expense.updated" && event.payload.lifecycleAction === "recurring_created")).toBe(true);
    expect(events.some((event) => event.topic === "expense.created" && event.payload.source === "recurring")).toBe(true);

    const missing = await app.inject({
      method: "POST",
      url: "/recurring-expenses/missing/generate",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {}
    });
    expect(missing.statusCode).toBe(404);
  });

  it("approves and rejects expenses with approval workflow persistence", async () => {
    const first = await createManualExpense("Approval candidate", "4200");
    const pendingSla = await app.inject({
      method: "GET",
      url: "/approvals/sla?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(pendingSla.statusCode).toBe(200);
    expect(
      pendingSla
        .json()
        .items.some(
          (item: { expense: { id: string }; workflow: { state: string; slaHours: number }; slaStatus: string; slaDueAt: string | null }) =>
            item.expense.id === first.id &&
            item.workflow.state === "PENDING" &&
            item.workflow.slaHours === 48 &&
            item.slaStatus === "ON_TRACK" &&
            item.slaDueAt !== null
        )
    ).toBe(true);
    const approved = await app.inject({
      method: "POST",
      url: `/expenses/${first.id}/approve`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-approve" },
      payload: { reason: "Policy checked" }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().expense.status).toBe("APPROVED");
    expect(approved.json().approvalWorkflow.state).toBe("APPROVED");
    expect(approved.json().approvalWorkflow.slaStatus).toBe("MET_ON_TIME");
    expect(approved.json().approvalWorkflow.slaDueAt).toEqual(expect.any(String));

    const second = await createManualExpense("Reject candidate", "9900");
    const rejected = await app.inject({
      method: "POST",
      url: `/expenses/${second.id}/reject`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-reject" },
      payload: { reason: "Missing receipt" }
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().expense.status).toBe("REJECTED");
    expect(rejected.json().approvalWorkflow.policySnapshot.reason).toBe("Missing receipt");
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?resourceType=Expense&limit=40",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.approved",
          resourceId: first.id,
          correlationId: "corr-expense-approve",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            previousStatus: "DRAFT",
            status: "APPROVED",
            reasonPresent: true,
            approvalWorkflowId: approved.json().approvalWorkflow.id,
            slaStatus: "MET_ON_TIME",
            policyViolationCount: 0
          })
        }),
        expect.objectContaining({
          action: "expense.rejected",
          resourceId: second.id,
          correlationId: "corr-expense-reject",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            previousStatus: "DRAFT",
            status: "REJECTED",
            reasonPresent: true,
            approvalWorkflowId: rejected.json().approvalWorkflow.id,
            slaStatus: expect.any(String),
            policyViolationCount: 0
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("Policy checked");
    expect(serializedAudit).not.toContain("Missing receipt");
    const events = await eventRepository.list({ tenantId, limit: 50 });
    expect(events.map((event) => event.topic)).toEqual(
      expect.arrayContaining(["expense.created", "expense.approved", "expense.rejected"])
    );

    const missing = await app.inject({
      method: "POST",
      url: "/expenses/missing/approve",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {}
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("EXPENSE_NOT_FOUND");
  });

  it("caches approval SLA dashboard reads until expense mutations bump the workspace cache version", async () => {
    const candidate = await createManualExpense("Cached approval candidate", "5550");
    const cachePrefix = `dashboard:${tenantId}:approval-sla:workspace_1:`;
    const listCountBefore = expenseRepository.listApprovalSlaCount;

    const first = await app.inject({
      method: "GET",
      url: "/approvals/sla?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items.some((item: { expense: { id: string } }) => item.expense.id === candidate.id)).toBe(true);
    expect(await cacheStore.listKeys(cachePrefix, 20)).not.toHaveLength(0);
    expect(expenseRepository.listApprovalSlaCount).toBe(listCountBefore + 1);

    const cached = await app.inject({
      method: "GET",
      url: "/approvals/sla?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.json().items.length).toBe(first.json().items.length);
    expect(expenseRepository.listApprovalSlaCount).toBe(listCountBefore + 1);

    const approved = await app.inject({
      method: "POST",
      url: `/expenses/${candidate.id}/approve`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reason: "Refresh dashboard cache" }
    });
    expect(approved.statusCode).toBe(200);

    const refreshed = await app.inject({
      method: "GET",
      url: "/approvals/sla?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(refreshed.statusCode).toBe(200);
    expect(expenseRepository.listApprovalSlaCount).toBe(listCountBefore + 2);
    expect(
      refreshed.json().items.find((item: { expense: { id: string }; workflow: { state: string } }) => item.expense.id === candidate.id).workflow.state
    ).toBe("APPROVED");
  });

  it("creates, reviews and pays reimbursement claims from reimbursable expenses", async () => {
    const taxi = await createManualExpense("Reimbursable taxi", "8750", { merchantName: "City Taxi", reimbursable: true });
    const hotel = await createManualExpense("Reimbursable hotel", "12500", { merchantName: "Ankara Hotel", reimbursable: true });

    const created = await app.inject({
      method: "POST",
      url: "/reimbursement-claims",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-reimbursement-submit" },
      payload: {
        workspaceId: "workspace_1",
        expenseIds: [taxi.id, hotel.id]
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().reimbursementClaim.status).toBe("NEEDS_REVIEW");
    expect(created.json().reimbursementClaim.totalMinor).toBe("21250");
    expect(created.json().items).toHaveLength(2);

    const duplicate = await app.inject({
      method: "POST",
      url: "/reimbursement-claims",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        expenseIds: [taxi.id]
      }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("EXPENSE_ALREADY_CLAIMED");

    const claims = await app.inject({
      method: "GET",
      url: "/reimbursement-claims?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(claims.statusCode).toBe(200);
    expect(claims.json().reimbursementClaims.some((entry: { claim: { id: string } }) => entry.claim.id === created.json().reimbursementClaim.id)).toBe(true);

    const approved = await app.inject({
      method: "POST",
      url: `/reimbursement-claims/${created.json().reimbursementClaim.id}/approve`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-reimbursement-approve" },
      payload: { reason: "Receipts checked" }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().reimbursementClaim.status).toBe("APPROVED");

    const paid = await app.inject({
      method: "POST",
      url: `/reimbursement-claims/${created.json().reimbursementClaim.id}/mark-paid`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-reimbursement-paid" },
      payload: { reason: "Paid by bank batch" }
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().reimbursementClaim.status).toBe("REIMBURSED");
    expect(paid.json().reimbursementClaim.paidAt).toEqual(expect.any(String));
    expect(paid.json().expenses.every((expense: { status: string }) => expense.status === "REIMBURSED")).toBe(true);

    const nonReimbursable = await createManualExpense("Personal meal", "3400", { reimbursable: false });
    const rejectedInput = await app.inject({
      method: "POST",
      url: "/reimbursement-claims",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        expenseIds: [nonReimbursable.id]
      }
    });
    expect(rejectedInput.statusCode).toBe(422);
    expect(rejectedInput.json().error.code).toBe("EXPENSE_NOT_REIMBURSABLE");

    const rejectCandidate = await createManualExpense("Reimbursement reject candidate", "5600", { reimbursable: true });
    const rejectClaim = await app.inject({
      method: "POST",
      url: "/reimbursement-claims",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-reimbursement-reject-submit" },
      payload: {
        workspaceId: "workspace_1",
        expenseIds: [rejectCandidate.id]
      }
    });
    const rejectedClaim = await app.inject({
      method: "POST",
      url: `/reimbursement-claims/${rejectClaim.json().reimbursementClaim.id}/reject`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-reimbursement-reject" },
      payload: { reason: "Outside policy" }
    });
    expect(rejectedClaim.statusCode).toBe(200);
    expect(rejectedClaim.json().reimbursementClaim.status).toBe("REJECTED");

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?resourceType=ReimbursementClaim&limit=30",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.reimbursement_submitted",
          resourceId: created.json().reimbursementClaim.id,
          correlationId: "corr-reimbursement-submit",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            status: "NEEDS_REVIEW",
            expenseCount: 2,
            totalMinor: "21250",
            currency: "TRY"
          })
        }),
        expect.objectContaining({
          action: "expense.reimbursement_decision",
          resourceId: created.json().reimbursementClaim.id,
          correlationId: "corr-reimbursement-approve",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            previousStatus: "NEEDS_REVIEW",
            status: "APPROVED",
            reasonPresent: true,
            expenseCount: 2,
            reimbursedExpenseCount: 0,
            paidAtPresent: false
          })
        }),
        expect.objectContaining({
          action: "expense.reimbursement_paid",
          resourceId: created.json().reimbursementClaim.id,
          correlationId: "corr-reimbursement-paid",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            previousStatus: "APPROVED",
            status: "REIMBURSED",
            reasonPresent: true,
            expenseCount: 2,
            reimbursedExpenseCount: 2,
            paidAtPresent: true
          })
        }),
        expect.objectContaining({
          action: "expense.reimbursement_decision",
          resourceId: rejectClaim.json().reimbursementClaim.id,
          correlationId: "corr-reimbursement-reject",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            previousStatus: "NEEDS_REVIEW",
            status: "REJECTED",
            reasonPresent: true,
            expenseCount: 1,
            reimbursedExpenseCount: 0,
            paidAtPresent: false
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("Receipts checked");
    expect(serializedAudit).not.toContain("Paid by bank batch");
    expect(serializedAudit).not.toContain("Outside policy");
    expect(serializedAudit).not.toContain("City Taxi");
    expect(serializedAudit).not.toContain("Ankara Hotel");
    const events = await eventRepository.list({ tenantId, limit: 200 });
    expect(events.some((event) => event.topic === "expense.updated" && event.payload.lifecycleAction === "reimbursement_submitted")).toBe(true);
    expect(events.some((event) => event.topic === "expense.updated" && event.payload.lifecycleAction === "reimbursement_approved")).toBe(true);
    expect(events.some((event) => event.topic === "expense.updated" && event.payload.lifecycleAction === "reimbursement_paid")).toBe(true);
  });

  it("persists expense policy rules, evaluates violations and blocks approval when configured", async () => {
    const receiptPolicy = await app.inject({
      method: "POST",
      url: "/expense-policies",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-policy-create-block" },
      payload: {
        workspaceId: "workspace_1",
        name: "Receipt above 100 TRY",
        ruleType: "RECEIPT_REQUIRED_ABOVE",
        severity: "block",
        config: { thresholdMinor: "10000" }
      }
    });
    expect(receiptPolicy.statusCode).toBe(201);
    expect(receiptPolicy.json().expensePolicy.ruleType).toBe("RECEIPT_REQUIRED_ABOVE");

    const policyList = await app.inject({
      method: "GET",
      url: "/expense-policies?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(policyList.statusCode).toBe(200);
    expect(policyList.json().expensePolicies.some((policy: { id: string }) => policy.id === receiptPolicy.json().expensePolicy.id)).toBe(true);

    const missingReceipt = await createManualExpense("Policy missing receipt", "15000");
    const evaluation = await app.inject({
      method: "GET",
      url: `/expenses/${missingReceipt.id}/policy-evaluation`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(evaluation.statusCode).toBe(200);
    expect(evaluation.json().evaluation.violations.map((violation: { code: string }) => violation.code)).toContain("RECEIPT_REQUIRED");

    const blockedApproval = await app.inject({
      method: "POST",
      url: `/expenses/${missingReceipt.id}/approve`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reason: "Should fail policy" }
    });
    expect(blockedApproval.statusCode).toBe(422);
    expect(blockedApproval.json().error.code).toBe("EXPENSE_POLICY_BLOCKED");

    const archivedPolicy = await app.inject({
      method: "DELETE",
      url: `/expense-policies/${receiptPolicy.json().expensePolicy.id}`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-policy-archive" }
    });
    expect(archivedPolicy.statusCode).toBe(200);
    expect(archivedPolicy.json().expensePolicy.active).toBe(false);

    const projectPolicy = await app.inject({
      method: "POST",
      url: "/expense-policies",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-policy-create-warning" },
      payload: {
        workspaceId: "workspace_1",
        name: "Business project required",
        ruleType: "PROJECT_REQUIRED",
        severity: "warning",
        config: { onlyBusiness: true }
      }
    });
    expect(projectPolicy.statusCode).toBe(201);

    const warningCandidate = await createManualExpense("Policy warning candidate", "2500", { businessExpense: true });
    const approved = await app.inject({
      method: "POST",
      url: `/expenses/${warningCandidate.id}/approve`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reason: "Warning accepted" }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().approvalWorkflow.policySnapshot.policyEvaluation.violations[0].code).toBe("PROJECT_REQUIRED");
    expect(approved.json().approvalWorkflow.policySnapshot.policyEvaluation.violations[0].severity).toBe("warning");

    const createdAudit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.policy.created&resourceType=ExpensePolicy&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(createdAudit.statusCode).toBe(200);
    expect(createdAudit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.policy.created",
          resourceId: receiptPolicy.json().expensePolicy.id,
          correlationId: "corr-expense-policy-create-block",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            ruleType: "RECEIPT_REQUIRED_ABOVE",
            severity: "block",
            active: true,
            configPresent: true
          })
        }),
        expect.objectContaining({
          action: "expense.policy.created",
          resourceId: projectPolicy.json().expensePolicy.id,
          correlationId: "corr-expense-policy-create-warning",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            ruleType: "PROJECT_REQUIRED",
            severity: "warning",
            active: true,
            configPresent: true
          })
        })
      ])
    );
    const archivedAudit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.policy.archived&resourceType=ExpensePolicy&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(archivedAudit.statusCode).toBe(200);
    expect(archivedAudit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.policy.archived",
          resourceId: receiptPolicy.json().expensePolicy.id,
          correlationId: "corr-expense-policy-archive",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            ruleType: "RECEIPT_REQUIRED_ABOVE",
            severity: "block",
            active: false
          })
        })
      ])
    );
    const serializedAudit = `${JSON.stringify(createdAudit.json().logs)} ${JSON.stringify(archivedAudit.json().logs)}`;
    expect(serializedAudit).not.toContain("Receipt above 100 TRY");
    expect(serializedAudit).not.toContain("Business project required");
    expect(serializedAudit).not.toContain("thresholdMinor");
    expect(serializedAudit).not.toContain("onlyBusiness");
    const events = await eventRepository.list({ tenantId, limit: 200 });
    expect(events.some((event) => event.topic === "expense.updated" && event.payload.lifecycleAction === "policy_created")).toBe(true);
    expect(events.some((event) => event.topic === "expense.approved" && event.payload.policyViolationCount === 1)).toBe(true);
  });

  it("archives expenses, removes them from active lists and records audit/outbox evidence", async () => {
    const expense = await createManualExpense("Archive candidate", "6400");
    const archived = await app.inject({
      method: "POST",
      url: `/expenses/${expense.id}/archive`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-archive" },
      payload: { reason: "No longer needed" }
    });

    expect(archived.statusCode).toBe(200);
    expect(archived.json().expense.status).toBe("ARCHIVED");
    expect(archived.json().expense.archivedAt).toEqual(expect.any(String));

    const list = await app.inject({
      method: "GET",
      url: "/expenses?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.json().expenses.some((item: { id: string }) => item.id === expense.id)).toBe(false);
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.archived&resourceType=Expense&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.archived",
          resourceId: expense.id,
          correlationId: "corr-expense-archive",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            previousStatus: "DRAFT",
            status: "ARCHIVED",
            reasonPresent: true,
            archivedAtPresent: true
          })
        })
      ])
    );
    expect(JSON.stringify(audit.json().logs)).not.toContain("No longer needed");
    const events = await eventRepository.list({ tenantId, limit: 100 });
    expect(events.some((event) => event.topic === "expense.updated" && event.aggregateId === expense.id)).toBe(true);

    const secondArchive = await app.inject({
      method: "POST",
      url: `/expenses/${expense.id}/archive`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {}
    });
    expect(secondArchive.statusCode).toBe(404);
  });

  it("returns local category prediction and anomaly reasons for persisted expenses", async () => {
    await createManualExpense("Market peer", "10000", { merchantName: "Mavi Market" });
    await createManualExpense("Taxi peer", "15000", { merchantName: "City Taxi" });
    await createManualExpense("Cafe peer", "20000", { merchantName: "Office Cafe" });
    await createManualExpense("Courier peer", "12000", { merchantName: "Aras Kargo" });
    await createManualExpense("Stationery peer", "18000", { merchantName: "Ofis Kirtasiye" });
    const candidate = await createManualExpense("Shell motorin weekend", "500000", {
      merchantName: "Shell",
      businessExpense: true,
      occurredAt: "2026-05-16T10:00:00.000Z"
    });

    const preview = await app.inject({
      method: "GET",
      url: `/expenses/${candidate.id}/ai-analysis`,
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json().cacheHit).toBe(false);
    expect(preview.json().persistedPrediction).toBeNull();
    expect(expenseRepository.categoryPredictions).toHaveLength(0);
    const categoryCacheKeys = await cacheStore.listKeys(`model-inference:${tenantId}:expense-category:${candidate.id}:`, 10);
    expect(categoryCacheKeys).toHaveLength(1);

    const response = await app.inject({
      method: "POST",
      url: `/expenses/${candidate.id}/ai-analysis`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-expense-category-predicted" }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.cacheHit).toBe(true);
    expect(body.model.externalServicesUsed).toBe(false);
    expect(body.prediction.categoryKey).toBe("akaryakit");
    expect(body.prediction.matchedKeywords).toContain("shell");
    expect(body.persistedPrediction.id).toEqual(expect.any(String));
    expect(body.persistedPrediction.expenseId).toBe(candidate.id);
    expect(body.persistedPrediction.categoryId).toEqual(expect.any(String));
    expect(body.persistedPrediction.confidence).toBe("0.7600");
    expect(body.anomalies.map((anomaly: { code: string }) => anomaly.code)).toEqual(
      expect.arrayContaining(["UNUSUALLY_HIGH_AMOUNT", "WEEKEND_BUSINESS_EXPENSE"])
    );
    expect(expenseRepository.categoryPredictions).toHaveLength(1);
    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=expense.category_predicted&resourceType=Expense&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "expense.category_predicted",
          resourceId: candidate.id,
          correlationId: "corr-expense-category-predicted",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            predictionId: body.persistedPrediction.id,
            categoryId: body.persistedPrediction.categoryId,
            categoryKey: "akaryakit",
            confidence: "0.7600",
            modelName: body.model.name,
            modelVersion: "category-rules-v1",
            externalServicesUsed: false,
            anomalyCount: body.anomalies.length,
            cacheHit: true
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("Shell");
    expect(serializedAudit).not.toContain("shell");
    expect(serializedAudit).not.toContain("matchedKeywords");
    expect(serializedAudit).not.toContain("UNUSUALLY_HIGH_AMOUNT");
    expect(serializedAudit).not.toContain("WEEKEND_BUSINESS_EXPENSE");

    const list = await app.inject({
      method: "GET",
      url: "/expenses?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const updatedCandidate = list.json().expenses.find((expense: { id: string }) => expense.id === candidate.id);
    expect(updatedCandidate.categoryId).toBe(body.persistedPrediction.categoryId);

    const missing = await app.inject({
      method: "GET",
      url: "/expenses/missing/ai-analysis",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("EXPENSE_NOT_FOUND");
  });

  async function createManualExpense(
    title: string,
    amountMinor: string,
    overrides: Partial<{
      merchantName: string;
      businessExpense: boolean;
      reimbursable: boolean;
      occurredAt: string;
    }> = {}
  ): Promise<{ id: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/expenses",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        title,
        currency: "TRY",
        amountMinor,
        occurredAt: overrides.occurredAt ?? "2026-05-12T10:00:00.000Z",
        ...(overrides.merchantName ? { merchantName: overrides.merchantName } : {}),
        ...(overrides.businessExpense !== undefined ? { businessExpense: overrides.businessExpense } : {}),
        ...(overrides.reimbursable !== undefined ? { reimbursable: overrides.reimbursable } : {})
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json().expense;
  }
});

class CountingExpenseRepository extends InMemoryExpenseRepository {
  public listApprovalSlaCount = 0;

  override async listApprovalSla(input: { tenantId: string; workspaceId: string; now?: Date }): Promise<ApprovalSlaItem[]> {
    this.listApprovalSlaCount += 1;
    return super.listApprovalSla(input);
  }
}

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
