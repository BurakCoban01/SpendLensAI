# Runbook: Dependency Degraded

1. Check `GET /admin/health`.
2. Confirm Docker service status with `docker compose ps`.
3. Inspect container logs for the degraded component.
4. Restart only the failed local service where safe.
5. For Kafka issues, verify outbox rows before replay.
6. For Redis loss, rebuild hot state from PostgreSQL and MinIO.
