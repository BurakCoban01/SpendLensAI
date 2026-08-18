from __future__ import annotations

import argparse
from collections import Counter
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from services.ocr.benchmarks.ocr_benchmark import cer, wer
from services.ocr.custom_model.cli import configure_utf8_stdout
from services.ocr.custom_model.dataset import generate_document_dataset
from services.ocr.custom_model.evaluate import summarize_prediction_rows
from services.ocr.custom_model.infer import DEFAULT_BLANK_PENALTY, infer_document


def run_custom_benchmark(
    output_dir: Path,
    checkpoint: Path,
    profile: str = "local_full",
    samples: int = 16,
    seed: int = 42,
    decoder_method: str = "beam",
    beam_width: int = 8,
    blank_penalty: float = DEFAULT_BLANK_PENALTY,
    numeric_char_checkpoint: Path | None = None,
) -> dict[str, object]:
    data_dir = output_dir / "dataset"
    report_dir = output_dir / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    generated = generate_document_dataset(data_dir, count=samples, seed=seed)
    predictions: list[dict[str, object]] = []
    for sample in generated:
        started = time.perf_counter()
        try:
            inference_options = {
                "decoder_method": decoder_method,
                "beam_width": beam_width,
                "blank_penalty": blank_penalty,
            }
            if numeric_char_checkpoint is not None:
                inference_options["numeric_char_checkpoint"] = numeric_char_checkpoint
            prediction = infer_document(checkpoint, sample.image_path, **inference_options)
            error = None
            predicted_text = prediction.text
            normalized_text = getattr(prediction, "normalized_text", predicted_text)
            confidence = prediction.confidence
            decoder = decoder_method
            warning_codes = list(prediction.warnings)
        except Exception as exc:  # benchmark records failures instead of hiding them
            error = exc.__class__.__name__
            predicted_text = ""
            normalized_text = ""
            confidence = 0.0
            decoder = decoder_method
            warning_codes = []
        predictions.append(
            {
                "engine": "CUSTOM_OCR",
                "documentType": sample.document_type,
                "variant": sample.variant,
                "image": str(sample.image_path),
                "reference": sample.text,
                "prediction": predicted_text,
                "normalizedPrediction": normalized_text,
                "referenceFields": sample.fields,
                "predictedFields": _extract_generated_fields(normalized_text),
                "confidence": confidence,
                "decoder": decoder,
                "latencyMs": round((time.perf_counter() - started) * 1000, 3),
                "cer": None if error else cer(sample.text, predicted_text),
                "wer": None if error else wer(sample.text, predicted_text),
                "normalizedCer": None if error else cer(sample.text, normalized_text),
                "normalizedWer": None if error else wer(sample.text, normalized_text),
                "errorCode": error,
                "warningCodes": warning_codes,
            }
        )
        predictions[-1]["fieldMatches"] = _field_matches(sample.fields, predictions[-1]["predictedFields"])
    successful = [row for row in predictions if row["errorCode"] is None]
    metrics = summarize_prediction_rows(successful)
    field_metrics = _summarize_field_accuracy(successful)
    variant_metrics = _summarize_variant_metrics(successful)
    warning_counts = Counter(
        str(code)
        for row in successful
        for code in (row.get("warningCodes") if isinstance(row.get("warningCodes"), list) else [])
    )
    failure_counts = Counter(str(row["errorCode"]) for row in predictions if row.get("errorCode"))
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "profile": profile,
        "checkpoint": str(checkpoint),
        "numericCharCheckpoint": str(numeric_char_checkpoint) if numeric_char_checkpoint is not None else None,
        "samples": len(predictions),
        "decoder": {
            "method": decoder_method,
            "beamWidth": beam_width if decoder_method == "beam" else None,
            "blankPenalty": blank_penalty,
        },
        "engines": {
            "CUSTOM_OCR": {
                "status": "ok" if successful else "failed",
                "attempted": len(predictions),
                "succeeded": len(successful),
                "averageCer": _average([float(row["cer"]) for row in successful if row["cer"] is not None]),
                "averageWer": _average([float(row["wer"]) for row in successful if row["wer"] is not None]),
                "averageNormalizedCer": _average(
                    [float(row["normalizedCer"]) for row in successful if row["normalizedCer"] is not None]
                ),
                "averageNormalizedWer": _average(
                    [float(row["normalizedWer"]) for row in successful if row["normalizedWer"] is not None]
                ),
                "averageConfidence": _average([float(row["confidence"]) for row in successful]),
                "exactMatchRate": metrics["exactMatchRate"],
                "turkishSpecialCharacterAccuracy": metrics["turkishSpecialCharacterAccuracy"],
                "turkishSpecialCharacterSupport": metrics["turkishSpecialCharacterSupport"],
                "characterConfusionMatrix": metrics["characterConfusionMatrix"],
                "confidenceCalibrationBuckets": metrics["confidenceCalibrationBuckets"],
                "fieldExtraction": field_metrics,
                "perVariant": variant_metrics,
                "warningCounts": dict(sorted(warning_counts.items())),
                "failureCounts": dict(sorted(failure_counts.items())),
            },
            "FOURIER_BASELINE": {"status": "included_as_custom_fallback"},
            "CRNN_RECOGNIZER": {"status": "included_when_checkpoint_confidence_is_sufficient"},
        },
        "groundTruthPolicy": "Synthetic labels rendered by generator; Tesseract output is not used as custom OCR ground truth.",
    }
    (report_dir / "custom-ocr-predictions.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in predictions),
        encoding="utf-8",
    )
    (report_dir / "custom-ocr-benchmark.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (report_dir / "custom-ocr-benchmark.md").write_text(_render_markdown_summary(report), encoding="utf-8")
    return report


def _average(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 6) if values else None


def _extract_generated_fields(text: str) -> dict[str, str | None]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    full_text = "\n".join(lines)
    fields: dict[str, str | None] = {
        "merchant": lines[0] if lines else None,
        "documentNo": _first_match(r"(?:FATURA|FIS|FİŞ)\s+NO\s+([A-Z0-9-]+)", full_text),
        "date": _first_match(r"(?:TARIH|TARİH)\s+(\d{2}[.]\d{2}[.]\d{4})", full_text),
        "subtotal": _amount_after_label(lines, ("ARA TOPLAM", "MATRAH")),
        "taxAmount": _amount_after_label(lines, ("KDV",)),
        "total": _amount_after_label(lines, ("TOPLAM", "GENEL TOPLAM")),
        "paymentMethod": _first_match(r"(?:ODEME|ÖDEME)\s+(KART|NAKIT|NAKİT|HAVALE)", full_text),
        "currency": _extract_currency(full_text),
    }
    return fields


def _first_match(pattern: str, text: str) -> str | None:
    match = re.search(pattern, text, flags=re.IGNORECASE)
    return match.group(1).strip() if match else None


def _amount_after_label(lines: list[str], labels: tuple[str, ...]) -> str | None:
    for line in lines:
        normalized = line.upper().replace("İ", "I")
        for label in labels:
            normalized_label = label.upper().replace("İ", "I")
            if not normalized.startswith(normalized_label):
                continue
            match = re.search(r"(\d+,\d{2})\s*(?:TL|TRY|₺)?", line, flags=re.IGNORECASE)
            if match:
                return match.group(1)
    return None


def _extract_currency(text: str) -> str | None:
    if re.search(r"\b(?:TL|TRY)\b|₺", text, flags=re.IGNORECASE):
        return "TRY"
    return None


def _field_matches(reference_fields: dict[str, str], predicted_fields: object) -> dict[str, bool]:
    predicted = predicted_fields if isinstance(predicted_fields, dict) else {}
    matches: dict[str, bool] = {}
    for field in ("merchant", "documentNo", "date", "subtotal", "taxAmount", "total", "currency", "paymentMethod"):
        expected = reference_fields.get(field)
        candidate = predicted.get(field)
        matches[field] = _normalize_field_value(field, expected) == _normalize_field_value(field, candidate)
    return matches


def _summarize_field_accuracy(rows: list[dict[str, object]]) -> dict[str, object]:
    per_field: dict[str, dict[str, object]] = {}
    total_support = 0
    total_correct = 0
    for row in rows:
        reference_fields = row.get("referenceFields")
        matches = row.get("fieldMatches")
        if not isinstance(reference_fields, dict) or not isinstance(matches, dict):
            continue
        for field, expected in reference_fields.items():
            if field not in {"merchant", "documentNo", "date", "subtotal", "taxAmount", "total", "currency", "paymentMethod"}:
                continue
            if expected is None or str(expected).strip() == "":
                continue
            bucket = per_field.setdefault(field, {"support": 0, "correct": 0, "accuracy": None})
            bucket["support"] = int(bucket["support"]) + 1
            total_support += 1
            if matches.get(field) is True:
                bucket["correct"] = int(bucket["correct"]) + 1
                total_correct += 1
    for bucket in per_field.values():
        support = int(bucket["support"])
        bucket["accuracy"] = round(int(bucket["correct"]) / support, 6) if support else None
    return {
        "overallAccuracy": round(total_correct / total_support, 6) if total_support else None,
        "support": total_support,
        "correct": total_correct,
        "perField": dict(sorted(per_field.items())),
    }


def _summarize_variant_metrics(rows: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    grouped: dict[str, list[dict[str, object]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("variant") or "unknown"), []).append(row)
    result: dict[str, dict[str, object]] = {}
    for variant, variant_rows in sorted(grouped.items()):
        result[variant] = {
            "samples": len(variant_rows),
            "averageCer": _average([float(row["cer"]) for row in variant_rows if row.get("cer") is not None]),
            "averageWer": _average([float(row["wer"]) for row in variant_rows if row.get("wer") is not None]),
            "averageNormalizedCer": _average(
                [float(row["normalizedCer"]) for row in variant_rows if row.get("normalizedCer") is not None]
            ),
            "averageNormalizedWer": _average(
                [float(row["normalizedWer"]) for row in variant_rows if row.get("normalizedWer") is not None]
            ),
            "fieldExtractionAccuracy": _summarize_field_accuracy(variant_rows)["overallAccuracy"],
        }
    return result


def _normalize_field_value(field: str, value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip().upper()
    if field in {"subtotal", "taxAmount", "total"}:
        return re.sub(r"[^0-9,]", "", text.replace(".", ","))
    if field == "paymentMethod":
        text = text.replace("İ", "I")
    return re.sub(r"\s+", " ", text)


def _render_markdown_summary(report: dict[str, object]) -> str:
    custom = (report.get("engines") if isinstance(report.get("engines"), dict) else {}).get("CUSTOM_OCR", {})
    engine = custom if isinstance(custom, dict) else {}
    lines = [
        "# Custom OCR Benchmark",
        "",
        f"- Generated at: `{report.get('generatedAt')}`",
        f"- Profile: `{report.get('profile')}`",
        f"- Samples: `{report.get('samples')}`",
        f"- Checkpoint: `{report.get('checkpoint')}`",
        f"- Numeric character checkpoint: `{report.get('numericCharCheckpoint')}`",
        f"- Decoder: `{(report.get('decoder') if isinstance(report.get('decoder'), dict) else {}).get('method')}`",
        f"- Blank penalty: `{(report.get('decoder') if isinstance(report.get('decoder'), dict) else {}).get('blankPenalty')}`",
        f"- Status: `{engine.get('status')}`",
        f"- Succeeded: `{engine.get('succeeded')}` / `{engine.get('attempted')}`",
        f"- Average CER: `{engine.get('averageCer')}`",
        f"- Average WER: `{engine.get('averageWer')}`",
        f"- Average normalized CER: `{engine.get('averageNormalizedCer')}`",
        f"- Average normalized WER: `{engine.get('averageNormalizedWer')}`",
        f"- Exact match rate: `{engine.get('exactMatchRate')}`",
        f"- Turkish special character accuracy: `{engine.get('turkishSpecialCharacterAccuracy')}`",
        f"- Turkish special character support: `{engine.get('turkishSpecialCharacterSupport')}`",
        f"- Field extraction accuracy: `{(engine.get('fieldExtraction') if isinstance(engine.get('fieldExtraction'), dict) else {}).get('overallAccuracy')}`",
        f"- Warning counts: `{engine.get('warningCounts')}`",
        f"- Failure counts: `{engine.get('failureCounts')}`",
        "",
        "Ground truth policy: synthetic labels rendered by the generator; Tesseract output is not used as Custom OCR ground truth.",
        "",
        "## Field Extraction",
        "",
    ]
    field_extraction = engine.get("fieldExtraction")
    per_field = field_extraction.get("perField") if isinstance(field_extraction, dict) else None
    if isinstance(per_field, dict) and per_field:
        lines.extend(["| Field | Support | Correct | Accuracy |", "| --- | ---: | ---: | ---: |"])
        for field, values in per_field.items():
            if isinstance(values, dict):
                lines.append(f"| `{field}` | {values.get('support')} | {values.get('correct')} | {values.get('accuracy')} |")
    else:
        lines.append("No field extraction matches were measured.")
    lines.extend(["", "## Document Variants", ""])
    per_variant = engine.get("perVariant")
    if isinstance(per_variant, dict) and per_variant:
        lines.extend(["| Variant | Samples | Average CER | Average WER | Field accuracy |", "| --- | ---: | ---: | ---: | ---: |"])
        for variant, values in per_variant.items():
            if isinstance(values, dict):
                lines.append(
                    f"| `{variant}` | {values.get('samples')} | {values.get('averageCer')} | "
                    f"{values.get('averageWer')} | {values.get('fieldExtractionAccuracy')} |"
                )
    lines.extend([
        "",
        "## Character Confusions",
        "",
    ])
    confusions = engine.get("characterConfusionMatrix")
    if isinstance(confusions, list) and confusions:
        lines.extend(["| Reference | Prediction | Count |", "| --- | --- | ---: |"])
        for row in confusions[:20]:
            if isinstance(row, dict):
                lines.append(f"| `{row.get('reference')}` | `{row.get('prediction')}` | {row.get('count')} |")
    else:
        lines.append("No character confusions were recorded.")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    configure_utf8_stdout()
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="local_full")
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/benchmarks/custom-ocr-local-full"))
    parser.add_argument("--checkpoint", type=Path, default=Path("artifacts/models/custom-crnn-smoke/model.pt"))
    parser.add_argument("--samples", type=int, default=16)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--decoder", choices=("greedy", "beam"), default="beam")
    parser.add_argument("--beam-width", type=int, default=8)
    parser.add_argument("--blank-penalty", type=float, default=DEFAULT_BLANK_PENALTY)
    parser.add_argument("--numeric-char-checkpoint", type=Path)
    args = parser.parse_args()
    print(
        json.dumps(
            run_custom_benchmark(
                args.output_dir,
                args.checkpoint,
                args.profile,
                args.samples,
                args.seed,
                decoder_method=args.decoder,
                beam_width=args.beam_width,
                blank_penalty=args.blank_penalty,
                numeric_char_checkpoint=args.numeric_char_checkpoint,
            ),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
