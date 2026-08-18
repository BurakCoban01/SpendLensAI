# Kafka Events

Event topics are defined in `packages/shared/src/events.ts`.

`eventCatalog` is the canonical topic catalog. Each topic records its producer, aggregate type, description, durability expectation and dead-letter topic name. `/catalog` exposes the topic names, while `/admin/events/catalog` exposes the detailed catalog to users with `admin.events.read`.

Events use:

- schema version
- tenant ID
- aggregate ID
- correlation ID
- JSON payload

The Prisma schema includes `OutboxEvent` for durable publishing when Kafka is degraded.
It also includes `InboxEvent` for idempotent consumer-side processing records.

## Current Outbox Foundation

The API persists outbox events through `apps/api/src/modules/events`.

Protected endpoints:

- `GET /admin/events/catalog` with `admin.events.read`
- `GET /admin/events?topic=<topic>&state=pending|published|failed` with `admin.events.read`
- `POST /admin/events/outbox` with `admin.events.publish`
- `POST /admin/events/drain` with `admin.events.publish`
- `GET /admin/events/dlq` with `admin.events.read`
- `GET /admin/events/inbox` with `admin.events.read`
- `POST /admin/events/inbox/record` with `admin.events.publish`
- `POST /admin/events/:id/requeue` with `admin.events.publish`
- `POST /admin/events/:id/mark-published` with `admin.events.publish`
- `POST /admin/events/:id/mark-failed` with `admin.events.publish`

Current automatic producers:

- document upload emits `document.uploaded`
- manual and extracted expense creation emit `expense.created`
- approval decisions emit `expense.approved` or `expense.rejected`
- report export generation emits `report.generated`

`POST /admin/events/drain` publishes pending events through the configured Kafka-compatible producer when `KAFKA_BROKERS` is set. Producer failures are explicit: the service attempts to publish a failure envelope to the topic's cataloged DLQ topic, marks the source event failed and records the failure reason. `GET /admin/events/dlq` lists failed events with recorded DLQ delivery evidence, and `POST /admin/events/:id/requeue` clears a failed event back to pending for controlled replay. The `/admin/events` UI exposes drain, DLQ inspection and requeue actions for operators.

The standalone outbox drainer runtime lives at `apps/api/src/event-drainer.ts`. It runs as `pnpm --filter @spendlens/api dev:event-drainer` in development or `node apps/api/dist/event-drainer.js` after build. It authenticates as a local operator/service account with `admin.events.publish`, periodically calls `POST /admin/events/drain`, and can optionally include failed events for bounded autonomous retry. Keep `EVENT_DRAINER_INCLUDE_FAILED=false` for conservative local operation; set it to `true` only when repeated retry/DLQ attempts are desired.

Drainer runtime environment:

- `EVENT_DRAINER_API_BASE_URL`
- `EVENT_DRAINER_ID`
- `EVENT_DRAINER_INTERVAL_MS`
- `EVENT_DRAINER_LIMIT`
- `EVENT_DRAINER_INCLUDE_FAILED`
- `EVENT_DRAINER_ACCESS_TOKEN`
- `EVENT_DRAINER_TENANT_SLUG`
- `EVENT_DRAINER_EMAIL`
- `EVENT_DRAINER_PASSWORD`

`POST /admin/events/inbox/record` is the operator/API-facing consumer inbox endpoint. It stores a single processed or failed record for each `consumerName` + event ID pair, returns duplicates without creating another row and rejects cross-tenant envelopes. The `/admin/events` UI shows inbox records with topic, consumer, status and event ID filters.

The standalone Kafka consumer runtime lives at `apps/api/src/event-consumer.ts`. It runs as `pnpm --filter @spendlens/api dev:event-consumer` in development or `node apps/api/dist/event-consumer.js` after build. It subscribes to the configured catalog topics, parses event envelopes produced by `/admin/events/drain`, validates the topic against `eventCatalog` and records an idempotent processed inbox checkpoint directly in PostgreSQL. Invalid JSON, empty messages and unknown topics are logged as structured errors without exposing payload contents.

Consumer runtime environment:

- `KAFKA_BROKERS`
- `EVENT_CONSUMER_CLIENT_ID`
- `EVENT_CONSUMER_GROUP_ID`
- `EVENT_CONSUMER_NAME`
- `EVENT_CONSUMER_TOPICS`

Docker Compose includes `event-consumer` and `event-drainer` services, and Kubernetes includes `k8s/event-consumer.yaml` plus `k8s/event-drainer.yaml` for local clusters.

Live broker validation is still pending. `/metrics` can collect consumer lag from a live Kafka-compatible broker when `KAFKA_BROKERS` and `KAFKA_LAG_CONSUMER_GROUPS` are configured, but live broker validation still depends on a healthy local Redpanda/Kafka runtime. Pending or failed events remain durable in PostgreSQL and visible in `/admin/events`.
