# Dataset And Annotation

This document describes how training data, demo documents, ground truth and human review annotations are produced and managed for the Custom OCR pipeline.

## Generated Data Locations

| Purpose | Path | Tracked in Git |
| --- | --- | --- |
| Synthetic OCR training/validation data | `data/generated/` | No (ignored) |
| Generated demo documents and ground truth | `data/demo-fixtures/` | No (ignored) |
| Public dataset copies | `data/datasets/` | No (ignored) |
| Model checkpoints and benchmark outputs | `artifacts/` | No (ignored) |

`scripts/generate-demo-documents.py` (`pnpm demo:fixtures`) renders synthetic Turkish receipts, invoices and payment proofs (JPEG, WebP, PNG, TIFF, BMP, GIF, PDF) together with JSON ground truth files. `pnpm demo:prepare` then seeds the demo tenant and uploads those fixtures through the real API.

## Synthetic Data

`services/ocr/custom_model/dataset.py` generates:

- isolated character crops for the full OCR vocabulary,
- receipt-like and invoice-like line images,
- full-page receipt/invoice samples,
- train/validation/test split manifests,
- labels with raw rendered text, fields, line items and generated line boxes,
- character variants for plain, rotated, blurred, low-contrast, thermal and noisy crops,
- document variants for thermal, scanned, noisy, rotated, blurred and cropped documents.

The line generator includes Turkish financial anchors such as `FİŞ`, `İZMİR`, `ŞUBE`, `ÖDEME`, `ÖĞRENCİ`, `ÜCRETİ`, `ÇAĞRI MARKET`, `ÖZEL GÜNEŞ ECZANESİ`, `İÇECEK`, `ÖĞLE YEMEĞİ` and `₺`. Anchor placement guarantees at least one Turkish-special-character line in each non-empty split. Document-aware rows (merchant-only lines, `FİŞ NO`, `FATURA NO`, `VKN`, `TARİH`, `KDV`, `TOPLAM`, payment rows) mirror the rendered receipt/invoice families so small local runs still see structured fields.

When `--dataset-mode document_lines` is used, the CRNN trainer also renders `expectedOcrTextSnippets` from the demo ground truth as extra line samples (`project_real_fixture_rendered_snippet`). These are vocabulary exposure rows — never real segmented crops, and never reported as real-document OCR success.

Profiles: `tiny` (fast regression), `demo` (smoke), `benchmark` (medium), `local_full` (primary full profile).

```bash
python -m services.ocr.custom_model.synthetic_documents --profile local_full --mode characters --max-disk-gb 12
python -m services.ocr.custom_model.synthetic_documents --profile local_full --max-disk-gb 12
```

## Public Dataset Adapters

`dataset_adapters.py` records guarded adapter metadata for CORD, SROIE, EMNIST and OCRTurk-style sources. Adapters are optional and explicit:

- They never silently download large or credential-gated datasets.
- Each source must be reviewed for license, size, checksum and Turkish character coverage before use.
- Third-party datasets are **not committed** to this repository; place local copies under `data/datasets/` for experiments.

```bash
pnpm custom-ocr:datasets:inventory
python -m services.ocr.custom_model.dataset_adapters --dataset-root data/datasets --fixture-root data/demo-fixtures --output artifacts/datasets/custom-ocr-dataset-sources.json
```

The inventory manifest records source URL or local note, license note, size, file count, split summary, checksum (when small enough), parseability, imported sample counts, skipped counts/reasons, intended usage and whether Turkish characters are expected.

The CRNN trainer supports `--dataset-mode combined_manifest` with `--combined-manifest-dir artifacts/datasets/custom-ocr`. That mode prepares a training manifest from `line_train.jsonl` / `line_validation.jsonl`, preserves `lineCropBox` evidence, respects the requested `--samples` / `--seed` bound and records `datasetSourceMix` in checkpoint metadata. Non-Turkish sources support pretraining/layout evaluation only and are never reported as Turkish production proof.

**Rule:** Tesseract output is never used as ground truth for the Custom OCR manifests.

## Annotation And Review Data

The application stores human review signal through persisted records:

- `OCRReviewTask` — review queue items (assign, approve, reject),
- `OCRCorrection` — corrected field values with audit history,
- `Annotation` — direct bounding-box annotations with payload history,
- `ActiveLearningSuggestion` — suggestions derived from corrections,
- review tasks, correction history and annotation APIs,
- `dataset_export_jsonl` report export — JSONL manifests with document references, labels, corrections and suggestions.

The review UI provides a real correction/export path. Sensitive production data must pass anonymization policy enforcement before being mixed into broad training data.

## Disk Budget

`local_full` generation/training is heavy. Keep the local footprint within budget:

- generated OCR data: 8-12 GB,
- public dataset imports: 4-8 GB,
- checkpoints: 3-5 GB,
- benchmark outputs: 1-3 GB,
- caches and dependencies: 5-8 GB,
- safety headroom: at least 5 GB.

Check free disk before large generation, training or benchmark runs.
