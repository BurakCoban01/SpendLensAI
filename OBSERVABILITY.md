# Observability

Implemented foundation:

- JSON logs in API
- request and correlation IDs
- `/metrics` Prometheus text endpoint with API info, process uptime, memory gauges, HTTP request counters, request-duration histogram buckets, event outbox/inbox gauges, optional Kafka consumer lag gauges, worker job and worker failure gauges, cache health/error gauges, object-storage health/error gauges, OCR quality gauges and review correction gauges
- public `/health/live` and `/health/ready`
- permission-protected `/admin/health` with local dependency status for PostgreSQL, Redis, Kafka, MinIO, Tesseract and workers
- permission-protected `/admin/jobs` with durable worker job backlog, status, retry and progress visibility
- permission-protected `/admin/events` with durable event outbox backlog and failed/published state
- permission-protected `/admin/cache` with cache backend health, key TTL summaries and lock probe visibility
- permission-protected `/admin/audit` with tenant-scoped sensitive action history, filters and summaries
- `/admin/health` frontend operations surface for authorized users
- Docker Compose profiles for Prometheus and Grafana
- Prometheus alert rules in `ops/prometheus/rules/spendlens-alerts.yml` for API scrape health, HTTP 5xx, failed outbox rows, failed worker jobs, Kafka lag, cache connectivity and object-storage connectivity
- Grafana provisioning for the Prometheus datasource and `ops/grafana/dashboards/spendlens-overview.json`, covering HTTP rate/latency, process memory, event outbox, worker queues, Kafka lag, dependency connectivity, OCR confidence and review workflow metrics
- `pnpm observability:validate` static validation for Prometheus rules, Grafana provisioning, dashboard expressions and observability Compose mounts
- `pnpm observability:smoke` live validation for API `/metrics`, Prometheus scrape/rule loading and Grafana datasource/dashboard provisioning

HTTP metrics use bounded labels for method, registered route and status code. Event metrics expose aggregate outbox state/topic counts and inbox status/topic counts without tenant labels. Kafka lag metrics expose configured consumer group/topic/partition lag, committed offset and topic high watermark when `KAFKA_BROKERS` and `KAFKA_LAG_CONSUMER_GROUPS` are set; the scrape stays available if lag collection is degraded. Worker metrics expose durable job status, queue/status counts and failed job counts by queue plus last processing worker without tenant labels or failure reason text. Cache metrics expose backend connectivity, visible worker hot-state key counts and Redis operation error counters without exposing cache key values. Storage metrics expose backend connectivity, memory object count where available and MinIO operation error counters without exposing bucket names or object keys. OCR metrics expose aggregate engine run counts, confidence averages and latency averages without document text or tenant labels. Review metrics expose aggregate task, correction, annotation, active-learning and correction-rate gauges without field values. The request-duration histogram enables p95-style calculation in Prometheus/Grafana once the local monitoring stack is running.

Run the local monitoring config checks with:

```bash
pnpm observability:validate
docker compose -f docker-compose.yml -f docker-compose.observability.yml --profile observability config --quiet
```

Run the local monitoring stack on high default host ports and verify it live with:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml --profile observability up -d prometheus grafana
pnpm observability:smoke
```

Defaults are Prometheus `http://localhost:19090` and Grafana `http://localhost:13001`. Override `PROMETHEUS_HOST_PORT`, `GRAFANA_HOST_PORT`, `PROMETHEUS_URL`, `GRAFANA_URL` or `API_METRICS_URL` when testing a different local port layout.
