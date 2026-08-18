import { afterEach, describe, expect, it, vi } from "vitest";

import { OcrServiceCustomCrnnClient } from "./preprocessing-client";

describe("OcrServiceCustomCrnnClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps Custom OCR raw text as the workflow OCR text while preserving normalized text in metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: "TOPLAM 646,9 TL",
          normalized_text: "TOPLAM 946,59 TL",
          confidence: 0.81,
          actual_engine_used: "CUSTOM_OCR",
          model_version: "custom-crnn-v1",
          vocab_version: "tr-finance-v1",
          warnings: ["CUSTOM_OCR_NUMERIC_FIELD_ASSIST_USED"],
          tokens: [],
          pages: []
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OcrServiceCustomCrnnClient("http://ocr-service:8000");

    const result = await client.recognize({
      filename: "fis.png",
      mimeType: "image/png",
      buffer: Buffer.from("fixture"),
      checkpoint: "artifacts/models/custom/model.pt"
    });

    expect(result.text).toBe("TOPLAM 646,9 TL");
    expect(result.metadata).toMatchObject({
      rawText: "TOPLAM 646,9 TL",
      normalizedText: "TOPLAM 946,59 TL",
      actualEngineUsed: "CUSTOM_OCR",
      modelVersion: "custom-crnn-v1",
      vocabVersion: "tr-finance-v1"
    });
    expect(result.warnings).toEqual(["CUSTOM_OCR_NUMERIC_FIELD_ASSIST_USED"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("checkpoint=artifacts%2Fmodels%2Fcustom%2Fmodel.pt");
  });
});
