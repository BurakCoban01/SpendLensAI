import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuditRepository } from "../audit/memory-repository";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { InMemoryDocumentRepository } from "../documents/memory-repository";
import { InMemoryDocumentStorage } from "../documents/storage";
import { InMemoryExpenseRepository } from "../expenses/memory-repository";
import { InMemoryModelRepository } from "../models/memory-repository";
import { InMemoryReviewRepository } from "../review/memory-repository";
import { InMemoryReportRepository } from "./memory-repository";

describe("report export routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let tenantId: string;
  let documentRepository: InMemoryDocumentRepository;
  let storage: InMemoryDocumentStorage;
  let modelRepository: InMemoryModelRepository;
  let auditRepository: InMemoryAuditRepository;
  let reviewRepository: InMemoryReviewRepository;

  beforeAll(async () => {
    documentRepository = new InMemoryDocumentRepository();
    storage = new InMemoryDocumentStorage();
    modelRepository = new InMemoryModelRepository();
    auditRepository = new InMemoryAuditRepository();
    reviewRepository = new InMemoryReviewRepository();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      documentRepository,
      documentStorage: storage,
      expenseRepository: new InMemoryExpenseRepository(),
      reportRepository: new InMemoryReportRepository(),
      modelRepository,
      auditRepository,
      reviewRepository
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Report Tenant",
        tenantSlug: "report",
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

    await createExpense("Market", "A Market", "45000", "2026-05-12T10:00:00.000Z");
    await createExpense("Formula merchant", "=CMD()", "12500", "2026-05-13T10:00:00.000Z");
    await createExpense("Old month", "Old Merchant", "90000", "2026-04-12T10:00:00.000Z");
  });

  afterAll(async () => {
    await app.close();
  });

  it("generates a persisted monthly merchant CSV export with protected CSV cells", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/reports/exports",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-report-export" },
      payload: {
        workspaceId: "workspace_1",
        type: "merchant_spend_csv",
        month: "2026-05"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.exportJob.status).toBe("SUCCEEDED");
    expect(body.exportJob.objectKey).toContain("/reports/");
    expect(body.signedUrl).toContain("memory://");

    const stored = storage.readObject(body.exportJob.bucket, body.exportJob.objectKey);
    expect(stored).not.toBeNull();
    const csv = stored?.toString("utf8") ?? "";
    expect(csv).toContain("merchant,currency,expense_count,total_minor,tax_minor");
    expect(csv).toContain("A Market,TRY,1,45000,0");
    expect(csv).toContain("'=CMD(),TRY,1,12500,0");
    expect(csv).not.toContain("Old Merchant");

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=report.generated&resourceType=ExportJob&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const reportLog = audit.json().logs.find((log: { resourceId: string }) => log.resourceId === body.exportJob.id);
    expect(reportLog).toMatchObject({
      action: "report.generated",
      resourceType: "ExportJob",
      resourceId: body.exportJob.id,
      actorUserId: expect.any(String),
      correlationId: "corr-report-export",
      metadata: {
        workspaceId: "workspace_1",
        reportType: "merchant_spend_csv",
        contentType: "text/csv",
        filename: "merchant_spend_csv-workspace_1-2026-05.csv",
        month: "2026-05",
        sizeBytes: expect.any(Number)
      }
    });
    const serializedAudit = JSON.stringify(reportLog);
    expect(serializedAudit).not.toContain(body.exportJob.objectKey);
    expect(serializedAudit).not.toContain(body.signedUrl);
    expect(serializedAudit).not.toContain("A Market");
    expect(serializedAudit).not.toContain("=CMD()");
  });

  it("generates a persisted monthly expense PDF report from real expenses", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/reports/exports",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        type: "monthly_expense_report_pdf",
        month: "2026-05"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.contentType).toBe("application/pdf");
    expect(body.filename).toContain("monthly_expense_report_pdf-workspace_1-2026-05.pdf");
    expect(body.exportJob.type).toBe("monthly_expense_report_pdf");
    expect(body.exportJob.status).toBe("SUCCEEDED");

    const stored = storage.readObject(body.exportJob.bucket, body.exportJob.objectKey);
    expect(stored).not.toBeNull();
    expect(stored?.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    const pdfText = stored?.toString("latin1") ?? "";
    expect(pdfText).toContain("SpendLens AI Monthly Expense Report");
    expect(pdfText).toContain(asPdfHex("A Mar"));
    expect(pdfText).not.toContain(asPdfHex("Old Merchant"));
  });

  it("generates a persisted reimbursement batch CSV from approved and paid claims", async () => {
    const reimbursable = await createExpense("Taxi payout", "Taxi Co", "8800", "2026-05-14T10:00:00.000Z", true);
    const claim = await app.inject({
      method: "POST",
      url: "/reimbursement-claims",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        expenseIds: [reimbursable.id]
      }
    });
    expect(claim.statusCode).toBe(201);
    const approved = await app.inject({
      method: "POST",
      url: `/reimbursement-claims/${claim.json().reimbursementClaim.id}/approve`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reason: "Finance batch export" }
    });
    expect(approved.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/reports/exports",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        type: "reimbursement_batch_csv",
        month: "2026-05"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.contentType).toBe("text/csv");
    expect(body.filename).toContain("reimbursement_batch_csv-workspace_1-2026-05.csv");
    expect(body.exportJob.type).toBe("reimbursement_batch_csv");
    const stored = storage.readObject(body.exportJob.bucket, body.exportJob.objectKey);
    const csv = stored?.toString("utf8") ?? "";
    expect(csv).toContain("claim_id,claim_status,claimant_id,submitted_at,paid_at,claim_total_minor,currency,expense_id");
    expect(csv).toContain(`${claim.json().reimbursementClaim.id},APPROVED`);
    expect(csv).toContain("Taxi payout,Taxi Co,DRAFT,8800");
  });

  it("generates a persisted reimbursement claim PDF from approved and paid claims", async () => {
    const reimbursable = await createExpense("Airport taxi payout", "Airport Taxi", "12300", "2026-05-16T10:00:00.000Z", true);
    const claim = await app.inject({
      method: "POST",
      url: "/reimbursement-claims",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        expenseIds: [reimbursable.id]
      }
    });
    expect(claim.statusCode).toBe(201);
    const approved = await app.inject({
      method: "POST",
      url: `/reimbursement-claims/${claim.json().reimbursementClaim.id}/approve`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reason: "PDF reimbursement export" }
    });
    expect(approved.statusCode).toBe(200);
    const paid = await app.inject({
      method: "POST",
      url: `/reimbursement-claims/${claim.json().reimbursementClaim.id}/mark-paid`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reason: "Paid for PDF export" }
    });
    expect(paid.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/reports/exports",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        type: "reimbursement_claim_report_pdf",
        month: "2026-05"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.contentType).toBe("application/pdf");
    expect(body.filename).toContain("reimbursement_claim_report_pdf-workspace_1-2026-05.pdf");
    expect(body.exportJob.type).toBe("reimbursement_claim_report_pdf");
    expect(body.exportJob.status).toBe("SUCCEEDED");

    const stored = storage.readObject(body.exportJob.bucket, body.exportJob.objectKey);
    expect(stored).not.toBeNull();
    expect(stored?.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    const pdfText = stored?.toString("latin1") ?? "";
    expect(pdfText).toContain("SpendLens AI Reimbursement Claim Report");
    expect(pdfText).toContain(asPdfHex("123.00"));
    expect(pdfText).toContain(asPdfHex("REIMB"));
    expect(pdfText).toContain(asPdfHex("URSED"));
  });

  it("generates a persisted approval evidence CSV for accountant and auditor review", async () => {
    const approvable = await createExpense("Client dinner approval", "Dinner Co", "64000", "2026-05-18T10:00:00.000Z", true);
    const approved = await app.inject({
      method: "POST",
      url: `/expenses/${approvable.id}/approve`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reason: "Accountant evidence approved" }
    });
    expect(approved.statusCode).toBe(200);
    const claim = await app.inject({
      method: "POST",
      url: "/reimbursement-claims",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        expenseIds: [approvable.id]
      }
    });
    expect(claim.statusCode).toBe(201);
    const claimApproval = await app.inject({
      method: "POST",
      url: `/reimbursement-claims/${claim.json().reimbursementClaim.id}/approve`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reason: "Approval evidence claim" }
    });
    expect(claimApproval.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/reports/exports",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        type: "approval_evidence_csv",
        month: "2026-05"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.contentType).toBe("text/csv");
    expect(body.filename).toContain("approval_evidence_csv-workspace_1-2026-05.csv");
    expect(body.exportJob.type).toBe("approval_evidence_csv");
    const stored = storage.readObject(body.exportJob.bucket, body.exportJob.objectKey);
    const csv = stored?.toString("utf8") ?? "";
    expect(csv).toContain("expense_id,expense_title,expense_status,occurred_at,currency,amount_minor");
    expect(csv).toContain(`${approvable.id},Client dinner approval,APPROVED`);
    expect(csv).toContain("Accountant evidence approved");
    expect(csv).toContain(`${claim.json().reimbursementClaim.id},APPROVED`);
  });

  it("generates a persisted OCR quality CSV from real OCR comparison runs", async () => {
    const uploaded = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("ocr-quality-boundary")
      },
      payload: multipartBody("ocr-quality-boundary", "ocr-quality.png", "image/png", pngBytes())
    });
    expect(uploaded.statusCode).toBe(201);
    const documentId = uploaded.json().document.id;

    const compare = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/ocr-runs/compare`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        groundTruthText: "A Market\nTOPLAM 100,00 TL",
        runs: [
          {
            engine: "TESSERACT",
            text: "A Market\nTOPLAM 100,00 TL",
            confidence: 0.91,
            latencyMs: 120
          },
          {
            engine: "CUSTOM_CRNN",
            text: "A Market\nTOPLAM 95,00 TL",
            confidence: 0.75,
            latencyMs: 220
          }
        ]
      }
    });
    expect(compare.statusCode).toBe(201);

    const response = await app.inject({
      method: "POST",
      url: "/reports/exports",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        type: "ocr_quality_report_csv"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.contentType).toBe("text/csv");
    expect(body.filename).toContain("ocr_quality_report_csv-workspace_1.csv");
    expect(body.exportJob.type).toBe("ocr_quality_report_csv");

    const stored = storage.readObject(body.exportJob.bucket, body.exportJob.objectKey);
    const csv = stored?.toString("utf8") ?? "";
    expect(csv).toContain("document_id,document_kind,document_name,ocr_job_id,job_status");
    expect(csv).toContain("ocr-quality.png");
    expect(csv).toContain("TESSERACT,SUCCEEDED,0.9100,120");
    expect(csv).toContain("CUSTOM_CRNN,SUCCEEDED,0.7500,220");
    expect(csv).toContain("ENSEMBLE,SUCCEEDED");
    expect(csv).toContain("TESSERACT,0.8300,0.0000,0.0000,0.0000");
    expect(csv).toContain("total");
  });

  it("generates a persisted model evaluation CSV from registry metrics", async () => {
    const modelVersion = await modelRepository.createModelVersion({
      tenantId,
      name: "category-ml-v1-seed-42",
      engine: "CATEGORY_ML",
      status: "CANDIDATE",
      artifactBucket: "local-artifacts",
      artifactKey: "artifacts/models/category/42/model.joblib",
      metrics: { accuracy: 0.875 }
    });
    const trainingRun = await modelRepository.createTrainingRun({
      tenantId,
      profile: "category-smoke",
      seed: 42
    });
    await modelRepository.completeTrainingRun({
      tenantId,
      trainingRunId: trainingRun.id,
      modelVersionId: modelVersion.id,
      metrics: { accuracy: 0.875, macro_f1: 0.86 },
      logsKey: "artifacts/models/category/42/train.log"
    });
    const evaluationRun = await modelRepository.createEvaluationRun({
      tenantId,
      modelVersionId: modelVersion.id,
      reportKey: "artifacts/models/category/42/metrics.json",
      metrics: {
        accuracy: 0.875,
        macro_f1: 0.86,
        confusion_matrix: [
          [3, 1],
          [0, 4]
        ],
        accuracy_note: "Synthetic smoke dataset only."
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/reports/exports",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        type: "model_evaluation_report_csv"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.contentType).toBe("text/csv");
    expect(body.filename).toContain("model_evaluation_report_csv-workspace_1.csv");
    expect(body.exportJob.type).toBe("model_evaluation_report_csv");

    const stored = storage.readObject(body.exportJob.bucket, body.exportJob.objectKey);
    const csv = stored?.toString("utf8") ?? "";
    expect(csv).toContain("model_version_id,model_name,engine,model_status,artifact_key");
    expect(csv).toContain(`${modelVersion.id},category-ml-v1-seed-42,CATEGORY_ML,CANDIDATE`);
    expect(csv).toContain(`${evaluationRun.id},SUCCEEDED`);
    expect(csv).toContain("0.8750,0.8600");
    expect(csv).toContain('"[[3,1],[0,4]]"');
    expect(csv).toContain("Synthetic smoke dataset only.");
  });

  it("generates a persisted audit pack CSV from expenses and audit logs", async () => {
    const expense = await createExpense("Audit taxi", "Audit Cab", "3400", "2026-05-15T10:00:00.000Z", true);
    await auditRepository.create({
      tenantId,
      actorUserId: "auditor_1",
      action: "expense.approved",
      resourceType: "Expense",
      resourceId: expense.id,
      metadata: { workspaceId: "workspace_1", reason: "Audit export evidence" },
      correlationId: "corr-audit-pack"
    });

    const response = await app.inject({
      method: "POST",
      url: "/reports/exports",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        type: "audit_pack_csv",
        month: "2026-05"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.contentType).toBe("text/csv");
    expect(body.filename).toContain("audit_pack_csv-workspace_1-2026-05.csv");
    expect(body.exportJob.type).toBe("audit_pack_csv");

    const stored = storage.readObject(body.exportJob.bucket, body.exportJob.objectKey);
    const csv = stored?.toString("utf8") ?? "";
    expect(csv).toContain("row_type,workspace_id,resource_type,resource_id,event_at");
    expect(csv).toContain(`expense,workspace_1,Expense,${expense.id}`);
    expect(csv).toContain("Audit taxi,Audit Cab,3400,TRY");
    expect(csv).toContain(`audit_event,workspace_1,Expense,${expense.id}`);
    expect(csv).toContain("expense.approved");
    expect(csv).toContain("corr-audit-pack");
    expect(csv).toContain("Audit export evidence");
  });

  it("generates a persisted dataset JSONL export from documents and annotations", async () => {
    const uploaded = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("dataset-export-boundary")
      },
      payload: multipartBody("dataset-export-boundary", "dataset-receipt.png", "image/png", Buffer.concat([pngBytes(), Buffer.from([0x42])]))
    });
    expect(uploaded.statusCode).toBe(201);
    const documentId = uploaded.json().document.id;

    const correction = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/corrections`,
      headers: { authorization: `Bearer ${accessToken}` },
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

    const response = await app.inject({
      method: "POST",
      url: "/reports/exports",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        type: "dataset_export_jsonl"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.contentType).toBe("application/x-ndjson");
    expect(body.filename).toContain("dataset_export_jsonl-workspace_1.jsonl");
    expect(body.exportJob.type).toBe("dataset_export_jsonl");

    const stored = storage.readObject(body.exportJob.bucket, body.exportJob.objectKey);
    const lines = (stored?.toString("utf8") ?? "").trim().split("\n").filter(Boolean);
    const datasetLine = lines.map((line) => JSON.parse(line)).find((line) => line.document.id === documentId);
    expect(datasetLine).toBeTruthy();
    expect(datasetLine.document.safeName).toBe("dataset-receipt.png");
    expect(datasetLine.document.objectKey).toContain("/documents/");
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
  });

  it("lists persisted export jobs for a workspace", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/reports/exports?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().exportJobs.length).toBeGreaterThanOrEqual(2);
    expect(response.json().exportJobs[0].workspaceId).toBe("workspace_1");
  });

  it("rejects report exports for missing workspaces", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/reports/exports",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "missing",
        type: "expense_ledger_csv"
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  async function createExpense(title: string, merchantName: string, amountMinor: string, occurredAt: string, reimbursable = false) {
    const response = await app.inject({
      method: "POST",
      url: "/expenses",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        title,
        merchantName,
        currency: "TRY",
        amountMinor,
        occurredAt,
        reimbursable,
        businessExpense: reimbursable
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json().expense;
  }
});

function asPdfHex(value: string): string {
  return Buffer.from(value, "ascii").toString("hex");
}

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
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
