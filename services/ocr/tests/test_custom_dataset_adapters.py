from __future__ import annotations

import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from services.ocr.custom_model.dataset_adapters import write_dataset_source_manifest


def _test_font(size: int = 22) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for font_name in ("DejaVuSans.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(font_name, size)
        except OSError:
            continue
    return ImageFont.load_default()


class CustomDatasetAdapterTests(unittest.TestCase):
    def test_unchanged_source_reuses_complete_adapter_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            ocrturk = root / "OCRTurk-local"
            ocrturk.mkdir()
            (ocrturk / "data_1.md").write_text("FİŞ TOPLAM 10,00 TL", encoding="utf-8")
            output = root / "out" / "inventory.json"

            first = write_dataset_source_manifest(root, output)
            with patch(
                "services.ocr.custom_model.dataset_adapters._collect_parseable_dataset_rows",
                side_effect=AssertionError("unchanged source must use its complete adapter cache"),
            ):
                second = write_dataset_source_manifest(root, output)

            first_source = next(entry for entry in first["datasets"] if entry["name"] == "OCRTurk")
            second_source = next(entry for entry in second["datasets"] if entry["name"] == "OCRTurk")
            self.assertEqual(first_source["adapter_cache_status"], "miss")
            self.assertEqual(second_source["adapter_cache_status"], "hit")
            self.assertEqual(first_source["sample_count_imported"], second_source["sample_count_imported"])
            self.assertRegex(second_source["sample_checksum_sha256"], r"^[0-9a-f]{64}$")

    def test_source_change_invalidates_adapter_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            ocrturk = root / "OCRTurk-local"
            ocrturk.mkdir()
            source = ocrturk / "data_1.md"
            source.write_text("FİŞ TOPLAM 10,00 TL", encoding="utf-8")
            output = root / "out" / "inventory.json"

            first = write_dataset_source_manifest(root, output)
            source.write_text("FİŞ TOPLAM 12,50 TL", encoding="utf-8")
            second = write_dataset_source_manifest(root, output)

            first_source = next(entry for entry in first["datasets"] if entry["name"] == "OCRTurk")
            second_source = next(entry for entry in second["datasets"] if entry["name"] == "OCRTurk")
            self.assertEqual(first_source["adapter_cache_status"], "miss")
            self.assertEqual(second_source["adapter_cache_status"], "miss")
            self.assertNotEqual(
                first_source["metadata_fingerprint_sha256"],
                second_source["metadata_fingerprint_sha256"],
            )

    def test_ocrturk_long_pdf_lines_create_scale_preserving_training_chunks(self) -> None:
        import fitz

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            ocrturk = root / "OCRTurk-local"
            ocrturk.mkdir()
            long_text = (
                "Türkçe belgelerde uzun satırlar karakter yüksekliği korunarak "
                "birden fazla gerçek metin parçasına ayrılır"
            )
            (ocrturk / "data_1.md").write_text(long_text, encoding="utf-8")
            pdf = fitz.open()
            page = pdf.new_page(width=900, height=120)
            page.insert_text((20, 60), long_text, fontsize=12)
            pdf.save(ocrturk / "data_1.pdf")
            pdf.close()

            manifest = write_dataset_source_manifest(root, root / "out" / "inventory.json")
            rows = [
                json.loads(line)
                for line in Path(manifest["combined_manifests"]["line_train"]).read_text(encoding="utf-8").splitlines()
                if line
            ]
            ocrturk_rows = [row for row in rows if row.get("source") == "OCRTurk"]
            chunk_rows = [row for row in ocrturk_rows if ":chunk:" in str(row.get("id"))]

            self.assertGreaterEqual(len(chunk_rows), 2)
            self.assertTrue(all(len(str(row["text"])) <= 48 for row in chunk_rows))
            self.assertTrue(all(Path(str(row["image"])).is_file() for row in chunk_rows))

    def test_emnist_balanced_idx_is_expanded_into_character_manifest_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            emnist_raw = root / "EMNIST-local" / "raw"
            emnist_raw.mkdir(parents=True)
            for split in ("train", "test"):
                labels = bytes([0, 10, 36])
                images = bytes(value % 256 for value in range(28 * 28)) * len(labels)
                (emnist_raw / f"emnist-balanced-{split}-labels-idx1-ubyte").write_bytes(
                    struct.pack(">II", 2049, len(labels)) + labels
                )
                (emnist_raw / f"emnist-balanced-{split}-images-idx3-ubyte").write_bytes(
                    struct.pack(">IIII", 2051, len(labels), 28, 28) + images
                )

            manifest = write_dataset_source_manifest(root, root / "out" / "inventory.json")
            emnist = next(entry for entry in manifest["datasets"] if entry["name"] == "EMNIST")
            train_rows = [
                json.loads(line)
                for line in Path(manifest["combined_manifests"]["character_train"]).read_text(encoding="utf-8").splitlines()
                if line
            ]
            validation_rows = [
                json.loads(line)
                for line in Path(manifest["combined_manifests"]["character_validation"]).read_text(encoding="utf-8").splitlines()
                if line
            ]

            self.assertEqual(emnist["parseability_status"], "parseable_emnist_balanced_idx")
            self.assertEqual(emnist["sample_count_imported"], 6)
            self.assertEqual({row["text"] for row in train_rows if row["source"] == "EMNIST"}, {"0", "A", "a"})
            self.assertEqual(len([row for row in validation_rows if row["source"] == "EMNIST"]), 3)
            self.assertTrue(all(Path(row["image"]).is_file() for row in train_rows if row["source"] == "EMNIST"))

    def test_turkish_hun_eng_mat_payload_is_expanded_into_turkish_special_character_rows(self) -> None:
        try:
            from scipy.io import savemat  # type: ignore[import-not-found]
        except ImportError:
            self.skipTest("scipy is required to write a compact T-H-E .mat fixture")

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            the_root = root / "Turkish-Hun-Eng-local" / "Version II Turkish special"
            the_root.mkdir(parents=True)
            samples = np.zeros((28, 28, 1, 4), dtype=np.uint8)
            samples[6:22, 8:20, 0, :] = 255
            labels = np.array([[1, 2, 7, 12]], dtype=np.uint8)
            savemat(the_root / "version_ii_turkish_special.mat", {"X": samples, "Y": labels})

            manifest = write_dataset_source_manifest(root, root / "out" / "inventory.json")
            by_name = {entry["name"]: entry for entry in manifest["datasets"]}
            train_rows = [
                json.loads(line)
                for line in Path(manifest["combined_manifests"]["character_train"]).read_text(encoding="utf-8").splitlines()
                if line
            ]
            validation_rows = [
                json.loads(line)
                for line in Path(manifest["combined_manifests"]["character_validation"]).read_text(encoding="utf-8").splitlines()
                if line
            ]
            imported_texts = {
                row["text"]
                for row in [*train_rows, *validation_rows]
                if row.get("source") == "Turkish-Hun-Eng"
            }

            self.assertEqual(by_name["Turkish-Hun-Eng"]["parseability_status"], "parseable_the_character_payload")
            self.assertEqual(by_name["Turkish-Hun-Eng"]["sample_count_imported"], 4)
            self.assertEqual(imported_texts, {"ç", "ğ", "Ç", "Ü"})
            self.assertTrue(all(Path(row["image"]).is_file() for row in train_rows if row.get("source") == "Turkish-Hun-Eng"))

    def test_dataset_source_manifest_records_size_checksum_splits_and_usage(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cord_train_json = root / "CORD-local" / "train" / "json"
            cord_train_image = root / "CORD-local" / "train" / "image"
            cord_test = root / "CORD-local" / "test"
            ocrturk_validation = root / "OCRTurk-manual" / "validation"
            cord_train_json.mkdir(parents=True)
            cord_train_image.mkdir(parents=True)
            cord_test.mkdir(parents=True)
            ocrturk_validation.mkdir(parents=True)
            (cord_train_json / "receipt.json").write_text(
                '{"valid_line":[{"category":"total.total_price","words":[{"text":"TOTAL","quad":{"x1":12,"y1":20,"x2":70,"y2":20,"x3":70,"y3":60,"x4":12,"y4":60}},{"text":"10.00","quad":{"x1":120,"y1":20,"x2":180,"y2":20,"x3":180,"y3":60,"x4":120,"y4":60}}]}]}',
                encoding="utf-8",
            )
            cord_image = Image.new("RGB", (260, 100), "white")
            cord_draw = ImageDraw.Draw(cord_image)
            cord_font = _test_font(18)
            cord_draw.text((10, 16), "TOTAL", fill=0, font=cord_font)
            cord_draw.text((120, 16), "10.00", fill=0, font=cord_font)
            cord_image.save(cord_train_image / "receipt.png")
            (ocrturk_validation / "data_1.md").write_text("FİŞ TOPLAM 10,00 TL", encoding="utf-8")
            import fitz

            pdf = fitz.open()
            page = pdf.new_page(width=300, height=120)
            page.insert_text((24, 60), "FIS TOPLAM 10,00 TL", fontsize=18)
            pdf.save(ocrturk_validation / "data_1.pdf")
            pdf.close()

            manifest = write_dataset_source_manifest(root, root / "manifest" / "sources.json")

            self.assertEqual(manifest["download_policy"], "manual/local only; this adapter never downloads datasets silently")
            self.assertTrue((root / "manifest" / "sources.json").exists())
            by_name = {entry["name"]: entry for entry in manifest["datasets"]}
            self.assertTrue(by_name["CORD"]["present"])
            self.assertGreater(by_name["CORD"]["size_bytes"], 0)
            self.assertEqual(by_name["CORD"]["split_summary"], {"train": 2})
            self.assertRegex(by_name["CORD"]["checksum_sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(by_name["CORD"]["usable_for_document_benchmark"])
            self.assertTrue(by_name["CORD"]["usable_for_extraction_benchmark"])
            self.assertFalse(by_name["CORD"]["usable_for_character_training"])
            self.assertTrue(by_name["CORD"]["usable_for_line_training"])
            self.assertFalse(by_name["CORD"]["contains_turkish"])
            self.assertEqual(by_name["CORD"]["parseability_status"], "parseable_cord_json")
            self.assertGreater(by_name["CORD"]["sample_count_imported"], 0)
            self.assertGreater(by_name["CORD"]["imported_manifest_counts"]["line_train"], 0)
            self.assertTrue(by_name["OCRTurk"]["contains_turkish"])
            self.assertTrue(by_name["OCRTurk"]["usable_for_line_training"])
            self.assertEqual(by_name["OCRTurk"]["split_summary"], {"validation": 2})
            self.assertEqual(by_name["OCRTurk"]["parseability_status"], "parseable_pdf_text_lines")
            self.assertGreater(by_name["OCRTurk"]["imported_manifest_counts"]["line_train"], 0)
            self.assertFalse(by_name["SROIE"]["present"])
            self.assertEqual(by_name["SROIE"]["checksum_note"], "dataset not present")
            self.assertIn("project_fixtures", manifest)
            self.assertIn("combined_manifest_counts", manifest)
            self.assertIn("hardcase_reason_counts", manifest)
            self.assertGreater(manifest["combined_manifest_counts"]["hardcase_train"], 0)
            self.assertIn("amount_or_decimal_comma", manifest["hardcase_reason_counts"]["train"])
            self.assertTrue((root / "manifest" / "custom-ocr-dataset-manifests" / "benchmark_manifest.jsonl").exists())
            self.assertTrue((root / "manifest" / "custom-ocr" / "dataset_sources.json").exists())
            self.assertTrue((root / "manifest" / "custom-ocr" / "line_train.jsonl").exists())
            self.assertTrue((root / "manifest" / "custom-ocr" / "hardcase_train.jsonl").exists())
            self.assertTrue((root / "manifest" / "custom-ocr" / "hardcase_validation.jsonl").exists())
            combined_line_rows = (root / "manifest" / "custom-ocr" / "line_train.jsonl").read_text(encoding="utf-8")
            self.assertIn('"source": "CORD"', combined_line_rows)
            self.assertIn('"source": "OCRTurk"', combined_line_rows)
            self.assertIn('"usableForTraining": true', combined_line_rows)
            self.assertIn('"lineCropBox": [8, 16, 184, 64]', combined_line_rows)
            character_rows = [
                json.loads(line)
                for line in (root / "manifest" / "custom-ocr" / "character_train.jsonl").read_text(encoding="utf-8").splitlines()
                if line
            ]
            cord_numeric_characters = [row for row in character_rows if row.get("source") == "CORD_numeric_character"]
            self.assertGreater(len(cord_numeric_characters), 0)
            self.assertTrue(all(Path(row["image"]).is_file() for row in cord_numeric_characters))
            ocrturk_assets = list((root / "manifest" / "custom-ocr" / "assets" / "ocrturk-lines").glob("*.png"))
            self.assertEqual(len(ocrturk_assets), 1)

    def test_project_fixture_manifests_repair_turkish_mojibake_for_benchmark_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset_root = root / "Dataset"
            fixture_root = root / "tr"
            ground_truth = fixture_root / "ground-truth"
            dataset_root.mkdir()
            ground_truth.mkdir(parents=True)
            (fixture_root / "valid-fis-01.jpg").write_bytes(b"fake-image")
            (ground_truth / "valid-fis-01.json").write_text(
                """{
  "merchant": "SPENDLENS MARKET",
  "date": "2026-06-02",
  "currency": "TRY",
  "total": "72.05",
  "paymentMethod": "KART",
  "lineItems": [{"description": "S\u00c3\u009cT", "amount": "32.50"}],
  "documentType": "receipt",
  "expectedOcrTextSnippets": ["F\u00c4\u00b0\u00c5\u009e NO", "S\u00c3\u009cT", "\u00c3\u0096DEME", "72,05 TL"]
}""",
                encoding="utf-8",
            )

            manifest = write_dataset_source_manifest(dataset_root, root / "out" / "inventory.json", fixture_root)
            benchmark_path = Path(manifest["generated_manifests"]["benchmark_manifest"])
            rows = [line for line in benchmark_path.read_text(encoding="utf-8").splitlines() if line.strip()]

            self.assertEqual(manifest["project_fixtures"]["benchmark_count"], 1)
            self.assertEqual(len(rows), 1)
            self.assertIn("F\u0130\u015e NO", rows[0])
            self.assertIn("S\u00dcT", rows[0])
            self.assertIn("\u00d6DEME", rows[0])
            combined_train = Path(manifest["combined_manifests"]["line_train"]).read_text(encoding="utf-8")
            self.assertIn('"source": "project_fixture_synthetic"', combined_train)
            self.assertIn('"usableForBenchmark": false', combined_train)

    def test_corrupt_replacement_character_labels_are_filtered_from_public_manifests(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            sroie_box = root / "SROIE-local" / "train" / "box"
            sroie_img = root / "SROIE-local" / "train" / "img"
            sroie_box.mkdir(parents=True)
            sroie_img.mkdir(parents=True)
            Image.new("RGB", (240, 120), "white").save(sroie_img / "receipt.jpg")
            (sroie_box / "receipt.txt").write_text(
                "\n".join(
                    [
                        "10,10,160,10,160,40,10,40,TOPLAM 22,23 TL",
                        "10,50,160,50,160,80,10,80,Ac\ufffd zeka",
                    ]
                ),
                encoding="utf-8",
            )

            manifest = write_dataset_source_manifest(root, root / "out" / "inventory.json")
            combined_train = Path(manifest["combined_manifests"]["line_train"]).read_text(encoding="utf-8")

            self.assertIn("TOPLAM 22,23 TL", combined_train)
            self.assertNotIn("Ac\ufffd zeka", combined_train)

    def test_project_fixture_line_annotations_create_real_crop_training_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset_root = root / "Dataset"
            fixture_root = root / "tr"
            annotations = fixture_root / "annotations"
            dataset_root.mkdir()
            annotations.mkdir(parents=True)
            fixture = Image.new("L", (240, 100), color=255)
            font = _test_font(22)
            ImageDraw.Draw(fixture).text((12, 20), "SÜT", fill=0, font=font)
            fixture.save(fixture_root / "fixture.png")
            (annotations / "fixture-lines.json").write_text(
                json.dumps(
                    {
                        "documents": [
                            {
                                "id": "fixture",
                                "fixture": "fixture.png",
                                "split": "train",
                                "documentType": "receipt",
                            "lines": [{"text": "S\u00c3\u009cT", "bbox": [8, 12, 180, 40]}],
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            manifest = write_dataset_source_manifest(dataset_root, root / "out" / "inventory.json", fixture_root)
            combined_train = Path(manifest["combined_manifests"]["line_train"])
            rows = [json.loads(line) for line in combined_train.read_text(encoding="utf-8").splitlines() if line]
            real_rows = [row for row in rows if row.get("source") == "project_fixture_real_crop"]

            self.assertEqual(manifest["project_fixtures"]["real_training_line_count"], 1)
            self.assertEqual(len(real_rows), 1)
            self.assertEqual(real_rows[0]["text"], "S\u00dcT")
            self.assertTrue(Path(real_rows[0]["image"]).is_file())
            combined_characters = Path(manifest["combined_manifests"]["character_train"])
            character_rows = [
                json.loads(line)
                for line in combined_characters.read_text(encoding="utf-8").splitlines()
                if line
            ]
            real_characters = [row for row in character_rows if row.get("source") == "project_fixture_real_character"]
            self.assertGreater(len(real_characters), 0)
            self.assertTrue(all(Path(row["image"]).is_file() for row in real_characters))

    def test_hardcase_manifests_prioritize_turkish_amount_and_field_lines(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset_root = root / "Dataset"
            fixture_root = root / "tr"
            annotations = fixture_root / "annotations"
            dataset_root.mkdir()
            annotations.mkdir(parents=True)
            fixture = Image.new("L", (360, 120), color=255)
            font = _test_font(22)
            draw = ImageDraw.Draw(fixture)
            draw.text((12, 20), "FİŞ TOPLAM 22,23 TL", fill=0, font=font)
            draw.text((12, 62), "MARKET RAF", fill=0, font=font)
            fixture.save(fixture_root / "fixture.png")
            (annotations / "fixture-lines.json").write_text(
                json.dumps(
                    {
                        "documents": [
                            {
                                "id": "fixture",
                                "fixture": "fixture.png",
                                "split": "train",
                                "documentType": "receipt",
                                "lines": [
                                    {"text": "FİŞ TOPLAM 22,23 TL", "bbox": [8, 12, 260, 44]},
                                    {"text": "MARKET RAF", "bbox": [8, 56, 220, 44]},
                                ],
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            manifest = write_dataset_source_manifest(dataset_root, root / "out" / "inventory.json", fixture_root)
            hardcase_path = Path(manifest["combined_manifests"]["hardcase_train"])
            hardcase_rows = [json.loads(line) for line in hardcase_path.read_text(encoding="utf-8").splitlines() if line]
            amount_rows = [row for row in hardcase_rows if row.get("text") == "FİŞ TOPLAM 22,23 TL"]

            self.assertGreaterEqual(len(hardcase_rows), 1)
            self.assertEqual(len(amount_rows), 1)
            self.assertIn("turkish_special_character", amount_rows[0]["hardcaseReasons"])
            self.assertIn("amount_or_decimal_comma", amount_rows[0]["hardcaseReasons"])
            self.assertIn("field_keyword", amount_rows[0]["hardcaseReasons"])
            self.assertEqual(amount_rows[0]["source"], "project_fixture_real_crop")
            self.assertGreaterEqual(amount_rows[0]["hardcaseWeight"], 2)


if __name__ == "__main__":
    unittest.main()
