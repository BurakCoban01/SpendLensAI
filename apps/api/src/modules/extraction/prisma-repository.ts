import { Prisma, PrismaClient, type OCREngineCode } from "@prisma/client";
import type { ExtractedDocumentType, ExtractedFieldEvidence } from "@spendlens/shared";
import type { ExtractionRepository, PersistedExtraction } from "./types";
import {
  EXTRACTION_DOCUMENT_TYPE_CONFIDENCE_FIELD,
  EXTRACTION_DOCUMENT_TYPE_FIELD,
  EXTRACTION_NORMALIZATION_CORRECTIONS_FIELD,
  EXTRACTION_NORMALIZED_TEXT_FIELD,
  EXTRACTION_REVIEW_STATE_FIELD,
  parseReviewState,
  toPersistedFields
} from "./persistence";

export class PrismaExtractionRepository implements ExtractionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createFromReceiptFields(input: Parameters<ExtractionRepository["createFromReceiptFields"]>[0]): Promise<PersistedExtraction> {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.extractionJob.create({
        data: {
          tenantId: input.tenantId,
          documentFileId: input.documentFileId,
          ocrJobId: "manual-text",
          status: "SUCCEEDED",
          confidence: new Prisma.Decimal(input.extracted.confidence.toFixed(4)),
          completedAt: new Date()
        }
      });
      const fields = toPersistedFields(input.extracted, input.sourceEngine as OCREngineCode | null, input.reviewState ?? null);
      if (fields.length > 0) {
        await tx.extractedField.createMany({
          data: fields.map((field) => ({
            tenantId: input.tenantId,
            extractionJobId: job.id,
            fieldName: field.fieldName,
            value: field.value,
            valueType: field.valueType,
            confidence: field.confidence ? new Prisma.Decimal(field.confidence) : null,
            sourceEngine: field.sourceEngine,
            validationStatus: input.extracted.validationIssues.length > 0 ? "WARN" : "OK"
          }))
        });
      }
      if (input.extracted.validationIssues.length > 0) {
        await tx.validationIssue.createMany({
          data: input.extracted.validationIssues.map((issue) => ({
            tenantId: input.tenantId,
            extractionJobId: job.id,
            code: issue.code,
            severity: issue.severity,
            message: issue.message
          }))
        });
      }
      return {
        job: {
          ...job,
          confidence: job.confidence?.toString() ?? null
        },
        fields,
        issues: input.extracted.validationIssues.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          message: issue.message
        })),
        extracted: input.extracted,
        reviewState: input.reviewState ?? null
      };
    });
  }

  async findLatestByDocument(tenantId: string, documentFileId: string): Promise<PersistedExtraction | null> {
    const job = await this.prisma.extractionJob.findFirst({
      where: { tenantId, documentFileId, status: "SUCCEEDED" },
      orderBy: { completedAt: "desc" }
    });
    if (!job) return null;

    const [fields, issues] = await Promise.all([
      this.prisma.extractedField.findMany({ where: { tenantId, extractionJobId: job.id } }),
      this.prisma.validationIssue.findMany({ where: { tenantId, extractionJobId: job.id } })
    ]);

    return {
      job: {
        ...job,
        confidence: job.confidence?.toString() ?? null
      },
      fields: fields.map((field) => ({
        fieldName: field.fieldName,
        value: field.value,
        valueType: field.valueType,
        confidence: field.confidence?.toString() ?? null,
        sourceEngine: field.sourceEngine
      })),
      issues: issues.map((issue) => ({ code: issue.code, severity: issue.severity, message: issue.message })),
      extracted: extractedFromPersistedFields(
        fields.map((field) => ({
          fieldName: field.fieldName,
          value: field.value,
          confidence: field.confidence?.toString() ?? null,
          sourceEngine: field.sourceEngine
        })),
        issues.map((issue) => ({ code: issue.code, severity: issue.severity, message: issue.message })),
        job.confidence?.toString() ?? null
      ),
      reviewState: parseReviewState(fields.find((field) => field.fieldName === EXTRACTION_REVIEW_STATE_FIELD)?.value)
    };
  }
}

function extractedFromPersistedFields(
  fields: Array<{ fieldName: string; value: string; confidence: string | null; sourceEngine: OCREngineCode | null }>,
  issues: Array<{ code: string; severity: string; message: string }>,
  jobConfidence: string | null
) {
  const byName = new Map(fields.map((field) => [field.fieldName, field.value]));
  const metadataFields = new Set([
    EXTRACTION_REVIEW_STATE_FIELD,
    EXTRACTION_NORMALIZED_TEXT_FIELD,
    EXTRACTION_NORMALIZATION_CORRECTIONS_FIELD,
    EXTRACTION_DOCUMENT_TYPE_FIELD,
    EXTRACTION_DOCUMENT_TYPE_CONFIDENCE_FIELD
  ]);
  const fieldEvidence = fields
    .filter((field) => !metadataFields.has(field.fieldName))
    .flatMap((field) => {
      const confidence = field.confidence ? Number(field.confidence) : 0;
      if (!Number.isFinite(confidence) || confidence <= 0) return [];
      return [
        {
          fieldName: field.fieldName,
          confidence,
          source: "normalized_ocr_text" as const,
          rawEvidence: null,
          normalizedEvidence: field.sourceEngine ? `${field.sourceEngine} alanı` : "Kalıcı çıkarım alanı"
        }
      ];
    });
  const persistedJobConfidence = jobConfidence ? Number(jobConfidence) : 0;
  const aggregateConfidence =
    Number.isFinite(persistedJobConfidence) && persistedJobConfidence > 0 ? persistedJobConfidence : confidenceFromEvidence(fieldEvidence);
  const documentType = parseDocumentType(byName.get(EXTRACTION_DOCUMENT_TYPE_FIELD));
  const documentTypeConfidence = parseConfidence(byName.get(EXTRACTION_DOCUMENT_TYPE_CONFIDENCE_FIELD)) ?? 0;
  const money = (name: string) => {
    const value = byName.get(name);
    return value ? { amountMinor: BigInt(value), currency: (byName.get("currency") ?? "TRY") as "TRY" | "USD" | "EUR" | "GBP" } : null;
  };
  return {
    normalizedText: byName.get(EXTRACTION_NORMALIZED_TEXT_FIELD) ?? "",
    normalizationCorrections: parseNormalizationCorrections(byName.get(EXTRACTION_NORMALIZATION_CORRECTIONS_FIELD)),
    documentType,
    documentTypeConfidence,
    merchantName: byName.get("merchantName") ?? null,
    date: byName.get("date") ?? null,
    time: byName.get("time") ?? null,
    currency: (byName.get("currency") ?? "TRY") as "TRY" | "USD" | "EUR" | "GBP",
    subtotal: money("subtotal"),
    discount: money("discount"),
    taxTotal: money("taxTotal"),
    total: money("total"),
    paymentMethod: byName.get("paymentMethod") ?? null,
    cardLast4: byName.get("cardLast4") ?? null,
    receiptNumber: byName.get("receiptNumber") ?? null,
    lineItems: parseLineItems(byName.get("lineItems"), (byName.get("currency") ?? "TRY") as "TRY" | "USD" | "EUR" | "GBP"),
    fieldEvidence,
    confidence: aggregateConfidence,
    validationIssues: issues.map((issue) => ({
      code: issue.code as never,
      severity: issue.severity as "info" | "warning" | "critical",
      message: issue.message
    }))
  };
}

function parseNormalizationCorrections(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseDocumentType(value: string | undefined): ExtractedDocumentType {
  if (
    value === "retail_receipt" ||
    value === "invoice" ||
    value === "e_archive_invoice" ||
    value === "bank_transfer_receipt" ||
    value === "payment_proof" ||
    value === "card_slip" ||
    value === "unknown_document"
  ) {
    return value;
  }
  return "unknown_document";
}

function parseConfidence(value: string | undefined): number | null {
  if (!value) return null;
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  return Math.max(0, Math.min(1, confidence));
}

function confidenceFromEvidence(fieldEvidence: readonly ExtractedFieldEvidence[]): number {
  if (fieldEvidence.length === 0) return 0;
  const average = fieldEvidence.reduce((sum, evidence) => sum + evidence.confidence, 0) / fieldEvidence.length;
  return Math.max(0, Math.min(1, Math.round(average * 10000) / 10000));
}

function parseLineItems(value: string | undefined, fallbackCurrency: "TRY" | "USD" | "EUR" | "GBP") {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const total = parseMoney(record.total, fallbackCurrency);
      if (typeof record.name !== "string" || !total) return [];
      return [
        {
          name: record.name,
          quantity: typeof record.quantity === "string" ? record.quantity : null,
          unitPrice: parseMoney(record.unitPrice, fallbackCurrency),
          total,
          confidence: typeof record.confidence === "number" ? record.confidence : 0
        }
      ];
    });
  } catch {
    return [];
  }
}

function parseMoney(value: unknown, fallbackCurrency: "TRY" | "USD" | "EUR" | "GBP") {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const amountMinor = record.amountMinor;
  const currency = record.currency;
  if (typeof amountMinor !== "string" && typeof amountMinor !== "number" && typeof amountMinor !== "bigint") return null;
  const amountText = String(amountMinor);
  if (!/^-?\d+$/.test(amountText)) return null;
  return {
    amountMinor: BigInt(amountText),
    currency: currency === "TRY" || currency === "USD" || currency === "EUR" || currency === "GBP" ? currency : fallbackCurrency
  };
}
