#!/usr/bin/env sh
set -eu
python -m services.ocr.custom_model.train --samples "${SAMPLES:-64}" --epochs 0 --data-dir data/generated/ocr-demo
