# Privacy

SpendLens AI is **local-first**. OCR text and document images must not be sent to paid or external AI/OCR APIs. The core stack (PostgreSQL, Redis, Redpanda, MinIO, Tesseract, PyTorch) runs entirely on the local machine.

Rules:

- Use synthetic/demo data for demos and tests. Do not upload real identity documents or sensitive personal data into demo environments.
- Optional LLM assistance is **disabled by default** (`LLM_ENABLED=false` in `.env.example`) and is never required for the local OCR/expense flow. When enabled, raw inputs are not stored by default (`LLM_STORE_RAW_INPUTS=false`).
- Human review corrections and annotations are persisted locally and can be exported as JSONL; enforce anonymization before mixing real production data into training datasets.
