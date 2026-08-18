import { parseTurkishMoney, type CurrencyCode, type Money } from "./money";
import { calculateAverageConfidence, type OcrToken } from "./ocr";
import { normalizeOcrText } from "./ocr-normalization";

export type ExtractedReceiptLineItem = Readonly<{
  name: string;
  quantity: string | null;
  unitPrice: Money | null;
  total: Money;
  confidence: number;
}>;

export type ExtractedDocumentType =
  | "retail_receipt"
  | "invoice"
  | "e_archive_invoice"
  | "bank_transfer_receipt"
  | "payment_proof"
  | "card_slip"
  | "unknown_document";

export type ExtractedReceiptFields = Readonly<{
  normalizedText: string;
  normalizationCorrections: string[];
  documentType: ExtractedDocumentType;
  documentTypeConfidence: number;
  merchantName: string | null;
  date: string | null;
  time: string | null;
  currency: CurrencyCode;
  subtotal: Money | null;
  discount: Money | null;
  taxTotal: Money | null;
  total: Money | null;
  paymentMethod: string | null;
  cardLast4: string | null;
  receiptNumber: string | null;
  lineItems: ExtractedReceiptLineItem[];
  fieldEvidence: ExtractedFieldEvidence[];
  confidence: number;
  validationIssues: ExtractionValidationIssue[];
}>;

export type ExtractedFieldEvidence = Readonly<{
  fieldName: string;
  confidence: number;
  source: "normalized_ocr_text" | "heuristic" | "review";
  rawEvidence: string | null;
  normalizedEvidence: string | null;
}>;

export type ExtractionValidationIssue = Readonly<{
  code:
    | "MISSING_MERCHANT"
    | "MISSING_TOTAL"
    | "MISSING_DATE"
    | "FUTURE_DATE"
    | "GARBAGE_OCR_TEXT"
    | "CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE"
    | "HIGH_CONFIDENCE_OCR_MISMATCH"
    | "LOW_SNIPPET_RECALL"
    | "LINE_TOTAL_MISMATCH"
    | "SUBTOTAL_TAX_TOTAL_MISMATCH"
    | "LOW_OCR_CONFIDENCE"
    | "NON_EXPENSE_DOCUMENT";
  severity: "info" | "warning" | "critical";
  message: string;
}>;

export function isStandardExpenseDocument(documentType: ExtractedDocumentType): boolean {
  return documentType === "retail_receipt" || documentType === "invoice" || documentType === "e_archive_invoice";
}

type CandidateAmount = Readonly<{
  label: string;
  money: Money;
  line: string;
  lineIndex: number;
  matchIndex: number;
  derivedFromArithmetic?: boolean;
}>;

const TOTAL_LABEL_RE = /\b(?:genel\s*)?(?:toplam|tutar|total|amount)\b/i;
const SUBTOTAL_LABEL_RE = /\b(?:ara\s*toplam|matrah|subtotal)\b/i;
const TAX_LABEL_RE = /\b(?:kdv|tax|vat)\b/i;
const DISCOUNT_LABEL_RE = /\b(?:indirim|discount)\b/i;
const DATE_RE = /\b(?<day>\d{1,2})[./-](?<month>\d{1,2})[./-](?<year>\d{2,4})\b/;
const TIME_RE = /\b(?<hour>\d{1,2}):(?<minute>\d{2})(?::\d{2})?\b/;
const MONEY_RE = /(?<![%\d])(?:(?:TRY|TL|₺)\s*)?-?(?:\d{1,3}(?:[.\s]\d{3})*(?:,\d{2}|\.\d{2})|\d+(?:,\d{2}|\.\d{2}))(?:\s*(?:TRY|TL|₺))?/gi;
const RECEIPT_NO_RE = /\b(?:f[ıiİI][sşŞ]|fiş|fis|fatura|invoice|belge|receipt)\s*(?:no|numara|number|#)?\s*[:#-]?\s*(?<value>[A-Z0-9-]{3,})\b/i;
const CARD_LAST4_RE = /(?:\*{2,}|x{2,}|son\s*4|last\s*4)\s*(?<last4>\d{4})\b/i;

export function extractReceiptFieldsFromText(input: {
  text: string;
  tokens?: readonly OcrToken[];
  now?: Date;
  defaultCurrency?: CurrencyCode;
  sourceEngine?: "TESSERACT" | "CUSTOM_CRNN" | "ENSEMBLE" | null;
}): ExtractedReceiptFields {
  const normalized = normalizeOcrText(input.text);
  const currency = input.defaultCurrency ?? detectCurrency(normalized.normalizedText);
  const lines = normalizeLines(normalized.normalizedText);
  const ocrConfidence = input.tokens ? calculateAverageConfidence(input.tokens) : 0;
  const documentClassification = classifyDocument(lines);

  const amounts = collectAmountCandidates(lines, currency);
  const subtotalCandidate = selectAmount(amounts, SUBTOTAL_LABEL_RE);
  const discountCandidate = selectAmount(amounts, DISCOUNT_LABEL_RE);
  const taxCandidate = selectAmount(amounts, TAX_LABEL_RE);
  const observedTotalCandidate = selectTotal(amounts, documentClassification.documentType);
  const totalCandidate = reconcileTotalFromArithmetic(
    observedTotalCandidate,
    subtotalCandidate,
    taxCandidate,
    discountCandidate,
    currency
  );
  const merchantName = extractMerchantName(lines);
  const dateResult = extractDate(lines);
  const timeResult = extractTime(lines);
  const paymentMethod = extractPaymentMethod(lines);
  const cardLast4 = extractCardLast4(lines);
  const receiptNumber = extractReceiptNumber(lines);
  const lineItems = isStandardExpenseDocument(documentClassification.documentType) ? extractLineItems(lines, currency) : [];
  const fieldEvidence = buildFieldEvidence({
    merchantName,
    date: dateResult,
    time: timeResult,
    subtotal: subtotalCandidate,
    discount: discountCandidate,
    taxTotal: taxCandidate,
    total: totalCandidate,
    paymentMethod,
    cardLast4,
    receiptNumber,
    lineItems,
    normalizationCorrections: normalized.corrections,
    baseConfidence: ocrConfidence
  });
  const confidence = ocrConfidence > 0 ? ocrConfidence : confidenceFromEvidence(fieldEvidence);
  const fields: ExtractedReceiptFields = {
    normalizedText: normalized.normalizedText,
    normalizationCorrections: normalized.corrections,
    documentType: documentClassification.documentType,
    documentTypeConfidence: documentClassification.confidence,
    merchantName,
    date: dateResult?.value ?? null,
    time: timeResult?.value ?? null,
    currency,
    subtotal: subtotalCandidate?.money ?? null,
    discount: discountCandidate?.money ?? null,
    taxTotal: taxCandidate?.money ?? null,
    total: totalCandidate?.money ?? null,
    paymentMethod: paymentMethod?.value ?? null,
    cardLast4: cardLast4?.value ?? null,
    receiptNumber: receiptNumber?.value ?? null,
    lineItems,
    fieldEvidence,
    confidence,
    validationIssues: []
  };

  return { ...fields, validationIssues: validateExtraction(fields, input.now ?? new Date(), input.sourceEngine ?? null) };
}

export function validateExtraction(
  fields: Omit<ExtractedReceiptFields, "validationIssues">,
  now = new Date(),
  sourceEngine: "TESSERACT" | "CUSTOM_CRNN" | "ENSEMBLE" | null = null
): ExtractionValidationIssue[] {
  const issues: ExtractionValidationIssue[] = [];
  const standardExpense = isStandardExpenseDocument(fields.documentType);
  const textQuality = assessOcrTextQuality(fields, sourceEngine);
  if (!fields.merchantName) {
    issues.push({ code: "MISSING_MERCHANT", severity: "warning", message: "Merchant name could not be extracted." });
  }
  if (!fields.total) {
    issues.push({ code: "MISSING_TOTAL", severity: "critical", message: "Total amount could not be extracted." });
  }
  if (!fields.date) {
    issues.push({
      code: "MISSING_DATE",
      severity: standardExpense ? "critical" : "warning",
      message: "Receipt date could not be extracted."
    });
  } else if (new Date(`${fields.date}T00:00:00.000Z`).getTime() > stripTimeUtc(now).getTime()) {
    issues.push({ code: "FUTURE_DATE", severity: "warning", message: "Receipt date is in the future." });
  }
  if (textQuality.garbageLikely) {
    issues.push({
      code: "GARBAGE_OCR_TEXT",
      severity: "critical",
      message: "OCR text appears unrelated or too noisy for automatic expense creation."
    });
  }
  if (fields.confidence > 0 && fields.confidence < 0.45) {
    issues.push({
      code: "LOW_OCR_CONFIDENCE",
      severity: sourceEngine === "CUSTOM_CRNN" && standardExpense ? "critical" : "warning",
      message: "Average OCR confidence is below review threshold."
    });
  }
  if (sourceEngine === "CUSTOM_CRNN" && textQuality.customOcrLowRealDocumentConfidence) {
    issues.push({
      code: "CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE",
      severity: "critical",
      message: "Custom OCR result does not meet real-document quality gates; review or correction is required before expense creation."
    });
  }
  if (!isStandardExpenseDocument(fields.documentType)) {
    issues.push({
      code: "NON_EXPENSE_DOCUMENT",
      severity: fields.documentType === "unknown_document" ? "warning" : "info",
      message: "Document type is not a standard receipt or invoice; review before creating an expense."
    });
  }
  if (fields.total && fields.lineItems.length > 0) {
    const lineSum = fields.lineItems.reduce((sum, item) => sum + item.total.amountMinor, 0n);
    const expectedFromLines = lineSum + (fields.taxTotal?.amountMinor ?? 0n) - (fields.discount?.amountMinor ?? 0n);
    if (!subtotalTaxTotalReconciles(fields) && absMinor(expectedFromLines - fields.total.amountMinor) > 2n) {
      issues.push({
        code: "LINE_TOTAL_MISMATCH",
        severity: standardExpense ? "critical" : "warning",
        message: "Line item totals do not match extracted receipt total."
      });
    }
  }
  if (fields.subtotal && fields.taxTotal && fields.total) {
    const expected = fields.subtotal.amountMinor + fields.taxTotal.amountMinor - (fields.discount?.amountMinor ?? 0n);
    if (absMinor(expected - fields.total.amountMinor) > 2n) {
      issues.push({
        code: "SUBTOTAL_TAX_TOTAL_MISMATCH",
        severity: "warning",
        message: "Subtotal, tax and discount do not reconcile with total."
      });
    }
  }
  return issues;
}

export function scoreExtractionReadiness(fields: ExtractedReceiptFields): number {
  let score = 0;
  if (fields.documentType !== "unknown_document") score += 0.12;
  if (isStandardExpenseDocument(fields.documentType)) score += 0.12;
  else if (fields.documentType !== "unknown_document") score += 0.04;
  score += clampEvidenceConfidence(fields.documentTypeConfidence) * 0.08;
  if (fields.merchantName) score += 0.16;
  if (fields.date) score += 0.15;
  if (fields.total) score += 0.24;
  if (fields.subtotal) score += 0.04;
  if (fields.taxTotal) score += 0.04;
  if (fields.paymentMethod) score += 0.03;
  if (fields.lineItems.length > 0) score += Math.min(0.08, fields.lineItems.length * 0.025);
  score += clampEvidenceConfidence(fields.confidence) * 0.12;

  const penalty = fields.validationIssues.reduce((total, issue) => {
    if (issue.severity === "critical") return total + 0.18;
    if (issue.severity === "warning") return total + 0.07;
    return total + 0.02;
  }, 0);
  return clampEvidenceConfidence(score - penalty);
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function assessOcrTextQuality(
  fields: Omit<ExtractedReceiptFields, "validationIssues">,
  sourceEngine: "TESSERACT" | "CUSTOM_CRNN" | "ENSEMBLE" | null
): {
  garbageLikely: boolean;
  customOcrLowRealDocumentConfidence: boolean;
} {
  const lines = normalizeLines(fields.normalizedText);
  const tokens = fields.normalizedText
    .toLocaleLowerCase("tr")
    .split(/[^0-9a-zçğıöşüİÇĞIÖŞÜ]+/u)
    .filter((token) => token.length >= 2);
  const uniqueTokenRatio = tokens.length === 0 ? 0 : new Set(tokens).size / tokens.length;
  const domainSignalCount = [
    fields.merchantName,
    fields.date,
    fields.total,
    fields.paymentMethod,
    fields.receiptNumber,
    fields.taxTotal,
    fields.lineItems.length > 0 ? "lineItems" : null
  ].filter(Boolean).length;
  const merchant = fields.merchantName ?? "";
  const merchantHasDigitInsideWord = /[A-ZÇĞİÖŞÜa-zçğıöşü]\d|\d[A-ZÇĞİÖŞÜa-zçğıöşü]/u.test(merchant);
  const merchantLetterRuns = merchant.match(/[A-ZÇĞİÖŞÜa-zçğıöşü]{2,}/gu) ?? [];
  const merchantHasVowel = /[aeıioöuüAEIİOÖUÜ]/u.test(merchant);
  const noisyMerchant = Boolean(merchant) && (merchantHasDigitInsideWord || !merchantHasVowel || merchantLetterRuns.some((run) => /(.)\1\1/u.test(run)));
  const repeatedNoisyLines = lines.length >= 8 && uniqueTokenRatio < 0.58;
  const missingCoreReceiptSignals = !fields.date || !fields.merchantName || !fields.total;
  const customMissingCoreWithTotal = sourceEngine === "CUSTOM_CRNN" && lines.length >= 4 && fields.total !== null && !fields.date;
  const garbageLikely =
    lines.length >= 4 &&
    fields.total !== null &&
    ((noisyMerchant || repeatedNoisyLines) && (missingCoreReceiptSignals || fields.lineItems.length > 0) || customMissingCoreWithTotal);
  const customOcrLowRealDocumentConfidence =
    missingCoreReceiptSignals ||
    garbageLikely ||
    (fields.lineItems.length > 0 && !subtotalTaxTotalReconciles(fields)) ||
    (domainSignalCount <= 2 && lines.length >= 4);
  return { garbageLikely, customOcrLowRealDocumentConfidence };
}

function detectCurrency(text: string): CurrencyCode {
  if (/\bUSD\b|\$/i.test(text)) return "USD";
  if (/\bEUR\b|€/i.test(text)) return "EUR";
  if (/\bGBP\b|£/i.test(text)) return "GBP";
  return "TRY";
}

function collectAmountCandidates(lines: readonly string[], currency: CurrencyCode): CandidateAmount[] {
  const candidates: CandidateAmount[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    let lineHasExplicitMoney = false;
    for (const match of moneyMatches(line)) {
      lineHasExplicitMoney = true;
      if (isDateTimeLikeAmountCandidate(line, match[0], match.index ?? 0)) continue;
      try {
        candidates.push({ label: line, money: parseTurkishMoney(match[0], currency), line, lineIndex, matchIndex: match.index ?? 0 });
      } catch {
        // OCR noise can produce amount-like fragments. Ignore them and keep extracting the rest.
      }
    }
    if (!lineHasExplicitMoney) {
      const implicit = implicitLabeledAmount(line);
      if (implicit) {
        try {
          candidates.push({ label: line, money: parseTurkishMoney(implicit, currency), line, lineIndex, matchIndex: line.lastIndexOf(implicit) });
        } catch {
          // Ignore noisy implicit totals.
        }
      }
    }
  }
  return candidates;
}

function implicitLabeledAmount(line: string): string | null {
  const normalized = normalizeSearchText(line);
  if (!/\b(?:toplam|tutar|tutari|amount|total)\b/.test(normalized)) return null;
  const match = /(?<!\d)[#%]?\s*(?<amount>\d{1,6})\s*$/.exec(line.trim());
  if (!match?.groups?.amount || match.index === undefined) return null;

  const candidatePrefix = normalizeSearchText(line.slice(0, match.index));
  const amountLabelIndex = Math.max(
    candidatePrefix.lastIndexOf("toplam"),
    candidatePrefix.lastIndexOf("tutar"),
    candidatePrefix.lastIndexOf("amount"),
    candidatePrefix.lastIndexOf("total")
  );
  const referenceLabel = /\b(?:islem\s*no|referans|reference|transaction\s*id|sorgu\s*no|dekont\s*no)\b/g;
  const referenceIndexes = [...candidatePrefix.matchAll(referenceLabel)].map((candidate) => candidate.index ?? -1);
  if (referenceIndexes.some((index) => index > amountLabelIndex)) return null;

  return match.groups.amount;
}

function selectAmount(candidates: readonly CandidateAmount[], label: RegExp): CandidateAmount | null {
  const match = candidates.find((candidate) => label.test(candidate.label));
  return match ?? null;
}

function selectTotal(candidates: readonly CandidateAmount[], documentType: ExtractedDocumentType): CandidateAmount | null {
  if (documentType === "bank_transfer_receipt" || documentType === "payment_proof") {
    const bankTotals = candidates.filter((candidate) => isBankTransactionAmount(candidate) && !isBankFeeAmount(candidate));
    if (bankTotals.length > 0) return bankTotals.sort(scoreBankTransferCandidate)[bankTotals.length - 1] ?? null;
    return null;
  }
  const labeledTotals = candidates.filter(
    (candidate) => TOTAL_LABEL_RE.test(candidate.label) && !SUBTOTAL_LABEL_RE.test(candidate.label) && !negativeTotalLabel(candidate.label)
  );
  if (labeledTotals.length > 0) return labeledTotals.sort(scoreTotalCandidate)[labeledTotals.length - 1] ?? null;
  if (candidates.length === 0) return null;
  return candidates.reduce((largest, candidate) => (candidate.money.amountMinor > largest.money.amountMinor ? candidate : largest));
}

function reconcileTotalFromArithmetic(
  observed: CandidateAmount | null,
  subtotal: CandidateAmount | null,
  tax: CandidateAmount | null,
  discount: CandidateAmount | null,
  currency: CurrencyCode
): CandidateAmount | null {
  if (!subtotal || !tax) return observed;
  const expected = subtotal.money.amountMinor + tax.money.amountMinor - (discount?.money.amountMinor ?? 0n);
  if (expected <= 0n) return observed;
  if (observed && absMinor(observed.money.amountMinor - expected) <= 2n) return observed;
  if (observed && observed.money.amountMinor > subtotal.money.amountMinor) return observed;
  return {
    label: "subtotal + tax - discount",
    money: { amountMinor: expected, currency },
    line: [subtotal.line, tax.line, discount?.line].filter(Boolean).join(" | "),
    lineIndex: Math.max(subtotal.lineIndex, tax.lineIndex, discount?.lineIndex ?? -1),
    matchIndex: 0,
    derivedFromArithmetic: true
  };
}

function scoreTotalCandidate(left: CandidateAmount, right: CandidateAmount): number {
  return totalCandidateScore(left) - totalCandidateScore(right);
}

function scoreBankTransferCandidate(left: CandidateAmount, right: CandidateAmount): number {
  return bankTransferCandidateScore(left) - bankTransferCandidateScore(right);
}

function bankTransferCandidateScore(candidate: CandidateAmount): number {
  const normalized = normalizeSearchText(candidate.label);
  let score = candidate.lineIndex;
  if (/\bislem\s+tut(?:ar|ari|an|ani)\b/.test(normalized)) score += 30;
  if (/\btut(?:ar|ari|an|ani)\b/.test(normalized)) score += 18;
  if (/\b(?:gonderilen|transfer|fast|eft|havale)\b/.test(normalized)) score += 14;
  if (/\b(?:hesabinizla|cekilmis|cekilmistir)\b/.test(normalized)) score += 4;
  if (isBankFeeAmount(candidate)) score -= 30;
  return score;
}

function isBankTransactionAmount(candidate: CandidateAmount): boolean {
  const normalized = normalizeSearchText(candidate.label);
  return /\b(?:tutar|tutari|tutan|tutani|gonderilen|transfer|fast|eft|havale|hesabinizla|cekilmis)\b/.test(
    normalized
  );
}

function isBankFeeAmount(candidate: CandidateAmount): boolean {
  const normalizedPrefix = normalizeSearchText(candidate.label.slice(0, candidate.matchIndex));
  return /\b(?:komisyon|masraf|fee|ucret)\b/.test(normalizedPrefix);
}

function totalCandidateScore(candidate: CandidateAmount): number {
  let score = candidate.lineIndex;
  if (/\b(?:genel\s+toplam|ödenecek|odenecek|grand\s+total)\b/i.test(candidate.label)) score += 8;
  if (/\b(?:try|tl)\b/i.test(candidate.label)) score += 2;
  if (negativeTotalLabel(candidate.label)) score -= 12;
  return score;
}

function negativeTotalLabel(line: string): boolean {
  return /\b(?:para\s*üstü|para\s*ustu|change|nakit\s*al[ıi]nan|puan|indirim|discount)\b/i.test(line);
}

function isDateTimeLikeAmountCandidate(line: string, amountText: string, matchIndex: number): boolean {
  const normalized = normalizeSearchText(line);
  const rawAmount = amountText.trim();
  const hasCurrency = /\b(?:try|tl)\b|₺/i.test(line);
  if (!hasCurrency && /\b(?:tarih|date|saat|time)\b/.test(normalized) && (DATE_RE.test(line) || TIME_RE.test(line))) return true;
  if (!hasCurrency && DATE_RE.test(line) && matchIndex <= line.search(DATE_RE) + 5) return true;
  if (/\b\d{8}\.\d{6}\b/.test(line)) return true;
  if (/^\d{6,}\.\d{2}$/.test(rawAmount) && !hasCurrency) return true;
  if (/\b\d{6,}[-.]\d{4,}\b/.test(line) && /\b(?:tarih|saat|time|islem)\b/.test(normalized)) return true;
  if (/^\d{6,}\.\d{2,}$/.test(rawAmount) && /\b(?:tarih|saat|time|islem)\b/.test(normalized)) return true;
  return false;
}

function classifyDocument(lines: readonly string[]): { documentType: ExtractedDocumentType; confidence: number } {
  const normalized = normalizeSearchText(lines.join(" "));
  const score = (patterns: readonly RegExp[]) => patterns.reduce((total, pattern) => total + (pattern.test(normalized) ? 1 : 0), 0);
  const bankScore = score([
    /\bziraat\s+bankasi\b/,
    /\bvakifbank\b/,
    /\bhesaptan\s+fast\b/,
    /\bfast\b/,
    /\bislem\s+(?:yeri|tutar|tutari|tarihi)\b/,
    /\bkomisyon\b/,
    /\biban\b/,
    /\b(?:eft|havale|transfer)\b/
  ]);
  if (bankScore >= 3) return { documentType: "bank_transfer_receipt", confidence: Math.min(0.96, 0.58 + bankScore * 0.08) };

  const eArchiveScore = score([/\be\s*arsiv\b/, /\bearsiv\b/, /\bettn\b/, /\bsenaryo\b/]);
  if (eArchiveScore >= 2) return { documentType: "e_archive_invoice", confidence: Math.min(0.94, 0.62 + eArchiveScore * 0.08) };

  const invoiceScore = score([
    /\bfatura\b/,
    /\binvoice\b/,
    /\bvkn\b/,
    /\btckn\b/,
    /\bvergi\b/,
    /\bseri\s+sira\b/,
    /\bv\s*d\b/,
    /\bcinsi\b/,
    /\bmiktari\b/,
    /\bfiyati\b/,
    /\btutari\b/
  ]);
  if (invoiceScore >= 2) return { documentType: "invoice", confidence: Math.min(0.9, 0.58 + invoiceScore * 0.08) };

  const cardSlipScore = score([/\bpos\b/, /\bslip\b/, /\bkart\s+slip\b/, /\bprovizyon\b/]);
  if (cardSlipScore >= 2) return { documentType: "card_slip", confidence: Math.min(0.88, 0.58 + cardSlipScore * 0.08) };

  const retailScore = score([/\bfis\b/, /\btoplam\b/, /\bgenel\s+toplam\b/, /\bkdv\b/, /\burun\b/, /\bmagaza\b/, /\bmarket\b/]);
  if (retailScore >= 2) return { documentType: "retail_receipt", confidence: Math.min(0.92, 0.56 + retailScore * 0.07) };

  const paymentProofScore = score([/\bmakbuz\b/, /\bdekont\b/, /\bodeme\b/, /\btahsilat\b/, /\bkare\s+odemesi\b/, /\bislemno\b/]);
  if (paymentProofScore >= 2) return { documentType: "payment_proof", confidence: Math.min(0.86, 0.56 + paymentProofScore * 0.07) };

  return { documentType: "unknown_document", confidence: 0.4 };
}

function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractMerchantName(lines: readonly string[]): string | null {
  const ignored = /^(tarih|tarİh|date|saat|time|fis|fiş|fİş|fatura|invoice|kdv|tax|toplam|total|ara toplam|subtotal)\b/i;
  const labeledMerchant = lines
    .map((line) => /^(?:satıcı|satici|seller|merchant)\s*(?:ünvanı|unvani|name)?\s*[:-]\s*(?<value>.+)$/i.exec(line))
    .find((match) => match?.groups?.value?.trim());
  if (labeledMerchant?.groups?.value) return labeledMerchant.groups.value.trim();
  const merchant = lines.find((line) => !ignored.test(line) && !hasMoney(line) && line.replace(/[^A-Za-zÇĞIİÖŞÜçğıöşü]/g, "").length >= 3);
  return merchant ?? null;
}

function hasMoney(line: string): boolean {
  MONEY_RE.lastIndex = 0;
  return MONEY_RE.test(line);
}

type TextExtractionResult = Readonly<{ value: string; evidence: string }>;

function extractDate(lines: readonly string[]): TextExtractionResult | null {
  for (const line of lines) {
    const match = DATE_RE.exec(line);
    if (!match?.groups) continue;
    let day = Number(match.groups.day);
    let month = Number(match.groups.month);
    const rawYear = Number(match.groups.year);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    if (month > 12 && day >= 1 && day <= 12) {
      [day, month] = [month, day];
    }
    if (!isValidDate(year, month, day)) continue;
    return {
      value: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
      evidence: line
    };
  }
  return null;
}

function extractTime(lines: readonly string[]): TextExtractionResult | null {
  for (const line of lines) {
    const match = TIME_RE.exec(line);
    if (!match?.groups) continue;
    const hour = Number(match.groups.hour);
    const minute = Number(match.groups.minute);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { value: `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`, evidence: line };
    }
  }
  return null;
}

function extractReceiptNumber(lines: readonly string[]): TextExtractionResult | null {
  for (const line of lines) {
    const match = RECEIPT_NO_RE.exec(line);
    if (match?.groups?.value) return { value: match.groups.value, evidence: line };
  }
  return null;
}

function extractPaymentMethod(lines: readonly string[]): TextExtractionResult | null {
  const cardLine = lines.find((line) => /\b(?:kredi|credit|visa|mastercard|kart|card|pos)\b/i.test(line));
  if (cardLine) return { value: "CARD", evidence: cardLine };
  const cashLine = lines.find((line) => /\b(?:nakit|cash)\b/i.test(line));
  if (cashLine) return { value: "CASH", evidence: cashLine };
  const transferLine = lines.find((line) => /\b(?:havale|eft|transfer)\b/i.test(line));
  if (transferLine) return { value: "TRANSFER", evidence: transferLine };
  return null;
}

function extractCardLast4(lines: readonly string[]): TextExtractionResult | null {
  for (const line of lines) {
    const match = CARD_LAST4_RE.exec(line);
    if (match?.groups?.last4) return { value: match.groups.last4, evidence: line };
  }
  return null;
}

function extractLineItems(lines: readonly string[], currency: CurrencyCode): ExtractedReceiptLineItem[] {
  const ignored = /^(tarih|tarİh|date|saat|time|fis|fiş|fİş|fatura|invoice|kdv|tax|toplam|total|ara toplam|subtotal|indirim|discount|nakit|cash|kredi|credit|kart|card)\b/i;
  const items: ExtractedReceiptLineItem[] = [];
  for (const line of lines) {
    if (ignored.test(line) || isReceiptMetadataLine(line)) continue;
    const matches = moneyMatches(line);
    if (matches.length === 0) continue;
    const amountText = matches[matches.length - 1]?.[0];
    if (!amountText) continue;
    const totalStart = line.lastIndexOf(amountText);
    const prefix = line.slice(0, totalStart).trim();
    const quantityEvidence = extractLineItemQuantity(prefix, matches, currency);
    const nameEnd = quantityEvidence?.nameEnd ?? totalStart;
    const name = cleanLineItemName(line.slice(0, nameEnd));
    if (!name || name.length < 2) continue;
    try {
      items.push({
        name,
        quantity: quantityEvidence?.quantity ?? null,
        unitPrice: quantityEvidence?.unitPrice ?? null,
        total: parseTurkishMoney(amountText, currency),
        confidence: quantityEvidence ? 0.78 : 0.72
      });
    } catch {
      // Ignore noisy candidate line items.
    }
  }
  return items;
}

function extractLineItemQuantity(
  prefix: string,
  money: readonly RegExpMatchArray[],
  currency: CurrencyCode
): { quantity: string; unitPrice: Money | null; nameEnd: number } | null {
  const vatQuantity = /(?<quantity>\d+(?:[.,]\d+)?)\s+%\s*\d{1,2}(?:[.,]\d+)?\s*$/u.exec(prefix);
  if (vatQuantity?.groups?.quantity && vatQuantity.index !== undefined) {
    return {
      quantity: vatQuantity.groups.quantity.replace(",", "."),
      unitPrice: null,
      nameEnd: vatQuantity.index
    };
  }
  if (money.length < 2) return null;
  const firstAmount = money[0];
  if (!firstAmount || firstAmount.index === undefined) return null;
  const beforeUnitPrice = prefix.slice(0, firstAmount.index);
  const quantityMatch = /(?<quantity>\d+(?:[.,]\d+)?)\s*(?:adet|x|×)\s*$/i.exec(beforeUnitPrice);
  if (!quantityMatch?.groups?.quantity || quantityMatch.index === undefined) return null;
  try {
    return {
      quantity: quantityMatch.groups.quantity.replace(",", "."),
      unitPrice: parseTurkishMoney(firstAmount[0], currency),
      nameEnd: quantityMatch.index
    };
  } catch {
    return null;
  }
}

function cleanLineItemName(value: string): string {
  return value
    .replace(/\s+%\s*\d{1,2}(?:[.,]\d+)?\s*$/u, "")
    .replace(/[-:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function subtotalTaxTotalReconciles(fields: Omit<ExtractedReceiptFields, "validationIssues">): boolean {
  if (!fields.subtotal || !fields.taxTotal || !fields.total) return false;
  const expected = fields.subtotal.amountMinor + fields.taxTotal.amountMinor - (fields.discount?.amountMinor ?? 0n);
  return absMinor(expected - fields.total.amountMinor) <= 2n;
}

function isReceiptMetadataLine(line: string): boolean {
  const normalized = line
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return /^(tarih|date|saat|time|fis|fis no|fatura|invoice|belge|receipt|vkn|tckn|vergi|kdv|tax|vat|toplam|genel toplam|ara toplam|subtotal|indirim|discount|odeme|ödeme|nakit|cash|kredi|credit|kart|card|para birimi|currency)\b/.test(
    normalized
  );
}

function buildFieldEvidence(input: {
  merchantName: string | null;
  date: TextExtractionResult | null;
  time: TextExtractionResult | null;
  subtotal: CandidateAmount | null;
  discount: CandidateAmount | null;
  taxTotal: CandidateAmount | null;
  total: CandidateAmount | null;
  paymentMethod: TextExtractionResult | null;
  cardLast4: TextExtractionResult | null;
  receiptNumber: TextExtractionResult | null;
  lineItems: ExtractedReceiptLineItem[];
  normalizationCorrections: string[];
  baseConfidence: number;
}): ExtractedFieldEvidence[] {
  const base = input.baseConfidence > 0 ? Math.max(0.35, input.baseConfidence) : 0.72;
  const normalizedBonus = input.normalizationCorrections.length > 0 ? -0.04 : 0;
  const evidence: ExtractedFieldEvidence[] = [];
  const add = (
    fieldName: string,
    rawEvidence: string | null,
    confidence: number,
    source: ExtractedFieldEvidence["source"] = "normalized_ocr_text"
  ) => {
    evidence.push({
      fieldName,
      confidence: clampEvidenceConfidence(confidence + normalizedBonus),
      source,
      rawEvidence,
      normalizedEvidence: rawEvidence
    });
  };

  if (input.merchantName) add("merchantName", input.merchantName, base * 0.86);
  if (input.date) add("date", input.date.evidence, base * 0.9);
  if (input.time) add("time", input.time.evidence, base * 0.86);
  if (input.subtotal) add("subtotal", input.subtotal.line, base * 0.76);
  if (input.discount) add("discount", input.discount.line, base * 0.74);
  if (input.taxTotal) add("taxTotal", input.taxTotal.line, base * 0.8);
  if (input.total) {
    add(
      "total",
      input.total.line,
      input.total.derivedFromArithmetic
        ? base * 0.68
        : /\b(?:genel\s+toplam|toplam|total|ödenecek|odenecek)\b/i.test(input.total.line)
          ? base * 0.94
          : base * 0.72,
      input.total.derivedFromArithmetic ? "heuristic" : "normalized_ocr_text"
    );
  }
  if (input.paymentMethod) add("paymentMethod", input.paymentMethod.evidence, base * 0.82);
  if (input.cardLast4) add("cardLast4", input.cardLast4.evidence, base * 0.88);
  if (input.receiptNumber) add("receiptNumber", input.receiptNumber.evidence, base * 0.78);
  if (input.lineItems.length > 0) add("lineItems", `${input.lineItems.length} line item(s) with trailing amounts`, base * 0.68);

  return evidence;
}

function confidenceFromEvidence(fieldEvidence: readonly ExtractedFieldEvidence[]): number {
  if (fieldEvidence.length === 0) return 0;
  const average = fieldEvidence.reduce((sum, evidence) => sum + evidence.confidence, 0) / fieldEvidence.length;
  return clampEvidenceConfidence(average);
}

function clampEvidenceConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 10000) / 10000));
}

function moneyMatches(line: string): RegExpMatchArray[] {
  MONEY_RE.lastIndex = 0;
  return [...line.matchAll(MONEY_RE)];
}

function isValidDate(year: number, month: number, day: number): boolean {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

function stripTimeUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function absMinor(value: bigint): bigint {
  return value < 0n ? -value : value;
}
