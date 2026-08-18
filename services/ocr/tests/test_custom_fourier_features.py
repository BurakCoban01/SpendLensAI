from __future__ import annotations

import unittest

import cv2
import numpy as np

from services.ocr.custom_model.classical_classifier import predict_character
from services.ocr.custom_model.fourier_features import cosine_similarity, embedding


class CustomFourierFeatureTests(unittest.TestCase):
    def test_embedding_length_is_stable_for_empty_and_tiny_crops(self) -> None:
        empty = np.zeros((16, 16), dtype=np.uint8)
        tiny = empty.copy()
        tiny[8, 8] = 255
        self.assertEqual(embedding(empty).shape, embedding(tiny).shape)

    def test_embedding_is_approximately_translation_invariant(self) -> None:
        left = np.zeros((32, 32), dtype=np.uint8)
        right = np.zeros((32, 32), dtype=np.uint8)
        cv2.rectangle(left, (8, 8), (20, 24), 255, -1)
        cv2.rectangle(right, (10, 9), (22, 25), 255, -1)
        self.assertGreater(cosine_similarity(embedding(left), embedding(right)), 0.92)

    def test_cosine_classifier_returns_top_k_prediction(self) -> None:
        crop = np.zeros((32, 32), dtype=np.uint8)
        cv2.rectangle(crop, (9, 5), (21, 27), 255, 2)
        prediction = predict_character(crop, top_k=3)
        self.assertGreaterEqual(len(prediction.top_k), 1)
        self.assertGreaterEqual(prediction.confidence, 0)
        self.assertLessEqual(prediction.confidence, 1)


if __name__ == "__main__":
    unittest.main()