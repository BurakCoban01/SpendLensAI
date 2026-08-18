import { parseTurkishMoney, type CurrencyCode, type Money } from "./money";

export const turkishSandboxDocumentKinds = ["UBL_TR_XML", "QR_PAYLOAD"] as const;
export type TurkishSandboxDocumentKind = (typeof turkishSandboxDocumentKinds)[number];

export type TurkishSandboxValidationIssue = Readonly<{
  code:
    | "MALFORMED_DOCUMENT"
    | "MISSING_DOCUMENT_NUMBER"
    | "MISSING_DATE"
    | "MISSING_TOTAL"
    | "MISSING_MERCHANT"
    | "INVALID_TAX_ID"
    | "UNSUPPORTED_CURRENCY"
    | "TOTAL_TAX_MISMATCH"
    | "NEGATIVE_AMOUNT";
  severity: "info" | "warning" | "critical";
  message: string;
}>;

export type TurkishSandboxParty = Readonly<{
  name: string | null;
  taxId: string | null;
  taxScheme: string | null;
}>;

export type TurkishSandboxLineItem = Readonly<{
  id: string | null;
  name: string | null;
  quantity: string | null;
  unitCode: string | null;
  unitPrice: Money | null;
  lineTotal: Money | null;
  taxRate: string | null;
  taxAmount: Money | null;
}>;

export type TurkishSandboxParsedDocument = Readonly<{
  source: "LOCAL_SANDBOX";
  officialIntegration: false;
  kind: TurkishSandboxDocumentKind;
  documentType: "invoice" | "receipt_qr";
  profileId: string | null;
  documentNumber: string | null;
  uuid: string | null;
  issueDate: string | null;
  issueTime: string | null;
  currency: CurrencyCode;
  supplier: TurkishSandboxParty;
  customer: TurkishSandboxParty;
  subtotal: Money | null;
  taxTotal: Money | null;
  total: Money | null;
  payableAmount: Money | null;
  paymentMethod: string | null;
  cardLast4: string | null;
  lineItems: TurkishSandboxLineItem[];
  rawFields: Record<string, string>;
  validationIssues: TurkishSandboxValidationIssue[];
}>;

type MutableParsedDocument = Omit<TurkishSandboxParsedDocument, "validationIssues"> & {
  validationIssues: TurkishSandboxValidationIssue[];
};

const SUPPORTED_CURRENCIES = new Set<CurrencyCode>(["TRY", "USD", "EUR", "GBP"]);
const EMPTY_PARTY: TurkishSandboxParty = { name: null, taxId: null, taxScheme: null };

export function parseTurkishSandboxDocument(input: {
  kind: TurkishSandboxDocumentKind;
  content: string;
}): TurkishSandboxParsedDocument {
  if (input.kind === "UBL_TR_XML") return parseUblTrSandboxInvoiceXml(input.content);
  return parseTurkishReceiptQrPayload(input.content);
}

export function parseUblTrSandboxInvoiceXml(xml: string): TurkishSandboxParsedDocument {
  const content = xml.trim();
  const issues: TurkishSandboxValidationIssue[] = [];
  if (!/<\s*(?:[\w.-]+:)?Invoice\b/i.test(content)) {
    issues.push({
      code: "MALFORMED_DOCUMENT",
      severity: "critical",
      message: "Content is not a namespace-tolerant UBL Invoice XML document."
    });
  }

  const legalTotalBlock = firstElementBlock(content, "LegalMonetaryTotal");
  const taxTotalBlock = firstElementBlock(content, "TaxTotal");
  const supplierBlock = firstElementBlock(content, "AccountingSupplierParty");
  const customerBlock = firstElementBlock(content, "AccountingCustomerParty");
  const invoiceLines = allElementBlocks(content, "InvoiceLine");
  const currency = readCurrency(content, issues);

  const document: MutableParsedDocument = {
    source: "LOCAL_SANDBOX",
    officialIntegration: false,
    kind: "UBL_TR_XML",
    documentType: "invoice",
    profileId: firstTagText(content, "ProfileID"),
    documentNumber: firstBusinessInvoiceId(content),
    uuid: firstTagText(content, "UUID"),
    issueDate: normalizeDate(firstTagText(content, "IssueDate")),
    issueTime: normalizeTime(firstTagText(content, "IssueTime")),
    currency,
    supplier: supplierBlock ? parseParty(supplierBlock) : EMPTY_PARTY,
    customer: customerBlock ? parseParty(customerBlock) : EMPTY_PARTY,
    subtotal: moneyFromTag(legalTotalBlock ?? content, "LineExtensionAmount", currency, issues),
    taxTotal: moneyFromTag(taxTotalBlock ?? content, "TaxAmount", currency, issues),
    total: moneyFromTag(legalTotalBlock ?? content, "TaxInclusiveAmount", currency, issues),
    payableAmount: moneyFromTag(legalTotalBlock ?? content, "PayableAmount", currency, issues),
    paymentMethod: normalizePaymentMethod(firstTagText(content, "PaymentMeansCode")),
    cardLast4: null,
    lineItems: invoiceLines.map((line) => parseInvoiceLine(line, currency, issues)),
    rawFields: {
      profileId: firstTagText(content, "ProfileID") ?? "",
      documentNumber: firstBusinessInvoiceId(content) ?? "",
      uuid: firstTagText(content, "UUID") ?? "",
      currency
    },
    validationIssues: issues
  };

  return finalizeParsedDocument(document);
}

export function parseTurkishReceiptQrPayload(payload: string): TurkishSandboxParsedDocument {
  const rawFields = parseQrFields(payload);
  const issues: TurkishSandboxValidationIssue[] = [];
  if (Object.keys(rawFields).length === 0) {
    issues.push({
      code: "MALFORMED_DOCUMENT",
      severity: "critical",
      message: "QR/barcode payload must be JSON, query-string, or key-value text."
    });
  }

  const currency = readFieldCurrency(rawFields, issues);
  const merchantName = readFirstField(rawFields, ["merchant", "merchantName", "unvan", "title", "isyeri", "firma"]);
  const supplierTaxId = onlyDigits(readFirstField(rawFields, ["vkn", "tckn", "taxId", "vergiNo"]));
  const date = normalizeDate(readFirstField(rawFields, ["date", "tarih", "issueDate"]));
  const total = moneyFromField(rawFields, ["total", "tutar", "toplam", "payableAmount"], currency, issues);
  const taxTotal = moneyFromField(rawFields, ["tax", "kdv", "taxTotal", "vat"], currency, issues);
  const cardLast4 = onlyDigits(readFirstField(rawFields, ["cardLast4", "kartSon4", "last4"]))?.slice(-4) ?? null;

  const document: MutableParsedDocument = {
    source: "LOCAL_SANDBOX",
    officialIntegration: false,
    kind: "QR_PAYLOAD",
    documentType: "receipt_qr",
    profileId: null,
    documentNumber: readFirstField(rawFields, ["documentNumber", "receiptNo", "fisNo", "faturaNo", "invoiceNo", "no"]),
    uuid: readFirstField(rawFields, ["uuid", "ettn"]),
    issueDate: date,
    issueTime: normalizeTime(readFirstField(rawFields, ["time", "saat", "issueTime"])),
    currency,
    supplier: { name: merchantName, taxId: supplierTaxId, taxScheme: supplierTaxId ? (supplierTaxId.length === 10 ? "VKN" : "TCKN") : null },
    customer: EMPTY_PARTY,
    subtotal: moneyFromField(rawFields, ["subtotal", "araToplam", "matrah"], currency, issues),
    taxTotal,
    total,
    payableAmount: total,
    paymentMethod: normalizePaymentMethod(readFirstField(rawFields, ["paymentMethod", "odeme", "payment"])),
    cardLast4: cardLast4?.length === 4 ? cardLast4 : null,
    lineItems: [],
    rawFields,
    validationIssues: issues
  };

  return finalizeParsedDocument(document);
}

function finalizeParsedDocument(document: MutableParsedDocument): TurkishSandboxParsedDocument {
  if (!document.documentNumber) {
    document.validationIssues.push({
      code: "MISSING_DOCUMENT_NUMBER",
      severity: "warning",
      message: "Sandbox parser could not find a receipt or invoice number."
    });
  }
  if (!document.issueDate) {
    document.validationIssues.push({
      code: "MISSING_DATE",
      severity: "warning",
      message: "Sandbox parser could not find a valid issue date."
    });
  }
  if (!document.total && !document.payableAmount) {
    document.validationIssues.push({
      code: "MISSING_TOTAL",
      severity: "critical",
      message: "Sandbox parser could not find a total or payable amount."
    });
  }
  if (!document.supplier.name) {
    document.validationIssues.push({
      code: "MISSING_MERCHANT",
      severity: "warning",
      message: "Sandbox parser could not find a supplier or merchant name."
    });
  }
  validateTaxId(document.supplier.taxId, document.validationIssues);
  validateTaxId(document.customer.taxId, document.validationIssues);
  validateNonNegative([document.subtotal, document.taxTotal, document.total, document.payableAmount], document.validationIssues);
  validateTotals(document, document.validationIssues);
  return document;
}

function parseParty(block: string): TurkishSandboxParty {
  const name = firstTagText(firstElementBlock(block, "PartyName") ?? block, "Name") ?? firstTagText(block, "RegistrationName");
  const taxSchemeBlock = firstElementBlock(block, "PartyTaxScheme");
  const taxId = onlyDigits(firstTagText(taxSchemeBlock ?? block, "CompanyID"));
  const taxScheme = firstTagText(firstElementBlock(taxSchemeBlock ?? block, "TaxScheme") ?? "", "Name");
  return { name, taxId, taxScheme };
}

function parseInvoiceLine(block: string, currency: CurrencyCode, issues: TurkishSandboxValidationIssue[]): TurkishSandboxLineItem {
  const quantityTag = firstTag(block, "InvoicedQuantity");
  const priceBlock = firstElementBlock(block, "Price");
  const taxSubtotalBlock = firstElementBlock(block, "TaxSubtotal") ?? firstElementBlock(block, "TaxTotal") ?? "";
  return {
    id: firstTagText(block, "ID"),
    name: firstTagText(firstElementBlock(block, "Item") ?? block, "Name"),
    quantity: quantityTag?.text ?? null,
    unitCode: quantityTag?.attrs ? readAttribute(quantityTag.attrs, "unitCode") : null,
    unitPrice: moneyFromTag(priceBlock ?? "", "PriceAmount", currency, issues),
    lineTotal: moneyFromTag(block, "LineExtensionAmount", currency, issues),
    taxRate: firstTagText(taxSubtotalBlock, "Percent"),
    taxAmount: moneyFromTag(taxSubtotalBlock, "TaxAmount", currency, issues)
  };
}

function parseQrFields(payload: string): Record<string, string> {
  const content = payload.trim();
  if (!content) return {};
  const fromJson = parseJsonFields(content);
  if (Object.keys(fromJson).length > 0) return fromJson;
  const query = content.includes("?") ? content.slice(content.indexOf("?") + 1) : content;
  const queryFields = parseQueryFields(query);
  if (Object.keys(queryFields).length > 0) return queryFields;
  return parseKeyValueFields(content);
}

function parseJsonFields(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => value !== null && value !== undefined && typeof value !== "object")
        .map(([key, value]) => [normalizeFieldKey(key), String(value).trim()])
        .filter(([key, value]) => key && value)
    );
  } catch {
    return {};
  }
}

function parseQueryFields(content: string): Record<string, string> {
  if (!content.includes("=")) return {};
  const fields: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(content)) {
    const normalizedKey = normalizeFieldKey(key);
    const normalizedValue = value.trim();
    if (normalizedKey && normalizedValue) fields[normalizedKey] = normalizedValue;
  }
  return fields;
}

function parseKeyValueFields(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of content.split(/[;|\n]/)) {
    const match = /^\s*([^:=]+)\s*[:=]\s*(.+?)\s*$/.exec(part);
    if (!match?.[1] || !match[2]) continue;
    fields[normalizeFieldKey(match[1])] = match[2].trim();
  }
  return fields;
}

function normalizeFieldKey(key: string): string {
  return key.trim().replace(/[\s_-]+/g, "");
}

function readFirstField(fields: Record<string, string>, keys: readonly string[]): string | null {
  const normalized = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = normalized[normalizeFieldKey(key).toLowerCase()];
    if (value) return value;
  }
  return null;
}

function readCurrency(content: string, issues: TurkishSandboxValidationIssue[]): CurrencyCode {
  return normalizeCurrency(
    firstTagText(content, "DocumentCurrencyCode") ?? firstAmountCurrency(content) ?? "TRY",
    issues
  );
}

function readFieldCurrency(fields: Record<string, string>, issues: TurkishSandboxValidationIssue[]): CurrencyCode {
  return normalizeCurrency(readFirstField(fields, ["currency", "paraBirimi", "currencyCode"]) ?? "TRY", issues);
}

function normalizeCurrency(value: string, issues: TurkishSandboxValidationIssue[]): CurrencyCode {
  const currency = value.trim().toUpperCase() as CurrencyCode;
  if (SUPPORTED_CURRENCIES.has(currency)) return currency;
  issues.push({
    code: "UNSUPPORTED_CURRENCY",
    severity: "warning",
    message: `Unsupported currency '${value}' was normalized to TRY for local sandbox parsing.`
  });
  return "TRY";
}

function moneyFromField(
  fields: Record<string, string>,
  keys: readonly string[],
  currency: CurrencyCode,
  issues: TurkishSandboxValidationIssue[]
): Money | null {
  const value = readFirstField(fields, keys);
  return value ? moneyFromText(value, currency, issues) : null;
}

function moneyFromTag(
  block: string,
  tagName: string,
  currency: CurrencyCode,
  issues: TurkishSandboxValidationIssue[]
): Money | null {
  const tag = firstTag(block, tagName);
  return tag ? moneyFromText(tag.text, currency, issues) : null;
}

function moneyFromText(value: string, currency: CurrencyCode, issues: TurkishSandboxValidationIssue[]): Money | null {
  try {
    return parseTurkishMoney(value, currency);
  } catch {
    issues.push({
      code: "MALFORMED_DOCUMENT",
      severity: "warning",
      message: `Amount '${value}' could not be parsed as decimal minor units.`
    });
    return null;
  }
}

function firstBusinessInvoiceId(content: string): string | null {
  const ids = allTagTexts(content, "ID");
  return (
    ids.find((id) => !/^(UBL|TR|EARSIV|TEMELFATURA|TICARIFATURA|IHRACAT)$/i.test(id) && !/^\d+(\.\d+)*$/.test(id)) ??
    null
  );
}

function firstTagText(content: string, tagName: string): string | null {
  return firstTag(content, tagName)?.text ?? null;
}

function allTagTexts(content: string, tagName: string): string[] {
  const tagRe = elementRegExp(tagName, "gi");
  const values: string[] = [];
  for (const match of content.matchAll(tagRe)) {
    const value = decodeXmlEntities(stripTags(match[2] ?? "").trim());
    if (value) values.push(value);
  }
  return values;
}

function firstElementBlock(content: string, tagName: string): string | null {
  const match = elementRegExp(tagName, "i").exec(content);
  return match?.[2] ?? null;
}

function allElementBlocks(content: string, tagName: string): string[] {
  return [...content.matchAll(elementRegExp(tagName, "gi"))].map((match) => match[2] ?? "");
}

function firstTag(content: string, tagName: string): { attrs: string; text: string } | null {
  const match = elementRegExp(tagName, "i").exec(content);
  if (!match) return null;
  return {
    attrs: match[1] ?? "",
    text: decodeXmlEntities(stripTags(match[2] ?? "").trim())
  };
}

function elementRegExp(tagName: string, flags: string): RegExp {
  return new RegExp(`<\\s*(?:[\\w.-]+:)?${tagName}\\b([^>]*)>([\\s\\S]*?)<\\s*\\/\\s*(?:[\\w.-]+:)?${tagName}\\s*>`, flags);
}

function firstAmountCurrency(content: string): string | null {
  const match = /\bcurrencyID\s*=\s*["']([^"']+)["']/i.exec(content);
  return match?.[1] ?? null;
}

function readAttribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(attrs);
  return match?.[1] ?? null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return isValidDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? trimmed : null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (compact) {
    const normalized = `${compact[1]}-${compact[2]}-${compact[3]}`;
    if (isValidDate(Number(compact[1]), Number(compact[2]), Number(compact[3]))) return normalized;
  }
  const compactTurkish = /^(\d{2})(\d{2})(\d{4})$/.exec(trimmed);
  if (compactTurkish) {
    const normalized = `${compactTurkish[3]}-${compactTurkish[2]}-${compactTurkish[1]}`;
    return isValidDate(Number(compactTurkish[3]), Number(compactTurkish[2]), Number(compactTurkish[1])) ? normalized : null;
  }
  const tr = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(trimmed);
  if (!tr) return null;
  const year = Number(tr[3]) < 100 ? 2000 + Number(tr[3]) : Number(tr[3]);
  const month = Number(tr[2]);
  const day = Number(tr[1]);
  return isValidDate(year, month, day)
    ? `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`
    : null;
}

function normalizeTime(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`
    : null;
}

function normalizePaymentMethod(value: string | null): string | null {
  if (!value) return null;
  if (/^(?:48|49|card|kredi|kart|pos)/i.test(value)) return "CARD";
  if (/^(?:10|cash|nakit)/i.test(value)) return "CASH";
  if (/^(?:42|transfer|havale|eft)/i.test(value)) return "TRANSFER";
  return value.trim().toUpperCase();
}

function validateTaxId(taxId: string | null, issues: TurkishSandboxValidationIssue[]): void {
  if (!taxId) return;
  if (!/^\d{10}$|^\d{11}$/.test(taxId)) {
    issues.push({
      code: "INVALID_TAX_ID",
      severity: "warning",
      message: "Synthetic Turkish tax identity field should contain 10 or 11 digits."
    });
  }
}

function validateNonNegative(values: readonly (Money | null)[], issues: TurkishSandboxValidationIssue[]): void {
  if (values.some((value) => value && value.amountMinor < 0n)) {
    issues.push({
      code: "NEGATIVE_AMOUNT",
      severity: "warning",
      message: "Sandbox parser found a negative monetary amount."
    });
  }
}

function validateTotals(document: MutableParsedDocument, issues: TurkishSandboxValidationIssue[]): void {
  const payable = document.payableAmount ?? document.total;
  if (document.total && payable && document.total.amountMinor !== payable.amountMinor) {
    issues.push({
      code: "TOTAL_TAX_MISMATCH",
      severity: "warning",
      message: "Tax-inclusive total and payable amount do not match."
    });
  }
  if (document.subtotal && document.taxTotal && payable) {
    const expected = document.subtotal.amountMinor + document.taxTotal.amountMinor;
    if (absoluteMinor(expected - payable.amountMinor) > 2n) {
      issues.push({
        code: "TOTAL_TAX_MISMATCH",
        severity: "warning",
        message: "Subtotal plus tax does not reconcile with payable amount."
      });
    }
  }
}

function onlyDigits(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits || null;
}

function isValidDate(year: number, month: number, day: number): boolean {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

function absoluteMinor(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
