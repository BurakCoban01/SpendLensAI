#!/usr/bin/env sh
set -eu
python -m services.ocr.category_model.train \
  --samples-per-category "${SAMPLES_PER_CATEGORY:-12}" \
  --seed "${SEED:-42}"

