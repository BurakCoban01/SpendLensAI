# OCR Service (Python)

Local Python OCR service: document preprocessing, the Tesseract engine and the project-owned Custom OCR (CRNN/CTC) pipeline. Runs on port `18622` (Docker: `ocr-service:8000`).

## Layout

| Path | Responsibility |
| --- | --- |
| `app/` | FastAPI service: `main.py`, `preprocessing.py`, `tesseract_engine.py` |
| `custom_model/` | Project-owned OCR: vocabulary, segmentation, CRNN/CTC, character CNNs, inference, training, evaluation, benchmark |
| `benchmarks/` | Benchmark harnesses: golden datasets, real fixtures, recognizer comparison, router evaluation |
| `category_model/` | Deterministic local expense category/anomaly model |
| `tests/` | Python unit tests (`python -m unittest discover services/ocr/tests`) |

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /ocr/tesseract` | Tesseract OCR with preprocessing profiles and PDF page splitting |
| `POST /ocr/custom-crnn` | Custom OCR inference (active registry checkpoint) |
| `POST /preprocess` | Preprocess-only worker endpoint |
| `GET /health/live` | Liveness probe |

## Custom OCR Pipeline

The custom engine is an independent OCR path — it never calls Tesseract or any other ready-made OCR engine.

```text
image/PDF → preprocessing → segmentation → CRNN line recognition
→ CTC decoding (greedy/beam) → Fourier/cosine fallback → raw text
→ optional numeric-field CNN assistance → tokens + confidence + warnings
```

It is **experimental**: activation in the product requires a passing inference smoke test and matching real-fixture benchmark evidence (see [MODEL_EVALUATION.md](../../MODEL_EVALUATION.md)).

## Training & Benchmarking

```bash
# Character CNN and CRNN training
python -m services.ocr.custom_model.train_char_cnn --profile local_full
python -m services.ocr.custom_model.train_crnn --profile local_full --batch-size 4 --learning-rate 0.001 --early-stopping-patience 2

# Evaluate / benchmark / infer
python -m services.ocr.custom_model.evaluate --profile local_full --model custom_crnn --decoder beam --beam-width 8
python -m services.ocr.custom_model.benchmark --profile local_full --decoder beam --beam-width 8
python -m services.ocr.custom_model.infer --checkpoint artifacts/models/custom-crnn-local-full/model.pt --image path/to/sample.png --decoder beam --beam-width 8

# Golden / real-fixture benchmarks
python -m services.ocr.benchmarks.ocr_benchmark --dataset-mode golden --samples 6 --output-dir artifacts/benchmarks/golden-smoke
python -m services.ocr.benchmarks.ocr_benchmark --dataset-mode real_fixtures --data-dir data/demo-fixtures --output-dir artifacts/benchmarks/custom-ocr-real-fixtures
```

Full pipeline tests: `pnpm test:custom-ocr`.

## Docker

```bash
docker compose --profile app up --build ocr-service
```

The image mounts `./artifacts` and `./data/generated` so local checkpoints and generated datasets stay on the host. See [CUSTOM_OCR_MODEL.md](../../CUSTOM_OCR_MODEL.md) and [CUSTOM_OCR_DEVELOPMENT_GUIDE.md](../../CUSTOM_OCR_DEVELOPMENT_GUIDE.md) for details.
