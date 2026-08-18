#!/usr/bin/env sh
set -eu
python -m services.ocr.custom_model.evaluate --predictions "${1:-artifacts/models/custom-crnn-smoke/predictions.jsonl}"
