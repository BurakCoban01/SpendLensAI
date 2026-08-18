from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from services.ocr.app.tesseract_engine import (
    TesseractEngineError,
    check_tesseract_availability,
    run_tesseract,
)


class TesseractEngineTests(unittest.TestCase):
    def test_availability_reports_missing_binary_without_crashing(self) -> None:
        with patch("services.ocr.app.tesseract_engine.shutil.which", return_value=None):
            status = check_tesseract_availability("tur+eng")

        self.assertFalse(status["available"])
        self.assertIsNone(status["binary_path"])
        self.assertEqual(status["missing_languages"], ["tur", "eng"])

    def test_run_fails_clearly_when_binary_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "receipt.png"
            Image.new("RGB", (120, 60), "white").save(image_path)

            with patch("services.ocr.app.tesseract_engine.shutil.which", return_value=None):
                with self.assertRaises(TesseractEngineError) as raised:
                    run_tesseract(image_path)

        self.assertEqual(raised.exception.code, "TESSERACT_BINARY_MISSING")
        self.assertEqual(raised.exception.status_code, 503)

    def test_run_normalizes_tokens_and_confidence_from_tsv_data(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "receipt.png"
            Image.new("RGB", (240, 120), "white").save(image_path)

            data = {
                "text": ["", "TOTAL", "72,05"],
                "conf": ["-1", "91.5", "120"],
                "left": [0, 10, 90],
                "top": [0, 20, 20],
                "width": [0, 70, 60],
                "height": [0, 18, 18],
            }

            with (
                patch("services.ocr.app.tesseract_engine.shutil.which", return_value="C:/tesseract.exe"),
                patch("services.ocr.app.tesseract_engine.pytesseract.get_languages", return_value=["eng", "tur"]),
                patch("services.ocr.app.tesseract_engine.pytesseract.image_to_string", return_value="TOTAL 72,05\n"),
                patch("services.ocr.app.tesseract_engine.pytesseract.image_to_data", return_value=data),
            ):
                result = run_tesseract(image_path, lang="tur+eng", psm=6, oem=3, timeout_seconds=5)

        self.assertEqual(result.text, "TOTAL 72,05\n")
        self.assertEqual([token.text for token in result.tokens], ["TOTAL", "72,05"])
        self.assertEqual(result.tokens[0].bbox, (10, 20, 70, 18))
        self.assertEqual(result.tokens[1].confidence, 1.0)
        self.assertGreater(result.confidence, 0.95)
        self.assertEqual(result.warnings, [])

    def test_run_uses_environment_timeout_when_not_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "receipt.png"
            Image.new("RGB", (240, 120), "white").save(image_path)

            data = {
                "text": ["TOTAL"],
                "conf": ["88"],
                "left": [10],
                "top": [20],
                "width": [70],
                "height": [18],
            }

            with (
                patch.dict("os.environ", {"TESSERACT_TIMEOUT_SECONDS": "120"}),
                patch("services.ocr.app.tesseract_engine.shutil.which", return_value="C:/tesseract.exe"),
                patch("services.ocr.app.tesseract_engine.pytesseract.get_languages", return_value=["eng", "tur"]),
                patch("services.ocr.app.tesseract_engine.pytesseract.image_to_string", return_value="TOTAL\n") as image_to_string,
                patch("services.ocr.app.tesseract_engine.pytesseract.image_to_data", return_value=data) as image_to_data,
            ):
                run_tesseract(image_path, lang="tur+eng")

        self.assertEqual(image_to_string.call_args.kwargs["timeout"], 120)
        self.assertEqual(image_to_data.call_args.kwargs["timeout"], 120)

    def test_missing_language_fails_before_ocr_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "receipt.png"
            Image.new("RGB", (120, 60), "white").save(image_path)

            with (
                patch("services.ocr.app.tesseract_engine.shutil.which", return_value="C:/tesseract.exe"),
                patch("services.ocr.app.tesseract_engine.pytesseract.get_languages", return_value=["eng"]),
            ):
                with self.assertRaises(TesseractEngineError) as raised:
                    run_tesseract(image_path, lang="tur+eng")

        self.assertEqual(raised.exception.code, "TESSERACT_LANGUAGE_MISSING")
        self.assertEqual(raised.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
