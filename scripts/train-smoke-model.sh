#!/usr/bin/env sh
set -eu
python -m services.ocr.custom_model.train --samples "${SAMPLES:-32}" --epochs "${EPOCHS:-1}"
