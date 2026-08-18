from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from statistics import mean

from services.ocr.category_model.evaluate import evaluate_category_model
from services.ocr.category_model.train import train_category_model


def run_category_benchmark(
    output_dir: Path,
    seeds: list[int] | None = None,
    samples_per_category: int = 24,
    min_accuracy: float = 0.65,
    min_macro_f1: float = 0.65,
) -> dict[str, object]:
    selected_seeds = seeds or [11, 29, 47]
    if samples_per_category < 8:
        raise ValueError("samples_per_category must be at least 8 for stable train/validation/test splits")
    output_dir.mkdir(parents=True, exist_ok=True)

    runs: list[dict[str, object]] = []
    for seed in selected_seeds:
        run_dir = output_dir / f"seed-{seed}"
        data_path = run_dir / "data" / "expenses.csv"
        artifact_dir = run_dir / "artifacts"
        train_metrics = train_category_model(data_path, artifact_dir, samples_per_category=samples_per_category, seed=seed)
        evaluation = evaluate_category_model(
            data_path=data_path,
            model_path=artifact_dir / "category_model.joblib",
            split="test",
            report_path=artifact_dir / "evaluation.json",
        )
        runs.append(
            {
                "seed": seed,
                "samples": train_metrics["samples"],
                "trainSamples": train_metrics["train_samples"],
                "validationSamples": train_metrics["validation_samples"],
                "testSamples": evaluation["samples"],
                "accuracy": evaluation["accuracy"],
                "macroF1": evaluation["macro_f1"],
                "labels": evaluation["labels"],
                "confusionMatrix": evaluation["confusion_matrix"],
                "artifactDir": str(artifact_dir),
                "reportPath": str(artifact_dir / "evaluation.json"),
            }
        )

    accuracies = [float(run["accuracy"]) for run in runs]
    macro_f1_scores = [float(run["macroF1"]) for run in runs]
    report: dict[str, object] = {
        "model": "local-sklearn-tfidf-logistic-regression",
        "benchmark": "category-regression",
        "profile": {
            "seeds": selected_seeds,
            "samplesPerCategory": samples_per_category,
            "minAccuracy": min_accuracy,
            "minMacroF1": min_macro_f1,
        },
        "summary": {
            "runs": len(runs),
            "averageAccuracy": mean(accuracies),
            "minimumAccuracy": min(accuracies),
            "averageMacroF1": mean(macro_f1_scores),
            "minimumMacroF1": min(macro_f1_scores),
            "passed": min(accuracies) >= min_accuracy and min(macro_f1_scores) >= min_macro_f1,
        },
        "runs": runs,
        "accuracyNote": "Synthetic local benchmark; use for regression detection, not production accuracy claims.",
    }
    (output_dir / "category-benchmark-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def parse_seeds(value: str) -> list[int]:
    seeds = [int(part) for part in re.split(r"[\s,]+", value.strip()) if part]
    if not seeds:
        raise argparse.ArgumentTypeError("At least one seed is required")
    return seeds


def main() -> None:
    parser = argparse.ArgumentParser(description="Run deterministic category model benchmark regression.")
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/benchmarks/category-regression"))
    parser.add_argument("--seeds", type=parse_seeds, default=[11, 29, 47])
    parser.add_argument("--samples-per-category", type=int, default=24)
    parser.add_argument("--min-accuracy", type=float, default=0.65)
    parser.add_argument("--min-macro-f1", type=float, default=0.65)
    parser.add_argument("--fail-under-threshold", action="store_true")
    args = parser.parse_args()

    report = run_category_benchmark(
        output_dir=args.output_dir,
        seeds=args.seeds,
        samples_per_category=args.samples_per_category,
        min_accuracy=args.min_accuracy,
        min_macro_f1=args.min_macro_f1,
    )
    print(json.dumps(report, indent=2))
    if args.fail_under_threshold and not report["summary"]["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
