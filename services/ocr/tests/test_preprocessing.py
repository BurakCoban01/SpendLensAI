from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from services.ocr.app.preprocessing import preprocess_document, preprocess_image, split_pdf_to_images


class PreprocessingTests(unittest.TestCase):
    def test_tesseract_profile_writes_artifact_and_decisions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "receipt.png"
            create_receipt_fixture(source)

            result = preprocess_image(source, profile="TESSERACT_OPTIMIZED")
            self.addCleanup(result.image_path.unlink, missing_ok=True)

            self.assertTrue(result.image_path.exists())
            output = cv2.imread(str(result.image_path), cv2.IMREAD_GRAYSCALE)
            self.assertIsNotNone(output)
            self.assertEqual(result.decisions["profile"], "TESSERACT_OPTIMIZED")
            self.assertTrue(result.decisions["grayscale"])
            self.assertTrue(result.decisions["adaptive_threshold"])
            self.assertTrue(result.decisions["shadow_reduction"])
            self.assertIn("receipt_boundary", result.decisions)
            self.assertGreater(result.decisions["output_width"], 0)
            self.assertGreater(result.decisions["output_height"], 0)
            self.assertGreaterEqual(result.decisions["quality_score"], 0.0)
            self.assertLessEqual(result.decisions["quality_score"], 1.0)

    def test_profiles_record_different_preprocessing_choices(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "receipt.png"
            create_receipt_fixture(source)

            default = preprocess_image(source, profile="DEFAULT")
            custom = preprocess_image(source, profile="CUSTOM_MODEL_OPTIMIZED")
            self.addCleanup(default.image_path.unlink, missing_ok=True)
            self.addCleanup(custom.image_path.unlink, missing_ok=True)

            self.assertFalse(default.decisions["adaptive_threshold"])
            self.assertFalse(default.decisions["shadow_reduction"])
            self.assertEqual(default.decisions["denoise"]["h"], 8)
            self.assertFalse(custom.decisions["adaptive_threshold"])
            self.assertEqual(custom.decisions["denoise"]["h"], 6)

    def test_blur_score_and_quality_flags_react_to_blurry_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            sharp_path = Path(temp_dir) / "sharp.png"
            blurry_path = Path(temp_dir) / "blurry.png"
            create_receipt_fixture(sharp_path)
            Image.open(sharp_path).filter(ImageFilter.GaussianBlur(radius=6)).save(blurry_path)

            sharp = preprocess_image(sharp_path)
            blurry = preprocess_image(blurry_path)
            self.addCleanup(sharp.image_path.unlink, missing_ok=True)
            self.addCleanup(blurry.image_path.unlink, missing_ok=True)

            self.assertGreater(sharp.decisions["blur_score"], blurry.decisions["blur_score"])
            self.assertGreater(sharp.decisions["quality_score"], blurry.decisions["quality_score"])
            self.assertTrue(blurry.decisions["low_quality"])

    def test_unsupported_profile_fails_clearly(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "receipt.png"
            create_receipt_fixture(source)

            with self.assertRaisesRegex(ValueError, "Unsupported preprocessing profile"):
                preprocess_image(source, profile="BAD_PROFILE")  # type: ignore[arg-type]

    def test_preprocess_document_writes_stable_manifest_for_image(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "receipt.png"
            artifact_dir = root / "artifacts"
            create_receipt_fixture(source)

            result = preprocess_document(source, profile="THERMAL_RECEIPT", output_dir=artifact_dir)

            self.assertEqual(len(result.pages), 1)
            self.assertTrue(result.manifest_path.exists())
            self.assertTrue(result.pages[0].processed_image_path.exists())
            self.assertEqual(result.pages[0].page_number, 1)
            self.assertEqual(result.pages[0].decisions["profile"], "THERMAL_RECEIPT")
            self.assertEqual(result.pages[0].decisions["page_number"], 1)
            self.assertIn("processed_artifact", result.pages[0].decisions)
            manifest = result.manifest_path.read_text(encoding="utf-8")
            self.assertIn('"page_count": 1', manifest)
            self.assertIn("page-0001-thermal-receipt.png", manifest)

    def test_preprocess_document_marks_multiframe_images_as_first_frame_only(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "animated.gif"
            artifact_dir = root / "artifacts"
            first = Image.new("RGB", (220, 180), "white")
            second = Image.new("RGB", (220, 180), "white")
            ImageDraw.Draw(first).text((20, 40), "FRAME 1 TOPLAM 10,00", fill="black")
            ImageDraw.Draw(second).text((20, 40), "FRAME 2 TOPLAM 20,00", fill="black")
            first.save(source, save_all=True, append_images=[second], duration=100, loop=0)

            result = preprocess_document(source, profile="TESSERACT_OPTIMIZED", output_dir=artifact_dir, source_mime_type="image/gif")

            self.assertEqual(len(result.pages), 1)
            decisions = result.pages[0].decisions
            self.assertEqual(decisions["source_frame_count"], 2)
            self.assertEqual(decisions["frame_handling"], "first_frame_only")
            self.assertIn("MULTIFRAME_FIRST_FRAME_ONLY", decisions["warnings"])

    def test_split_pdf_and_preprocess_document_render_each_page(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            pdf_path = root / "batch.pdf"
            artifact_dir = root / "artifacts"
            create_pdf_fixture(pdf_path)

            pages = split_pdf_to_images(pdf_path, artifact_dir / "raw-pages", dpi=96)
            self.assertEqual(len(pages), 2)
            self.assertTrue(all(page.exists() for page in pages))

            result = preprocess_document(
                pdf_path,
                profile="TESSERACT_OPTIMIZED",
                output_dir=artifact_dir / "processed",
                source_mime_type="application/pdf",
                dpi=96,
            )

            self.assertEqual(len(result.pages), 2)
            self.assertTrue(result.manifest_path.exists())
            self.assertEqual([page.page_number for page in result.pages], [1, 2])
            for page in result.pages:
                self.assertTrue(page.source_image_path.exists())
                self.assertTrue(page.processed_image_path.exists())
                self.assertGreater(page.decisions["output_width"], 0)
                self.assertGreater(page.decisions["output_height"], 0)
                self.assertEqual(page.decisions["profile"], "TESSERACT_OPTIMIZED")


def create_receipt_fixture(path: Path) -> None:
    image = Image.new("RGB", (420, 620), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((55, 35, 365, 575), outline="black", width=3)
    draw.text((90, 80), "SPENDLENS MARKET", fill="black")
    draw.text((90, 130), "TARIH 12.05.2026", fill="black")
    for index, item in enumerate(["EKMEK 20,00", "SUT 45,50", "KDV 6,55", "TOPLAM 72,05"]):
        draw.text((90, 190 + index * 55), item, fill="black")

    array = np.array(image)
    matrix = cv2.getRotationMatrix2D((210, 310), -4.0, 1.0)
    rotated = cv2.warpAffine(array, matrix, (420, 620), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    Image.fromarray(rotated).save(path)


def create_pdf_fixture(path: Path) -> None:
    import fitz  # type: ignore[import-not-found]

    document = fitz.open()
    for page_number in range(1, 3):
        page = document.new_page(width=420, height=620)
        page.draw_rect(fitz.Rect(55, 35, 365, 575), color=(0, 0, 0), width=2)
        page.insert_text((90, 80), f"SPENDLENS MARKET {page_number}", fontsize=14, color=(0, 0, 0))
        page.insert_text((90, 130), "TARIH 12.05.2026", fontsize=12, color=(0, 0, 0))
        page.insert_text((90, 190), f"TOPLAM {70 + page_number},05", fontsize=12, color=(0, 0, 0))
    document.save(path)
    document.close()


if __name__ == "__main__":
    unittest.main()
