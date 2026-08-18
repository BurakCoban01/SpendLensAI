import type { DocumentCustomOcrClient, DocumentOcrToken, DocumentPreprocessingClient, DocumentTesseractOcrClient } from "../documents/service";

export class OcrServicePreprocessingClient implements DocumentPreprocessingClient {
  constructor(private readonly baseUrl: string) {}

  async preprocess(input: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
    profile: string;
  }): Promise<{
    pages: Array<{
      pageNumber: number;
      width?: number | null;
      height?: number | null;
      qualityScore?: number | null;
      mimeType: string;
      processedImageBase64: string;
      decisions?: Record<string, unknown>;
    }>;
  }> {
    if (!this.baseUrl) throw new Error("OCR_PREPROCESSING_CLIENT_NOT_CONFIGURED");
    const form = new FormData();
    const fileBytes = new Uint8Array(input.buffer);
    form.append("file", new Blob([fileBytes], { type: input.mimeType }), input.filename);
    const url = new URL("/preprocess", this.baseUrl);
    url.searchParams.set("profile", input.profile);
    const response = await fetchOcrService(url, { method: "POST", body: form }, "OCR_PREPROCESSING_FAILED");
    if (!response.ok) {
      throw new Error(await formatOcrServiceHttpError(response, "OCR_PREPROCESSING_FAILED"));
    }
    const responseBody = (await response.json()) as {
      pages?: Array<{
        page_number?: number;
        pageNumber?: number;
        output_width?: number | null;
        output_height?: number | null;
        quality_score?: number | null;
        qualityScore?: number | null;
        mime_type?: string;
        mimeType?: string;
        processed_image_base64?: string;
        processedImageBase64?: string;
        preprocessing?: Record<string, unknown>;
        decisions?: Record<string, unknown>;
      }>;
    };
    return {
      pages: (responseBody.pages ?? []).map((page) => ({
        pageNumber: page.pageNumber ?? page.page_number ?? 0,
        width: page.output_width ?? null,
        height: page.output_height ?? null,
        qualityScore: page.qualityScore ?? page.quality_score ?? null,
        mimeType: page.mimeType ?? page.mime_type ?? "image/png",
        processedImageBase64: page.processedImageBase64 ?? page.processed_image_base64 ?? "",
        decisions: page.decisions ?? page.preprocessing ?? {}
      }))
    };
  }
}

export class OcrServiceTesseractClient implements DocumentTesseractOcrClient {
  constructor(private readonly baseUrl: string) {}

  async recognize(input: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
    language: string;
  }): Promise<{
    text: string;
    confidence: number;
    tokens?: DocumentOcrToken[];
    latencyMs?: number;
    warnings?: string[];
    pageCount?: number;
    metadata?: Record<string, unknown>;
  }> {
    if (!this.baseUrl) throw new Error("OCR_TESSERACT_CLIENT_NOT_CONFIGURED");
    const form = new FormData();
    const fileBytes = new Uint8Array(input.buffer);
    form.append("file", new Blob([fileBytes], { type: input.mimeType }), input.filename);
    const url = new URL("/ocr/tesseract", this.baseUrl);
    url.searchParams.set("lang", input.language);
    const startedAt = performance.now();
    const response = await fetchOcrService(url, { method: "POST", body: form }, "OCR_TESSERACT_FAILED");
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (!response.ok) {
      throw new Error(await formatOcrServiceHttpError(response, "OCR_TESSERACT_FAILED"));
    }
    const body = (await response.json()) as {
      text?: string;
      confidence?: number;
      tokens?: unknown[];
      warnings?: string[];
      page_count?: number;
      pageCount?: number;
      attempts?: unknown;
      selected_attempts?: unknown;
      selectedAttempts?: unknown;
      preprocessing_manifests?: unknown;
    };
    const pageCount = body.pageCount ?? body.page_count;
    return {
      text: body.text ?? "",
      confidence: typeof body.confidence === "number" ? body.confidence : 0,
      tokens: parseOcrTokens(body.tokens),
      latencyMs,
      warnings: Array.isArray(body.warnings) ? body.warnings : [],
      metadata: {
        attempts: Array.isArray(body.attempts) ? body.attempts : [],
        selectedAttempts: Array.isArray(body.selectedAttempts)
          ? body.selectedAttempts
          : Array.isArray(body.selected_attempts)
            ? body.selected_attempts
            : [],
        preprocessingManifests: Array.isArray(body.preprocessing_manifests) ? body.preprocessing_manifests : []
      },
      ...(pageCount !== undefined ? { pageCount } : {})
    };
  }
}

export class OcrServiceCustomCrnnClient implements DocumentCustomOcrClient {
  constructor(private readonly baseUrl: string) {}

  async recognize(input: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
    checkpoint: string;
  }): Promise<{
    text: string;
    confidence: number;
    tokens?: DocumentOcrToken[];
    latencyMs?: number;
    warnings?: string[];
    pageCount?: number;
    metadata?: Record<string, unknown>;
  }> {
    if (!this.baseUrl) throw new Error("OCR_CUSTOM_CRNN_CLIENT_NOT_CONFIGURED");
    const form = new FormData();
    const fileBytes = new Uint8Array(input.buffer);
    form.append("file", new Blob([fileBytes], { type: input.mimeType }), input.filename);
    const url = new URL("/ocr/custom-crnn", this.baseUrl);
    url.searchParams.set("checkpoint", input.checkpoint);
    const startedAt = performance.now();
    const response = await fetchOcrService(url, { method: "POST", body: form }, "OCR_CUSTOM_CRNN_FAILED");
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (!response.ok) {
      throw new Error(await formatOcrServiceHttpError(response, "OCR_CUSTOM_CRNN_FAILED"));
    }
    const body = (await response.json()) as {
      text?: string;
      normalized_text?: string;
      confidence?: number;
      tokens?: unknown[];
      warnings?: string[];
      page_count?: number;
      pageCount?: number;
      actual_engine_used?: string;
      quality?: unknown;
      segmentation_manifest?: string;
      model_version?: string;
      vocab_version?: string;
      pages?: unknown;
    };
    const pageCount = body.pageCount ?? body.page_count;
    const rawText = body.text ?? "";
    const normalizedText = body.normalized_text?.trim() ? body.normalized_text : rawText;
    return {
      text: rawText,
      confidence: typeof body.confidence === "number" ? body.confidence : 0,
      tokens: parseOcrTokens(body.tokens),
      latencyMs,
      warnings: Array.isArray(body.warnings) ? body.warnings : [],
      metadata: {
        actualEngineUsed: body.actual_engine_used ?? "CUSTOM_OCR",
        rawText,
        normalizedText,
        quality: body.quality ?? null,
        segmentationManifest: body.segmentation_manifest ?? null,
        modelVersion: body.model_version ?? null,
        vocabVersion: body.vocab_version ?? null,
        pages: Array.isArray(body.pages) ? body.pages : []
      },
      ...(pageCount !== undefined ? { pageCount } : {})
    };
  }
}

async function fetchOcrService(url: URL, init: RequestInit, failureCode: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OCR_SERVICE_UNAVAILABLE:${failureCode}:${url.origin}:${detail}`);
  }
}

async function formatOcrServiceHttpError(response: Response, failureCode: string): Promise<string> {
  const detail = await response.text().catch(() => "");
  const normalizedDetail = detail.trim().replace(/\s+/g, " ").slice(0, 300);
  return normalizedDetail ? `${failureCode}:${response.status}:${normalizedDetail}` : `${failureCode}:${response.status}`;
}

function parseOcrTokens(value: unknown): DocumentOcrToken[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((token): DocumentOcrToken[] => {
    if (!token || typeof token !== "object") return [];
    const row = token as Record<string, unknown>;
    const bbox = row.bbox;
    if (
      typeof row.text !== "string" ||
      typeof row.confidence !== "number" ||
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)
    ) {
      return [];
    }
    const pageNumber = row.pageNumber ?? row.page_number;
    return [
      {
        text: row.text,
        confidence: Math.max(0, Math.min(1, row.confidence)),
        bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        ...(typeof pageNumber === "number" && Number.isInteger(pageNumber) && pageNumber > 0 ? { pageNumber } : {})
      }
    ];
  });
}
