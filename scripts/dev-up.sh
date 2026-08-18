#!/usr/bin/env sh
set -eu
docker compose up -d postgres redis redpanda minio
echo "Base services are starting. Run 'pnpm db:migrate && pnpm db:seed' after Postgres is healthy."
