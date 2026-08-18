#!/usr/bin/env sh
set -eu
pnpm install --frozen-lockfile=false
pnpm db:generate
pnpm lint
pnpm typecheck
pnpm test
python -m compileall services
python -m unittest discover services/ocr/tests
