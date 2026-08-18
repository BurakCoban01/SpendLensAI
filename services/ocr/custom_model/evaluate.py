from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import cv2
import numpy as np

from services.ocr.custom_model.cli import configure_utf8_stdout
from services.ocr.custom_model.dataset import generate_dataset
from services.ocr.custom_model.infer import DEFAULT_BLANK_PENALTY, infer_with_confidence
from services.ocr.custom_model.normalization import normalize_for_extraction
from services.ocr.custom_model.numeric_field_recognizer import (
    load_numeric_character_model,
    recognize_numeric_field_line,
)
from services.ocr.custom_model.segmentation import SegmentBox

TURKISH_SPECIAL_CHARACTERS = set("çğıİöşüÇĞÖŞÜ₺")
CONFIDENCE_BUCKETS = (
    ("0.00-0.50", 0.0, 0.5),
    ("0.50-0.75", 0.5, 0.75),
    ("0.75-0.90", 0.75, 0.9),
    ("0.90-1.00", 0.9, 1.0000001),
)
HIGH_CONFIDENCE_THRESHOLD = 0.75
HIGH_CONFIDENCE_WRONG_CER_THRESHOLD = 0.35


def cer(reference: str, hypothesis: str) -> float:
    rows = len(reference) + 1
    cols = len(hypothesis) + 1
    dp = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        dp[i][0] = i
    for j in range(cols):
        dp[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            cost = 0 if reference[i - 1] == hypothesis[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    return dp[-1][-1] / max(len(reference), 1)


def wer(reference: str, hypothesis: str) -> float:
    return _edit_distance(reference.split(), hypothesis.split()) / max(len(reference.split()), 1)


def evaluate_predictions(predictions_path: Path) -> dict[str, object]:
    rows = [json.loads(line) for line in predictions_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return summarize_prediction_rows(rows)


def evaluate_custom_ocr_checkpoint(
    checkpoint: Path,
    data_dir: Path,
    manifest_path: Path | None = None,
    split: str = "test",
    report_path: Path | None = None,
    predictions_path: Path | None = None,
    generate_if_missing: bool = False,
    samples: int = 32,
    seed: int = 42,
    decoder_method: str = "beam",
    beam_width: int = 8,
    blank_penalty: float = DEFAULT_BLANK_PENALTY,
    numeric_char_checkpoint: Path | None = None,
    variant: str | None = None,
) -> dict[str, object]:
    manifest = manifest_path or data_dir / "manifest.jsonl"
    if generate_if_missing and not manifest.exists():
        generate_dataset(data_dir, count=samples, seed=seed)
    if not checkpoint.exists():
        raise FileNotFoundError(f"Custom OCR checkpoint not found: {checkpoint}")
    if not manifest.exists():
        raise FileNotFoundError(f"Custom OCR manifest not found: {manifest}")

    rows = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
    selected = rows if split == "all" else [row for row in rows if row.get("split") == split]
    if variant is not None:
        selected = [row for row in selected if row.get("variant") == variant]
    numeric_model = None
    numeric_metadata: dict[str, object] = {}
    if numeric_char_checkpoint is not None:
        numeric_model, numeric_metadata = load_numeric_character_model(numeric_char_checkpoint)
    predictions: list[dict[str, object]] = []
    for row in selected:
        image_path = _resolve_manifest_image_path(data_dir, row.get("image"))
        line_crop_box = _line_crop_box(row)
        prediction = infer_with_confidence(
            checkpoint,
            image_path,
            decoder_method=decoder_method,
            beam_width=beam_width,
            blank_penalty=blank_penalty,
            cropped_line=row.get("source") == "synthetic_document_line_crop" or line_crop_box is not None,
            line_crop_box=line_crop_box,
        )
        normalized_prediction = normalize_for_extraction(prediction.text)
        assisted = False
        if numeric_model is not None:
            gray = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
            if gray is None:
                raise ValueError(f"Evaluation image could not be read: {image_path}")
            _threshold, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            foreground_y, foreground_x = np.where(binary > 0)
            if len(foreground_x):
                line = SegmentBox(
                    int(foreground_x.min()),
                    int(foreground_y.min()),
                    int(foreground_x.max() - foreground_x.min() + 1),
                    int(foreground_y.max() - foreground_y.min() + 1),
                    "line",
                )
                numeric_prediction = recognize_numeric_field_line(
                    numeric_model,
                    numeric_metadata,
                    gray,
                    binary,
                    line,
                    prediction.text,
                )
                if numeric_prediction is not None:
                    normalized_prediction = normalize_for_extraction(numeric_prediction.normalized_line)
                    assisted = True
        predictions.append(
            {
                "image": str(image_path),
                "split": row.get("split", "unknown"),
                "source": row.get("source", "unknown"),
                "reference": row["text"],
                "prediction": prediction.text,
                "normalizedPrediction": normalized_prediction,
                "confidence": prediction.confidence,
                "decoder": prediction.decoder,
                "cer": cer(row["text"], prediction.text),
                "wer": wer(row["text"], prediction.text),
                "exactMatch": row["text"] == prediction.text,
                "normalizedCer": cer(row["text"], normalized_prediction),
                "normalizedWer": wer(row["text"], normalized_prediction),
                "normalizedExactMatch": row["text"] == normalized_prediction,
                "numericFieldAssistUsed": assisted,
            }
        )

    metrics = summarize_prediction_rows(predictions)
    metrics["sourceMix"] = _prediction_source_mix(predictions)
    metrics["bySource"] = _summarize_prediction_rows_by_source(predictions)
    normalized_metrics = summarize_prediction_rows(
        [
            {
                **row,
                "prediction": row["normalizedPrediction"],
                "cer": row["normalizedCer"],
                "wer": row["normalizedWer"],
                "exactMatch": row["normalizedExactMatch"],
            }
            for row in predictions
        ]
    )
    normalized_metrics["sourceMix"] = _prediction_source_mix(predictions)
    normalized_metrics["bySource"] = _summarize_prediction_rows_by_source(
        [
            {
                **row,
                "prediction": row["normalizedPrediction"],
                "cer": row["normalizedCer"],
                "wer": row["normalizedWer"],
                "exactMatch": row["normalizedExactMatch"],
            }
            for row in predictions
        ]
    )
    report = {
        "engine": "CUSTOM_CRNN",
        "checkpoint": str(checkpoint),
        "dataset": {
            "dataDir": str(data_dir),
            "manifest": str(manifest),
            "split": split,
            "variant": variant,
            "samples": len(predictions),
        },
        "decoder": {
            "method": decoder_method,
            "beamWidth": beam_width if decoder_method == "beam" else None,
            "blankPenalty": blank_penalty,
        },
        "metrics": metrics,
        "normalizedMetrics": normalized_metrics,
        "numericFieldAssist": {
            "checkpoint": str(numeric_char_checkpoint) if numeric_char_checkpoint is not None else None,
            "assistedSamples": sum(bool(row["numericFieldAssistUsed"]) for row in predictions),
        },
        "limitations": [
            "Synthetic smoke evaluation is not a production accuracy claim.",
            "Accuracy must be interpreted with dataset size and split context.",
        ],
    }

    if predictions_path:
        predictions_path.parent.mkdir(parents=True, exist_ok=True)
        predictions_path.write_text(
            "\n".join(json.dumps(row, ensure_ascii=False) for row in predictions),
            encoding="utf-8",
        )
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def summarize_prediction_rows(rows: list[dict[str, object]]) -> dict[str, object]:
    cer_scores = [float(row.get("cer", cer(str(row["reference"]), str(row["prediction"])))) for row in rows]
    wer_scores = [float(row.get("wer", wer(str(row["reference"]), str(row["prediction"])))) for row in rows]
    confidence_scores = [float(row["confidence"]) for row in rows if isinstance(row.get("confidence"), int | float)]
    exact_matches = [bool(row.get("exactMatch", row["reference"] == row["prediction"])) for row in rows]
    token_true_positive = 0
    token_reference_total = 0
    token_prediction_total = 0
    special_reference_total = 0
    special_prediction_total = 0
    special_correct = 0
    amount_true_positive = 0
    amount_reference_total = 0
    amount_prediction_total = 0
    confusion: dict[str, dict[str, int]] = {}
    for row in rows:
        reference = str(row["reference"])
        prediction = str(row["prediction"])
        reference_tokens = reference.split()
        prediction_tokens = prediction.split()
        token_reference_total += len(reference_tokens)
        token_prediction_total += len(prediction_tokens)
        token_true_positive += _multiset_intersection_size(reference_tokens, prediction_tokens)
        reference_amounts = _amount_tokens(reference)
        prediction_amounts = _amount_tokens(prediction)
        amount_reference_total += len(reference_amounts)
        amount_prediction_total += len(prediction_amounts)
        amount_true_positive += _multiset_intersection_size(reference_amounts, prediction_amounts)
        for ref_char, hyp_char in _align_characters(reference, prediction):
            if ref_char in TURKISH_SPECIAL_CHARACTERS:
                special_reference_total += 1
            if hyp_char in TURKISH_SPECIAL_CHARACTERS:
                special_prediction_total += 1
            if ref_char in TURKISH_SPECIAL_CHARACTERS:
                if hyp_char == ref_char:
                    special_correct += 1
            if ref_char != hyp_char:
                source = ref_char if ref_char is not None else "<inserted>"
                target = hyp_char if hyp_char is not None else "<deleted>"
                confusion.setdefault(source, {})
                confusion[source][target] = confusion[source].get(target, 0) + 1
    token_precision = token_true_positive / token_prediction_total if token_prediction_total else 0.0
    token_recall = token_true_positive / token_reference_total if token_reference_total else 0.0
    special_precision = special_correct / special_prediction_total if special_prediction_total else 0.0
    special_recall = special_correct / special_reference_total if special_reference_total else 0.0
    amount_precision = amount_true_positive / amount_prediction_total if amount_prediction_total else 0.0
    amount_recall = amount_true_positive / amount_reference_total if amount_reference_total else 0.0
    return {
        "samples": len(rows),
        "averageCer": sum(cer_scores) / len(cer_scores) if cer_scores else 1.0,
        "averageWer": sum(wer_scores) / len(wer_scores) if wer_scores else 1.0,
        "exactMatchRate": sum(1 for value in exact_matches if value) / len(exact_matches) if exact_matches else 0.0,
        "averageConfidence": sum(confidence_scores) / len(confidence_scores) if confidence_scores else None,
        "highConfidenceWrongCount": _high_confidence_wrong_count(rows),
        "tokenPrecision": token_precision,
        "tokenRecall": token_recall,
        "tokenF1": _f1(token_precision, token_recall),
        "turkishSpecialCharacterAccuracy": special_correct / special_reference_total if special_reference_total else None,
        "turkishSpecialCharacterPrecision": special_precision,
        "turkishSpecialCharacterRecall": special_recall,
        "turkishSpecialCharacterF1": _f1(special_precision, special_recall),
        "turkishSpecialCharacterSupport": special_reference_total,
        "turkishSpecialCharacterPredictionSupport": special_prediction_total,
        "amountPrecision": amount_precision,
        "amountRecall": amount_recall,
        "amountF1": _f1(amount_precision, amount_recall),
        "amountSupport": amount_reference_total,
        "amountPredictionSupport": amount_prediction_total,
        "characterConfusionMatrix": _sorted_confusion(confusion),
        "confidenceCalibrationBuckets": _confidence_buckets(rows),
    }


def _amount_tokens(text: str) -> list[str]:
    matches = re.findall(r"(?<!\d)(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[,.]\d{1,3}(?!\d)", text)
    return [re.sub(r"\D", "", match) for match in matches]


def _resolve_manifest_image_path(data_dir: Path, image_value: object) -> Path:
    if not isinstance(image_value, str) or not image_value.strip():
        raise ValueError("Evaluation manifest row is missing a usable image path.")
    image_path = Path(image_value)
    if image_path.is_absolute():
        return image_path
    candidate = data_dir / image_path
    if candidate.exists():
        return candidate
    return image_path


def _line_crop_box(row: dict[str, object]) -> tuple[int, int, int, int] | None:
    value = row.get("lineCropBox")
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError("lineCropBox must be a four-value [left, top, right, bottom] list.")
    try:
        left, top, right, bottom = [int(item) for item in value]
    except (TypeError, ValueError) as exc:
        raise ValueError("lineCropBox values must be integers.") from exc
    if right <= left or bottom <= top:
        raise ValueError("lineCropBox must have positive width and height.")
    return (left, top, right, bottom)


def _prediction_source_mix(rows: list[dict[str, object]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        source = str(row.get("source") or "unknown")
        counts[source] = counts.get(source, 0) + 1
    return dict(sorted(counts.items()))


def _summarize_prediction_rows_by_source(rows: list[dict[str, object]]) -> dict[str, object]:
    grouped: dict[str, list[dict[str, object]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("source") or "unknown"), []).append(row)
    return {source: summarize_prediction_rows(source_rows) for source, source_rows in sorted(grouped.items())}


def _multiset_intersection_size(reference_tokens: list[str], prediction_tokens: list[str]) -> int:
    remaining: dict[str, int] = {}
    for token in reference_tokens:
        remaining[token] = remaining.get(token, 0) + 1
    matches = 0
    for token in prediction_tokens:
        count = remaining.get(token, 0)
        if count <= 0:
            continue
        matches += 1
        remaining[token] = count - 1
    return matches


def _f1(precision: float, recall: float) -> float:
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def _edit_distance(reference: str | list[str], hypothesis: str | list[str]) -> int:
    rows = len(reference) + 1
    cols = len(hypothesis) + 1
    dp = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        dp[i][0] = i
    for j in range(cols):
        dp[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            cost = 0 if reference[i - 1] == hypothesis[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    return dp[-1][-1]


def _align_characters(reference: str, hypothesis: str) -> list[tuple[str | None, str | None]]:
    rows = len(reference) + 1
    cols = len(hypothesis) + 1
    dp = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        dp[i][0] = i
    for j in range(cols):
        dp[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            cost = 0 if reference[i - 1] == hypothesis[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)

    alignment: list[tuple[str | None, str | None]] = []
    i = len(reference)
    j = len(hypothesis)
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            cost = 0 if reference[i - 1] == hypothesis[j - 1] else 1
            if dp[i][j] == dp[i - 1][j - 1] + cost:
                alignment.append((reference[i - 1], hypothesis[j - 1]))
                i -= 1
                j -= 1
                continue
        if i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            alignment.append((reference[i - 1], None))
            i -= 1
        else:
            alignment.append((None, hypothesis[j - 1]))
            j -= 1
    alignment.reverse()
    return alignment


def _sorted_confusion(confusion: dict[str, dict[str, int]]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for reference in sorted(confusion):
        for prediction, count in sorted(confusion[reference].items(), key=lambda item: (-item[1], item[0])):
            rows.append({"reference": reference, "prediction": prediction, "count": count})
    return rows


def _confidence_buckets(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    buckets = {label: {"bucket": label, "samples": 0, "exactMatches": 0, "averageCer": None} for label, _lower, _upper in CONFIDENCE_BUCKETS}
    cer_values: dict[str, list[float]] = {label: [] for label, _lower, _upper in CONFIDENCE_BUCKETS}
    for row in rows:
        confidence = row.get("confidence")
        if not isinstance(confidence, int | float):
            continue
        label = next((bucket_label for bucket_label, lower, upper in CONFIDENCE_BUCKETS if lower <= confidence < upper), None)
        if label is None:
            continue
        buckets[label]["samples"] = int(buckets[label]["samples"]) + 1
        if bool(row.get("exactMatch", row["reference"] == row["prediction"])):
            buckets[label]["exactMatches"] = int(buckets[label]["exactMatches"]) + 1
        cer_values[label].append(float(row.get("cer", cer(str(row["reference"]), str(row["prediction"])))))
    result = []
    for label, _lower, _upper in CONFIDENCE_BUCKETS:
        bucket = dict(buckets[label])
        values = cer_values[label]
        bucket["exactMatchRate"] = bucket["exactMatches"] / bucket["samples"] if bucket["samples"] else None
        bucket["averageCer"] = sum(values) / len(values) if values else None
        result.append(bucket)
    return result


def _high_confidence_wrong_count(rows: list[dict[str, object]]) -> int:
    count = 0
    for row in rows:
        confidence = row.get("confidence")
        if not isinstance(confidence, int | float) or float(confidence) < HIGH_CONFIDENCE_THRESHOLD:
            continue
        row_cer = float(row.get("cer", cer(str(row["reference"]), str(row["prediction"]))))
        exact_match = bool(row.get("exactMatch", row["reference"] == row["prediction"]))
        if not exact_match or row_cer > HIGH_CONFIDENCE_WRONG_CER_THRESHOLD:
            count += 1
    return count


def main() -> None:
    configure_utf8_stdout()
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="local_full")
    parser.add_argument("--model", default="custom_crnn")
    parser.add_argument("--predictions", type=Path)
    parser.add_argument("--checkpoint", type=Path, default=Path("artifacts/models/custom-crnn-local-full/model.pt"))
    parser.add_argument("--data-dir", type=Path, default=Path("data/generated/ocr-smoke"))
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--split", choices=["all", "train", "validation", "test"], default="test")
    parser.add_argument("--report-path", type=Path)
    parser.add_argument("--predictions-path", type=Path)
    parser.add_argument("--generate-if-missing", action="store_true")
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--decoder", choices=("greedy", "beam"), default="beam")
    parser.add_argument("--beam-width", type=int, default=8)
    parser.add_argument("--blank-penalty", type=float, default=DEFAULT_BLANK_PENALTY)
    parser.add_argument("--numeric-char-checkpoint", type=Path)
    parser.add_argument("--variant")
    args = parser.parse_args()
    if args.predictions and "--checkpoint" not in _argv_flags():
        result = evaluate_predictions(args.predictions)
    elif args.checkpoint:
        result = evaluate_custom_ocr_checkpoint(
            checkpoint=args.checkpoint,
            data_dir=args.data_dir,
            manifest_path=args.manifest,
            split=args.split,
            report_path=args.report_path,
            predictions_path=args.predictions_path,
            generate_if_missing=args.generate_if_missing,
            samples=args.samples,
            seed=args.seed,
            decoder_method=args.decoder,
            beam_width=args.beam_width,
            blank_penalty=args.blank_penalty,
            numeric_char_checkpoint=args.numeric_char_checkpoint,
            variant=args.variant,
        )
    else:
        raise SystemExit("Provide either --predictions or --checkpoint.")
    if isinstance(result, dict):
        result = {"profile": args.profile, "model": args.model, **result}
    print(json.dumps(result, ensure_ascii=False, indent=2))


def _argv_flags() -> set[str]:
    import sys

    return {arg for arg in sys.argv[1:] if arg.startswith("--")}


if __name__ == "__main__":
    main()
