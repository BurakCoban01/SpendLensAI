#!/usr/bin/env sh
set -eu
docker compose down -v --remove-orphans
rm -rf data/generated artifacts/models
