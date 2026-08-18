from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score

from services.ocr.category_model.dataset import generate_category_dataset, read_category_dataset, sample_to_text


def evaluate_category_model(data_path: Path, model_path: Path, split: str = "test", report_path: Path | None = None) -> dict[str, object]:
    samples = [sample for sample in read_category_dataset(data_path) if split == "all" or sample.split == split]
    if not samples:
        raise ValueError("EVALUATION_SPLIT_EMPTY")

    pipeline = joblib.load(model_path)
    expected = [sample.category for sample in samples]
    predicted = pipeline.predict([sample_to_text(sample) for sample in samples])
    labels = sorted(set(expected) | set(predicted))
    report: dict[str, object] = {
        "split": split,
        "samples": len(samples),
        "labels": labels,
        "accuracy": accuracy_score(expected, predicted),
        "macro_f1": f1_score(expected, predicted, average="macro", zero_division=0),
        "confusion_matrix": confusion_matrix(expected, predicted, labels=labels).tolist(),
        "classification_report": classification_report(expected, predicted, labels=labels, zero_division=0, output_dict=True),
        "accuracy_note": "Synthetic/local evaluation only; review before promotion."
    }
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-path", type=Path, default=Path("data/generated/category-smoke/expenses.csv"))
    parser.add_argument("--model-path", type=Path, default=Path("artifacts/models/category-smoke/category_model.joblib"))
    parser.add_argument("--split", choices=["train", "validation", "test", "all"], default="test")
    parser.add_argument("--report-path", type=Path, default=Path("artifacts/models/category-smoke/evaluation.json"))
    parser.add_argument("--generate-if-missing", action="store_true")
    parser.add_argument("--samples-per-category", type=int, default=12)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if args.generate_if_missing and not args.data_path.exists():
        generate_category_dataset(args.data_path, count_per_category=args.samples_per_category, seed=args.seed)

    report = evaluate_category_model(args.data_path, args.model_path, args.split, args.report_path)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
