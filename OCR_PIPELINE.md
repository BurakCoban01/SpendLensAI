# OCR Pipeline

Pipeline target:

1. Upload and validate document.
2. Preserve original file in MinIO.
3. Preprocess pages with profile-specific image cleanup.
4. Run Tesseract and/or custom CRNN.
5. Store engine runs, tokens, confidence scores and raw artifacts.
6. Extract structured receipt/invoice fields.
7. Send low-confidence or conflicting fields to review.
8. Convert approved corrections into annotations and dataset items.

The first implemented code lives in `services/ocr/app` and `services/ocr/custom_model`.

## Preprocessing Profiles

`services/ocr/app/preprocessing.py` currently supports:

- `DEFAULT`
- `TESSERACT_OPTIMIZED`
- `CUSTOM_MODEL_OPTIMIZED`
- `LOW_LIGHT`
- `THERMAL_RECEIPT`
- `CRUMPLED_RECEIPT`

Each run writes a processed PNG artifact and returns decisions for EXIF transpose, source/output dimensions, grayscale conversion, contrast, blur score, low-quality flag, denoise strength, shadow reduction, contrast normalization, receipt boundary estimate, crop decision, adaptive threshold, deskew angle and quality score.

Current preprocessing tests are synthetic fixture tests:

```bash
python -m unittest discover services/ocr/tests
```

Pending work: PDF page splitting, persisted preprocessing artifacts linked to `DocumentPage`, comparison UI for original vs processed images and production runtime verification inside Docker.

## OCR Comparison And Ensemble Foundation

`packages/shared/src/ensemble.ts` provides the first deterministic comparison layer for Tesseract and custom CRNN outputs. It accepts OCR run candidates with raw text, confidence, latency, failure state and optional extracted fields.

Current behavior:

- selects the strongest successful text run with confidence and validation penalties
- penalizes Custom OCR runs whose extracted fields contain critical OCR/extraction issues
- computes average confidence, average latency and failure rate
- computes character error rate and word error rate when ground-truth text is available
- compares extracted merchant/date/time/currency/money/payment/receipt fields
- records field provenance with source engine, confidence and validation penalty
- flags conflicting field values for later human review

The API persistence layer is implemented in `apps/api/src/modules/ocr-comparison`:

- `POST /documents/:id/ocr-runs/compare` persists an `OCRJob`, per-engine `OCREngineRun` records and one `ENSEMBLE` run.
- `GET /documents/:id/ocr-runs` lists stored OCR jobs and runs for a tenant-scoped document.
- Prisma-backed persistence writes an `OCRConfidenceScore` for the ensemble average and an `ocr.ensemble.completed` audit log.
- In-memory persistence covers route tests without requiring PostgreSQL.

Background workers now invoke this after OCR jobs. If `ocr.custom_crnn` returns low-real-document confidence or critical extraction issues, the OCR job may still persist the raw result for review, but the worker does not automatically enqueue normal extraction. Expense creation also rejects critical OCR/extraction issues, so a noisy merchant line plus a random total cannot become a normal expense.

Custom OCR activation is additionally gated before the worker can use it. `pnpm custom-ocr:bootstrap` requires smoke snippet recall, a loadable checkpoint, vocabulary metadata, and current real-fixture validation. The 2026-06-30 ensemble passed the strict 9-fixture gate with CER `0.067689` error, WER `0.143414` error, token F1 `0.851648`, Turkish-special F1 `0.944400`, field F1 `0.962963`, line-item amount recall `0.888889`, and zero high-confidence-wrong outputs. It is active; smoke, synthetic-only, missing-artifact, and failed-gate candidates remain non-promotable.

The worker stores raw and normalized text separately, carries warning/quality state into extraction, and blocks normal extraction/expense creation for critical OCR or extraction issues. Passing the bounded fixture gate does not bypass per-document review rules for noisy or unknown uploads.
