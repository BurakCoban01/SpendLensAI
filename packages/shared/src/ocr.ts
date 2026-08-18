export const ocrEngines = ["TESSERACT", "CUSTOM_CRNN", "ENSEMBLE"] as const;
export type OcrEngine = (typeof ocrEngines)[number];

export const preprocessingProfiles = [
  "DEFAULT",
  "TESSERACT_OPTIMIZED",
  "CUSTOM_MODEL_OPTIMIZED",
  "LOW_LIGHT",
  "THERMAL_RECEIPT",
  "CRUMPLED_RECEIPT"
] as const;
export type PreprocessingProfile = (typeof preprocessingProfiles)[number];

export type OcrToken = Readonly<{
  text: string;
  confidence: number;
  bbox: readonly [number, number, number, number];
}>;

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function calculateAverageConfidence(tokens: readonly OcrToken[]): number {
  if (tokens.length === 0) return 0;
  return clampConfidence(tokens.reduce((sum, token) => sum + clampConfidence(token.confidence), 0) / tokens.length);
}
