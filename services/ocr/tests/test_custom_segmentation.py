from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from services.ocr.custom_model.dataset import generate_document_dataset
from services.ocr.custom_model.preprocessing import preprocess_custom_document
from services.ocr.custom_model.segmentation import segment_characters, segment_lines, segment_words


class CustomSegmentationTests(unittest.TestCase):
    def test_generated_turkish_document_has_line_word_and_character_boxes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            sample = generate_document_dataset(root, count=2, seed=22)[0]
            page = preprocess_custom_document(sample.image_path)[0]
            lines = segment_lines(page.binary)
            self.assertGreaterEqual(len(lines), 3)
            self.assertTrue(all(line.w < page.binary.shape[1] * 0.95 for line in lines))
            words = segment_words(page.binary, lines[0])
            self.assertGreaterEqual(len(words), 1)
            chars = segment_characters(page.binary, words[0])
            self.assertGreaterEqual(len(chars), 1)
            self.assertTrue(all(char.w > 0 and char.h > 0 for char in chars))

    def test_quality_metrics_are_reported(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            sample = generate_document_dataset(Path(temp_dir), count=1, seed=23)[0]
            page = preprocess_custom_document(sample.image_path)[0]
            self.assertIn("blur_score", page.quality)
            self.assertIn("contrast_score", page.quality)
            self.assertIn("skew_estimate_degrees", page.quality)
            self.assertIn("foreground_density", page.quality)

    def test_rotated_document_is_deskewed_before_line_segmentation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            sample = generate_document_dataset(Path(temp_dir), count=5, seed=24)[4]
            self.assertEqual(sample.variant, "rotated")

            page = preprocess_custom_document(sample.image_path)[0]
            lines = segment_lines(page.binary)

            self.assertEqual(len(lines), len(sample.text.splitlines()))
            self.assertGreater(abs(float(page.quality["skew_estimate_degrees"])), 0.2)

    def test_noisy_document_rejects_speckle_only_line_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            sample = generate_document_dataset(Path(temp_dir), count=4, seed=25)[3]
            self.assertEqual(sample.variant, "noisy")

            page = preprocess_custom_document(sample.image_path)[0]
            lines = segment_lines(page.binary)

            self.assertEqual(len(lines), len(sample.text.splitlines()))

    def test_touching_numeric_glyphs_are_split_without_merging_the_decimal_comma(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            sample = generate_document_dataset(Path(temp_dir), count=1, seed=20260725)[0]
            page = preprocess_custom_document(sample.image_path)[0]
            references = sample.text.splitlines()
            lines = segment_lines(page.binary)
            subtotal_index = next(index for index, text in enumerate(references) if text.startswith("ARA TOPLAM "))
            expected_amount = references[subtotal_index].split()[2]
            amount_word = segment_words(page.binary, lines[subtotal_index])[2]

            characters = segment_characters(page.binary, amount_word)

            self.assertEqual(len(characters), len(expected_amount))
            self.assertTrue(all(left.x < right.x for left, right in zip(characters, characters[1:])))
            self.assertLess(min(character.w for character in characters), amount_word.h // 2)

    def test_photo_background_is_masked_and_does_not_collapse_all_text_into_one_line(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "receipt-on-desk.png"
            rng = np.random.default_rng(41)
            background = np.full((900, 1200, 3), (132, 105, 78), dtype=np.uint8)
            texture = rng.normal(0, 10, background.shape[:2]).astype(np.int16)
            for channel in range(3):
                background[:, :, channel] = np.clip(background[:, :, channel].astype(np.int16) + texture, 0, 255)
            receipt = Image.new("RGB", (620, 720), "white")
            draw = ImageDraw.Draw(receipt)
            try:
                font = ImageFont.truetype("arial.ttf", 32)
            except OSError:
                font = ImageFont.load_default()
            for index, text in enumerate(("YILDIZ KIRTASİYE", "TARİH 27.05.2024", "KDV 208,08 TL", "TOPLAM 1.248,50 TL")):
                draw.text((48, 80 + index * 110), text, fill="black", font=font)
            receipt_array = np.array(receipt.rotate(4, expand=True, fillcolor="white"))
            top, left = 90, 250
            height, width = receipt_array.shape[:2]
            background[top : top + height, left : left + width] = receipt_array
            cv2.imwrite(str(image_path), cv2.cvtColor(background, cv2.COLOR_RGB2BGR))

            page = preprocess_custom_document(image_path, "image/png")[0]
            lines = segment_lines(page.binary)

            self.assertTrue(page.quality["document_surface_detected"])
            self.assertGreaterEqual(len(lines), 4)
            self.assertTrue(all(line.h < page.binary.shape[0] * 0.15 for line in lines))


if __name__ == "__main__":
    unittest.main()
