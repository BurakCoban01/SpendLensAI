from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from services.ocr.category_model.dataset import generate_category_dataset, read_category_dataset
from services.ocr.category_model.benchmark import parse_seeds, run_category_benchmark
from services.ocr.category_model.evaluate import evaluate_category_model
from services.ocr.category_model.infer import predict_category
from services.ocr.category_model.train import train_category_model


class CategoryModelTests(unittest.TestCase):
    def test_category_dataset_generation_is_deterministic_and_split(self) -> None:
        with tempfile.TemporaryDirectory() as left_dir, tempfile.TemporaryDirectory() as right_dir:
            left_path = Path(left_dir) / "expenses.csv"
            right_path = Path(right_dir) / "expenses.csv"
            left = generate_category_dataset(left_path, count_per_category=8, seed=7)
            right = generate_category_dataset(right_path, count_per_category=8, seed=7)

            self.assertEqual(left, right)
            rows = read_category_dataset(left_path)
            self.assertEqual(len(rows), 64)
            self.assertEqual({row.split for row in rows}, {"train", "validation", "test"})
            self.assertIn("akaryakit", {row.category for row in rows})

    def test_train_evaluate_and_infer_smoke_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_path = root / "data" / "expenses.csv"
            artifact_dir = root / "artifacts"

            metrics = train_category_model(data_path, artifact_dir, samples_per_category=8, seed=11)
            self.assertEqual(metrics["model"], "local-sklearn-tfidf-logistic-regression")
            self.assertEqual(metrics["samples"], 64)
            self.assertTrue((artifact_dir / "category_model.joblib").exists())
            self.assertTrue((artifact_dir / "metrics.json").exists())

            report = evaluate_category_model(
                data_path,
                artifact_dir / "category_model.joblib",
                split="test",
                report_path=artifact_dir / "evaluation.json"
            )
            self.assertGreaterEqual(report["accuracy"], 0)
            self.assertTrue((artifact_dir / "evaluation.json").exists())
            persisted_report = json.loads((artifact_dir / "evaluation.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted_report["split"], "test")

            prediction = predict_category(
                artifact_dir / "category_model.joblib",
                merchant="Shell",
                description="motorin yakit petrol istasyonu",
                amount_minor=150000,
                payment_method="corporate_card",
                occurred_weekday=2
            )
            self.assertEqual(prediction["prediction"]["category"], "akaryakit")
            self.assertFalse(prediction["externalServicesUsed"])

    def test_category_benchmark_regression_writes_aggregate_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "category-benchmark"
            report = run_category_benchmark(
                output_dir=output_dir,
                seeds=[3, 5],
                samples_per_category=10,
                min_accuracy=0.2,
                min_macro_f1=0.2,
            )

            self.assertEqual(report["benchmark"], "category-regression")
            self.assertEqual(report["summary"]["runs"], 2)
            self.assertTrue(report["summary"]["passed"])
            self.assertGreaterEqual(report["summary"]["minimumAccuracy"], 0.2)
            self.assertEqual([run["seed"] for run in report["runs"]], [3, 5])
            self.assertTrue((output_dir / "category-benchmark-report.json").exists())
            self.assertTrue(all((Path(run["reportPath"])).exists() for run in report["runs"]))

    def test_category_benchmark_seed_parser_accepts_shell_variants(self) -> None:
        self.assertEqual(parse_seeds("3,5"), [3, 5])
        self.assertEqual(parse_seeds("3 5"), [3, 5])
        self.assertEqual(parse_seeds("3, 5 7"), [3, 5, 7])


if __name__ == "__main__":
    unittest.main()
