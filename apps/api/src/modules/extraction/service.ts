import type { OCREngineCode } from "@prisma/client";
import {
  extractReceiptFieldsFromText,
  validateExtraction,
  type ExtractedReceiptFields,
  type ExtractedFieldEvidence,
  type ExtractedReceiptLineItem
} from "@spendlens/shared";
import type { AuditRepository } from "../audit/types";
import type { AuthPrincipal } from "../auth/types";
import type { DocumentRepository } from "../documents/types";
import type { ExtractionFieldPatch, ExtractionRepository, ExtractionReviewState, PersistedExtraction } from "./types";

type ExtractionSourceEngine = "TESSERACT" | "CUSTOM_CRNN" | "ENSEMBLE" | null;

export class ExtractionError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class ExtractionService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly repository: ExtractionRepository,
    private readonly audit?: AuditRepository
  ) {}

  async extractFromText(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    text: string;
    sourceEngine: OCREngineCode | null;
    now?: Date;
    correlationId?: string | null;
  }): Promise<PersistedExtraction> {
    const document = await this.documents.findById(input.principal.tenantId, input.documentFileId);
    if (!document || document.deletedAt) throw new ExtractionError("DOCUMENT_NOT_FOUND", 404);
    if (!input.text.trim()) throw new ExtractionError("OCR_TEXT_REQUIRED", 400);
    const extracted = extractReceiptFieldsFromText({
      text: input.text,
      sourceEngine: toExtractionSourceEngine(input.sourceEngine),
      ...(input.now ? { now: input.now } : {})
    });
    const extraction = await this.repository.createFromReceiptFields({
      tenantId: input.principal.tenantId,
      documentFileId: document.id,
      sourceEngine: input.sourceEngine,
      extracted,
      reviewState: null
    });
    await this.auditExtractionCompleted(input.principal, extraction, "ocr_text", input.correlationId ?? null);
    return extraction;
  }

  async latestForDocument(input: { principal: AuthPrincipal; documentFileId: string }): Promise<PersistedExtraction> {
    const document = await this.documents.findById(input.principal.tenantId, input.documentFileId);
    if (!document || document.deletedAt) throw new ExtractionError("DOCUMENT_NOT_FOUND", 404);
    const extraction = await this.repository.findLatestByDocument(input.principal.tenantId, document.id);
    if (!extraction) throw new ExtractionError("EXTRACTION_NOT_FOUND", 404);
    return extraction;
  }

  async reconcileLineItems(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    lineItems: ExtractedReceiptLineItem[];
    now?: Date;
    correlationId?: string | null;
  }): Promise<PersistedExtraction> {
    const document = await this.documents.findById(input.principal.tenantId, input.documentFileId);
    if (!document || document.deletedAt) throw new ExtractionError("DOCUMENT_NOT_FOUND", 404);
    const latest = await this.repository.findLatestByDocument(input.principal.tenantId, document.id);
    if (!latest) throw new ExtractionError("EXTRACTION_NOT_FOUND", 404);
    const base = {
      normalizedText: latest.extracted.normalizedText,
      normalizationCorrections: latest.extracted.normalizationCorrections,
      documentType: latest.extracted.documentType,
      documentTypeConfidence: latest.extracted.documentTypeConfidence,
      merchantName: latest.extracted.merchantName,
      date: latest.extracted.date,
      time: latest.extracted.time,
      currency: latest.extracted.currency,
      subtotal: latest.extracted.subtotal,
      discount: latest.extracted.discount,
      taxTotal: latest.extracted.taxTotal,
      total: latest.extracted.total,
      paymentMethod: latest.extracted.paymentMethod,
      cardLast4: latest.extracted.cardLast4,
      receiptNumber: latest.extracted.receiptNumber,
      lineItems: input.lineItems,
      fieldEvidence: reviewEvidence(latest.extracted.fieldEvidence, ["lineItems"]),
      confidence: latest.extracted.confidence
    };
    const extraction = await this.repository.createFromReceiptFields({
      tenantId: input.principal.tenantId,
      documentFileId: document.id,
      sourceEngine: null,
      extracted: {
        ...base,
        validationIssues: validateExtraction(
          base,
          input.now ?? new Date(),
          toExtractionSourceEngine(latest.fields.find((field) => field.sourceEngine)?.sourceEngine ?? null)
        )
      },
      reviewState: reviewState(input.principal.userId, "NEEDS_REVIEW", [], input.lineItems.length > 0, input.now ?? new Date())
    });
    await this.auditExtractionCompleted(input.principal, extraction, "line_item_reconciliation", input.correlationId ?? null);
    return extraction;
  }

  async reconcileFields(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    fields: ExtractionFieldPatch[];
    reviewStatus: ExtractionReviewState["status"];
    reason?: string | null;
    now?: Date;
    correlationId?: string | null;
  }): Promise<PersistedExtraction> {
    const document = await this.documents.findById(input.principal.tenantId, input.documentFileId);
    if (!document || document.deletedAt) throw new ExtractionError("DOCUMENT_NOT_FOUND", 404);
    const latest = await this.repository.findLatestByDocument(input.principal.tenantId, document.id);
    if (!latest) throw new ExtractionError("EXTRACTION_NOT_FOUND", 404);
    if (input.fields.length === 0 && input.reviewStatus !== "APPROVED") {
      throw new ExtractionError("FIELD_RECONCILIATION_REQUIRED", 400);
    }
    if (input.reviewStatus === "REJECTED" && !input.reason?.trim()) {
      throw new ExtractionError("REJECTION_REASON_REQUIRED", 400);
    }
    const patched = applyFieldPatches(latest.extracted, input.fields);
    const review = reviewState(
      input.principal.userId,
      input.reviewStatus,
      input.fields.map((field) => field.fieldName),
      Boolean(input.reason?.trim()),
      input.now ?? new Date()
    );
    const extraction = await this.repository.createFromReceiptFields({
      tenantId: input.principal.tenantId,
      documentFileId: document.id,
      sourceEngine: null,
      extracted: patched,
      reviewState: review
    });
    await this.auditExtractionCompleted(input.principal, extraction, "field_reconciliation", input.correlationId ?? null);
    return extraction;
  }

  private async auditExtractionCompleted(
    principal: AuthPrincipal,
    extraction: PersistedExtraction,
    source: "ocr_text" | "line_item_reconciliation" | "field_reconciliation",
    correlationId: string | null
  ): Promise<void> {
    await this.audit?.create({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action: "extraction.completed",
      resourceType: "ExtractionJob",
      resourceId: extraction.job.id,
      metadata: {
        documentFileId: extraction.job.documentFileId,
        source,
        sourceEngine: extraction.fields.find((field) => field.sourceEngine)?.sourceEngine ?? null,
        fieldCount: extraction.fields.length,
        issueCount: extraction.issues.length,
        issueCodes: extraction.issues.map((issue) => issue.code),
        lineItemCount: extraction.extracted.lineItems.length,
        totalPresent: extraction.extracted.total !== null,
        merchantPresent: extraction.extracted.merchantName !== null,
        reviewStatus: extraction.reviewState?.status ?? null,
        correctedFields: extraction.reviewState?.correctedFields ?? [],
        reasonPresent: extraction.reviewState?.reasonPresent ?? false
      },
      correlationId
    });
  }
}

function applyFieldPatches(base: ExtractedReceiptFields, patches: ExtractionFieldPatch[]): ExtractedReceiptFields {
  const mutable = {
    normalizedText: base.normalizedText,
    normalizationCorrections: base.normalizationCorrections,
    documentType: base.documentType,
    documentTypeConfidence: base.documentTypeConfidence,
    merchantName: base.merchantName,
    date: base.date,
    time: base.time,
    currency: base.currency,
    subtotal: base.subtotal,
    discount: base.discount,
    taxTotal: base.taxTotal,
    total: base.total,
    paymentMethod: base.paymentMethod,
    cardLast4: base.cardLast4,
    receiptNumber: base.receiptNumber,
    lineItems: base.lineItems,
    fieldEvidence: base.fieldEvidence,
    confidence: base.confidence
  };
  for (const patch of patches) {
    switch (patch.fieldName) {
      case "currency":
        mutable.currency = patch.value;
        break;
      case "subtotal":
      case "discount":
      case "taxTotal":
      case "total":
        mutable[patch.fieldName] = patch.value;
        break;
      case "merchantName":
      case "date":
      case "time":
      case "paymentMethod":
      case "cardLast4":
      case "receiptNumber":
        mutable[patch.fieldName] = normalizeTextPatch(patch.value);
        break;
    }
  }
  return {
    ...mutable,
    fieldEvidence: reviewEvidence(mutable.fieldEvidence, patches.map((patch) => patch.fieldName)),
    validationIssues: validateExtraction(mutable, new Date(), null)
  };
}

function reviewEvidence(existing: readonly ExtractedFieldEvidence[], correctedFields: readonly string[]): ExtractedFieldEvidence[] {
  const corrected = new Set(correctedFields);
  const preserved = existing.filter((evidence) => !corrected.has(evidence.fieldName));
  const reviewEntries: ExtractedFieldEvidence[] = [...corrected].map((fieldName) => ({
    fieldName,
    confidence: 1,
    source: "review",
    rawEvidence: null,
    normalizedEvidence: "Kullanıcı tarafından doğrulandı veya düzeltildi."
  }));
  return [...preserved, ...reviewEntries];
}

function toExtractionSourceEngine(engine: OCREngineCode | null | undefined): ExtractionSourceEngine {
  if (engine === "TESSERACT" || engine === "CUSTOM_CRNN" || engine === "ENSEMBLE") return engine;
  return null;
}

function normalizeTextPatch(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function reviewState(
  reviewedById: string,
  status: ExtractionReviewState["status"],
  correctedFields: string[],
  reasonPresent: boolean,
  reviewedAt: Date
): ExtractionReviewState {
  return {
    status,
    reviewedById,
    reviewedAt,
    reasonPresent,
    correctedFields: [...new Set(correctedFields)]
  };
}
