from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.pipeline import Pipeline

from services.ocr.category_model.dataset import generate_category_dataset, read_category_dataset, sample_to_text


def train_category_model(data_path: Path, artifact_dir: Path, samples_per_category: int = 12, seed: int = 42) -> dict[str, object]:
    if not data_path.exists():
        generate_category_dataset(data_path, count_per_category=samples_per_category, seed=seed)

    samples = read_category_dataset(data_path)
    train_samples = [sample for sample in samples if sample.split == "train"]
    validation_samples = [sample for sample in samples if sample.split == "validation"]
    if not train_samples or not validation_samples:
        raise ValueError("TRAIN_AND_VALIDATION_SPLITS_REQUIRED")

    pipeline = Pipeline(
        [
            ("tfidf", TfidfVectorizer(ngram_range=(1, 2), min_df=1)),
            ("classifier", LogisticRegression(max_iter=400, random_state=seed, class_weight="balanced"))
        ]
    )
    pipeline.fit([sample_to_text(sample) for sample in train_samples], [sample.category for sample in train_samples])

    expected = [sample.category for sample in validation_samples]
    predicted = pipeline.predict([sample_to_text(sample) for sample in validation_samples])
    labels = sorted({sample.category for sample in samples})
    metrics: dict[str, object] = {
        "model": "local-sklearn-tfidf-logistic-regression",
        "version": "category-ml-v1",
        "seed": seed,
        "samples": len(samples),
        "train_samples": len(train_samples),
        "validation_samples": len(validation_samples),
        "labels": labels,
        "accuracy": accuracy_score(expected, predicted),
        "macro_f1": f1_score(expected, predicted, average="macro", zero_division=0),
        "confusion_matrix": confusion_matrix(expected, predicted, labels=labels).tolist(),
        "classification_report": classification_report(expected, predicted, labels=labels, zero_division=0, output_dict=True),
        "accuracy_note": "Synthetic smoke dataset only; not production accurate."
    }

    artifact_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(pipeline, artifact_dir / "category_model.joblib")
    (artifact_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-path", type=Path, default=Path("data/generated/category-smoke/expenses.csv"))
    parser.add_argument("--artifact-dir", type=Path, default=Path("artifacts/models/category-smoke"))
    parser.add_argument("--samples-per-category", type=int, default=12)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    metrics = train_category_model(
        data_path=args.data_path,
        artifact_dir=args.artifact_dir,
        samples_per_category=args.samples_per_category,
        seed=args.seed
    )
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()

