from __future__ import annotations

import unittest
import json
import math
import tempfile
from pathlib import Path

from services.ocr.benchmarks.recognizer_comparison import (
    _document_lineage,
    _summarize_comparison_rows,
    select_document_balanced_lines,
)
from services.ocr.benchmarks.stage_diagnostics import AnnotatedLine
from services.ocr.custom_model.router_reranker import (
    ROUTER_FEATURE_NAMES,
    ROUTER_FEATURE_VERSION,
    comparison_row_features,
    load_pairwise_router,
)
from services.ocr.custom_model.infer import CustomOcrPrediction, _select_pairwise_router_candidate
from services.ocr.custom_model.router_reranker import PairwiseRouter


class RecognizerComparisonTests(unittest.TestCase):
    def test_document_balanced_selection_is_deterministic_and_bounded(self) -> None:
        rows = [
            AnnotatedLine(
                sample_id=f"doc-{document}:line-{line}",
                image_path=Path(f"doc-{document}.png"),
                text=str(line),
                box=(0, 0, 10, 10),
                source="test",
            )
            for document in range(5)
            for line in range(7)
        ]

        first = select_document_balanced_lines(rows, max_documents=3, lines_per_document=2, seed=41)
        second = select_document_balanced_lines(rows, max_documents=3, lines_per_document=2, seed=41)

        self.assertEqual([row.sample_id for row in first], [row.sample_id for row in second])
        self.assertEqual(len(first), 6)
        self.assertEqual(len({row.image_path for row in first}), 3)

        holdout = select_document_balanced_lines(
            rows,
            max_documents=2,
            lines_per_document=2,
            seed=41,
            document_offset=3,
        )
        self.assertTrue({row.image_path for row in first}.isdisjoint({row.image_path for row in holdout}))

        ocrturk_chunk = AnnotatedLine(
            sample_id="OCRTurk:data_102:p1:line:0:chunk:1",
            image_path=Path("chunk.png"),
            text="line",
            box=(0, 0, 0, 0),
            source="OCRTurk",
        )
        self.assertEqual(_document_lineage(ocrturk_chunk), "OCRTurk:data_102")

    def test_comparison_summary_counts_composed_regressions_separately(self) -> None:
        rows = [
            {
                "reference": "TOTAL 22,23",
                "championPrediction": "TOTAL 22,23",
                "championConfidence": 0.8,
                "championCer": 0.0,
                "challengerPrediction": "TOTAL 22,28",
                "challengerConfidence": 0.9,
                "challengerCer": 0.08,
                "selectedPrediction": "TOTAL 22,23",
                "selectedConfidence": 0.8,
                "selectedCer": 0.0,
                "challengerSelected": False,
            },
            {
                "reference": "LONG MERCHANT NAME",
                "championPrediction": "LONG NAME",
                "championConfidence": 0.5,
                "championCer": 0.45,
                "challengerPrediction": "LONG MERCHANT NAME",
                "challengerConfidence": 0.7,
                "challengerCer": 0.0,
                "selectedPrediction": "LONG MERCHANT NAME",
                "selectedConfidence": 0.7,
                "selectedCer": 0.0,
                "challengerSelected": True,
            },
        ]

        summary = _summarize_comparison_rows(rows)

        self.assertEqual(summary["paired"]["wins"], 1)
        self.assertEqual(summary["paired"]["regressions"], 1)
        self.assertEqual(summary["paired"]["composedRegressions"], 0)
        self.assertLess(summary["composed"]["averageCer"], summary["champion"]["averageCer"])

    def test_pairwise_router_features_are_fixed_width_and_ground_truth_free(self) -> None:
        row = {
            "bbox": [10, 20, 210, 50],
            "aspectRatio": 200 / 30,
            "lineRole": "general_text",
            "championPrediction": "SPEND MARKET",
            "challengerPrediction": "SPENDLENS MARKET",
            "championConfidence": 0.4,
            "challengerConfidence": 0.6,
            "candidateScores": {"champion": {"score": 0.5}, "challenger": {"score": 0.7}},
            "reference": "THIS MUST NOT BE A FEATURE",
        }

        features = comparison_row_features(row)
        changed_reference = comparison_row_features({**row, "reference": "DIFFERENT GROUND TRUTH"})

        self.assertEqual(len(features), len(ROUTER_FEATURE_NAMES))
        self.assertEqual(features, changed_reference)

    def test_pairwise_router_never_overrides_conflicting_amount_evidence(self) -> None:
        router = PairwiseRouter(
            metadata={"decisionThreshold": 0.95},
            means=tuple(0.0 for _ in ROUTER_FEATURE_NAMES),
            scales=tuple(1.0 for _ in ROUTER_FEATURE_NAMES),
            coefficients=tuple(0.0 for _ in ROUTER_FEATURE_NAMES),
            intercept=0.0,
        )

        accepted = _select_pairwise_router_candidate(
            CustomOcrPrediction(text="MARKET RECEIPT", confidence=0.4),
            CustomOcrPrediction(text="MARKET RECEIPT NO", confidence=0.6),
            router,
            0.99,
        )
        rejected = _select_pairwise_router_candidate(
            CustomOcrPrediction(text="TOTAL 22,23", confidence=0.4),
            CustomOcrPrediction(text="TOTAL 22,28", confidence=0.6),
            router,
            0.99,
        )

        self.assertEqual(accepted, (True, "validated_pairwise_router"))
        self.assertEqual(rejected, (False, "champion_fallback_pairwise_amount_disagreement"))

    def test_plain_json_router_loads_fixed_schema_and_matches_logistic_probability(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "router.json"
            checkpoint.write_text(
                json.dumps(
                    {
                        "metadata": {
                            "featureVersion": ROUTER_FEATURE_VERSION,
                            "featureNames": list(ROUTER_FEATURE_NAMES),
                            "decisionThreshold": 0.95,
                        },
                        "model": {
                            "means": [0.0] * len(ROUTER_FEATURE_NAMES),
                            "scales": [1.0] * len(ROUTER_FEATURE_NAMES),
                            "coefficients": [0.0] * len(ROUTER_FEATURE_NAMES),
                            "intercept": math.log(3.0),
                        },
                    }
                ),
                encoding="utf-8",
            )

            router = load_pairwise_router(checkpoint)

            self.assertAlmostEqual(router.challenger_probability([0.0] * len(ROUTER_FEATURE_NAMES)), 0.75)
            self.assertEqual(router.threshold, 0.95)


if __name__ == "__main__":
    unittest.main()
