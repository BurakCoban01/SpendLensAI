import {
  compareOcrEngineRuns,
  extractReceiptFieldsFromText,
  type ComparableOcrEngine,
  type CurrencyCode
} from "@spendlens/shared";
import type { AuditRepository } from "../audit/types";
import type { AuthPrincipal } from "../auth/types";
import type { DocumentRepository } from "../documents/types";
import type { OcrCandidateInput, OcrComparisonRepository } from "./types";

export class OcrComparisonError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export class OcrComparisonService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly comparisons: OcrComparisonRepository,
    private readonly audit?: AuditRepository
  ) {}

  async compare(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    runs: OcrCandidateInput[];
    groundTruthText?: string;
    defaultCurrency?: CurrencyCode;
    correlationId?: string | null;
  }) {
    const document = await this.documents.findById(input.principal.tenantId, input.documentFileId);
    if (!document || document.deletedAt) throw new OcrComparisonError("DOCUMENT_NOT_FOUND", 404);
    if (input.runs.length < 1) throw new OcrComparisonError("OCR_RUN_REQUIRED", 400);
    const candidates = input.runs.map((run) => {
      const engine = toComparableOcrEngine(run.engine);
      return {
        engine,
        text: run.text,
        confidence: run.confidence,
        ...(run.latencyMs !== undefined ? { latencyMs: run.latencyMs } : {}),
        ...(run.failed !== undefined ? { failed: run.failed } : {}),
        ...(run.failureReason !== undefined ? { failureReason: run.failureReason } : {}),
        ...(run.failed
          ? {}
          : {
              extracted: extractReceiptFieldsFromText({
                text: run.text,
                sourceEngine: engine,
                defaultCurrency: input.defaultCurrency ?? "TRY"
              })
            })
      };
    });
    const comparison = compareOcrEngineRuns({
      runs: candidates,
      ...(input.groundTruthText !== undefined ? { groundTruthText: input.groundTruthText } : {})
    });
    const persisted = await this.comparisons.createComparison({
      tenantId: input.principal.tenantId,
      documentFileId: document.id,
      candidates: input.runs,
      comparison
    });
    const failedRuns = input.runs.filter((run) => run.failed);
    await this.audit?.create({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "ocr.ensemble.completed",
      resourceType: "OCRJob",
      resourceId: persisted.job.id,
      metadata: {
        documentFileId: document.id,
        selectedEngine: comparison.selectedEngine,
        candidateEngineCount: input.runs.length,
        runCount: persisted.runs.length,
        conflictFieldCount: comparison.conflictFields.length,
        conflictFields: comparison.conflictFields,
        averageConfidence: comparison.averageConfidence,
        selectionReason: comparison.selectionReason,
        selectionScores: comparison.selectionScores,
        failedRunCount: failedRuns.length,
        failedEngines: [...new Set(failedRuns.map((run) => run.engine))],
        failureRate: comparison.failureRate
      },
      correlationId: input.correlationId ?? null
    });
    return persisted;
  }

  async list(principal: AuthPrincipal, documentFileId: string) {
    const document = await this.documents.findById(principal.tenantId, documentFileId);
    if (!document || document.deletedAt) throw new OcrComparisonError("DOCUMENT_NOT_FOUND", 404);
    return this.comparisons.listByDocument(principal.tenantId, document.id);
  }

  async metrics() {
    return this.comparisons.metrics();
  }
}

function toComparableOcrEngine(engine: OcrCandidateInput["engine"]): ComparableOcrEngine {
  if (engine === "TESSERACT" || engine === "CUSTOM_CRNN") return engine;
  throw new OcrComparisonError("OCR_ENGINE_NOT_COMPARABLE", 400);
}
