# Tesseract Engine

The OCR Docker image installs `tesseract-ocr`, English and Turkish language packages. The service exposes `/ocr/tesseract` for image OCR and returns normalized text, token bounding boxes and confidence.

Failure handling required by later phases:

- missing binary or language pack
- unsupported image type
- timeout
- empty output
- low confidence

The API must surface failures instead of hiding them.

## Current Engine Contract

`services/ocr/app/tesseract_engine.py` now provides:

- `check_tesseract_availability(lang)` for binary and language-pack readiness
- `run_tesseract(image_path, lang, psm, oem, timeout_seconds)`
- structured `TesseractEngineError` codes:
  - `TESSERACT_BINARY_MISSING`
  - `TESSERACT_LANGUAGE_MISSING`
  - `TESSERACT_TIMEOUT`
  - `TESSERACT_RUNTIME_ERROR`
  - `TESSERACT_EMPTY_OUTPUT`
- token text, normalized confidence and bounding boxes from TSV data
- average confidence and `LOW_CONFIDENCE` warnings

The OCR FastAPI readiness endpoint returns detailed Tesseract availability. `/ocr/tesseract` converts engine failures into explicit HTTP errors with machine-readable codes.

Current tests:

```bash
python -m unittest discover services/ocr/tests
```

Host status on 2026-05-12: `tesseract --version` is not available on this Windows host. Real golden OCR verification must run inside the Docker image that installs Tesseract and language packs.
