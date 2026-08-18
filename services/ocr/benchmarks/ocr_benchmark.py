from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from services.ocr.app.tesseract_engine import TesseractEngineError, check_tesseract_availability, run_tesseract
from services.ocr.benchmarks.golden_dataset import generate_golden_dataset
from services.ocr.custom_model.dataset import generate_dataset
from services.ocr.custom_model.fixture_memory import build_project_fixture_reference_text, load_project_fixture_line_references
from services.ocr.custom_model.infer import infer_document, infer_with_confidence


@dataclass(frozen=True)
class BenchmarkSample:
    image_path: Path
    text: str
    split: str
    document_type: str
    snippets: tuple[str, ...] = ()
    fields: dict[str, str | None] | None = None
    line_item_amounts: tuple[str, ...] = ()
    line_items: tuple[dict[str, str], ...] = ()
    source: str = "synthetic"
    line_crop_box: tuple[int, int, int, int] | None = None
    benchmark_level: str = "document"


@dataclass(frozen=True)
class PredictionRow:
    engine: str
    image: str
    document_type: str
    reference: str
    prediction: str
    confidence: float | None
    latency_ms: float
    error_code: str | None
    snippet_recall: float | None = None
    token_precision: float | None = None
    token_recall: float | None = None
    token_f1: float | None = None
    turkish_char_precision: float | None = None
    turkish_char_recall: float | None = None
    turkish_char_f1: float | None = None
    amount_precision: float | None = None
    amount_recall: float | None = None
    amount_f1: float | None = None
    line_item_amount_recall: float | None = None
    line_item_counts: dict[str, int] | None = None
    field_matches: dict[str, bool] | None = None
    field_predictions: dict[str, str] | None = None
    field_counts: dict[str, dict[str, int]] | None = None
    warning_codes: tuple[str, ...] = ()
    source: str = "unknown"
    benchmark_level: str = "document"


def cer(reference: str, hypothesis: str) -> float:
    return _edit_distance(reference, hypothesis) / max(len(reference), 1)


def wer(reference: str, hypothesis: str) -> float:
    reference_words = reference.split()
    hypothesis_words = hypothesis.split()
    return _edit_distance(reference_words, hypothesis_words) / max(len(reference_words), 1)


TURKISH_SPECIAL_CHARS = set("çğıİöşüÇĞIÖŞÜ")
OCR_EXTRACTABLE_FIELD_KEYS = {
    "merchant",
    "date",
    "subtotal",
    "discount",
    "total",
    "currency",
    "tax",
    "payment",
    "paymentMethod",
    "receiptNumber",
    "invoiceNumber",
    "documentNumber",
    "documentType",
}
OCR_FIELD_KEY_ALIASES = {
    "invoiceNo": "invoiceNumber",
    "receiptNo": "receiptNumber",
    "taxTotal": "tax",
    "payment": "paymentMethod",
}


def run_benchmark(
    data_dir: Path,
    output_dir: Path,
    samples: int = 16,
    seed: int = 42,
    split: str = "all",
    dataset_mode: str = "synthetic",
    checkpoint: Path | None = None,
    numeric_char_checkpoint: Path | None = None,
    character_checkpoint: Path | None = None,
    challenger_checkpoint: Path | None = None,
    challenger_mode: str = "shadow",
    router_checkpoint: Path | None = None,
    manifest_path: Path | None = None,
    include_sources: tuple[str, ...] = (),
    lang: str = "tur+eng",
    skip_tesseract: bool = False,
) -> dict[str, object]:
    benchmark_samples = _load_or_generate_samples(
        data_dir,
        samples,
        seed,
        split,
        dataset_mode,
        manifest_path=manifest_path,
        include_sources=include_sources,
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    predictions: list[PredictionRow] = []
    engine_reports: dict[str, dict[str, object]] = {}

    if skip_tesseract:
        engine_reports["TESSERACT"] = _unavailable_engine("skipped", "Tesseract benchmark disabled by flag.")
    else:
        availability = check_tesseract_availability(lang)
        if availability["available"]:
            rows = _run_engine("TESSERACT", benchmark_samples, lambda sample: _run_tesseract_text(sample.image_path, lang))
            predictions.extend(rows)
            engine_reports["TESSERACT"] = _summarize_engine(rows, len(benchmark_samples))
        else:
            engine_reports["TESSERACT"] = _unavailable_engine("unavailable", availability)

    if checkpoint and checkpoint.exists():
        rows = _run_engine(
            "CUSTOM_CRNN",
            benchmark_samples,
            lambda sample: _run_custom_crnn_text(
                checkpoint,
                sample,
                dataset_mode=dataset_mode,
                numeric_char_checkpoint=numeric_char_checkpoint,
                character_checkpoint=character_checkpoint,
                challenger_checkpoint=challenger_checkpoint,
                challenger_mode=challenger_mode,
                router_checkpoint=router_checkpoint,
            ),
        )
        predictions.extend(rows)
        engine_reports["CUSTOM_CRNN"] = _summarize_engine(rows, len(benchmark_samples))
    else:
        engine_reports["CUSTOM_CRNN"] = _unavailable_engine(
            "unavailable",
            f"Custom OCR checkpoint not found: {checkpoint}" if checkpoint else "Custom OCR checkpoint not provided.",
        )

    predictions_path = output_dir / "predictions.jsonl"
    predictions_path.write_text(
        "\n".join(json.dumps(_prediction_to_json(row), ensure_ascii=False) for row in predictions),
        encoding="utf-8",
    )

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "provenance": {
            "pipeline": "project-owned-custom-ocr",
            "implementation": _implementation_provenance(),
            "checkpoints": {
                "recognizer": _checkpoint_provenance(checkpoint),
                "numericCharacter": _checkpoint_provenance(numeric_char_checkpoint),
                "characterLine": _checkpoint_provenance(character_checkpoint),
                "crnnChallenger": _checkpoint_provenance(challenger_checkpoint),
                "challengerMode": challenger_mode,
                "pairwiseRouter": _checkpoint_provenance(router_checkpoint),
            },
        },
        "dataset": {
            "dataDir": str(data_dir),
            "mode": dataset_mode,
            "samples": len(benchmark_samples),
            "split": split,
            "seed": seed,
            "documentTypes": _count_by_document_type(benchmark_samples),
            "sourceMix": _count_by_source(benchmark_samples),
            "benchmarkLevels": _count_by_benchmark_level(benchmark_samples),
            "manifestPath": str(manifest_path) if manifest_path else None,
        },
        "engines": engine_reports,
        "extractionEvaluation": {
            "onReferenceText": _reference_text_extraction_metrics(benchmark_samples),
            "onOcrText": {
                engine: _extraction_metrics([row for row in predictions if row.engine == engine])
                for engine in sorted({row.engine for row in predictions})
            },
        },
        "artifacts": {
            "predictionsJsonl": str(predictions_path),
        },
        "limitations": [
            "Tiny synthetic datasets are smoke benchmarks, not production accuracy claims.",
            "Unavailable engines are reported explicitly instead of using mock predictions.",
        ],
    }
    report_path = output_dir / "benchmark-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_path = output_dir / "summary.md"
    summary_path.write_text(_render_summary(report), encoding="utf-8")
    report["artifacts"]["summaryMd"] = str(summary_path)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def _checkpoint_provenance(checkpoint: Path | None) -> dict[str, object] | None:
    if checkpoint is None:
        return None
    resolved = checkpoint.resolve()
    try:
        display_path = resolved.relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        display_path = resolved.as_posix()
    if not resolved.is_file():
        return {"path": display_path, "exists": False, "sizeBytes": None, "sha256": None}
    digest = hashlib.sha256()
    with resolved.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "path": display_path,
        "exists": True,
        "sizeBytes": resolved.stat().st_size,
        "sha256": digest.hexdigest(),
    }


def _implementation_provenance() -> dict[str, object]:
    project_root = Path.cwd().resolve()
    custom_model_root = project_root / "services" / "ocr" / "custom_model"
    files = sorted(custom_model_root.glob("*.py")) + [Path(__file__).resolve()]
    digest = hashlib.sha256()
    included: list[str] = []
    for file_path in sorted({path.resolve() for path in files}):
        relative = file_path.relative_to(project_root).as_posix()
        included.append(relative)
        digest.update(f"{relative}\n".encode("utf-8"))
        digest.update(file_path.read_bytes())
    return {"sha256": digest.hexdigest(), "files": included}


def _load_or_generate_samples(
    data_dir: Path,
    count: int,
    seed: int,
    split: str,
    dataset_mode: str,
    manifest_path: Path | None = None,
    include_sources: tuple[str, ...] = (),
) -> list[BenchmarkSample]:
    if dataset_mode == "real_fixtures":
        return _load_real_fixture_samples(data_dir, count=count, split=split)
    if dataset_mode == "combined_manifest_lines":
        return _load_combined_manifest_line_samples(
            data_dir,
            count=count,
            seed=seed,
            split=split,
            manifest_path=manifest_path,
            include_sources=include_sources,
        )

    manifest_path = data_dir / "manifest.jsonl"
    if not manifest_path.exists():
        if dataset_mode == "golden":
            generate_golden_dataset(data_dir)
        else:
            generate_dataset(data_dir, count=count, seed=seed)

    rows = [json.loads(line) for line in manifest_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    selected = rows if split == "all" else [row for row in rows if row.get("split") == split]
    if dataset_mode == "golden" and count > 0:
        selected = selected[:count]
    return [
        BenchmarkSample(
            image_path=data_dir / row["image"],
            text=row["text"],
            split=row.get("split", "unknown"),
            document_type=row.get("documentType", "line"),
            fields=_string_fields(row.get("fields")),
            source=str(row.get("source") or dataset_mode),
            benchmark_level="line",
        )
        for row in selected
    ]


def _load_combined_manifest_line_samples(
    data_dir: Path,
    count: int,
    seed: int,
    split: str,
    manifest_path: Path | None,
    include_sources: tuple[str, ...],
) -> list[BenchmarkSample]:
    selected_manifest = manifest_path or (data_dir / "line_validation.jsonl")
    if not selected_manifest.exists():
        raise FileNotFoundError(f"Combined manifest line benchmark file not found: {selected_manifest}")
    allowed_sources = {source.casefold() for source in include_sources}
    rows: list[BenchmarkSample] = []
    for line in selected_manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        row_split = str(row.get("split") or "unknown")
        if split != "all" and row_split != split:
            continue
        source = str(row.get("source") or "unknown")
        if allowed_sources and source.casefold() not in allowed_sources:
            continue
        if row.get("usableForBenchmark") is False:
            continue
        text = str(row.get("text") or "").strip()
        image_value = str(row.get("image") or "").strip()
        if not text or not image_value:
            continue
        image_path = _resolve_manifest_image_path(data_dir, image_value)
        line_crop_box = _line_crop_box(row.get("lineCropBox"))
        if line_crop_box is None and row.get("usableForTraining") is not True:
            continue
        rows.append(
            BenchmarkSample(
                image_path=image_path,
                text=text,
                split=row_split,
                document_type=str(row.get("documentType") or "line"),
                fields=_string_fields(row.get("fields")),
                source=source,
                line_crop_box=line_crop_box,
                benchmark_level="line",
            )
        )
    return _bounded_source_sample(rows, count=count, seed=seed)


def _load_real_fixture_samples(data_dir: Path, count: int, split: str) -> list[BenchmarkSample]:
    ground_truth_root = data_dir / "ground-truth"
    truth_files = sorted(ground_truth_root.glob("*.json")) if ground_truth_root.exists() else []
    rows: list[BenchmarkSample] = []
    full_line_references = load_project_fixture_line_references(data_dir)
    for index, truth_file in enumerate(truth_files):
        sample_split = _fixture_split(index, len(truth_files))
        if split != "all" and sample_split != split:
            continue
        truth = _repair_mojibake(json.loads(truth_file.read_text(encoding="utf-8")))
        image_path = _matching_fixture_path(data_dir, truth_file.stem)
        if image_path is None:
            continue
        snippets = tuple(str(item).strip() for item in truth.get("expectedOcrTextSnippets", []) if str(item).strip())
        fields = {
            field: _string_or_none(truth.get(source_key))
            for field, source_key in (
                ("merchant", "merchant"),
                ("date", "date"),
                ("subtotal", "subtotal"),
                ("tax", "tax"),
                ("total", "total"),
                ("currency", "currency"),
                ("paymentMethod", "paymentMethod"),
                ("documentType", "documentType"),
            )
            if source_key in truth
        }
        line_items = tuple(
            {
                "description": str(item.get("description") or "").strip(),
                "amount": str(item.get("amount") or "").strip(),
            }
            for item in truth.get("lineItems", [])
            if isinstance(item, dict)
            and str(item.get("description") or "").strip()
            and str(item.get("amount") or "").strip()
        )
        line_item_amounts = tuple(
            str(item.get("amount")).strip()
            for item in truth.get("lineItems", [])
            if isinstance(item, dict) and str(item.get("amount", "")).strip()
        )
        rows.append(
            BenchmarkSample(
                image_path=image_path,
                text=full_line_references.get(truth_file.stem) or build_project_fixture_reference_text(truth),
                split=sample_split,
                document_type=str(truth.get("documentType", "unknown")),
                snippets=snippets,
                fields=fields,
                line_item_amounts=line_item_amounts,
                line_items=line_items,
                source="project_fixture",
            )
        )
    return rows[:count] if count > 0 else rows


def _run_engine(
    engine: str,
    samples: list[BenchmarkSample],
    recognizer: Callable[[BenchmarkSample], tuple[str, float | None] | tuple[str, float | None, tuple[str, ...]]],
) -> list[PredictionRow]:
    rows: list[PredictionRow] = []
    for sample in samples:
        started = time.perf_counter()
        warning_codes: tuple[str, ...] = ()
        try:
            result = recognizer(sample)
            prediction, confidence = result[0], result[1]
            if len(result) >= 3:
                warning_codes = tuple(str(code) for code in result[2])
            error_code = None
        except TesseractEngineError as error:
            prediction = ""
            confidence = None
            error_code = error.code
        except FileNotFoundError:
            prediction = ""
            confidence = None
            error_code = "FILE_NOT_FOUND"
        except Exception as error:  # noqa: BLE001 - benchmark must report per-sample engine failures.
            prediction = ""
            confidence = None
            error_code = f"OCR_ENGINE_RUNTIME_ERROR:{error.__class__.__name__}"
        latency_ms = (time.perf_counter() - started) * 1000
        token_metrics = _token_metrics(sample.text, prediction) if error_code is None else None
        turkish_char_metrics = _turkish_char_metrics(sample.text, prediction) if error_code is None else None
        amount_metrics = _amount_metrics(sample.text, prediction) if error_code is None else None
        predicted_fields = _extract_structured_fields(prediction, sample.document_type) if error_code is None else {}
        field_matches, field_counts = _evaluate_structured_fields(sample.fields or {}, predicted_fields)
        predicted_line_items = _extract_line_items(prediction) if error_code is None else []
        rows.append(
            PredictionRow(
                engine=engine,
                image=str(sample.image_path),
                document_type=sample.document_type,
                reference=sample.text,
                prediction=prediction.strip(),
                confidence=confidence,
                latency_ms=latency_ms,
                error_code=error_code,
                snippet_recall=_snippet_recall(sample.snippets, prediction) if error_code is None else None,
                token_precision=token_metrics["precision"] if token_metrics else None,
                token_recall=token_metrics["recall"] if token_metrics else None,
                token_f1=token_metrics["f1"] if token_metrics else None,
                turkish_char_precision=turkish_char_metrics["precision"] if turkish_char_metrics else None,
                turkish_char_recall=turkish_char_metrics["recall"] if turkish_char_metrics else None,
                turkish_char_f1=turkish_char_metrics["f1"] if turkish_char_metrics else None,
                amount_precision=amount_metrics["precision"] if amount_metrics else None,
                amount_recall=amount_metrics["recall"] if amount_metrics else None,
                amount_f1=amount_metrics["f1"] if amount_metrics else None,
                line_item_amount_recall=_line_item_amount_recall(sample.line_item_amounts, prediction) if error_code is None else None,
                line_item_counts=_evaluate_line_items(sample.line_items, predicted_line_items) if error_code is None else None,
                field_matches=field_matches if error_code is None else None,
                field_predictions=predicted_fields if error_code is None else None,
                field_counts=field_counts if error_code is None else None,
                warning_codes=warning_codes,
                source=sample.source,
                benchmark_level=sample.benchmark_level,
            )
        )
    return rows


def _run_tesseract_text(image_path: Path, lang: str) -> tuple[str, float | None]:
    result = run_tesseract(image_path, lang=lang)
    return result.text, result.confidence


def _run_custom_crnn_text(
    checkpoint: Path,
    sample: BenchmarkSample,
    dataset_mode: str = "synthetic",
    numeric_char_checkpoint: Path | None = None,
    character_checkpoint: Path | None = None,
    challenger_checkpoint: Path | None = None,
    challenger_mode: str = "shadow",
    router_checkpoint: Path | None = None,
) -> tuple[str, float | None] | tuple[str, float | None, tuple[str, ...]]:
    image_path = sample.image_path
    if dataset_mode == "real_fixtures":
        result = infer_document(
            checkpoint,
            image_path,
            source_mime_type=_mime_type_for_path(image_path),
            numeric_char_checkpoint=numeric_char_checkpoint,
            character_checkpoint=character_checkpoint,
            challenger_checkpoint=challenger_checkpoint,
            challenger_mode=challenger_mode,
            router_checkpoint=router_checkpoint,
        )
        normalized_text = getattr(result, "normalized_text", None)
        prediction_text = normalized_text if isinstance(normalized_text, str) else str(getattr(result, "text", ""))
        return prediction_text, result.confidence, tuple(getattr(result, "warnings", []))
    result = infer_with_confidence(
        checkpoint,
        image_path,
        cropped_line=sample.benchmark_level == "line",
        line_crop_box=sample.line_crop_box,
        numeric_char_checkpoint=numeric_char_checkpoint,
        character_checkpoint=character_checkpoint,
        challenger_checkpoint=challenger_checkpoint,
        challenger_mode=challenger_mode,
    )
    return result.text, result.confidence, tuple(getattr(result, "warnings", ()))


def _mime_type_for_path(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "application/pdf"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix in {".tif", ".tiff"}:
        return "image/tiff"
    if suffix == ".bmp":
        return "image/bmp"
    if suffix == ".gif":
        return "image/gif"
    return ""


def _summarize_engine(rows: list[PredictionRow], sample_count: int) -> dict[str, object]:
    successful = [row for row in rows if row.error_code is None]
    failed = [row for row in rows if row.error_code is not None]
    warning_counts = dict(sorted(Counter(code for row in successful for code in row.warning_codes).items()))
    high_confidence_wrong_count = sum(
        1
        for row in successful
        if row.confidence is not None
        and row.confidence >= 0.75
        and (cer(row.reference, row.prediction) > 0.5 or (row.snippet_recall is not None and row.snippet_recall < 0.4))
    )
    report = {
        "status": "ok" if successful else "failed",
        "samples": sample_count,
        "attempted": len(rows),
        "succeeded": len(successful),
        "failed": len(failed),
        "failureRate": len(failed) / max(len(rows), 1),
        "averageCer": _average([cer(row.reference, row.prediction) for row in successful]),
        "averageWer": _average([wer(row.reference, row.prediction) for row in successful]),
        "averageSnippetRecall": _average([row.snippet_recall for row in successful if row.snippet_recall is not None]),
        "tokenPrecision": _average([row.token_precision for row in successful if row.token_precision is not None]),
        "tokenRecall": _average([row.token_recall for row in successful if row.token_recall is not None]),
        "tokenF1": _average([row.token_f1 for row in successful if row.token_f1 is not None]),
        "turkishSpecialCharacterPrecision": _average(
            [row.turkish_char_precision for row in successful if row.turkish_char_precision is not None]
        ),
        "turkishSpecialCharacterRecall": _average([row.turkish_char_recall for row in successful if row.turkish_char_recall is not None]),
        "turkishSpecialCharacterF1": _average([row.turkish_char_f1 for row in successful if row.turkish_char_f1 is not None]),
        "amountPrecision": _average([row.amount_precision for row in successful if row.amount_precision is not None]),
        "amountRecall": _average([row.amount_recall for row in successful if row.amount_recall is not None]),
        "amountF1": _average([row.amount_f1 for row in successful if row.amount_f1 is not None]),
        "lineItemAmountRecall": _average([row.line_item_amount_recall for row in successful if row.line_item_amount_recall is not None]),
        **_line_item_metrics(successful),
        "fieldAccuracy": _field_accuracy(successful),
        **_field_micro_metrics(successful),
        **_field_macro_metrics(successful),
        **_confidence_calibration_metrics(successful),
        "highConfidenceWrongCount": high_confidence_wrong_count,
        "averageLatencyMs": _average([row.latency_ms for row in successful]),
        "averageConfidence": _average([row.confidence for row in successful if row.confidence is not None]),
        "warningCounts": warning_counts,
        "failureCodes": sorted({row.error_code for row in failed if row.error_code}),
    }
    report.update(_quality_gate(report))
    return report


def _quality_gate(report: dict[str, object]) -> dict[str, object]:
    reasons: list[str] = []
    if report.get("status") != "ok":
        reasons.append("ENGINE_NOT_OK")
    average_cer = report.get("averageCer")
    if not isinstance(average_cer, (int, float)) or average_cer > 0.35:
        reasons.append("CER_TOO_HIGH")
    snippet_recall = report.get("averageSnippetRecall")
    if isinstance(snippet_recall, (int, float)) and snippet_recall < 0.7:
        reasons.append("SNIPPET_RECALL_TOO_LOW")
    field_f1 = report.get("fieldF1")
    if isinstance(field_f1, (int, float)) and field_f1 < 0.6:
        reasons.append("FIELD_F1_TOO_LOW")
    token_f1 = report.get("tokenF1")
    if isinstance(token_f1, (int, float)) and token_f1 < 0.75:
        reasons.append("TOKEN_F1_TOO_LOW")
    turkish_f1 = report.get("turkishSpecialCharacterF1")
    if isinstance(turkish_f1, (int, float)) and turkish_f1 < 0.75:
        reasons.append("TURKISH_SPECIAL_CHARACTER_F1_TOO_LOW")
    amount_f1 = report.get("amountF1")
    if isinstance(amount_f1, (int, float)) and amount_f1 < 0.75:
        reasons.append("AMOUNT_F1_TOO_LOW")
    line_item_amount_recall = report.get("lineItemAmountRecall")
    if isinstance(line_item_amount_recall, (int, float)) and line_item_amount_recall < 0.6:
        reasons.append("LINE_ITEM_AMOUNT_RECALL_TOO_LOW")
    line_item_f1 = report.get("lineItemF1")
    if isinstance(line_item_f1, (int, float)) and line_item_f1 < 0.6:
        reasons.append("LINE_ITEM_F1_TOO_LOW")
    if int(report.get("highConfidenceWrongCount") or 0) > 0:
        reasons.append("HIGH_CONFIDENCE_WRONG_OUTPUT")
    passed = len(reasons) == 0
    return {
        "qualityGateStatus": "passed" if passed else "failed",
        "qualityGatePassed": passed,
        "qualityGateReasons": reasons,
    }


def _unavailable_engine(status: str, detail: object) -> dict[str, object]:
    return {
        "status": status,
        "samples": 0,
        "attempted": 0,
        "succeeded": 0,
        "failed": 0,
        "failureRate": 1.0,
        "averageCer": None,
        "averageWer": None,
        "averageLatencyMs": None,
        "averageConfidence": None,
        "detail": detail,
    }


def _prediction_to_json(row: PredictionRow) -> dict[str, object]:
    return {
        "engine": row.engine,
        "image": row.image,
        "source": row.source,
        "benchmarkLevel": row.benchmark_level,
        "documentType": row.document_type,
        "reference": row.reference,
        "prediction": row.prediction,
        "confidence": row.confidence,
        "latencyMs": row.latency_ms,
        "cer": cer(row.reference, row.prediction) if row.error_code is None else None,
        "wer": wer(row.reference, row.prediction) if row.error_code is None else None,
        "errorCode": row.error_code,
        "snippetRecall": row.snippet_recall,
        "tokenPrecision": row.token_precision,
        "tokenRecall": row.token_recall,
        "tokenF1": row.token_f1,
        "turkishSpecialCharacterPrecision": row.turkish_char_precision,
        "turkishSpecialCharacterRecall": row.turkish_char_recall,
        "turkishSpecialCharacterF1": row.turkish_char_f1,
        "amountPrecision": row.amount_precision,
        "amountRecall": row.amount_recall,
        "amountF1": row.amount_f1,
        "lineItemAmountRecall": row.line_item_amount_recall,
        "lineItemCounts": row.line_item_counts,
        "fieldMatches": row.field_matches,
        "fieldPredictions": row.field_predictions,
        "fieldCounts": row.field_counts,
        "warningCodes": list(row.warning_codes),
    }


def _average(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _count_by_document_type(samples: list[BenchmarkSample]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for sample in samples:
        counts[sample.document_type] = counts.get(sample.document_type, 0) + 1
    return counts


def _count_by_source(samples: list[BenchmarkSample]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for sample in samples:
        counts[sample.source] = counts.get(sample.source, 0) + 1
    return counts


def _count_by_benchmark_level(samples: list[BenchmarkSample]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for sample in samples:
        counts[sample.benchmark_level] = counts.get(sample.benchmark_level, 0) + 1
    return counts


def _snippet_recall(snippets: tuple[str, ...], prediction: str) -> float | None:
    if not snippets:
        return None
    normalized_prediction = _normalize_for_match(prediction)
    matched = sum(1 for snippet in snippets if _normalize_for_match(snippet) in normalized_prediction)
    return matched / len(snippets)


def _token_metrics(reference: str, prediction: str) -> dict[str, float]:
    reference_tokens = _token_set(reference)
    prediction_tokens = _token_set(prediction)
    true_positive = len(reference_tokens & prediction_tokens)
    precision = true_positive / max(len(prediction_tokens), 1)
    recall = true_positive / max(len(reference_tokens), 1)
    return {"precision": precision, "recall": recall, "f1": _f1(precision, recall)}


def _turkish_char_metrics(reference: str, prediction: str) -> dict[str, float]:
    reference_chars = [char for char in reference if char in TURKISH_SPECIAL_CHARS]
    prediction_chars = [char for char in prediction if char in TURKISH_SPECIAL_CHARS]
    if not reference_chars and not prediction_chars:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    remaining = reference_chars.copy()
    true_positive = 0
    for char in prediction_chars:
        if char in remaining:
            remaining.remove(char)
            true_positive += 1
    precision = true_positive / max(len(prediction_chars), 1)
    recall = true_positive / max(len(reference_chars), 1)
    return {"precision": precision, "recall": recall, "f1": _f1(precision, recall)}


def _amount_metrics(reference: str, prediction: str) -> dict[str, float] | None:
    reference_amounts = _amount_token_set(reference)
    prediction_amounts = _amount_token_set(prediction)
    if not reference_amounts and not prediction_amounts:
        return None
    true_positive = len(reference_amounts & prediction_amounts)
    precision = true_positive / max(len(prediction_amounts), 1)
    recall = true_positive / max(len(reference_amounts), 1)
    return {"precision": precision, "recall": recall, "f1": _f1(precision, recall)}


def _amount_token_set(value: str) -> set[str]:
    tokens = re.findall(r"(?:\u20ba\s*)?(?:\d{1,3}(?:[.\s,]\d{3})+(?:[,.]\d{1,2})?|\d+[,.]\d{1,3})", value)
    return {_normalize_amount(token) for token in tokens if _normalize_amount(token)}


def _line_item_amount_recall(amounts: tuple[str, ...], prediction: str) -> float | None:
    if not amounts:
        return None
    normalized_prediction = _normalize_amount(prediction)
    matched = sum(1 for amount in amounts if _normalize_amount(amount) in normalized_prediction)
    return matched / len(amounts)


def _extract_line_items(text: str) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    ignored = re.compile(
        r"^(?:TAR[İI]H|DATE|SAAT|TIME|F[İI]Ş|FIS|FATURA|INVOICE|KDV|TAX|VAT|"
        r"(?:GENEL\s+|ARA\s+)?TOPLAM|TOTAL|SUBTOTAL|İNDİRİM|INDIRIM|DISCOUNT|ÖDEME|ODEME|PAYMENT)\b",
        re.IGNORECASE,
    )
    amount_pattern = re.compile(
        r"(?<![%\d])(?:₺\s*)?(?:\d{1,3}(?:[.\s,]\d{3})+(?:[,.]\d{1,2})?|\d+[,.]\d{1,3})(?:\s*(?:TL|TRY))?",
        re.IGNORECASE,
    )
    for raw_line in str(_repair_mojibake(text)).splitlines():
        line = raw_line.strip()
        if not line or ignored.search(line):
            continue
        amounts = list(amount_pattern.finditer(line))
        if not amounts:
            continue
        total_match = amounts[-1]
        name_prefix = line[: total_match.start()].strip()
        if len(amounts) >= 2:
            quantity = re.search(r"\d+(?:[.,]\d+)?\s*(?:ADET|X|×)\s*$", line[: amounts[0].start()], re.IGNORECASE)
            if quantity:
                name_prefix = line[: quantity.start()].strip()
        description = re.sub(
            r"\s+(?:\d+(?:[.,]\d+)?\s+)?%\s*\d{1,2}(?:[.,]\d+)?\s*$",
            "",
            name_prefix,
        ).strip(" -:")
        if len(description) < 2:
            continue
        items.append({"description": description, "amount": _normalize_amount(total_match.group(0))})
    return items


def _evaluate_line_items(
    references: tuple[dict[str, str], ...],
    predictions: list[dict[str, str]],
) -> dict[str, int] | None:
    if not references:
        return None
    unmatched_predictions = list(predictions)
    true_positive = 0
    for reference in references:
        expected_description = _normalize_for_match(reference.get("description", ""))
        expected_amount = _normalize_amount(reference.get("amount", ""))
        match_index = next(
            (
                index
                for index, prediction in enumerate(unmatched_predictions)
                if _normalize_for_match(prediction.get("description", "")) == expected_description
                and _normalize_amount(prediction.get("amount", "")) == expected_amount
            ),
            None,
        )
        if match_index is None:
            continue
        true_positive += 1
        unmatched_predictions.pop(match_index)
    return {
        "tp": true_positive,
        "fp": len(unmatched_predictions),
        "fn": len(references) - true_positive,
    }


def _line_item_metrics(rows: list[PredictionRow]) -> dict[str, float | int | None]:
    counts = {"tp": 0, "fp": 0, "fn": 0}
    evaluated = 0
    for row in rows:
        if row.line_item_counts is None:
            continue
        evaluated += 1
        for key in counts:
            counts[key] += int(row.line_item_counts.get(key, 0))
    if evaluated == 0:
        return {
            "lineItemPrecision": None,
            "lineItemRecall": None,
            "lineItemF1": None,
            "lineItemTruePositive": 0,
            "lineItemFalsePositive": 0,
            "lineItemFalseNegative": 0,
        }
    precision = counts["tp"] / max(counts["tp"] + counts["fp"], 1)
    recall = counts["tp"] / max(counts["tp"] + counts["fn"], 1)
    return {
        "lineItemPrecision": precision,
        "lineItemRecall": recall,
        "lineItemF1": _f1(precision, recall),
        "lineItemTruePositive": counts["tp"],
        "lineItemFalsePositive": counts["fp"],
        "lineItemFalseNegative": counts["fn"],
    }


def _field_matches(fields: dict[str, str | None], prediction: str) -> dict[str, bool]:
    normalized_prediction = _normalize_for_match(prediction)
    matches: dict[str, bool] = {}
    for field, value in fields.items():
        if not value:
            continue
        candidates = _field_match_candidates(field, value)
        matches[field] = any(_normalize_for_match(candidate) in normalized_prediction for candidate in candidates)
    return matches


def _field_accuracy(rows: list[PredictionRow]) -> dict[str, object]:
    counts: dict[str, dict[str, int]] = {}
    for row in rows:
        for field, values in (row.field_counts or {}).items():
            aggregate = counts.setdefault(field, {"tp": 0, "fp": 0, "fn": 0})
            for key in ("tp", "fp", "fn"):
                aggregate[key] += int(values.get(key, 0))
    return {
        field: {
            "precision": values["tp"] / max(values["tp"] + values["fp"], 1),
            "recall": values["tp"] / max(values["tp"] + values["fn"], 1),
            "f1": _f1(
                values["tp"] / max(values["tp"] + values["fp"], 1),
                values["tp"] / max(values["tp"] + values["fn"], 1),
            ),
            **values,
        }
        for field, values in sorted(counts.items())
    }


def _field_micro_metrics(rows: list[PredictionRow]) -> dict[str, float | None]:
    counts = {"tp": 0, "fp": 0, "fn": 0}
    for row in rows:
        for values in (row.field_counts or {}).values():
            for key in counts:
                counts[key] += int(values.get(key, 0))
    if sum(counts.values()) == 0:
        return {"fieldPrecision": None, "fieldRecall": None, "fieldF1": None}
    precision = counts["tp"] / max(counts["tp"] + counts["fp"], 1)
    recall = counts["tp"] / max(counts["tp"] + counts["fn"], 1)
    return {
        "fieldPrecision": precision,
        "fieldRecall": recall,
        "fieldF1": _f1(precision, recall),
        "fieldTruePositive": counts["tp"],
        "fieldFalsePositive": counts["fp"],
        "fieldFalseNegative": counts["fn"],
    }


def _field_macro_metrics(rows: list[PredictionRow]) -> dict[str, float | None]:
    per_field = _field_accuracy(rows)
    if not per_field:
        return {"fieldMacroPrecision": None, "fieldMacroRecall": None, "fieldMacroF1": None}
    return {
        "fieldMacroPrecision": _average([float(values["precision"]) for values in per_field.values()]),
        "fieldMacroRecall": _average([float(values["recall"]) for values in per_field.values()]),
        "fieldMacroF1": _average([float(values["f1"]) for values in per_field.values()]),
    }


def _extraction_metrics(rows: list[PredictionRow]) -> dict[str, object]:
    successful = [row for row in rows if row.error_code is None]
    return {
        "samples": len(rows),
        "succeeded": len(successful),
        "fieldAccuracy": _field_accuracy(successful),
        **_field_micro_metrics(successful),
        **_field_macro_metrics(successful),
        **_line_item_metrics(successful),
    }


def _reference_text_extraction_metrics(samples: list[BenchmarkSample]) -> dict[str, object]:
    rows: list[PredictionRow] = []
    for sample in samples:
        predictions = _extract_structured_fields(sample.text, sample.document_type)
        field_matches, field_counts = _evaluate_structured_fields(sample.fields or {}, predictions)
        predicted_line_items = _extract_line_items(sample.text)
        rows.append(
            PredictionRow(
                engine="REFERENCE_TEXT",
                image=str(sample.image_path),
                document_type=sample.document_type,
                reference=sample.text,
                prediction=sample.text,
                confidence=1.0,
                latency_ms=0.0,
                error_code=None,
                field_matches=field_matches,
                field_predictions=predictions,
                field_counts=field_counts,
                line_item_counts=_evaluate_line_items(sample.line_items, predicted_line_items),
                source=sample.source,
                benchmark_level=sample.benchmark_level,
            )
        )
    return _extraction_metrics(rows)


def _evaluate_structured_fields(
    references: dict[str, str | None],
    predictions: dict[str, str],
) -> tuple[dict[str, bool], dict[str, dict[str, int]]]:
    matches: dict[str, bool] = {}
    counts: dict[str, dict[str, int]] = {}
    for raw_field, expected in references.items():
        field = OCR_FIELD_KEY_ALIASES.get(raw_field, raw_field)
        predicted = predictions.get(field)
        if expected is None or not str(expected).strip():
            if predicted:
                counts[field] = {"tp": 0, "fp": 1, "fn": 0}
                matches[field] = False
            continue
        matched = predicted is not None and _structured_field_values_match(field, str(expected), predicted)
        matches[field] = matched
        counts[field] = {"tp": int(matched), "fp": int(predicted is not None and not matched), "fn": int(not matched)}
    return matches, counts


def _structured_field_values_match(field: str, expected: str, predicted: str) -> bool:
    if field in {"total", "tax", "subtotal", "discount"}:
        return _normalize_amount(expected) == _normalize_amount(predicted)
    expected_candidates = {_normalize_for_match(value) for value in _field_match_candidates(field, expected)}
    normalized_prediction = _normalize_for_match(predicted)
    return normalized_prediction in expected_candidates or any(
        candidate and candidate in normalized_prediction for candidate in expected_candidates
    )


def _extract_structured_fields(text: str, document_type_hint: str = "unknown") -> dict[str, str]:
    repaired = str(_repair_mojibake(text))
    lines = [line.strip() for line in repaired.splitlines() if line.strip()]
    normalized = _normalize_for_match(repaired)
    fields: dict[str, str] = {}
    date_match = re.search(r"(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?!\d)", repaired)
    if date_match:
        day, month, year = date_match.groups()
        year = f"20{year}" if len(year) == 2 else year
        fields["date"] = f"{year.zfill(4)}-{month.zfill(2)}-{day.zfill(2)}"
    if re.search(r"(?:₺|\bTL\b|\bTRY\b)", repaired, re.IGNORECASE):
        fields["currency"] = "TRY"
    if any(keyword in normalized for keyword in ("FATURA", "INVOICE", "E-ARSIV", "E-ARŞIV")):
        fields["documentType"] = "invoice"
    elif any(keyword in normalized for keyword in ("FIS", "FIŞ", "RECEIPT")):
        fields["documentType"] = "receipt"
    elif document_type_hint not in {"", "unknown"}:
        fields["documentType"] = document_type_hint
    if any(keyword in normalized for keyword in ("KART", "CARD", "VISA", "MASTERCARD")):
        fields["paymentMethod"] = "KART"
    elif any(keyword in normalized for keyword in ("NAKIT", "CASH")):
        fields["paymentMethod"] = "NAKIT"
    for line in lines:
        normalized_line = _normalize_for_match(line)
        amounts = _amount_token_set(line)
        if amounts and re.search(r"\b(KDV|VAT|TAX)\b", normalized_line):
            fields["tax"] = sorted(amounts, key=len)[-1]
        if amounts and re.search(r"\b(ARA\s+TOPLAM|MATRAH|SUBTOTAL)\b", normalized_line):
            fields["subtotal"] = sorted(amounts, key=len)[-1]
        if amounts and re.search(r"\b(İNDİRİM|INDIRIM|DISCOUNT)\b", normalized_line):
            fields["discount"] = sorted(amounts, key=len)[-1]
        if amounts and re.search(r"\b(GENEL\s+TOPLAM|TOPLAM|TOTAL|ODENECEK|TUTAR)\b", normalized_line):
            if not re.search(r"\b(ARA\s+TOPLAM|SUBTOTAL|KDV|VAT|TAX)\b", normalized_line):
                fields["total"] = sorted(amounts, key=len)[-1]
    subtotal_minor = int(fields.get("subtotal", "0") or "0")
    tax_minor = int(fields.get("tax", "0") or "0")
    discount_minor = int(fields.get("discount", "0") or "0")
    total_minor = int(fields.get("total", "0") or "0")
    expected_total = subtotal_minor + tax_minor - discount_minor
    if subtotal_minor > 0 and tax_minor > 0 and expected_total > subtotal_minor and total_minor <= subtotal_minor:
        fields["total"] = str(expected_total)
    labeled_merchant = next(
        (
            match.group("value").strip()
            for line in lines
            if (
                match := re.search(
                    r"^(?:SATICI|SELLER|MERCHANT)\s*(?:ÜNVANI|UNVANI|NAME)?\s*[:\-]\s*(?P<value>.+)$",
                    line,
                    re.IGNORECASE,
                )
            )
        ),
        None,
    )
    merchant_candidates = [
        line
        for line in lines[:5]
        if sum(character.isalpha() for character in line) >= 3
        and not re.search(r"\b(TARIH|DATE|FIS|FIŞ|FATURA|INVOICE|TOPLAM|TOTAL|KDV|VAT|TAX)\b", _normalize_for_match(line))
    ]
    if labeled_merchant:
        fields["merchant"] = labeled_merchant
    elif merchant_candidates:
        fields["merchant"] = merchant_candidates[0]
    return fields


def _confidence_calibration_metrics(rows: list[PredictionRow]) -> dict[str, object]:
    calibrated = [row for row in rows if isinstance(row.confidence, int | float)]
    if not calibrated:
        return {
            "confidenceCalibrationBuckets": [],
            "expectedCalibrationError": None,
            "brierScore": None,
            "riskCoverage": [],
        }
    buckets: list[dict[str, object]] = []
    ece = 0.0
    brier = 0.0
    boundaries = ((0.0, 0.5), (0.5, 0.75), (0.75, 0.9), (0.9, 1.000001))
    for lower, upper in boundaries:
        selected = [row for row in calibrated if lower <= float(row.confidence) < upper]
        if not selected:
            buckets.append({"bucket": f"{lower:.2f}-{min(upper, 1.0):.2f}", "samples": 0, "averageConfidence": None, "averageQuality": None})
            continue
        average_confidence = sum(float(row.confidence) for row in selected) / len(selected)
        average_quality = sum(1.0 - min(cer(row.reference, row.prediction), 1.0) for row in selected) / len(selected)
        ece += len(selected) / len(calibrated) * abs(average_confidence - average_quality)
        buckets.append(
            {
                "bucket": f"{lower:.2f}-{min(upper, 1.0):.2f}",
                "samples": len(selected),
                "averageConfidence": average_confidence,
                "averageQuality": average_quality,
            }
        )
    for row in calibrated:
        quality = 1.0 - min(cer(row.reference, row.prediction), 1.0)
        brier += (float(row.confidence) - quality) ** 2
    ranked = sorted(calibrated, key=lambda row: float(row.confidence), reverse=True)
    risk_coverage = []
    for coverage in (0.25, 0.5, 0.75, 1.0):
        count = max(1, round(len(ranked) * coverage))
        selected = ranked[:count]
        risk_coverage.append(
            {
                "coverage": count / len(ranked),
                "risk": sum(min(cer(row.reference, row.prediction), 1.0) for row in selected) / len(selected),
                "minimumConfidence": float(selected[-1].confidence),
            }
        )
    return {
        "confidenceCalibrationBuckets": buckets,
        "expectedCalibrationError": ece,
        "brierScore": brier / len(calibrated),
        "riskCoverage": risk_coverage,
    }


def _field_match_candidates(field: str, value: str) -> list[str]:
    candidates = [value]
    if field == "date" and "-" in value:
        year, month, day = value.split("-", 2)
        candidates.extend([f"{day}.{month}.{year}", f"{day}/{month}/{year}"])
    if field == "total":
        candidates.extend([value.replace(".", ","), f"{value.replace('.', ',')} TL"])
    if field == "documentType":
        normalized = value.casefold()
        if normalized == "receipt":
            candidates.extend(["FIS", "FİŞ", "FIŞ", "FİS"])
        elif normalized == "invoice":
            candidates.extend(["FATURA", "E-ARŞİV", "E-ARSIV"])
    return candidates


def _token_set(value: str) -> set[str]:
    return {token for token in _normalize_for_match(value).split() if token}


def _normalize_for_match(value: str) -> str:
    return " ".join(value.upper().replace("₺", " TL ").replace("TRY", " TL ").split())


def _normalize_amount(value: str) -> str:
    return re.sub(r"\D", "", _normalize_for_match(value))


def _f1(precision: float, recall: float) -> float:
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def _matching_fixture_path(data_dir: Path, stem: str) -> Path | None:
    extensions = (".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".gif", ".pdf")
    for path in (sorted(data_dir.iterdir()) if data_dir.exists() else []):
        if path.is_file() and path.stem == stem and path.suffix.lower() in extensions:
            return path
    return None


def _resolve_manifest_image_path(data_dir: Path, image_value: str) -> Path:
    raw_path = Path(image_value)
    if raw_path.is_absolute():
        return raw_path
    data_relative = data_dir / raw_path
    if data_relative.exists():
        return data_relative
    return raw_path


def _line_crop_box(value: object) -> tuple[int, int, int, int] | None:
    if not isinstance(value, list | tuple) or len(value) != 4:
        return None
    try:
        left, top, right, bottom = (int(round(float(item))) for item in value)
    except (TypeError, ValueError):
        return None
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _bounded_source_sample(samples: list[BenchmarkSample], count: int, seed: int) -> list[BenchmarkSample]:
    if count <= 0 or len(samples) <= count:
        return samples
    rng = random.Random(seed)
    grouped: dict[str, list[BenchmarkSample]] = {}
    for sample in samples:
        grouped.setdefault(sample.source, []).append(sample)
    for group in grouped.values():
        rng.shuffle(group)
    source_names = sorted(grouped)
    base_quota, extra = divmod(count, len(source_names))
    selected: list[BenchmarkSample] = []
    overflow: list[BenchmarkSample] = []
    for index, source in enumerate(source_names):
        quota = base_quota + (1 if index < extra else 0)
        group = grouped[source]
        selected.extend(group[:quota])
        overflow.extend(group[quota:])
    if len(selected) < count:
        rng.shuffle(overflow)
        selected.extend(overflow[: count - len(selected)])
    rng.shuffle(selected)
    return selected


def _string_fields(value: object) -> dict[str, str | None] | None:
    if not isinstance(value, dict):
        return None
    fields: dict[str, str | None] = {}
    for raw_key, field_value in value.items():
        key = OCR_FIELD_KEY_ALIASES.get(str(raw_key), str(raw_key))
        if key not in OCR_EXTRACTABLE_FIELD_KEYS:
            continue
        if field_value is None:
            fields[key] = None
        else:
            fields[key] = str(field_value)
    return fields or None


def _fixture_split(index: int, count: int) -> str:
    if count <= 2:
        return "test"
    ratio = index / max(count, 1)
    if ratio < 0.7:
        return "train"
    if ratio < 0.85:
        return "validation"
    return "test"


def _string_or_none(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _repair_mojibake(value: object) -> object:
    if isinstance(value, str):
        if any(marker in value for marker in ("Ã", "Ä", "Å", "â")):
            try:
                return value.encode("latin1").decode("utf-8")
            except UnicodeError:
                return value
        return value
    if isinstance(value, list):
        return [_repair_mojibake(item) for item in value]
    if isinstance(value, dict):
        return {key: _repair_mojibake(item) for key, item in value.items()}
    return value


def _render_summary(report: dict[str, object]) -> str:
    dataset = report["dataset"] if isinstance(report.get("dataset"), dict) else {}
    engines = report["engines"] if isinstance(report.get("engines"), dict) else {}
    extraction = report["extractionEvaluation"] if isinstance(report.get("extractionEvaluation"), dict) else {}
    lines = [
        "# Custom OCR Benchmark Summary",
        "",
        f"- Dataset mode: {dataset.get('mode')}",
        f"- Data dir: {dataset.get('dataDir')}",
        f"- Samples: {dataset.get('samples')}",
        f"- Source mix: {_format_json_inline(dataset.get('sourceMix'))}",
        "",
        "| Engine | Status | Quality gate | CER error | WER error | Snippet recall | Token F1 | Field F1 | Turkish char F1 | Amount F1 | Line item F1 | Line item amount recall | High-confidence wrong | Warnings |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for engine, payload in engines.items():
        row = payload if isinstance(payload, dict) else {}
        lines.append(
            "| {engine} | {status} | {gate} | {cer} | {wer} | {snippet} | {token_f1} | {field_f1} | {tr_f1} | {amount_f1} | {line_f1} | {line_amounts} | {hcw} | {warnings} |".format(
                engine=engine,
                status=row.get("status"),
                gate=_format_quality_gate(row),
                cer=_format_metric(row.get("averageCer")),
                wer=_format_metric(row.get("averageWer")),
                snippet=_format_metric(row.get("averageSnippetRecall")),
                token_f1=_format_metric(row.get("tokenF1")),
                field_f1=_format_metric(row.get("fieldF1")),
                tr_f1=_format_metric(row.get("turkishSpecialCharacterF1")),
                amount_f1=_format_metric(row.get("amountF1")),
                line_f1=_format_metric(row.get("lineItemF1")),
                line_amounts=_format_metric(row.get("lineItemAmountRecall")),
                hcw=row.get("highConfidenceWrongCount", "-"),
                warnings=_format_warning_counts(row.get("warningCounts")),
            )
        )
    lines.extend(
        [
            "",
            "## Extraction by Input Text",
            "",
            "| Input | Field precision | Field recall | Field F1 | Macro precision | Macro recall | Macro F1 | Line-item precision | Line-item recall | Line-item F1 |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    extraction_rows: dict[str, object] = {"REFERENCE_TEXT": extraction.get("onReferenceText")}
    on_ocr_text = extraction.get("onOcrText")
    if isinstance(on_ocr_text, dict):
        extraction_rows.update(on_ocr_text)
    for label, payload in extraction_rows.items():
        row = payload if isinstance(payload, dict) else {}
        lines.append(
            f"| {label} | {_format_metric(row.get('fieldPrecision'))} | {_format_metric(row.get('fieldRecall'))} | "
            f"{_format_metric(row.get('fieldF1'))} | {_format_metric(row.get('fieldMacroPrecision'))} | "
            f"{_format_metric(row.get('fieldMacroRecall'))} | {_format_metric(row.get('fieldMacroF1'))} | "
            f"{_format_metric(row.get('lineItemPrecision'))} | {_format_metric(row.get('lineItemRecall'))} | "
            f"{_format_metric(row.get('lineItemF1'))} |"
        )
    lines.append("")
    lines.append("CER/WER are error rates. Synthetic-only metrics are not production readiness proof.")
    return "\n".join(lines) + "\n"


def _format_metric(value: object) -> str:
    return "-" if not isinstance(value, (int, float)) else f"{value:.4f}"


def _format_warning_counts(value: object) -> str:
    if not isinstance(value, dict) or not value:
        return "-"
    return ", ".join(f"{key}: {count}" for key, count in sorted(value.items()))


def _format_json_inline(value: object) -> str:
    if not isinstance(value, dict) or not value:
        return "-"
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _format_quality_gate(row: dict[str, object]) -> str:
    status = row.get("qualityGateStatus")
    if not isinstance(status, str):
        return "-"
    reasons = row.get("qualityGateReasons")
    if isinstance(reasons, list) and reasons:
        return f"{status} ({', '.join(str(reason) for reason in reasons)})"
    return status


def _edit_distance(reference: str | list[str], hypothesis: str | list[str]) -> int:
    rows = len(reference) + 1
    cols = len(hypothesis) + 1
    dp = [[0] * cols for _ in range(rows)]
    for index in range(rows):
        dp[index][0] = index
    for index in range(cols):
        dp[0][index] = index
    for row in range(1, rows):
        for col in range(1, cols):
            cost = 0 if reference[row - 1] == hypothesis[col - 1] else 1
            dp[row][col] = min(dp[row - 1][col] + 1, dp[row][col - 1] + 1, dp[row - 1][col - 1] + cost)
    return dp[-1][-1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path("artifacts/benchmarks/synthetic"))
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/benchmarks/latest"))
    parser.add_argument("--samples", type=int, default=16)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--split", choices=["all", "train", "validation", "test"], default="all")
    parser.add_argument("--dataset-mode", choices=["synthetic", "golden", "real_fixtures", "combined_manifest_lines"], default="synthetic")
    parser.add_argument("--manifest-path", type=Path)
    parser.add_argument("--include-sources", nargs="*", default=[])
    parser.add_argument("--checkpoint", type=Path)
    configured_numeric_checkpoint = os.getenv("CUSTOM_OCR_NUMERIC_CHAR_CHECKPOINT")
    configured_character_checkpoint = os.getenv("CUSTOM_OCR_CHARACTER_CHECKPOINT")
    parser.add_argument(
        "--numeric-char-checkpoint",
        type=Path,
        default=Path(configured_numeric_checkpoint) if configured_numeric_checkpoint else None,
    )
    parser.add_argument(
        "--character-checkpoint",
        type=Path,
        default=Path(configured_character_checkpoint) if configured_character_checkpoint else None,
    )
    parser.add_argument("--challenger-checkpoint", type=Path)
    parser.add_argument("--challenger-mode", choices=("off", "shadow", "validated"), default="shadow")
    parser.add_argument("--router-checkpoint", type=Path)
    parser.add_argument("--lang", default="tur+eng")
    parser.add_argument("--skip-tesseract", action="store_true")
    args = parser.parse_args()
    report = run_benchmark(
        data_dir=args.data_dir,
        output_dir=args.output_dir,
        samples=args.samples,
        seed=args.seed,
        split=args.split,
        dataset_mode=args.dataset_mode,
        checkpoint=args.checkpoint,
        numeric_char_checkpoint=args.numeric_char_checkpoint,
        character_checkpoint=args.character_checkpoint,
        challenger_checkpoint=args.challenger_checkpoint,
        challenger_mode=args.challenger_mode,
        router_checkpoint=args.router_checkpoint,
        manifest_path=args.manifest_path,
        include_sources=tuple(args.include_sources),
        lang=args.lang,
        skip_tesseract=args.skip_tesseract,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
