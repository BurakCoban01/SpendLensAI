from __future__ import annotations

import tempfile
from pathlib import Path
import unittest

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import torch
from torch import nn

from services.ocr.custom_model.dataset import generate_numeric_field_dataset
from services.ocr.custom_model.numeric_field_recognizer import recognize_numeric_field_line, recognize_visual_amount_line
from services.ocr.custom_model.segmentation import SegmentBox
from services.ocr.custom_model.train_numeric_char_cnn import SegmentedNumericCharacterDataset
from services.ocr.custom_model.vocab import CHAR_TO_INDEX, VOCAB


class _FixedSequenceClassifier(nn.Module):
    def __init__(self, text: str):
        super().__init__()
        self.text = text
        self.offset = 0

    def forward(self, images: torch.Tensor) -> torch.Tensor:
        end = self.offset + images.shape[0]
        characters = self.text[self.offset : end]
        if len(characters) != images.shape[0]:
            raise AssertionError(f"No fixed prediction remains for {images.shape[0]} character boxes.")
        self.offset = end
        logits = torch.full((len(characters), len(VOCAB)), -20.0)
        for index, character in enumerate(characters):
            logits[index, CHAR_TO_INDEX[character]] = 20.0
        return logits


class NumericFieldRecognizerTests(unittest.TestCase):
    def test_amount_assist_preserves_raw_line_and_emits_character_evidence(self) -> None:
        font = _font(22)
        image = Image.new("L", (360, 64), color=245)
        ImageDraw.Draw(image).text((12, 17), "TOPLAM 860,54 TL", fill=20, font=font)
        gray = np.asarray(image, dtype=np.uint8)
        _threshold, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        foreground_y, foreground_x = np.where(binary > 0)
        line = SegmentBox(
            int(foreground_x.min()),
            int(foreground_y.min()),
            int(foreground_x.max() - foreground_x.min() + 1),
            int(foreground_y.max() - foreground_y.min() + 1),
            "line",
        )
        raw_line = "TOPLAM 80,54 TL"

        prediction = recognize_numeric_field_line(
            _FixedSequenceClassifier("860,54"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            raw_line,
        )

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(raw_line, "TOPLAM 80,54 TL")
        self.assertEqual(prediction.normalized_line, "TOPLAM 860,54 TL")
        self.assertEqual(prediction.field_kind, "amount")
        self.assertEqual(prediction.model_version, "numeric-test-v1")
        self.assertEqual("".join(str(token["text"]) for token in prediction.tokens), "860,54")
        self.assertTrue(all(token["source"] == "char_cnn_numeric_constrained" for token in prediction.tokens))

    def test_amount_assist_accepts_turkish_thousand_separator(self) -> None:
        gray, binary, line = _render_line("TOPLAM 1.248,50 TL")

        prediction = recognize_numeric_field_line(
            _FixedSequenceClassifier("1.248,50"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "TOPLAM 248,50 TL",
        )

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(prediction.normalized_line, "TOPLAM 1.248,50 TL")

    def test_amount_assist_accepts_dot_decimal_amount(self) -> None:
        gray, binary, line = _render_line("TOTAL 99.90 TL")

        prediction = recognize_numeric_field_line(
            _FixedSequenceClassifier("99.90"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "TOTAL 99,00 TL",
        )

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(prediction.normalized_line, "TOTAL 99.90 TL")

    def test_line_item_assist_requires_and_reconstructs_explicit_financial_layout(self) -> None:
        font = _font(22)
        image = Image.new("L", (440, 64), color=245)
        ImageDraw.Draw(image).text((12, 17), "KALEM 2 x 121,57 TL 243,14 TL", fill=20, font=font)
        gray = np.asarray(image, dtype=np.uint8)
        _threshold, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        foreground_y, foreground_x = np.where(binary > 0)
        line = SegmentBox(
            int(foreground_x.min()),
            int(foreground_y.min()),
            int(foreground_x.max() - foreground_x.min() + 1),
            int(foreground_y.max() - foreground_y.min() + 1),
            "line",
        )

        prediction = recognize_numeric_field_line(
            _FixedSequenceClassifier("2" + "121,57" + "243,14"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "KALEM 3 x 11,7 TL 23,14 TL",
        )

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(prediction.normalized_line, "KALEM 2 x 121,57 TL 243,14 TL")
        self.assertEqual(prediction.field_kind, "line_item")
        self.assertEqual(
            {str(token["field_kind"]) for token in prediction.tokens},
            {"line_item_quantity", "line_item_unit_price", "line_item_total"},
        )

    def test_generated_numeric_fields_build_aligned_train_validation_and_test_datasets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            generate_numeric_field_dataset(root, count=64, seed=20260620)

            datasets = [SegmentedNumericCharacterDataset(root, split) for split in ("train", "validation", "test")]

            self.assertTrue(all(len(dataset) > 0 for dataset in datasets))
            self.assertTrue(all(len(dataset.sequences) > 0 for dataset in datasets))
            self.assertTrue(
                all(sequence.field_kind in {"amount", "date", "document_no", "vkn"} for dataset in datasets for sequence in dataset.sequences)
            )

    def test_fuzzy_date_role_uses_visual_numeric_evidence(self) -> None:
        gray, binary, line = _render_line("TARİH: 02.06.2026")

        prediction = recognize_numeric_field_line(
            _FixedSequenceClassifier("02.06.2026"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "TZRUT 02002.06",
        )

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(prediction.normalized_line, "TZRUT 02.06.2026")

    def test_numeric_tail_recovers_amount_but_rejects_non_numeric_garbage(self) -> None:
        gray, binary, line = _render_line("GENEL TOPLAM 72,05 TL")

        prediction = recognize_numeric_field_line(
            _FixedSequenceClassifier("72,05"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "AVENEDE LM PL 61 TL",
        )
        rejected = recognize_numeric_field_line(
            _FixedSequenceClassifier("72,05"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "MAMENLESER AAA TL",
        )

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(prediction.normalized_line, "AVENEDE LM PL 72,05 TL")
        self.assertIsNone(rejected)

    def test_visual_amount_assist_recovers_amount_without_raw_text_keyword(self) -> None:
        gray, binary, line = _render_line("72,05")

        prediction = recognize_visual_amount_line(
            _FixedSequenceClassifier("72,05"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "KAVG R 1011.200T",
        )

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(prediction.normalized_line, "KAVG R 1011.200T 72,05")
        self.assertEqual(prediction.field_kind, "amount")
        self.assertEqual("".join(str(token["text"]) for token in prediction.tokens), "72,05")
        self.assertTrue(all(token["source"] == "char_cnn_numeric_visual_amount" for token in prediction.tokens))

    def test_visual_amount_assist_accepts_grouped_receipt_amounts(self) -> None:
        gray, binary, line = _render_line("33,636")

        prediction = recognize_visual_amount_line(
            _FixedSequenceClassifier("33,636"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "",
            minimum_confidence=0.85,
        )

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(prediction.normalized_line, "33,636")

    def test_visual_amount_assist_repairs_low_group_separator_geometry(self) -> None:
        gray, binary, line = _render_line("76,000")

        prediction = recognize_visual_amount_line(
            _FixedSequenceClassifier("760000"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "",
            minimum_confidence=0.85,
        )

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(prediction.normalized_line, "76,000")

    def test_visual_amount_assist_can_use_lower_threshold_for_standalone_amount_lines(self) -> None:
        gray, binary, line = _render_line("12.00")

        prediction = recognize_visual_amount_line(
            _FixedSequenceClassifier("12.00"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "01 T",
            minimum_confidence=0.85,
        )

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(prediction.normalized_line, "12.00")

    def test_visual_amount_assist_does_not_rewrite_time_lines(self) -> None:
        gray, binary, line = _render_line("11:20")

        prediction = recognize_visual_amount_line(
            _FixedSequenceClassifier("11,20"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "SAAT: 11:20",
        )

        self.assertIsNone(prediction)

    def test_visual_amount_assist_rejects_textual_identifier_garbage_without_amount_context(self) -> None:
        gray, binary, line = _render_line("00.51")

        prediction = recognize_visual_amount_line(
            _FixedSequenceClassifier("00.51"),
            {"modelVersion": "numeric-test-v1"},
            gray,
            binary,
            line,
            "FATOTVS0",
            minimum_confidence=0.85,
        )

        self.assertIsNone(prediction)


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"):
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _render_line(text: str) -> tuple[np.ndarray, np.ndarray, SegmentBox]:
    image = Image.new("L", (420, 64), color=245)
    ImageDraw.Draw(image).text((12, 17), text, fill=20, font=_font(22))
    gray = np.asarray(image, dtype=np.uint8)
    _threshold, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    foreground_y, foreground_x = np.where(binary > 0)
    line = SegmentBox(
        int(foreground_x.min()),
        int(foreground_y.min()),
        int(foreground_x.max() - foreground_x.min() + 1),
        int(foreground_y.max() - foreground_y.min() + 1),
        "line",
    )
    return gray, binary, line


if __name__ == "__main__":
    unittest.main()
