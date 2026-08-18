# Custom OCR Model

SpendLens AI ships two independent OCR engines:

- **Tesseract** — the production baseline, fully integrated with preprocessing and extraction.
- **Custom OCR** — a project-owned, trainable CRNN/CTC pipeline under `services/ocr/custom_model/`. It does **not** call Tesseract, pytesseract, external OCR APIs or ready-made OCR models.

This document describes the custom engine's architecture, training commands and honest evaluation status. See [CUSTOM_OCR_DEVELOPMENT_GUIDE.md](CUSTOM_OCR_DEVELOPMENT_GUIDE.md) for a step-by-step developer guide.

## Status Summary

- The custom OCR pipeline is **experimental / research-grade**. Tesseract remains the recommended engine for production-like use.
- A model can only be activated in the product through `pnpm custom-ocr:bootstrap`, which requires a passing inference smoke test **and** matching real-fixture benchmark evidence.
- As of the last real-fixture recheck, **no custom checkpoint has passed the strict quality gate** (CER/WER/field-accuracy targets). The bootstrap therefore keeps matching registry rows `FAILED` with `qualityGatePassed: false` instead of leaving an unsafe model active.
- Low-quality custom OCR output is still stored with low-confidence review gates; it never bypasses extraction review or expense creation checks.

## Architecture

| File | Responsibility |
| --- | --- |
| `vocab.py` | Central Turkish finance vocabulary and `VOCAB_VERSION`. |
| `normalization.py` | Preserves raw OCR output; normalization only happens for downstream extraction. |
| `preprocessing.py`, `image_ops.py` | Grayscale, thresholding, denoising, deskew estimation, page quality metrics. |
| `segmentation.py` | Text region / line / word / character-box detection with Turkish diacritic merge logic and page rule-line removal. |
| `boundary.py`, `fourier_features.py`, `classical_classifier.py` | Boundary tracing, Fourier descriptors, embeddings and a cosine-similarity fallback path. |
| `char_cnn.py` | CNN character classifier. |
| `numeric_field_recognizer.py` | Separately trained character CNN for finance-field and line-item words; constrained by visible field syntax and format validation. |
| `crnn.py`, `model.py`, `ctc_decoder.py`, `infer.py` | CRNN + CTC line recognizer, greedy and prefix beam-search decoding, document inference pipeline. |
| `line_images.py` | Line-height normalization with dynamic width, stroke-scale preservation and CTC input-length computation. |
| `dataset.py`, `synthetic_documents.py`, `dataset_adapters.py` | Synthetic data generation and guarded public dataset adapters. |
| `train_char_cnn.py`, `train_numeric_char_cnn.py`, `train_crnn.py`, `evaluate.py`, `benchmark.py` | Local training, evaluation and benchmark CLI entry points. |
| `registry.py` | Local model artifact metadata registry (used when no DB-backed registry is configured). |

## Inference Flow

`infer_document()` runs:

1. File loading or PDF page rendering.
2. Custom preprocessing and page quality metrics.
3. Custom line segmentation with page frame/rule-line removal.
4. Document-crop line preparation: tight crops keep their original stroke scale inside a 64px model canvas.
5. CRNN line recognition.
6. CTC decoding (`beam` or `greedy`; beam is the default).
7. Fourier/cosine fallback for low-confidence or implausible CRNN lines.
8. Raw text preservation.
9. Optional segmented numeric-field CNN assistance in normalized text only.
10. Line/character token evidence.
11. Warnings such as `CUSTOM_OCR_LOW_CONFIDENCE` and `CUSTOM_OCR_FOURIER_FALLBACK_USED`.

The API endpoint `POST /ocr/custom-crnn` returns engine metadata, `model_version`, `vocab_version`, quality metrics, a segmentation manifest, pages and tokens. The worker job `ocr.custom_crnn` resolves an **active, real-fixture-validated** registry model or fails with `CUSTOM_OCR_ACTIVE_MODEL_NOT_FOUND`.

## Training

Synthetic line images are rendered wide enough for their text up to a configured cap, tensors preserve aspect ratio at 64px height, and the collate function pads batches to the widest line. CTC input lengths are computed from each padded line after the two CNN pooling stages, and training fails explicitly if a target sequence is longer than the available CTC timesteps. The default architecture is `crnn-ctc-v3-length-aware` (temporal downsampling 4); `--temporal-downsample 2` is available as an experimental variant.

```bash
# Character CNN
python -m services.ocr.custom_model.train_char_cnn --profile local_full

# Numeric-field character CNN
python -m services.ocr.custom_model.train_numeric_char_cnn --profile local_full

# CRNN line recognizer
python -m services.ocr.custom_model.train_crnn --profile local_full --batch-size 4 --learning-rate 0.001 --early-stopping-patience 2

# Evaluate and benchmark a checkpoint
python -m services.ocr.custom_model.evaluate --profile local_full --model custom_crnn --decoder beam --beam-width 8
python -m services.ocr.custom_model.benchmark --profile local_full --decoder beam --beam-width 8

# Single-image inference
python -m services.ocr.custom_model.infer --checkpoint artifacts/models/custom-crnn-local-full/model.pt --image path/to/sample.png --decoder beam --beam-width 8
```

Smoke verification commands (tiny profiles, minutes):

```bash
python -m services.ocr.custom_model.train_char_cnn --profile tiny --samples 16 --epochs 1 --artifact-dir artifacts/models/test-cli-char-cnn
python -m services.ocr.custom_model.train_crnn --profile tiny --samples 8 --epochs 1 --artifact-dir artifacts/models/test-cli-crnn --data-dir data/generated/test-cli-crnn
python -m services.ocr.custom_model.evaluate --profile tiny --model custom_crnn --checkpoint artifacts/models/test-cli-crnn/model.pt --data-dir data/generated/test-cli-crnn --split all
```

Full test suite: `pnpm test:custom-ocr`.

## Model Registry And Artifacts

Local training writes ignored artifacts under `artifacts/` and records READY metadata in `local-model-registry.json` next to the artifact directory:

- CRNN training records `CUSTOM_CRNN`, model version, checkpoint path, dataset manifest ID, vocabulary version and validation metrics.
- Character CNN training records `CUSTOM_CHAR_CNN`, model version, checkpoint path, top-k metrics, per-character metrics and confusion matrix.
- `registry.py` exposes `find_ready_model()` so local tooling resolves the latest READY artifact without pretending a missing model succeeded.

## Evaluation Honesty Rules

- Synthetic validation metrics (CER/WER/accuracy on generated data) are **not** treated as production accuracy.
- A real-fixture benchmark must match the exact recognizer checkpoint, numeric helper, character helper and current implementation fingerprint (SHA-256) before a model can be activated.
- Results that fail quality gates remain visible in benchmark reports and are not hidden, but they are never promoted to active status.
