# Performance

Current benchmark tooling:

```bash
scripts/run-ocr-benchmark.sh --samples 16 --output-dir artifacts/benchmarks/latest
scripts/run-ocr-benchmark.cmd --samples 16 --output-dir artifacts/benchmarks/latest
python -m services.ocr.benchmarks.ocr_benchmark --dataset-mode golden --samples 6 --skip-tesseract --output-dir artifacts/benchmarks/golden-smoke
pnpm ocr:benchmark:docker
```

The OCR benchmark harness generates or reads synthetic receipt line images or the deterministic golden receipt/invoice suite, runs available local OCR engines and writes:

- `benchmark-report.json`
- `predictions.jsonl`

Golden mode creates six small local-only document images, three receipts and three invoices, plus `manifest.jsonl` ground truth with document type, full OCR text and key field labels such as merchant, date, invoice number, category and total. This is still a smoke suite, not a production accuracy claim.

Reported metrics include:

- character error rate
- word error rate
- average latency
- average confidence where the engine exposes one
- attempted/succeeded/failed counts
- failure rate and failure codes

If Tesseract is not installed, required language packs are missing or no custom CRNN checkpoint is provided, the harness reports the engine as unavailable instead of producing mock predictions.

`pnpm ocr:benchmark:docker` runs the golden receipt/invoice suite inside the Docker Compose `ocr-service` image, where Tesseract and the English/Turkish language packs are installed. The smoke command validates that `TESSERACT` attempted all six golden samples, produced successful prediction rows, and wrote finite CER, WER, latency and confidence metrics to `artifacts/benchmarks/live-tesseract-golden/benchmark-report.json`.

Remaining performance gates are planned for:

- batch upload 10 and 100 generated documents
- OCR latency
- larger Tesseract vs custom model inference comparisons
- report generation time
- dashboard query latency
- worker throughput
- memory during PDF/image processing
