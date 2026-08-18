#!/usr/bin/env sh
set -eu
python -m services.ocr.custom_model.train --samples 8 --epochs 0 --data-dir data/generated/ocr-tiny
