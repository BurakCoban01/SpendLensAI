from __future__ import annotations

import argparse
import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from PIL import Image

from services.ocr.benchmarks.ocr_benchmark import cer, wer
from services.ocr.custom_model.infer import (
    _calibrate_line_prediction,
    _decoder_blank_penalty_from_metadata,
    _input_inverted_from_metadata,
    _line_image_min_width_from_metadata,
    _load_model,
    _predict_line,
    _validation_reliability,
)
from services.ocr.custom_model.numeric_field_recognizer import image_to_gray_and_binary
from services.ocr.custom_model.segmentation import SegmentBox, segment_lines


@dataclass(frozen=True)
class AnnotatedLine:
    sample_id: str
    image_path: Path
    text: str
    box: tuple[int, int, int, int]
    source: str


@dataclass(frozen=True)
class BoxMatch:
    truth_index: int
    prediction_index: int
    iou: float


class CheckpointRecognizer:
    def __init__(self, checkpoint: Path) -> None:
        self.model, self.metadata = _load_model(checkpoint)
        self.blank_penalty = _decoder_blank_penalty_from_metadata(self.metadata, None)
        self.reliability = _validation_reliability(self.metadata)

    def recognize(self, image: Image.Image) -> tuple[str, float]:
        prediction = _predict_line(
            self.model,
            image,
            decoder_method="beam",
            beam_width=8,
            blank_penalty=self.blank_penalty,
            cropped_line=True,
            line_image_min_width=_line_image_min_width_from_metadata(self.metadata),
            input_inverted=_input_inverted_from_metadata(self.metadata),
        )
        calibrated = _calibrate_line_prediction(prediction, self.reliability)
        return calibrated.text, calibrated.confidence


def box_iou(left: tuple[int, int, int, int], right: tuple[int, int, int, int]) -> float:
    intersection = _intersection_area(left, right)
    if intersection <= 0:
        return 0.0
    left_area = max(0, left[2] - left[0]) * max(0, left[3] - left[1])
    right_area = max(0, right[2] - right[0]) * max(0, right[3] - right[1])
    return intersection / max(left_area + right_area - intersection, 1)


def match_boxes(
    truth: list[tuple[int, int, int, int]],
    predictions: list[tuple[int, int, int, int]],
    threshold: float,
) -> list[BoxMatch]:
    candidates = sorted(
        (
            BoxMatch(truth_index, prediction_index, box_iou(truth_box, prediction_box))
            for truth_index, truth_box in enumerate(truth)
            for prediction_index, prediction_box in enumerate(predictions)
        ),
        key=lambda match: (-match.iou, match.truth_index, match.prediction_index),
    )
    used_truth: set[int] = set()
    used_predictions: set[int] = set()
    matches: list[BoxMatch] = []
    for candidate in candidates:
        if candidate.iou < threshold:
            break
        if candidate.truth_index in used_truth or candidate.prediction_index in used_predictions:
            continue
        matches.append(candidate)
        used_truth.add(candidate.truth_index)
        used_predictions.add(candidate.prediction_index)
    return sorted(matches, key=lambda match: match.truth_index)


def detection_metrics(
    truth: list[tuple[int, int, int, int]],
    predictions: list[tuple[int, int, int, int]],
    threshold: float = 0.5,
) -> dict[str, float | int]:
    matches = match_boxes(truth, predictions, threshold)
    matched = len(matches)
    precision = matched / len(predictions) if predictions else (1.0 if not truth else 0.0)
    recall = matched / len(truth) if truth else (1.0 if not predictions else 0.0)
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    ious = [match.iou for match in matches]
    return {
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "meanIoU": sum(ious) / len(ious) if ious else 0.0,
        "medianIoU": _median(ious),
        "matchedLineCount": matched,
        "missedLineCount": max(0, len(truth) - matched),
        "duplicateLineCount": max(0, len(predictions) - matched),
        "mergedLineCount": _many_to_one_count(truth, predictions),
        "splitLineCount": _many_to_one_count(predictions, truth),
        "readingOrderAccuracy": _reading_order_accuracy(matches, predictions),
    }


def run_stage_diagnostics(
    manifest_paths: list[Path],
    checkpoint: Path,
    output_dir: Path,
    *,
    iou_threshold: float = 0.5,
    max_documents: int = 20,
    max_lines: int = 400,
) -> dict[str, Any]:
    annotations = _load_annotations(manifest_paths)
    grouped: dict[Path, list[AnnotatedLine]] = defaultdict(list)
    for annotation in annotations:
        grouped[annotation.image_path].append(annotation)
    selected = sorted(grouped.items(), key=lambda item: item[0].as_posix())[:max_documents]
    recognizer = CheckpointRecognizer(checkpoint)
    document_rows: list[dict[str, Any]] = []
    ground_truth_predictions: list[tuple[str, str]] = []
    predicted_crop_predictions: list[tuple[str, str]] = []
    remaining_lines = max_lines

    for image_path, lines in selected:
        lines = sorted(lines, key=lambda line: (line.box[1], line.box[0]))
        recognition_lines = lines[: max(0, remaining_lines)]
        remaining_lines -= len(recognition_lines)
        with Image.open(image_path) as source:
            page = source.convert("RGB")
            _gray, binary = image_to_gray_and_binary(page)
            predicted_segments = segment_lines(binary)
            predicted_boxes = [_segment_xyxy(segment) for segment in predicted_segments]
            recognition_boxes = [_segment_recognition_xyxy(segment) for segment in predicted_segments]
            truth_boxes = [line.box for line in lines]
            matches = match_boxes(truth_boxes, predicted_boxes, iou_threshold)
            metrics = detection_metrics(truth_boxes, predicted_boxes, iou_threshold)
            for line in recognition_lines:
                prediction, _confidence = recognizer.recognize(page.crop(line.box))
                ground_truth_predictions.append((line.text, prediction))
            for match in matches:
                if match.truth_index >= len(recognition_lines):
                    continue
                line = lines[match.truth_index]
                prediction, _confidence = recognizer.recognize(page.crop(recognition_boxes[match.prediction_index]))
                predicted_crop_predictions.append((line.text, prediction))
        document_rows.append({"image": image_path.as_posix(), "source": lines[0].source, **metrics})

    detection = _aggregate_detection(document_rows)
    ground_truth_crop = _recognition_metrics(ground_truth_predictions)
    predicted_crop = _recognition_metrics(predicted_crop_predictions)
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "checkpoint": checkpoint.as_posix(),
        "manifests": [path.as_posix() for path in manifest_paths],
        "configuration": {
            "iouThreshold": iou_threshold,
            "maxDocuments": max_documents,
            "maxLines": max_lines,
        },
        "detectionSegmentation": detection,
        "groundTruthCropRecognition": ground_truth_crop,
        "predictedCropRecognition": predicted_crop,
        "segmentationCerDamage": _optional_delta(predicted_crop.get("cer"), ground_truth_crop.get("cer")),
        "documents": document_rows,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "stage-diagnostics-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def _load_annotations(paths: Iterable[Path]) -> list[AnnotatedLine]:
    rows: list[AnnotatedLine] = []
    for manifest_path in paths:
        for raw_line in manifest_path.read_text(encoding="utf-8").splitlines():
            if not raw_line.strip():
                continue
            payload = json.loads(raw_line)
            raw_box = payload.get("lineCropBox") or payload.get("bbox")
            image = payload.get("image")
            text = payload.get("text")
            if not isinstance(raw_box, list) or len(raw_box) != 4 or not isinstance(image, str) or not isinstance(text, str):
                continue
            image_path = Path(image)
            if not image_path.is_file():
                continue
            box = _normalize_box(raw_box, payload.get("lineCropBoxFormat", "xywh"))
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


def _normalize_box(values: list[Any], box_format: object) -> tuple[int, int, int, int]:
    x1, y1, third, fourth = (int(value) for value in values)
    if box_format == "xyxy":
        return x1, y1, third, fourth
    return x1, y1, x1 + third, y1 + fourth


def _segment_xyxy(segment: SegmentBox) -> tuple[int, int, int, int]:
    return segment.x, segment.y, segment.x + segment.w, segment.y + segment.h


def _segment_recognition_xyxy(segment: SegmentBox) -> tuple[int, int, int, int]:
    x, y, width, height = segment.recognition_bbox or segment.bbox
    return x, y, x + width, y + height


def _intersection_area(left: tuple[int, int, int, int], right: tuple[int, int, int, int]) -> int:
    width = max(0, min(left[2], right[2]) - max(left[0], right[0]))
    height = max(0, min(left[3], right[3]) - max(left[1], right[1]))
    return width * height


def _coverage(inner: tuple[int, int, int, int], outer: tuple[int, int, int, int]) -> float:
    area = max(1, (inner[2] - inner[0]) * (inner[3] - inner[1]))
    return _intersection_area(inner, outer) / area


def _many_to_one_count(parts: list[tuple[int, int, int, int]], containers: list[tuple[int, int, int, int]]) -> int:
    return sum(1 for container in containers if sum(_coverage(part, container) >= 0.5 for part in parts) >= 2)


def _reading_order_accuracy(matches: list[BoxMatch], predictions: list[tuple[int, int, int, int]]) -> float:
    if len(matches) < 2:
        return 1.0
    predicted_order = {index: index for index in range(len(predictions))}
    concordant = 0
    pairs = 0
    for left_index, left in enumerate(matches):
        for right in matches[left_index + 1 :]:
            pairs += 1
            if predicted_order[left.prediction_index] < predicted_order[right.prediction_index]:
                concordant += 1
    return concordant / pairs if pairs else 1.0


def _aggregate_detection(rows: list[dict[str, Any]]) -> dict[str, float | int]:
    if not rows:
        return {"documentCount": 0, "matchedLineCount": 0, "missedLineCount": 0, "duplicateLineCount": 0}
    count_keys = ("matchedLineCount", "missedLineCount", "duplicateLineCount", "mergedLineCount", "splitLineCount")
    totals = {key: sum(int(row[key]) for row in rows) for key in count_keys}
    truth_total = totals["matchedLineCount"] + totals["missedLineCount"]
    prediction_total = totals["matchedLineCount"] + totals["duplicateLineCount"]
    precision = totals["matchedLineCount"] / prediction_total if prediction_total else 0.0
    recall = totals["matchedLineCount"] / truth_total if truth_total else 0.0
    return {
        "documentCount": len(rows),
        **totals,
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
        "meanIoU": sum(float(row["meanIoU"]) for row in rows) / len(rows),
        "medianIoU": _median([float(row["medianIoU"]) for row in rows]),
        "readingOrderAccuracy": sum(float(row["readingOrderAccuracy"]) for row in rows) / len(rows),
    }


def _recognition_metrics(rows: list[tuple[str, str]]) -> dict[str, float | int | None]:
    if not rows:
        return {"lineCount": 0, "cer": None, "wer": None, "lineExactMatch": None, "numericPunctuationExact": None}
    punctuation_rows = [(reference, prediction) for reference, prediction in rows if any(char in reference for char in ",.:/")]
    return {
        "lineCount": len(rows),
        "cer": sum(cer(reference, prediction) for reference, prediction in rows) / len(rows),
        "wer": sum(wer(reference, prediction) for reference, prediction in rows) / len(rows),
        "lineExactMatch": sum(reference == prediction for reference, prediction in rows) / len(rows),
        "numericPunctuationExact": (
            sum(_punctuation_sequence(reference) == _punctuation_sequence(prediction) for reference, prediction in punctuation_rows)
            / len(punctuation_rows)
            if punctuation_rows
            else None
        ),
    }


def _punctuation_sequence(value: str) -> str:
    return "".join(character for character in value if character in ",.:/")


def _optional_delta(value: object, baseline: object) -> float | None:
    if not isinstance(value, (int, float)) or not isinstance(baseline, (int, float)):
        return None
    return float(value) - float(baseline)


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def main() -> None:
    parser = argparse.ArgumentParser(description="Stage-separated Custom OCR segmentation and recognition diagnostics.")
    parser.add_argument("--manifest", action="append", required=True, type=Path)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    parser.add_argument("--max-documents", type=int, default=20)
    parser.add_argument("--max-lines", type=int, default=400)
    args = parser.parse_args()
    report = run_stage_diagnostics(
        args.manifest,
        args.checkpoint,
        args.output_dir,
        iou_threshold=args.iou_threshold,
        max_documents=args.max_documents,
        max_lines=args.max_lines,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
