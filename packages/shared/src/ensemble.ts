import { scoreExtractionReadiness, type ExtractedReceiptFields } from "./extraction";
import { clampConfidence, type OcrEngine } from "./ocr";

export type ComparableOcrEngine = Exclude<OcrEngine, "ENSEMBLE">;

export type OcrEngineCandidate = Readonly<{
  engine: ComparableOcrEngine;
  text: string;
  confidence: number;
  latencyMs?: number;
  failed?: boolean;
  failureReason?: string;
  extracted?: ExtractedReceiptFields;
}>;

export type EnsembleFieldName =
  | "merchantName"
  | "date"
  | "time"
  | "currency"
  | "subtotal"
  | "discount"
  | "taxTotal"
  | "total"
  | "paymentMethod"
  | "cardLast4"
  | "receiptNumber";

export type EnsembleFieldCandidate = Readonly<{
  engine: ComparableOcrEngine;
  value: string;
  confidence: number;
  validationPenalty: number;
}>;

export type EnsembleFieldDecision = Readonly<{
  field: EnsembleFieldName;
  value: string | null;
  sourceEngine: ComparableOcrEngine | "NONE";
  confidence: number;
  status: "missing" | "single_source" | "exact_match" | "conflict";
  candidates: EnsembleFieldCandidate[];
}>;

export type OcrRunSelectionScore = Readonly<{
  engine: ComparableOcrEngine;
  score: number;
  ocrConfidence: number;
  extractionReadiness: number | null;
  criticalIssueCount: number;
  warningIssueCount: number;
  missingCriticalFields: string[];
  issueCodes: string[];
  snippetRecall: number | null;
  characterErrorRate: number | null;
  wordErrorRate: number | null;
}>;

export type OcrComparisonResult = Readonly<{
  selectedText: string;
  selectedEngine: ComparableOcrEngine | "NONE";
  selectionReason: string;
  selectionScores: OcrRunSelectionScore[];
  averageConfidence: number;
  averageLatencyMs: number | null;
  failureRate: number;
  fieldDecisions: EnsembleFieldDecision[];
  conflictFields: EnsembleFieldName[];
  pairwiseTextSimilarity: number | null;
  characterErrorRate: number | null;
  wordErrorRate: number | null;
}>;

const comparableFields: EnsembleFieldName[] = [
  "merchantName",
  "date",
  "time",
  "currency",
  "subtotal",
  "discount",
  "taxTotal",
  "total",
  "paymentMethod",
  "cardLast4",
  "receiptNumber"
];

export function compareOcrEngineRuns(input: {
  runs: readonly OcrEngineCandidate[];
  groundTruthText?: string;
}): OcrComparisonResult {
  const successfulRuns = input.runs.filter((run) => !run.failed);
  const selectionScores = successfulRuns.map((run) => scoreRun(run, input.groundTruthText));
  const selected = selectTextRun(successfulRuns, selectionScores);
  const latencies = successfulRuns.map((run) => run.latencyMs).filter((value): value is number => typeof value === "number");
  const fieldDecisions = comparableFields.map((field) => decideField(field, successfulRuns));
  return {
    selectedText: selected?.text ?? "",
    selectedEngine: selected?.engine ?? "NONE",
    selectionReason: selected ? selectionReason(selected, selectionScores) : "no-successful-ocr-run",
    selectionScores,
    averageConfidence:
      successfulRuns.length === 0
        ? 0
        : clampConfidence(successfulRuns.reduce((sum, run) => sum + clampConfidence(run.confidence), 0) / successfulRuns.length),
    averageLatencyMs: latencies.length === 0 ? null : latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    failureRate: input.runs.length === 0 ? 0 : input.runs.filter((run) => run.failed).length / input.runs.length,
    fieldDecisions,
    conflictFields: fieldDecisions.filter((decision) => decision.status === "conflict").map((decision) => decision.field),
    pairwiseTextSimilarity: calculatePairwiseTextSimilarity(successfulRuns),
    characterErrorRate: input.groundTruthText ? calculateCharacterErrorRate(selected?.text ?? "", input.groundTruthText) : null,
    wordErrorRate: input.groundTruthText ? calculateWordErrorRate(selected?.text ?? "", input.groundTruthText) : null
  };
}

export function calculateCharacterErrorRate(predicted: string, expected: string): number {
  if (expected.length === 0) return predicted.length === 0 ? 0 : 1;
  return levenshtein(normalizeText(predicted), normalizeText(expected)) / normalizeText(expected).length;
}

export function calculateWordErrorRate(predicted: string, expected: string): number {
  const predictedWords = words(predicted);
  const expectedWords = words(expected);
  if (expectedWords.length === 0) return predictedWords.length === 0 ? 0 : 1;
  return levenshteinArray(predictedWords, expectedWords) / expectedWords.length;
}

function selectTextRun(runs: readonly OcrEngineCandidate[], scores: readonly OcrRunSelectionScore[]): OcrEngineCandidate | null {
  if (runs.length === 0) return null;
  const scoresByEngine = new Map(scores.map((score) => [score.engine, score.score]));
  return runs.reduce((best, run) => ((scoresByEngine.get(run.engine) ?? 0) > (scoresByEngine.get(best.engine) ?? 0) ? run : best));
}

function scoreRun(run: OcrEngineCandidate, groundTruthText?: string): OcrRunSelectionScore {
  const ocrConfidence = clampConfidence(run.confidence);
  const comparisonCharacterErrorRate = groundTruthText ? calculateCharacterErrorRate(run.text, groundTruthText) : null;
  const comparisonWordErrorRate = groundTruthText ? calculateWordErrorRate(run.text, groundTruthText) : null;
  const snippetRecall = groundTruthText ? calculateSnippetRecall(run.text, groundTruthText) : null;
  const comparisonIssueCodes = [
    ...(snippetRecall !== null && snippetRecall < 0.4 ? ["LOW_SNIPPET_RECALL"] : []),
    ...(comparisonCharacterErrorRate !== null && comparisonCharacterErrorRate > 0.5 && ocrConfidence >= 0.75 ? ["HIGH_CONFIDENCE_OCR_MISMATCH"] : [])
  ];
  const extractedCriticalCount = run.extracted?.validationIssues.filter((issue) => issue.severity === "critical").length ?? 0;
  const extractedWarningCount = run.extracted?.validationIssues.filter((issue) => issue.severity === "warning").length ?? 0;
  const criticalIssueCount = extractedCriticalCount + comparisonIssueCodes.length;
  const warningIssueCount = extractedWarningCount;
  const missingCriticalFields = missingCriticalExtractionFields(run.extracted);
  const extractionReadiness = run.extracted ? scoreExtractionReadiness(run.extracted) : null;
  const issuePenalty = Math.min(0.72, criticalIssueCount * 0.22 + warningIssueCount * 0.04);
  const score = (extractionReadiness === null ? ocrConfidence * 0.72 : ocrConfidence * 0.36 + extractionReadiness * 0.64) - issuePenalty;
  return {
    engine: run.engine,
    score: clampConfidence(score),
    ocrConfidence,
    extractionReadiness,
    criticalIssueCount,
    warningIssueCount,
    missingCriticalFields,
    issueCodes: [...(run.extracted?.validationIssues.map((issue) => issue.code) ?? []), ...comparisonIssueCodes],
    snippetRecall,
    characterErrorRate: comparisonCharacterErrorRate,
    wordErrorRate: comparisonWordErrorRate
  };
}

function missingCriticalExtractionFields(extracted?: ExtractedReceiptFields): string[] {
  if (!extracted) return ["extraction"];
  const missing: string[] = [];
  if (!extracted.total) missing.push("total");
  if (!extracted.date) missing.push("date");
  if (!extracted.merchantName) missing.push("merchantName");
  return missing;
}

function selectionReason(selected: OcrEngineCandidate, scores: readonly OcrRunSelectionScore[]): string {
  const selectedScore = scores.find((score) => score.engine === selected.engine);
  if (!selectedScore) return "selected-run-score-unavailable";
  if (selectedScore.extractionReadiness === null) return "selected-by-ocr-confidence";
  const hasCriticalFields = selectedScore.missingCriticalFields.length === 0;
  return hasCriticalFields
    ? "selected-by-extraction-readiness-and-ocr-confidence"
    : `selected-with-review-needed-missing:${selectedScore.missingCriticalFields.join(",")}`;
}

function decideField(field: EnsembleFieldName, runs: readonly OcrEngineCandidate[]): EnsembleFieldDecision {
  const candidates = runs.flatMap((run): EnsembleFieldCandidate[] => {
    const value = run.extracted ? serializeFieldValue(run.extracted[field]) : null;
    if (!value) return [];
    return [
      {
        engine: run.engine,
        value,
        confidence: clampConfidence(((run.extracted?.confidence ?? 0) + clampConfidence(run.confidence)) / 2),
        validationPenalty: fieldValidationPenalty(field, run.extracted)
      }
    ];
  });

  if (candidates.length === 0) {
    return { field, value: null, sourceEngine: "NONE", confidence: 0, status: "missing", candidates };
  }

  const grouped = groupCandidates(candidates);
  const bestGroup = grouped.reduce((best, current) => (current.score > best.score ? current : best));
  const hasConflict = grouped.length > 1;
  const exactMatch = bestGroup.candidates.length > 1 && !hasConflict;
  const representative = bestGroup.candidates.reduce((best, current) =>
    current.confidence - current.validationPenalty > best.confidence - best.validationPenalty ? current : best
  );

  return {
    field,
    value: bestGroup.value,
    sourceEngine: representative.engine,
    confidence: clampConfidence(bestGroup.score),
    status: hasConflict ? "conflict" : exactMatch ? "exact_match" : "single_source",
    candidates
  };
}

function groupCandidates(candidates: readonly EnsembleFieldCandidate[]): Array<{ value: string; score: number; candidates: EnsembleFieldCandidate[] }> {
  const groups = new Map<string, EnsembleFieldCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.value.toLocaleLowerCase("tr-TR");
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return Array.from(groups.values()).map((group) => ({
    value: group[0]?.value ?? "",
    score: clampConfidence(group.reduce((sum, item) => sum + item.confidence - item.validationPenalty, 0) / group.length + (group.length > 1 ? 0.1 : 0)),
    candidates: group
  }));
}

function serializeFieldValue(value: ExtractedReceiptFields[EnsembleFieldName]): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && "amountMinor" in value) return `${value.amountMinor.toString()} ${value.currency}`;
  return String(value).trim() || null;
}

function fieldValidationPenalty(field: EnsembleFieldName, extracted?: ExtractedReceiptFields): number {
  if (!extracted) return 0;
  const issueCodes = extracted.validationIssues.map((issue) => issue.code);
  if (field === "total" && issueCodes.includes("MISSING_TOTAL")) return 0.4;
  if (field === "date" && (issueCodes.includes("MISSING_DATE") || issueCodes.includes("FUTURE_DATE"))) return 0.25;
  if (field === "merchantName" && issueCodes.includes("MISSING_MERCHANT")) return 0.2;
  if ((field === "subtotal" || field === "taxTotal" || field === "discount") && issueCodes.includes("SUBTOTAL_TAX_TOTAL_MISMATCH")) return 0.2;
  return 0;
}

function calculatePairwiseTextSimilarity(runs: readonly OcrEngineCandidate[]): number | null {
  if (runs.length < 2) return null;
  const scores: number[] = [];
  for (let left = 0; left < runs.length; left += 1) {
    for (let right = left + 1; right < runs.length; right += 1) {
      const leftText = normalizeText(runs[left]?.text ?? "");
      const rightText = normalizeText(runs[right]?.text ?? "");
      const longest = Math.max(leftText.length, rightText.length);
      scores.push(longest === 0 ? 1 : clampConfidence(1 - levenshtein(leftText, rightText) / longest));
    }
  }
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function calculateSnippetRecall(predicted: string, expected: string): number {
  const predictedWords = new Set(words(predicted).map((word) => word.toLocaleUpperCase("tr-TR")));
  const expectedWords = [...new Set(words(expected).map((word) => word.toLocaleUpperCase("tr-TR")))];
  if (expectedWords.length === 0) return predictedWords.size === 0 ? 1 : 0;
  return expectedWords.filter((word) => predictedWords.has(word)).length / expectedWords.length;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function words(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter(Boolean);
}

function levenshtein(left: string, right: string): number {
  return levenshteinArray([...left], [...right]);
}

function levenshteinArray<T>(left: readonly T[], right: readonly T[]): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j] ?? 0;
  }
  return previous[right.length] ?? 0;
}
