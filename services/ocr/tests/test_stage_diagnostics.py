from __future__ import annotations

import unittest

import numpy as np

from services.ocr.benchmarks.stage_diagnostics import box_iou, detection_metrics, match_boxes
from services.ocr.custom_model.segmentation import SegmentBox, _finalize_line_segments, _split_distant_line_columns


class StageDiagnosticsTests(unittest.TestCase):
    def test_box_matching_is_one_to_one_and_prefers_highest_iou(self) -> None:
        truth = [(0, 0, 100, 20), (0, 30, 100, 50)]
        predictions = [(1, 1, 99, 19), (0, 29, 100, 51), (200, 200, 220, 220)]

        matches = match_boxes(truth, predictions, 0.5)

        self.assertEqual([(match.truth_index, match.prediction_index) for match in matches], [(0, 0), (1, 1)])
        self.assertGreater(box_iou(truth[0], predictions[0]), 0.8)

    def test_detection_metrics_count_merged_and_split_lines(self) -> None:
        truth = [(0, 0, 100, 20), (0, 20, 100, 40)]
        merged_prediction = [(0, 0, 100, 40)]
        split_predictions = [(0, 0, 50, 20), (50, 0, 100, 20), (0, 20, 100, 40)]

        merged = detection_metrics(truth, merged_prediction, 0.4)
        split = detection_metrics(truth, split_predictions, 0.4)

        self.assertEqual(merged["mergedLineCount"], 1)
        self.assertEqual(split["splitLineCount"], 1)
        self.assertEqual(split["duplicateLineCount"], 1)

    def test_reading_order_metric_detects_reversed_predictions(self) -> None:
        truth = [(0, 0, 100, 20), (0, 30, 100, 50)]
        predictions = [(0, 30, 100, 50), (0, 0, 100, 20)]

        metrics = detection_metrics(truth, predictions, 0.5)

        self.assertEqual(metrics["readingOrderAccuracy"], 0.0)

    def test_distant_columns_split_without_breaking_normal_word_spaces(self) -> None:
        binary = np.zeros((20, 220), dtype=np.uint8)
        binary[4:16, 5:35] = 255
        binary[4:16, 43:75] = 255
        binary[4:16, 180:215] = 255

        segments = _split_distant_line_columns(binary, SegmentBox(0, 0, 220, 20, "line"))

        self.assertEqual([segment.bbox for segment in segments], [(5, 0, 70, 20), (180, 0, 35, 20)])

    def test_line_box_padding_preserves_bounds_and_annotation_iou(self) -> None:
        binary = np.zeros((100, 200), dtype=np.uint8)
        tight = SegmentBox(20, 40, 100, 10, "line")

        padded = _finalize_line_segments(binary, [tight])

        self.assertEqual(padded[0].bbox, (17, 36, 106, 18))
        self.assertEqual(padded[0].recognition_bbox, tight.bbox)
        self.assertGreater(box_iou((15, 35, 125, 55), (17, 36, 123, 54)), 0.8)


if __name__ == "__main__":
    unittest.main()
