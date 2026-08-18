export type OcrNormalizationResult = Readonly<{
  originalText: string;
  normalizedText: string;
  corrections: string[];
}>;

const labelCorrections: Array<{ pattern: RegExp; replacement: string; code: string }> = [
  { pattern: /\bT[0O]P[L1Iİ]AM\b/giu, replacement: "TOPLAM", code: "TOTAL_LABEL" },
  { pattern: /\bGENE[L1Iİ]\s+T[0O]P[L1Iİ]AM\b/giu, replacement: "GENEL TOPLAM", code: "GRAND_TOTAL_LABEL" },
  { pattern: /\bTAR[L1Iİ]H\b/giu, replacement: "TARİH", code: "DATE_LABEL" },
  { pattern: /\bSA[A4]T\b/giu, replacement: "SAAT", code: "TIME_LABEL" },
  { pattern: /\bF[L1Iİ]S\b/giu, replacement: "FİŞ", code: "RECEIPT_LABEL" },
  { pattern: /\bK[O0]V\b/giu, replacement: "KDV", code: "TAX_LABEL" },
  { pattern: /\bT[L1Iİ]\b/giu, replacement: "TL", code: "CURRENCY_LABEL" }
];

const lineRoleCorrections: Array<{ pattern: RegExp; replacement: string; code: string }> = [
  { pattern: /^S[0O]T(?=\s+%\s*\d{1,2}\b)/gimu, replacement: "SÜT", code: "LINE_ITEM_PRODUCT_TOKEN" },
  { pattern: /^[0O]:?R[0O]N(?=\s+KDV\s+TUTAR\b)/gimu, replacement: "ÜRÜN", code: "LINE_ITEM_HEADER" }
];

export function normalizeOcrText(text: string): OcrNormalizationResult {
  const corrections = new Set<string>();
  let normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/₺/g, "TL")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const beforeMoney = normalized;
  normalized = normalizeMoneyNoise(normalized);
  if (normalized !== beforeMoney) corrections.add("MONEY_DIGIT_CONFUSION");

  for (const correction of labelCorrections) {
    const before = normalized;
    normalized = normalized.replace(correction.pattern, correction.replacement);
    if (normalized !== before) corrections.add(correction.code);
  }
  for (const correction of lineRoleCorrections) {
    const before = normalized;
    normalized = normalized.replace(correction.pattern, correction.replacement);
    if (normalized !== before) corrections.add(correction.code);
  }

  return {
    originalText: text,
    normalizedText: normalized,
    corrections: [...corrections].sort()
  };
}

function normalizeMoneyNoise(text: string): string {
  return text.replace(/[0-9OIlıİS]{1,8}(?:[.,][0-9OIlıİS]{2})/g, (value) =>
    value
      .replace(/[O]/g, "0")
      .replace(/[Ilıİ]/g, "1")
      .replace(/[S]/g, "5")
  );
}
