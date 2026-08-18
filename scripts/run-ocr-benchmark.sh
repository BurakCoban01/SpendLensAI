#!/usr/bin/env sh
set -eu
python -m services.ocr.benchmarks.ocr_benchmark "$@"
