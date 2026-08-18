# Failure Recovery

Expected behavior:

- Redis down: progress/cache degrades; PostgreSQL remains source of truth.
- Kafka down: outbox stores events; admin health shows degraded status.
- MinIO down: upload fails safely and metadata is not corrupted.
- OCR service down: document remains uploaded and OCR is retryable.
- Tesseract missing: custom model may still run if a checkpoint exists.
- Custom checkpoint missing: custom run is marked unavailable; Tesseract still runs.
- Worker crash: job retries or resumes idempotently.
