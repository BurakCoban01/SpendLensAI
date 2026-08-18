#!/usr/bin/env sh
set -eu
mkdir -p artifacts/exports
tar -czf artifacts/exports/ocr-dataset.tgz data/generated/ocr-demo
