#!/usr/bin/env sh
set -eu
python -m services.ocr.category_model.evaluate \
  --data-path "${DATA_PATH:-data/generated/category-smoke/expenses.csv}" \
  --model-path "${MODEL_PATH:-artifacts/models/category-smoke/category_model.joblib}" \
  --split "${SPLIT:-test}" \
  --report-path "${REPORT_PATH:-artifacts/models/category-smoke/evaluation.json}"

