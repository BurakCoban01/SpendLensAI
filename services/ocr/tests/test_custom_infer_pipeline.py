from __future__ import annotations

import ast
import tempfile
import unittest
from pathlib import Path

import torch

from services.ocr.custom_model.dataset import generate_document_dataset
from services.ocr.custom_model.infer import (
    _document_structure_factor,
    _fragmented_segment_text,
    _page_quality_factor,
    _temporal_downsample_from_metadata,
    _validation_reliability,
    infer_document,
)
from services.ocr.custom_model.model import CRNNOCR
from services.ocr.custom_model.vocab import VOCAB, VOCAB_VERSION


def _ast_dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _ast_dotted_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


class CustomInferencePipelineTests(unittest.TestCase):
    def test_custom_document_inference_returns_tokens_without_tesseract_modules(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            sample = generate_document_dataset(root / "data", count=2, seed=31)[0]
            checkpoint = root / "model.pt"
            torch.save(
                {
                    "model_state": CRNNOCR(num_classes=len(VOCAB)).state_dict(),
                    "metadata": {"model_version": "unit-custom-crnn", "vocab_version": VOCAB_VERSION},
                },
                checkpoint,
            )
            prediction = infer_document(checkpoint, sample.image_path)

            self.assertEqual(prediction.actual_engine_used, "CUSTOM_OCR")
            self.assertEqual(prediction.vocab_version, VOCAB_VERSION)
            self.assertEqual(prediction.model_version, "unit-custom-crnn")
            self.assertGreater(len(prediction.pages), 0)
            self.assertGreater(len(prediction.tokens), 0)
            self.assertTrue(prediction.segmentation_manifest.startswith("custom-lines:"))
            self.assertIn("pages", prediction.quality)

    def test_custom_model_package_does_not_import_ready_ocr_engines(self) -> None:
        custom_root = Path("services/ocr/custom_model")
        forbidden = {
            "tesseract",
            "pytesseract",
            "paddleocr",
            "easyocr",
            "trocr",
            "donut",
            "doctr",
            "ocrmypdf",
            "textract",
            "google vision",
            "azure document intelligence",
            "external ocr api",
        }
        offenders: list[str] = []
        for path in custom_root.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                names: list[str] = []
                if isinstance(node, ast.Import):
                    names.extend(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom):
                    names.append(node.module or "")
                elif isinstance(node, ast.Call):
                    names.append(_ast_dotted_name(node.func))
                    if _ast_dotted_name(node.func) in {"__import__", "importlib.import_module", "subprocess.run", "subprocess.Popen"}:
                        names.extend(
                            argument.value
                            for argument in node.args
                            if isinstance(argument, ast.Constant) and isinstance(argument.value, str)
                        )
                for name in names:
                    folded = name.casefold()
                    for term in forbidden:
                        if term in folded:
                            offenders.append(f"{path}:{node.lineno}:{term}")
        self.assertEqual(offenders, [])

    def test_document_inference_does_not_replace_model_output_with_fixture_ground_truth(self) -> None:
        source = Path("services/ocr/custom_model/infer.py").read_text(encoding="utf-8")

        self.assertNotIn("match_project_fixture", source)
        self.assertNotIn("project_fixture_ground_truth_sha256_match", source)
        self.assertNotIn("CUSTOM_OCR_PROJECT_FIXTURE_GROUND_TRUTH_MATCH_USED", source)

    def test_document_confidence_uses_checkpoint_and_page_quality_calibration(self) -> None:
        metadata = {"metrics": {"finalValidation": {"averageCer": 0.2}}}

        self.assertEqual(_validation_reliability(metadata), 0.8)
        self.assertEqual(_validation_reliability({}), 1.0)
        self.assertEqual(_temporal_downsample_from_metadata({}), 4)
        self.assertEqual(_temporal_downsample_from_metadata({"architecture_version": "crnn-ctc-v2"}), 2)
        self.assertEqual(
            _page_quality_factor(
                {
                    "status": "low_contrast",
                    "skew_estimate_degrees": 3.0,
                    "foreground_density": 0.2,
                }
            ),
            0.68,
        )

    def test_document_structure_factor_penalizes_garbage_ocr_text(self) -> None:
        good_text = "SPENDLENS MARKET\nFIS NO 12345\nTARIH 02.06.2026\nKDV 10,00 TL\nGENEL TOPLAM 245,90 TL\nODEME KART"
        garbage_text = "KZV ATTII ARKET0 I\nKZV TTTII 1AIKII1\nMAVI KIR EMET TOPLAM 22,23 T TL"
        structured_garbage = "\n".join(
            [
                "ANKAR KIR I MKMEM TOPLAMMMMM ,0 TL",
                "KDVED 0,06 KAR 0 I II 10,0 TL",
                "ODEME NAK 0 I 10,0L L",
                "ANKARA IRAx TOPLAM II10,71",
            ]
        )

        self.assertGreaterEqual(_document_structure_factor(good_text), 0.95)
        self.assertLess(_document_structure_factor(garbage_text), 0.75)
        self.assertLessEqual(_document_structure_factor(structured_garbage), 0.70)

    def test_fragmented_low_reliability_segments_are_marked_as_garbage(self) -> None:
        fragmented = ["I", "N0", "KDV", "T", "MAVG", "11T"] * 3

        self.assertTrue(_fragmented_segment_text(fragmented, 0.65))
        self.assertFalse(_fragmented_segment_text(fragmented, 1.0))


if __name__ == "__main__":
    unittest.main()
