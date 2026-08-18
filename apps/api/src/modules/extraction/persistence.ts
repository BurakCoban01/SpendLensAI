import type { OCREngineCode } from "@prisma/client";
import type { ExtractedReceiptFields, Money } from "@spendlens/shared";
import type { ExtractionReviewState } from "./types";

export const EXTRACTION_REVIEW_STATE_FIELD = "__reviewState";
export const EXTRACTION_NORMALIZED_TEXT_FIELD = "__normalizedText";
export const EXTRACTION_NORMALIZATION_CORRECTIONS_FIELD = "__normalizationCorrections";
export const EXTRACTION_DOCUMENT_TYPE_FIELD = "__documentType";
export const EXTRACTION_DOCUMENT_TYPE_CONFIDENCE_FIELD = "__documentTypeConfidence";

export function toPersistedFields(
  extracted: ExtractedReceiptFields,
  sourceEngine: OCREngineCode | null,
  reviewState: ExtractionReviewState | null = null
) {
  const confidenceByField = new Map(extracted.fieldEvidence.map((evidence) => [evidence.fieldName, evidence.confidence.toFixed(4)]));
  return [
    textField(EXTRACTION_NORMALIZED_TEXT_FIELD, extracted.normalizedText, null, null, "text"),
    extracted.normalizationCorrections.length > 0
      ? textField(EXTRACTION_NORMALIZATION_CORRECTIONS_FIELD, JSON.stringify(extracted.normalizationCorrections), null, null, "json")
      : null,
    textField(EXTRACTION_DOCUMENT_TYPE_FIELD, extracted.documentType, null, extracted.documentTypeConfidence.toFixed(4)),
    textField(EXTRACTION_DOCUMENT_TYPE_CONFIDENCE_FIELD, extracted.documentTypeConfidence.toFixed(4), null, null, "number"),
    textField("merchantName", extracted.merchantName, sourceEngine, confidenceByField.get("merchantName")),
    textField("date", extracted.date, sourceEngine, confidenceByField.get("date")),
    textField("time", extracted.time, sourceEngine, confidenceByField.get("time")),
    textField("currency", extracted.currency, sourceEngine, confidenceByField.get("currency")),
    moneyField("subtotal", extracted.subtotal, sourceEngine, confidenceByField.get("subtotal")),
    moneyField("discount", extracted.discount, sourceEngine, confidenceByField.get("discount")),
    moneyField("taxTotal", extracted.taxTotal, sourceEngine, confidenceByField.get("taxTotal")),
    moneyField("total", extracted.total, sourceEngine, confidenceByField.get("total")),
    textField("paymentMethod", extracted.paymentMethod, sourceEngine, confidenceByField.get("paymentMethod")),
    textField("cardLast4", extracted.cardLast4, sourceEngine, confidenceByField.get("cardLast4")),
    textField("receiptNumber", extracted.receiptNumber, sourceEngine, confidenceByField.get("receiptNumber")),
    textField(
      "lineItems",
      JSON.stringify(extracted.lineItems, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
      sourceEngine,
      confidenceByField.get("lineItems"),
      "json"
    ),
    reviewState
      ? textField(
          EXTRACTION_REVIEW_STATE_FIELD,
          JSON.stringify(reviewState, (_key, value) => (value instanceof Date ? value.toISOString() : value)),
          null,
          null,
          "json"
        )
      : null
  ].filter((field): field is NonNullable<typeof field> => Boolean(field));
}

export function parseReviewState(value: string | undefined): ExtractionReviewState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const status = record.status;
    const reviewedById = record.reviewedById;
    const reviewedAt = record.reviewedAt;
    const reasonPresent = record.reasonPresent;
    const correctedFields = record.correctedFields;
    if (status !== "NEEDS_REVIEW" && status !== "APPROVED" && status !== "REJECTED") return null;
    if (typeof reviewedById !== "string" || typeof reviewedAt !== "string" || typeof reasonPresent !== "boolean") return null;
    if (!Array.isArray(correctedFields) || !correctedFields.every((field) => typeof field === "string")) return null;
    return {
      status,
      reviewedById,
      reviewedAt: new Date(reviewedAt),
      reasonPresent,
      correctedFields
    };
  } catch {
    return null;
  }
}

function textField(fieldName: string, value: string | null, sourceEngine: OCREngineCode | null, confidence: string | null | undefined = null, valueType = "string") {
  if (value === null || value === "") return null;
  return { fieldName, value, valueType, confidence: confidence ?? null, sourceEngine };
}

function moneyField(fieldName: string, value: Money | null, sourceEngine: OCREngineCode | null, confidence: string | null | undefined = null) {
  if (!value) return null;
  return {
    fieldName,
    value: value.amountMinor.toString(),
    valueType: "money_minor",
    confidence: confidence ?? null,
    sourceEngine
  };
}
