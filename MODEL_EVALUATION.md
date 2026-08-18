# Model Evaluation

This document defines how Custom OCR models are evaluated and why results are reported honestly. Custom OCR evaluation is intentionally separate from Tesseract: Tesseract may be benchmarked as a baseline, but its output is **never** used as ground truth for Custom OCR.

## Current Gate Status

The latest real-fixture quality gate (last recheck) **failed**. The runnable checkpoint is therefore **not active** and **not eligible for promotion**; `pnpm custom-ocr:bootstrap` keeps matching registry rows `FAILED` with `qualityGatePassed: false` and `realFixtureBenchmarkStatus: failed`. Historical passed reports are superseded and must not be used as a promotion claim.

The quality gate checks on real (non-synthetic) Turkish fixture documents:

| Gate | Latest result |
| --- | ---: |
| CER (character error rate) | `0.543983` |
| WER (word error rate) | `0.957640` |
| Snippet recall | `0.237037` |
| Token precision / recall / F1 | `0.108 / 0.118 / 0.112` |
| Turkish-special character F1 | `0.563848` |
| Field precision / recall / F1 | `0.463 / 0.463 / 0.463` |
| Line-item amount recall | `0.0` |
| High-confidence-wrong count | `0` |
| Average calibrated confidence | `0.218644` |

Reasons: `CER_TOO_HIGH`, `SNIPPET_RECALL_TOO_LOW`, `FIELD_F1_TOO_LOW`, `TURKISH_SPECIAL_CHARACTER_F1_TOO_LOW`, `LINE_ITEM_AMOUNT_RECALL_TOO_LOW`, `LOW_REAL_DOCUMENT_CONFIDENCE`.

**Consequence:** Custom OCR is an experimental component. Tesseract remains the production baseline for document OCR, and the product routes uncertain outputs to human review regardless of engine.

## Metrics

Implemented custom OCR metrics:

- CER and WER (`evaluate.py`, `benchmark.py`),
- exact line match rate (`evaluate.py`),
- Turkish special character accuracy with support count,
- per-character confusion rows including deletions and insertions,
- confidence calibration buckets (sample count, exact-match rate, average CER),
- failure counts and latency per benchmark sample,
- generated-document field extraction accuracy for merchant, date, document number, currency, subtotal, KDV/tax, total and payment method,
- Character CNN metrics: top-1/top-3 accuracy, macro F1, per-character precision/recall/F1 and confusion matrix,
- CRNN+CTC training metrics: per-epoch validation history, best validation CER, final validation CER/WER/confidence/Turkish metrics,
- training control metrics: batch size, learning rate, completed epochs, early stopping and whether it fired,
- CTC decoder metadata (`greedy` or `beam` and beam width),
- dynamic line-width handling with batch padding and per-sample CTC input-length validation,
- local model registry metadata for `CUSTOM_CRNN` and `CUSTOM_CHAR_CNN` READY artifacts,
- engine sections for `CUSTOM_OCR`, `FOURIER_BASELINE` and `CRNN_RECOGNIZER`,
- JSON and Markdown benchmark summaries.

The broader product extraction pipeline also records field decisions, source engine, field confidence and validation issues.

## Evaluation Commands

```bash
python -m services.ocr.benchmarks.ocr_benchmark --dataset-mode real_fixtures --data-dir data/demo-fixtures --output-dir artifacts/benchmarks/custom-ocr-real-fixtures --checkpoint artifacts/models/crnn-length-aware/model.pt --split all --skip-tesseract
python -m services.ocr.custom_model.evaluate --profile local_full --model custom_crnn --decoder beam --beam-width 8
python -m services.ocr.custom_model.benchmark --profile local_full --decoder beam --beam-width 8
```

## Honesty Rules

- Synthetic validation metrics are never presented as production accuracy.
- A real-fixture benchmark must match the exact recognizer checkpoint, numeric helper, character helper and current implementation SHA-256 fingerprints before activation.
- Failed gates keep models blocked; passing synthetic metrics alone cannot activate a model.
- Raw and normalized measurements stay separate in every report.
- Low-confidence or fallback-assisted results remain visible and enter review rather than being silently accepted.
