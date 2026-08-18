import { describe, expect, it } from "vitest";
import {
  addMoney,
  calculateAverageConfidence,
  calculateCharacterErrorRate,
  calculateWordErrorRate,
  compareOcrEngineRuns,
  crc32Hex,
  detectExpenseAnomalies,
  eventCatalog,
  extractReceiptFieldsFromText,
  isKafkaTopic,
  normalizeOcrText,
  normalizeSafeFilename,
  parseTurkishMoney,
  predictExpenseCategory,
  roleHasPermission,
  sanitizeCsvCell
} from "./index";

describe("shared domain utilities", () => {
  it("parses Turkish decimal and thousands separators without floats", () => {
    expect(parseTurkishMoney("1.234,56 TL").amountMinor).toBe(123456n);
    expect(parseTurkishMoney("₺99,90").amountMinor).toBe(9990n);
    expect(addMoney(parseTurkishMoney("10,00"), parseTurkishMoney("2,50")).amountMinor).toBe(1250n);
  });

  it("normalizes unsafe filenames and blocks traversal segments", () => {
    expect(normalizeSafeFilename("../../Fiş 001.PNG")).toBe("fis-001.png");
    expect(normalizeSafeFilename("..\\..\\invoice.pdf")).toBe("invoice.pdf");
  });

  it("escapes CSV formula injection prefixes", () => {
    expect(sanitizeCsvCell("=cmd|calc")).toBe("'=cmd|calc");
    expect(sanitizeCsvCell("merchant")).toBe("merchant");
  });

  it("computes stable CRC32 values for upload chunks", () => {
    expect(crc32Hex(new TextEncoder().encode("123456789"))).toBe("cbf43926");
    expect(crc32Hex(new Uint8Array())).toBe("00000000");
  });

  it("checks RBAC permissions centrally", () => {
    expect(roleHasPermission("OWNER", "tenant.manage")).toBe(true);
    expect(roleHasPermission("EMPLOYEE", "ocr.run")).toBe(true);
    expect(roleHasPermission("EMPLOYEE", "models.train")).toBe(false);
    expect(roleHasPermission("VIEWER", "expenses.update")).toBe(false);
  });

  it("keeps the Kafka event catalog typed and durable", () => {
    expect(isKafkaTopic("expense.created")).toBe(true);
    expect(isKafkaTopic("expense.deleted")).toBe(false);
    expect(eventCatalog["expense.created"]).toMatchObject({
      producer: "api.expenses",
      aggregate: "Expense",
      durable: true,
      dlqTopic: "expense.created.dlq"
    });
  });

  it("clamps OCR confidence aggregation", () => {
    expect(calculateAverageConfidence([{ text: "A", confidence: 1.4, bbox: [0, 0, 1, 1] }])).toBe(1);
  });

  it("extracts structured Turkish receipt fields without floating point math", () => {
    const result = extractReceiptFieldsFromText({
      now: new Date("2026-05-12T12:00:00.000Z"),
      text: [
        "MAVI MARKET",
        "FIS NO: TR-12345",
        "TARIH: 12.05.2026 SAAT 14:35",
        "EKMEK 20,00 TL",
        "SUT 45,50 TL",
        "KDV 6,55 TL",
        "TOPLAM 72,05 TL",
        "KREDI KARTI **** 1234"
      ].join("\n"),
      tokens: [
        { text: "MAVI", confidence: 0.9, bbox: [0, 0, 10, 10] },
        { text: "MARKET", confidence: 0.8, bbox: [12, 0, 10, 10] }
      ]
    });

    expect(result.merchantName).toBe("MAVI MARKET");
    expect(result.receiptNumber).toBe("TR-12345");
    expect(result.date).toBe("2026-05-12");
    expect(result.time).toBe("14:35");
    expect(result.paymentMethod).toBe("CARD");
    expect(result.cardLast4).toBe("1234");
    expect(result.total?.amountMinor).toBe(7205n);
    expect(result.taxTotal?.amountMinor).toBe(655n);
    expect(result.lineItems.map((item) => item.name)).toEqual(["EKMEK", "SUT"]);
    expect(result.normalizedText).toContain("TOPLAM 72,05 TL");
    expect(result.fieldEvidence.find((field) => field.fieldName === "total")).toMatchObject({
      source: "normalized_ocr_text",
      rawEvidence: "TOPLAM 72,05 TL"
    });
    expect(result.validationIssues).toEqual([]);
  });

  it("normalizes common OCR confusions before extracting Turkish receipt fields", () => {
    const normalized = normalizeOcrText(["MIGROS TICARET", "TARlH 12.05.2026", "K0V 14,1O TL", "T0PLAM 155,4O T1"].join("\n"));
    expect(normalized.normalizedText).toContain("TARİH 12.05.2026");
    expect(normalized.normalizedText).toContain("KDV 14,10 TL");
    expect(normalized.normalizedText).toContain("TOPLAM 155,40 TL");

    const result = extractReceiptFieldsFromText({
      now: new Date("2026-05-12T12:00:00.000Z"),
      text: normalized.originalText
    });
    expect(result.total?.amountMinor).toBe(15540n);
    expect(result.taxTotal?.amountMinor).toBe(1410n);
    expect(result.normalizationCorrections).toEqual(expect.arrayContaining(["MONEY_DIGIT_CONFUSION", "TAX_LABEL", "TOTAL_LABEL"]));
    expect(result.fieldEvidence.find((field) => field.fieldName === "total")?.confidence).toBeGreaterThan(0.6);
  });

  it("repairs product tokens only when receipt line-role evidence is present", () => {
    const normalized = normalizeOcrText("0:R0N KDV TUTAR\nS0T %10 32,50 TL\nS0T TEKNOLOJI");

    expect(normalized.normalizedText).toBe("ÜRÜN KDV TUTAR\nSÜT %10 32,50 TL\nS0T TEKNOLOJI");
    expect(normalized.corrections).toEqual(expect.arrayContaining(["LINE_ITEM_HEADER", "LINE_ITEM_PRODUCT_TOKEN"]));
  });

  it("does not create false line-total warnings from Turkish receipt metadata lines", () => {
    const result = extractReceiptFieldsFromText({
      now: new Date("2026-06-04T12:00:00.000Z"),
      text: [
        "SPENDLENS MARKET SANDBOX",
        "FİŞ NO: SL-2026-0001",
        "TARİH; 02.06.2026",
        "SAAT: 11:20",
        "VKN: 1111111111",
        "ÜRÜN KDV TUTAR",
        "EKMEK %1 20,00TL",
        "SÜT %10 32,50TL",
        "KAHVE %20 12,00TL",
        "ARA TOPLAM 64,50 TL",
        "KDV 7,55 TL",
        "GENEL TOPLAM 72,05 TL",
        "ODEME: KART",
        "PARA BİRİMİ: TRY /TL"
      ].join("\n")
    });

    expect(result.documentType).toBe("retail_receipt");
    expect(result.documentTypeConfidence).toBeGreaterThan(0.7);
    expect(result.subtotal?.amountMinor).toBe(6450n);
    expect(result.taxTotal?.amountMinor).toBe(755n);
    expect(result.total?.amountMinor).toBe(7205n);
    expect(result.lineItems.map((item) => item.name)).toEqual(["EKMEK", "SÜT", "KAHVE"]);
    expect(result.validationIssues.map((issue) => issue.code)).not.toContain("LINE_TOTAL_MISMATCH");
  });

  it("extracts quantity and unit price without polluting the product name", () => {
    const result = extractReceiptFieldsFromText({
      text: [
        "MAVI MARKET",
        "FIS NO: TR-12345",
        "TARIH: 12.05.2026",
        "SÜT %10 2 x 16,25 TL 32,50 TL",
        "GENEL TOPLAM 32,50 TL"
      ].join("\n")
    });

    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0]).toMatchObject({ name: "SÜT", quantity: "2" });
    expect(result.lineItems[0]?.unitPrice?.amountMinor).toBe(1625n);
    expect(result.lineItems[0]?.total.amountMinor).toBe(3250n);
  });

  it("prefers a labeled invoice seller and extracts quantity before VAT", () => {
    const result = extractReceiptFieldsFromText({
      text: [
        "SPENDLENS FATURA SANDBOX",
        "FATURA NO: SLF202600001",
        "TARİH: 02.06.2026",
        "SATICI: SPENDLENS MARKET SANDBOX",
        "HİZMET / ÜRÜN MİKTAR KDV TUTAR",
        "Ofis kırtasiye 1 %20 420,00 TL",
        "ARA TOPLAM 420,00 TL",
        "KDV 84,00 TL",
        "GENEL TOPLAM 00,0 TL"
      ].join("\n")
    });

    expect(result.merchantName).toBe("SPENDLENS MARKET SANDBOX");
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0]).toMatchObject({ name: "Ofis kırtasiye", quantity: "1", unitPrice: null });
    expect(result.lineItems[0]?.total.amountMinor).toBe(42000n);
    expect(result.total?.amountMinor).toBe(50400n);
    expect(result.fieldEvidence.find((field) => field.fieldName === "total")?.source).toBe("heuristic");
  });

  it("does not replace a plausible explicit total with arithmetic", () => {
    const result = extractReceiptFieldsFromText({
      text: "MAVI MARKET\nTARIH 12.05.2026\nARA TOPLAM 500,00 TL\nKDV 100,00 TL\nGENEL TOPLAM 700,00 TL"
    });

    expect(result.total?.amountMinor).toBe(70000n);
    expect(result.fieldEvidence.find((field) => field.fieldName === "total")?.source).toBe("normalized_ocr_text");
    expect(result.validationIssues.map((issue) => issue.code)).toContain("SUBTOTAL_TAX_TOTAL_MISMATCH");
  });

  it("classifies bank transfer receipts without treating timestamps as totals", () => {
    const result = extractReceiptFieldsFromText({
      now: new Date("2026-06-04T12:00:00.000Z"),
      text: [
        "Ziraat Bankasi",
        "HESAPTAN FAST",
        "Islem Yeri: Internet Subesi",
        "Islem Tarihi: 04042023.221613",
        "Islem Tutan: 640,00 TRY - Komisyon: 3,61 TRY",
        "Hesabinizla 644,00 TL cekilmistir",
        "Alici IBAN: TR000000000000000000000000"
      ].join("\n")
    });

    expect(result.documentType).toBe("bank_transfer_receipt");
    expect(result.documentTypeConfidence).toBeGreaterThan(0.7);
    expect(result.total?.amountMinor).toBe(64000n);
    expect(result.total?.amountMinor).not.toBe(404202322n);
    expect(result.lineItems).toEqual([]);
    expect(result.validationIssues.map((issue) => issue.code)).toContain("NON_EXPENSE_DOCUMENT");
    expect(result.validationIssues.map((issue) => issue.code)).not.toContain("LINE_TOTAL_MISMATCH");
  });

  it("handles noisy bank transfer OCR without trusting date or reference numbers", () => {
    const result = extractReceiptFieldsFromText({
      now: new Date("2026-06-09T12:00:00.000Z"),
      text: [
        "Ü Ziraat Bankası",
        "HESAPTAN FAST",
        "İŞLEMTARİYİ + 04042023.221613-F24854",
        "Fast Sorgu No : 1270721482",
        "İşlem Tutan : 640,00 TRY -",
        "Komisyon : 3,61 TRY BSMV: 0,18 TRY Mesg Ücreti: 0,21 TRY",
        "Toplem Masraf: 4,00 TRY",
        "Hesabınızla 644,00 TL Çekilmiştir"
      ].join("\n")
    });

    expect(result.documentType).toBe("bank_transfer_receipt");
    expect(result.total?.amountMinor).toBe(64000n);
    expect(result.total?.amountMinor).not.toBe(404202322n);
    expect(result.lineItems).toEqual([]);
    expect(result.validationIssues.map((issue) => issue.code)).toContain("NON_EXPENSE_DOCUMENT");
    expect(result.validationIssues.map((issue) => issue.code)).not.toContain("LINE_TOTAL_MISMATCH");
  });

  it("classifies payment proof OCR as non-standard and blocks silent totals", () => {
    const result = extractReceiptFieldsFromText({
      now: new Date("2026-06-09T12:00:00.000Z"),
      text: [
        "VakıfBank Bankaalice",
        "KART SAHİBİ AD-SOYAD MUSTAFA ARİ",
        "İŞLEM TARİM 20210004811120604",
        "İSLEMNO 20210600488120604",
        "KARE ODEMESI YAPILMIŞTIR.",
        "Dekont bilgilendirme amaçlıdır."
      ].join("\n")
    });

    expect(result.documentType).toBe("payment_proof");
    expect(result.total).toBeNull();
    expect(result.validationIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["MISSING_TOTAL", "MISSING_DATE", "NON_EXPENSE_DOCUMENT"])
    );
  });

  it("does not use a transaction identifier suffix as a payment-proof total", () => {
    const result = extractReceiptFieldsFromText({
      now: new Date("2026-08-15T12:00:00.000Z"),
      text: [
        "VakıfBank",
        "KART SAHİBİ AD-SOYAD MUSTAFA ARİ",
        "TuTAR zocen0 İŞLEMNO 2021000480120604",
        "KARE ODEMESI YAPILMIŞTIR.",
        "Dekont bilgilendirme amaçlıdır."
      ].join("\n")
    });

    expect(result.documentType).toBe("payment_proof");
    expect(result.total).toBeNull();
    expect(result.fieldEvidence.find((field) => field.fieldName === "total")).toBeUndefined();
    expect(result.validationIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["MISSING_TOTAL", "MISSING_DATE", "NON_EXPENSE_DOCUMENT"])
    );
  });

  it("does not treat a six-digit reference after an amount label as an implicit total", () => {
    const result = extractReceiptFieldsFromText({
      text: "VakıfBank\nKARE ODEMESI\nTUTAR okunamadı REFERANS 120604\nDekont"
    });

    expect(result.documentType).toBe("payment_proof");
    expect(result.total).toBeNull();
  });

  it("classifies invoice-like OCR and extracts ambiguous visible invoice total with review signals", () => {
    const result = extractReceiptFieldsFromText({
      now: new Date("2026-06-09T12:00:00.000Z"),
      text: [
        "dg ÖRNEK FATURA",
        "Seri-Sira No A4",
        "Aydin V.D. Tarih 05/21/2026",
        "Cinsi Miktarı Fiyatı(t) Tutari(t)",
        "| Uriin1 1 50 50",
        "| Ürün2 | 4 | 100 | 400 |",
        "Ürün3 2 80 160 .",
        "Toplam #610",
        "Genel Toplam %610"
      ].join("\n")
    });

    expect(result.documentType).toBe("invoice");
    expect(result.date).toBe("2026-05-21");
    expect(result.total?.amountMinor).toBe(61000n);
    expect(result.validationIssues.map((issue) => issue.code)).not.toContain("NON_EXPENSE_DOCUMENT");
  });

  it("reports extraction validation issues for risky OCR output", () => {
    const result = extractReceiptFieldsFromText({
      now: new Date("2026-05-12T12:00:00.000Z"),
      text: ["TARIH 13.05.2026", "KALEM 10,00", "TOPLAM 30,00"].join("\n"),
      tokens: [{ text: "noise", confidence: 0.2, bbox: [0, 0, 1, 1] }]
    });

    expect(result.validationIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["MISSING_MERCHANT", "FUTURE_DATE", "LOW_OCR_CONFIDENCE", "NON_EXPENSE_DOCUMENT"])
    );
  });

  it("marks high-confidence garbage Custom OCR receipt text as review-blocking", () => {
    const result = extractReceiptFieldsFromText({
      now: new Date("2026-06-25T12:00:00.000Z"),
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
      ].join("\n"),
      tokens: [{ text: "KZV", confidence: 0.8072, bbox: [0, 0, 10, 10] }]
    });

    expect(result.total?.amountMinor).toBe(2223n);
    expect(result.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MISSING_DATE", severity: "critical" }),
        expect.objectContaining({ code: "GARBAGE_OCR_TEXT", severity: "critical" }),
        expect.objectContaining({ code: "CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE", severity: "critical" })
      ])
    );
  });

  it("compares OCR engines and records field provenance", () => {
    const tesseractExtraction = extractReceiptFieldsFromText({
      now: new Date("2026-05-12T12:00:00.000Z"),
      text: ["MAVI MARKET", "TARIH 12.05.2026", "TOPLAM 72,05 TL"].join("\n")
    });
    const customExtraction = extractReceiptFieldsFromText({
      now: new Date("2026-05-12T12:00:00.000Z"),
      text: ["MAVI MARKET", "TARIH 12.05.2026", "TOPLAM 72,05 TL"].join("\n")
    });

    const comparison = compareOcrEngineRuns({
      groundTruthText: "MAVI MARKET TARIH 12.05.2026 TOPLAM 72,05 TL",
      runs: [
        { engine: "TESSERACT", text: "MAVI MARKET TARIH 12.05.2026 TOPLAM 72,05 TL", confidence: 0.82, latencyMs: 410, extracted: tesseractExtraction },
        { engine: "CUSTOM_CRNN", text: "MAVI MARKET TARIH 12.05.2026 TOPLAM 72,05 TL", confidence: 0.63, latencyMs: 120, extracted: customExtraction }
      ]
    });

    const totalDecision = comparison.fieldDecisions.find((decision) => decision.field === "total");
    expect(comparison.selectedEngine).toBe("TESSERACT");
    expect(comparison.selectionReason).toBe("selected-by-extraction-readiness-and-ocr-confidence");
    expect(comparison.selectionScores).toHaveLength(2);
    expect(comparison.conflictFields).toEqual([]);
    expect(totalDecision?.status).toBe("exact_match");
    expect(totalDecision?.value).toBe("7205 TRY");
    expect(comparison.characterErrorRate).toBe(0);
    expect(comparison.wordErrorRate).toBe(0);
  });

  it("flags conflicting OCR field candidates", () => {
    const first = extractReceiptFieldsFromText({
      now: new Date("2026-05-12T12:00:00.000Z"),
      text: ["MAVI MARKET", "TARIH 12.05.2026", "TOPLAM 72,05 TL"].join("\n")
    });
    const second = extractReceiptFieldsFromText({
      now: new Date("2026-05-12T12:00:00.000Z"),
      text: ["MAVI MARKET", "TARIH 12.05.2026", "TOPLAM 79,05 TL"].join("\n")
    });

    const comparison = compareOcrEngineRuns({
      runs: [
        { engine: "TESSERACT", text: "TOPLAM 72,05 TL", confidence: 0.76, extracted: first },
        { engine: "CUSTOM_CRNN", text: "TOPLAM 79,05 TL", confidence: 0.78, extracted: second }
      ]
    });

    expect(comparison.conflictFields).toContain("total");
    expect(comparison.fieldDecisions.find((decision) => decision.field === "total")?.status).toBe("conflict");
    expect(calculateCharacterErrorRate("abc", "axc")).toBeCloseTo(1 / 3);
    expect(calculateWordErrorRate("a b", "a c")).toBeCloseTo(1 / 2);
  });

  it("selects the OCR run with usable extraction fields over raw confidence alone", () => {
    const highConfidenceButIncomplete = extractReceiptFieldsFromText({
      now: new Date("2026-06-10T12:00:00.000Z"),
      text: ["MAVI MARKET", "TARIH 10.06.2026", "OCR OKUNDU"].join("\n")
    });
    const lowerConfidenceButUsable = extractReceiptFieldsFromText({
      now: new Date("2026-06-10T12:00:00.000Z"),
      text: ["MAVI MARKET", "TARIH 10.06.2026", "TOPLAM 72,05 TL"].join("\n")
    });

    const comparison = compareOcrEngineRuns({
      runs: [
        { engine: "TESSERACT", text: "MAVI MARKET\nTARIH 10.06.2026\nOCR OKUNDU", confidence: 0.95, extracted: highConfidenceButIncomplete },
        { engine: "CUSTOM_CRNN", text: "MAVI MARKET\nTARIH 10.06.2026\nTOPLAM 72,05 TL", confidence: 0.68, extracted: lowerConfidenceButUsable }
      ]
    });

    expect(comparison.selectedEngine).toBe("CUSTOM_CRNN");
    expect(comparison.selectedText).toContain("TOPLAM 72,05 TL");
    expect(comparison.selectionScores.find((score) => score.engine === "TESSERACT")?.missingCriticalFields).toContain("total");
    expect(comparison.selectionReason).toBe("selected-by-extraction-readiness-and-ocr-confidence");
  });

  it("penalizes high-confidence OCR mismatch and low snippet recall when ground truth exists", () => {
    const garbageCustomExtraction = extractReceiptFieldsFromText({
      now: new Date("2026-06-25T12:00:00.000Z"),
      sourceEngine: "CUSTOM_CRNN",
      text: ["KZV ATTİİ ARKET0 İ", "MAVI KIR EMET TOPLAM 22,23 T TL"].join("\n")
    });
    const tesseractExtraction = extractReceiptFieldsFromText({
      now: new Date("2026-06-25T12:00:00.000Z"),
      text: ["SPENDLENS MARKET", "TARIH 02.06.2026", "GENEL TOPLAM 72,05 TL"].join("\n")
    });

    const comparison = compareOcrEngineRuns({
      groundTruthText: "SPENDLENS MARKET TARIH 02.06.2026 GENEL TOPLAM 72,05 TL",
      runs: [
        { engine: "CUSTOM_CRNN", text: garbageCustomExtraction.normalizedText, confidence: 0.8072, extracted: garbageCustomExtraction },
        { engine: "TESSERACT", text: tesseractExtraction.normalizedText, confidence: 0.72, extracted: tesseractExtraction }
      ]
    });

    const customScore = comparison.selectionScores.find((score) => score.engine === "CUSTOM_CRNN");
    expect(comparison.selectedEngine).toBe("TESSERACT");
    expect(customScore?.issueCodes).toEqual(expect.arrayContaining(["LOW_SNIPPET_RECALL", "HIGH_CONFIDENCE_OCR_MISMATCH"]));
    expect(customScore?.snippetRecall).toBeLessThan(0.4);
    expect(customScore?.characterErrorRate).toBeGreaterThan(0.5);
  });

  it("predicts local expense categories with explainable keyword evidence", () => {
    const prediction = predictExpenseCategory({
      title: "Shell akaryakit fis",
      merchantName: "Shell",
      amountMinor: 125000n,
      occurredAt: new Date("2026-05-12T10:00:00.000Z"),
      lineItemNames: ["motorin"]
    });

    expect(prediction.categoryKey).toBe("akaryakit");
    expect(prediction.confidence).toBeGreaterThan(0.6);
    expect(prediction.matchedKeywords).toEqual(expect.arrayContaining(["shell", "motorin"]));
    expect(prediction.reasons.join(" ")).toContain("local heuristic");
  });

  it("detects explainable expense anomaly reasons without external services", () => {
    const input = {
      title: "Weekend hotel",
      merchantName: "New Hotel",
      amountMinor: 500000n,
      occurredAt: new Date("2026-05-16T10:00:00.000Z"),
      businessExpense: true
    };
    const peers = [
      { title: "Market", merchantName: "Mavi Market", amountMinor: 10000n, occurredAt: new Date("2026-05-12T10:00:00.000Z") },
      { title: "Taxi", merchantName: "City Taxi", amountMinor: 15000n, occurredAt: new Date("2026-05-13T10:00:00.000Z") },
      { title: "Cafe", merchantName: "Office Cafe", amountMinor: 20000n, occurredAt: new Date("2026-05-14T10:00:00.000Z") },
      { title: "Courier", merchantName: "Aras Kargo", amountMinor: 12000n, occurredAt: new Date("2026-05-15T10:00:00.000Z") },
      { title: "Stationery", merchantName: "Ofis Kirtasiye", amountMinor: 18000n, occurredAt: new Date("2026-05-15T10:00:00.000Z") }
    ];

    const anomalies = detectExpenseAnomalies(input, peers);
    expect(anomalies.map((anomaly) => anomaly.code)).toEqual(
      expect.arrayContaining(["UNUSUALLY_HIGH_AMOUNT", "WEEKEND_BUSINESS_EXPENSE", "UNUSUAL_MERCHANT"])
    );
  });
});
