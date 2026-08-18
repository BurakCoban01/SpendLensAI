from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from services.ocr.app.main import app
from services.ocr.app.tesseract_engine import TesseractResult, TesseractToken
from services.ocr.custom_model.infer import CustomOcrDocumentPrediction


class OcrApiTests(unittest.TestCase):
    def test_tesseract_endpoint_accepts_pdf_and_returns_per_page_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            pdf_path = Path(temp_dir) / "batch.pdf"
            create_pdf_fixture(pdf_path)

            calls: list[Path] = []

            def fake_tesseract(image_path: Path, lang: str = "tur+eng", psm: int = 6) -> TesseractResult:
                calls.append(image_path)
                return TesseractResult(
                    text=f"PAGE {len(calls)} TOPLAM {70 + len(calls)},05",
                    confidence=0.82,
                    tokens=[
                        TesseractToken(
                            text="TOPLAM",
                            confidence=0.82,
                            bbox=(12, 18, 60, 16),
                        )
                    ],
                    warnings=[],
                )

            with patch("services.ocr.app.main.run_tesseract", side_effect=fake_tesseract):
                response = TestClient(app).post(
                    "/ocr/tesseract",
                    files={"file": ("batch.pdf", pdf_path.read_bytes(), "application/pdf")},
                )

            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["engine"], "TESSERACT")
            self.assertEqual(body["page_count"], 2)
            self.assertEqual(len(body["pages"]), 2)
            self.assertEqual(len(calls), 2)
            self.assertEqual(len(body["attempts"]), 2)
            self.assertEqual(body["selected_attempts"][0]["psm"], 6)
            self.assertIn("PAGE 1", body["text"])
            self.assertIn("PAGE 2", body["text"])
            self.assertEqual(body["tokens"][0]["page_number"], 1)
            self.assertEqual(body["pages"][1]["tokens"][0]["page_number"], 2)
            self.assertTrue(body["preprocessing_manifest"].endswith("preprocessing-manifest.json"))
            for page in body["pages"]:
                self.assertIn("preprocessing", page)
                self.assertIn("processed_artifact", page["preprocessing"])
                self.assertEqual(page["selected_psm"], 6)

    def test_tesseract_endpoint_uses_bounded_psm_fallback_for_weak_first_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "weak.png"
            create_image_fixture(image_path, "PNG")
            calls: list[int] = []

            def fake_tesseract(image_path: Path, lang: str = "tur+eng", psm: int = 6) -> TesseractResult:
                calls.append(psm)
                if psm == 6:
                    return TesseractResult(
                        text="x",
                        confidence=0.20,
                        tokens=[TesseractToken(text="x", confidence=0.20, bbox=(1, 1, 4, 4))],
                        warnings=["LOW_CONFIDENCE"],
                    )
                return TesseractResult(
                    text="SPENDLENS MARKET\nTARIH 12.05.2026\nGENEL TOPLAM 72,05 TL",
                    confidence=0.78,
                    tokens=[
                        TesseractToken(text="GENEL", confidence=0.80, bbox=(10, 10, 45, 14)),
                        TesseractToken(text="TOPLAM", confidence=0.82, bbox=(58, 10, 55, 14)),
                    ],
                    warnings=[],
                )

            with patch("services.ocr.app.main.run_tesseract", side_effect=fake_tesseract):
                response = TestClient(app).post(
                    "/ocr/tesseract",
                    files={"file": ("weak.png", image_path.read_bytes(), "image/png")},
                )

            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(calls[:2], [6, 4])
            self.assertEqual(body["pages"][0]["selected_psm"], 4)
            self.assertIn("OCR_FALLBACK_ATTEMPTS_USED", body["warnings"])
            self.assertEqual(len(body["attempts"]), 2)
            self.assertEqual(body["attempts"][0]["psm"], 6)
            self.assertEqual(body["attempts"][1]["psm"], 4)

    def test_tesseract_endpoint_rejects_unsupported_document_type(self) -> None:
        response = TestClient(app).post(
            "/ocr/tesseract",
            files={"file": ("notes.txt", b"plain text", "text/plain")},
        )

        self.assertEqual(response.status_code, 415)
        self.assertIn("Unsupported document type", response.json()["detail"])

    def test_custom_crnn_endpoint_uses_custom_pipeline_and_checkpoint_without_tesseract(self) -> None:
        checkpoint = Path("artifacts/models/test-api/model.pt")
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        checkpoint.write_bytes(b"patched-test-checkpoint")
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                pdf_path = Path(temp_dir) / "custom.pdf"
                create_pdf_fixture(pdf_path)
                calls: list[Path] = []

                def fake_custom_ocr_document(
                    checkpoint_path: Path,
                    image_path: Path,
                    source_mime_type: str = "",
                    *,
                    numeric_char_checkpoint: Path | None = None,
                    character_checkpoint: Path | None = None,
                    challenger_checkpoint: Path | None = None,
                    challenger_mode: str = "shadow",
                ) -> CustomOcrDocumentPrediction:
                    self.assertEqual(checkpoint_path, checkpoint.resolve())
                    self.assertEqual(numeric_char_checkpoint, checkpoint.resolve())
                    self.assertEqual(character_checkpoint, checkpoint.resolve())
                    self.assertEqual(challenger_checkpoint, checkpoint.resolve())
                    self.assertEqual(challenger_mode, "validated")
                    calls.append(image_path)
                    return CustomOcrDocumentPrediction(
                        engine="CUSTOM_OCR",
                        actual_engine_used="CUSTOM_OCR",
                        text="CUSTOM PAGE 1 TOPLAM 41,50 TL",
                        normalized_text="CUSTOM PAGE 1 TOPLAM 41,50 TL",
                        confidence=0.71,
                        model_version="unit-custom",
                        vocab_version="tr-finance-v1",
                        pages=[
                            {
                                "page_number": 1,
                                "text": "CUSTOM PAGE 1 TOPLAM 41,50 TL",
                                "confidence": 0.71,
                                "tokens": [],
                                "warnings": [],
                                "quality": {"status": "ok"},
                                "lines": [],
                            }
                        ],
                        tokens=[
                            {
                                "text": "CUSTOM PAGE 1 TOPLAM 41,50 TL",
                                "confidence": 0.71,
                                "page_number": 1,
                                "bbox": [10, 20, 180, 24],
                                "level": "line",
                                "source": "crnn",
                            }
                        ],
                        warnings=[],
                        quality={"pages": [{"status": "ok"}]},
                        segmentation_manifest="custom-lines:1",
                    )

                with (
                    patch("services.ocr.app.main.run_custom_ocr_document", side_effect=fake_custom_ocr_document),
                    patch("services.ocr.app.main.run_tesseract", side_effect=AssertionError("custom OCR endpoint must not call Tesseract")),
                ):
                    response = TestClient(app).post(
                        (
                            f"/ocr/custom-crnn?checkpoint={checkpoint.as_posix()}"
                            f"&numeric_char_checkpoint={checkpoint.as_posix()}"
                            f"&character_checkpoint={checkpoint.as_posix()}"
                            f"&challenger_checkpoint={checkpoint.as_posix()}"
                            "&challenger_mode=validated"
                        ),
                        files={"file": ("custom.pdf", pdf_path.read_bytes(), "application/pdf")},
                    )

                self.assertEqual(response.status_code, 200)
                body = response.json()
                self.assertEqual(body["engine"], "CUSTOM_CRNN")
                self.assertEqual(body["actual_engine_used"], "CUSTOM_OCR")
                self.assertEqual(body["page_count"], 1)
                self.assertAlmostEqual(body["confidence"], 0.71)
                self.assertEqual(len(calls), 1)
                self.assertIn("CUSTOM PAGE 1", body["text"])
                self.assertEqual(body["pages"][0]["confidence"], 0.71)
                self.assertEqual(body["tokens"][0]["source"], "crnn")
                self.assertEqual(body["warnings"], [])
                self.assertEqual(body["model_version"], "unit-custom")
                self.assertEqual(body["vocab_version"], "tr-finance-v1")
                self.assertEqual(body["segmentation_manifest"], "custom-lines:1")
                self.assertEqual(body["challenger_checkpoint"], str(checkpoint.resolve()))
                self.assertEqual(body["challenger_mode"], "validated")
        finally:
            checkpoint.unlink(missing_ok=True)

    def test_custom_crnn_endpoint_fails_clearly_without_checkpoint(self) -> None:
        response = TestClient(app).post(
            "/ocr/custom-crnn?checkpoint=artifacts/models/missing/model.pt",
            files={"file": ("receipt.png", b"not-a-real-image", "image/png")},
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"]["code"], "CUSTOM_OCR_CHECKPOINT_NOT_FOUND")

    def test_custom_ocr_smoke_training_endpoint_returns_local_artifact_contract(self) -> None:
        captured: dict[str, object] = {}

        def fake_train_custom_ocr_model(**kwargs) -> dict[str, object]:
            captured.update(kwargs)
            return {"epochs": kwargs["epochs"], "samples": kwargs["samples"], "loss": 3.25}

        with patch("services.ocr.app.main.train_custom_ocr_model", side_effect=fake_train_custom_ocr_model):
            response = TestClient(app).post(
                "/models/custom-ocr/smoke-train",
                json={
                    "tenant_id": "tenant/api",
                    "training_run_id": "run:123",
                    "seed": 19,
                    "samples": 8,
                    "epochs": 1,
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["artifactBucket"], "local-artifacts")
        self.assertRegex(body["artifactKey"], r"^artifacts/models/custom-ocr-api/tenant-api-run-123-")
        self.assertEqual(body["checkpoint"], f"{body['artifactKey']}/model.pt")
        self.assertEqual(body["reportKey"], f"{body['artifactKey']}/metrics.json")
        self.assertEqual(body["metrics"]["engine"], "CUSTOM_CRNN")
        self.assertEqual(body["metrics"]["seed"], 19)
        self.assertEqual(captured["samples"], 8)
        self.assertEqual(captured["epochs"], 1)

    def test_custom_ocr_full_training_uses_combined_manifest_when_available(self) -> None:
        captured: dict[str, object] = {}

        def fake_train_custom_ocr_model(**kwargs) -> dict[str, object]:
            captured.update(kwargs)
            return {
                "epochs": kwargs["epochs"],
                "samples": kwargs["samples"],
                "datasetMode": kwargs["dataset_mode"],
                "datasetSourceMix": {"CORD": 1, "SROIE": 1},
                "loss": 2.75,
            }

        with (
            patch("services.ocr.app.main._full_custom_ocr_dataset_config", return_value=("combined_manifest", Path("artifacts/datasets/custom-ocr"))),
            patch("services.ocr.app.main.train_custom_ocr_model", side_effect=fake_train_custom_ocr_model),
        ):
            response = TestClient(app).post(
                "/models/custom-ocr/full-train",
                json={
                    "tenant_id": "tenant/api",
                    "training_run_id": "run:full",
                    "seed": 23,
                    "samples": 128,
                    "epochs": 2,
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["metrics"]["engine"], "CUSTOM_CRNN")
        self.assertEqual(body["metrics"]["training_profile"], "local_full")
        self.assertEqual(body["metrics"]["datasetMode"], "combined_manifest")
        self.assertEqual(captured["dataset_mode"], "combined_manifest")
        self.assertEqual(captured["combined_manifest_dir"], Path("artifacts/datasets/custom-ocr"))
        self.assertEqual(captured["field_oversample_factor"], 3.0)
        self.assertEqual(captured["blank_regularization"], 0.05)

    def test_preprocess_endpoint_returns_base64_page_artifacts_for_pdf(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            pdf_path = Path(temp_dir) / "batch.pdf"
            create_pdf_fixture(pdf_path)

            response = TestClient(app).post(
                "/preprocess?profile=TESSERACT_OPTIMIZED",
                files={"file": ("batch.pdf", pdf_path.read_bytes(), "application/pdf")},
            )

            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["page_count"], 2)
            self.assertEqual(len(body["pages"]), 2)
            self.assertEqual(body["pages"][0]["mime_type"], "image/png")
            self.assertRegex(body["pages"][0]["processed_image_base64"], r"^[A-Za-z0-9+/]+={0,2}$")
            self.assertGreater(body["pages"][0]["output_width"], 0)
            self.assertGreater(body["pages"][0]["output_height"], 0)
            self.assertIn("preprocessing", body["pages"][0])

    def test_preprocess_endpoint_accepts_core_image_document_types(self) -> None:
        cases = [
            ("receipt.jpg", "JPEG", "image/jpeg"),
            ("receipt.png", "PNG", "image/png"),
            ("receipt.webp", "WEBP", "image/webp"),
            ("receipt.tiff", "TIFF", "image/tiff"),
            ("receipt.bmp", "BMP", "image/bmp"),
            ("receipt.gif", "GIF", "image/gif"),
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            for filename, image_format, mime_type in cases:
                with self.subTest(mime_type=mime_type):
                    path = Path(temp_dir) / filename
                    create_image_fixture(path, image_format)

                    response = TestClient(app).post(
                        "/preprocess?profile=TESSERACT_OPTIMIZED",
                        files={"file": (filename, path.read_bytes(), mime_type)},
                    )

                    self.assertEqual(response.status_code, 200)
                    body = response.json()
                    self.assertEqual(body["page_count"], 1)
                    self.assertEqual(body["pages"][0]["mime_type"], "image/png")
                    self.assertGreater(body["pages"][0]["output_width"], 0)
                    self.assertGreater(body["pages"][0]["output_height"], 0)


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


def create_image_fixture(path: Path, image_format: str) -> None:
    image = Image.new("RGB", (420, 620), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((55, 35, 365, 575), outline="black", width=3)
    draw.text((90, 80), "SPENDLENS MARKET", fill="black")
    draw.text((90, 130), "TARIH 12.05.2026", fill="black")
    draw.text((90, 190), "TOPLAM 72,05 TL", fill="black")
    image.save(path, format=image_format)


if __name__ == "__main__":
    unittest.main()
