from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from PIL import Image

from services.ocr.benchmarks.stage_diagnostics import AnnotatedLine, CheckpointRecognizer, _normalize_box
from services.ocr.custom_model.evaluate import cer, summarize_prediction_rows
from services.ocr.custom_model.infer import (
    CustomOcrPrediction,
    _infer_line_role,
    _select_crnn_challenger,
)
from services.ocr.custom_model.segmentation import SegmentBox


def select_document_balanced_lines(
    annotations: Iterable[AnnotatedLine],
    *,
    max_documents: int,
    lines_per_document: int,
    seed: int,
    document_offset: int = 0,
) -> list[AnnotatedLine]:
    grouped: dict[str, list[AnnotatedLine]] = defaultdict(list)
    for annotation in annotations:
        grouped[_document_lineage(annotation)].append(annotation)
    ranked_documents = sorted(
        grouped,
        key=lambda lineage: (_stable_hash(f"document:{seed}:{lineage}"), lineage),
    )
    selected_documents = ranked_documents[document_offset : document_offset + max_documents]
    selected: list[AnnotatedLine] = []
    for lineage in selected_documents:
        lines = sorted(
            grouped[lineage],
            key=lambda line: (_stable_hash(f"line:{seed}:{line.sample_id}"), line.sample_id),
        )[:lines_per_document]
        selected.extend(lines)
    return selected


def run_recognizer_comparison(
    manifest_paths: list[Path],
    champion_checkpoint: Path,
    challenger_checkpoint: Path,
    output_dir: Path,
    *,
    max_documents: int = 40,
    lines_per_document: int = 8,
    seed: int = 20260711,
    document_offset: int = 0,
) -> dict[str, Any]:
    annotations = _load_comparison_annotations(manifest_paths)
    selected = select_document_balanced_lines(
        annotations,
        max_documents=max_documents,
        lines_per_document=lines_per_document,
        seed=seed,
        document_offset=document_offset,
    )
    champion = CheckpointRecognizer(champion_checkpoint)
    challenger = CheckpointRecognizer(challenger_checkpoint)
    grouped: dict[Path, list[AnnotatedLine]] = defaultdict(list)
    for annotation in selected:
        grouped[annotation.image_path].append(annotation)

    rows: list[dict[str, Any]] = []
    selection_reasons: Counter[str] = Counter()
    for image_path, lines in sorted(grouped.items(), key=lambda item: item[0].as_posix()):
        with Image.open(image_path) as source:
            page = source.convert("RGB")
            for line in lines:
                line_box = line.box if line.box[2] > line.box[0] and line.box[3] > line.box[1] else (0, 0, page.width, page.height)
                crop = page.crop(line_box)
                champion_text, champion_confidence = champion.recognize(crop)
                challenger_text, challenger_confidence = challenger.recognize(crop)
                x1, y1, x2, y2 = line_box
                aspect_ratio = (x2 - x1) / max(y2 - y1, 1)
                geometry = SegmentBox(x1, y1, x2 - x1, y2 - y1, "line")
                line_role = _infer_line_role(champion_text, line=geometry, page_width=page.width)
                champion_prediction = CustomOcrPrediction(text=champion_text, confidence=champion_confidence)
                challenger_prediction = CustomOcrPrediction(text=challenger_text, confidence=challenger_confidence)
                use_challenger, reason, candidate_scores = _select_crnn_challenger(
                    champion_prediction,
                    challenger_prediction,
                    line_role=line_role,
                    aspect_ratio=aspect_ratio,
                    mode="validated",
                    route_evidence={"status": "SPECIALIST_ACTIVE"},
                )
                selection_reasons[reason] += 1
                selected_text = challenger_text if use_challenger else champion_text
                selected_confidence = challenger_confidence if use_challenger else champion_confidence
                rows.append(
                    {
                        "sampleId": line.sample_id,
                        "image": image_path.as_posix(),
                        "source": line.source,
                        "reference": line.text,
                        "bbox": list(line_box),
                        "aspectRatio": aspect_ratio,
                        "referenceLength": len(line.text),
                        "lineRole": line_role,
                        "championPrediction": champion_text,
                        "championConfidence": champion_confidence,
                        "championCer": cer(line.text, champion_text),
                        "challengerPrediction": challenger_text,
                        "challengerConfidence": challenger_confidence,
                        "challengerCer": cer(line.text, challenger_text),
                        "selectedPrediction": selected_text,
                        "selectedConfidence": selected_confidence,
                        "selectedCer": cer(line.text, selected_text),
                        "challengerSelected": use_challenger,
                        "selectionReason": reason,
                        "candidateScores": candidate_scores,
                    }
                )

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "championCheckpoint": champion_checkpoint.as_posix(),
        "challengerCheckpoint": challenger_checkpoint.as_posix(),
        "manifests": [path.as_posix() for path in manifest_paths],
        "configuration": {
            "maxDocuments": max_documents,
            "linesPerDocument": lines_per_document,
            "seed": seed,
            "documentOffset": document_offset,
            "selectionUnit": "document_lineage",
        },
        "sampleCount": len(rows),
        "documentCount": len({_document_lineage(line) for line in selected}),
        "selectionReasons": dict(sorted(selection_reasons.items())),
        "overall": _summarize_comparison_rows(rows),
        "byAspectRatio": _slice_report(rows, _aspect_bucket),
        "byReferenceLength": _slice_report(rows, _length_bucket),
        "byInferenceRole": _slice_report(rows, lambda row: str(row["lineRole"])),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "recognizer-comparison-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (output_dir / "predictions.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows), encoding="utf-8"
    )
    return report


def _summarize_comparison_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    champion_rows = _evaluation_rows(rows, "champion")
    challenger_rows = _evaluation_rows(rows, "challenger")
    selected_rows = _evaluation_rows(rows, "selected")
    wins = sum(float(row["challengerCer"]) + 0.02 < float(row["championCer"]) for row in rows)
    regressions = sum(float(row["championCer"]) + 0.02 < float(row["challengerCer"]) for row in rows)
    significant_regressions = sum(float(row["challengerCer"]) - float(row["championCer"]) > 0.10 for row in rows)
    selected_regressions = sum(float(row["selectedCer"]) - float(row["championCer"]) > 0.02 for row in rows)
    return {
        "samples": len(rows),
        "challengerSelected": sum(bool(row["challengerSelected"]) for row in rows),
        "champion": _compact_metrics(summarize_prediction_rows(champion_rows)),
        "challenger": _compact_metrics(summarize_prediction_rows(challenger_rows)),
        "composed": _compact_metrics(summarize_prediction_rows(selected_rows)),
        "paired": {
            "wins": wins,
            "regressions": regressions,
            "ties": len(rows) - wins - regressions,
            "regressionRate": regressions / len(rows) if rows else 0.0,
            "significantRegressions": significant_regressions,
            "composedRegressions": selected_regressions,
            "composedRegressionRate": selected_regressions / len(rows) if rows else 0.0,
        },
    }


def _evaluation_rows(rows: list[dict[str, Any]], prefix: str) -> list[dict[str, object]]:
    return [
        {
            "reference": row["reference"],
            "prediction": row[f"{prefix}Prediction"],
            "confidence": row[f"{prefix}Confidence"],
            "cer": row[f"{prefix}Cer"],
            "exactMatch": row["reference"] == row[f"{prefix}Prediction"],
        }
        for row in rows
    ]


def _compact_metrics(metrics: dict[str, object]) -> dict[str, object]:
    return {
        key: value
        for key, value in metrics.items()
        if key not in {"characterConfusionMatrix", "confidenceCalibrationBuckets"}
    }


def _slice_report(rows: list[dict[str, Any]], classifier: Any) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[classifier(row)].append(row)
    return {key: _summarize_comparison_rows(value) for key, value in sorted(grouped.items())}


def _aspect_bucket(row: dict[str, Any]) -> str:
    value = float(row["aspectRatio"])
    if value < 3:
        return "lt_3"
    if value < 6:
        return "3_to_6"
    if value < 10:
        return "6_to_10"
    return "ge_10"


def _length_bucket(row: dict[str, Any]) -> str:
    value = int(row["referenceLength"])
    if value <= 12:
        return "01_12"
    if value <= 24:
        return "13_24"
    if value <= 48:
        return "25_48"
    return "49_plus"


def _stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _document_lineage(annotation: AnnotatedLine) -> str:
    if annotation.source.casefold() == "ocrturk" and ":p" in annotation.sample_id:
        return annotation.sample_id.split(":p", 1)[0]
    return annotation.image_path.as_posix()


def _load_comparison_annotations(paths: Iterable[Path]) -> list[AnnotatedLine]:
    rows: list[AnnotatedLine] = []
    for manifest_path in paths:
        for raw_line in manifest_path.read_text(encoding="utf-8").splitlines():
            if not raw_line.strip():
                continue
            payload = json.loads(raw_line)
            image = payload.get("image")
            text = payload.get("text")
            if not isinstance(image, str) or not isinstance(text, str):
                continue
            image_path = Path(image)
            if not image_path.is_file():
                continue
            raw_box = payload.get("lineCropBox") or payload.get("bbox")
            box = (
                _normalize_box(raw_box, payload.get("lineCropBoxFormat", "xywh"))
                if isinstance(raw_box, list) and len(raw_box) == 4
                else (0, 0, 0, 0)
            )
            rows.append(
                AnnotatedLine(
                    sample_id=str(payload.get("id", "")),
                    image_path=image_path,
                    text=text,
                    box=box,
                    source=str(payload.get("source", "unknown")),
                )
            )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Paired document-balanced Custom OCR recognizer comparison.")
    parser.add_argument("--manifest", action="append", required=True, type=Path)
    parser.add_argument("--champion-checkpoint", required=True, type=Path)
    parser.add_argument("--challenger-checkpoint", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--max-documents", type=int, default=40)
    parser.add_argument("--lines-per-document", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260711)
    parser.add_argument("--document-offset", type=int, default=0)
    args = parser.parse_args()
    report = run_recognizer_comparison(
        args.manifest,
        args.champion_checkpoint,
        args.challenger_checkpoint,
        args.output_dir,
        max_documents=args.max_documents,
        lines_per_document=args.lines_per_document,
        seed=args.seed,
        document_offset=args.document_offset,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
