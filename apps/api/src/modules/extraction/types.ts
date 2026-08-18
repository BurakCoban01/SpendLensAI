import type { OCREngineCode } from "@prisma/client";
import type { CurrencyCode, ExtractedReceiptFields, Money } from "@spendlens/shared";

export type ExtractionReviewState = {
  status: "NEEDS_REVIEW" | "APPROVED" | "REJECTED";
  reviewedById: string;
  reviewedAt: Date;
  reasonPresent: boolean;
  correctedFields: string[];
};

export type StoredExtractionJob = {
  id: string;
  tenantId: string;
  documentFileId: string;
  ocrJobId: string | null;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  confidence: string | null;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type PersistedExtraction = {
  job: StoredExtractionJob;
  fields: Array<{ fieldName: string; value: string; valueType: string; confidence: string | null; sourceEngine: OCREngineCode | null }>;
  issues: Array<{ code: string; severity: string; message: string }>;
  extracted: ExtractedReceiptFields;
  reviewState: ExtractionReviewState | null;
};

export type ExtractionFieldPatch =
  | { fieldName: "merchantName" | "date" | "time" | "paymentMethod" | "cardLast4" | "receiptNumber"; value: string | null }
  | { fieldName: "currency"; value: CurrencyCode }
  | { fieldName: "subtotal" | "discount" | "taxTotal" | "total"; value: Money | null };

export type ExtractionRepository = {
  createFromReceiptFields(input: {
    tenantId: string;
    documentFileId: string;
    sourceEngine: OCREngineCode | null;
    extracted: ExtractedReceiptFields;
    reviewState?: ExtractionReviewState | null;
  }): Promise<PersistedExtraction>;
  findLatestByDocument(tenantId: string, documentFileId: string): Promise<PersistedExtraction | null>;
};
