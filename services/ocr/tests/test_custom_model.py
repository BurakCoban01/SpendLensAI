from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch
from PIL import Image, ImageDraw
from torch import nn

from services.ocr.benchmarks.ocr_benchmark import (
    BenchmarkSample,
    PredictionRow,
    _amount_token_set,
    _confidence_calibration_metrics,
    _evaluate_line_items,
    _evaluate_structured_fields,
    _extract_line_items,
    _extract_structured_fields,
    _extraction_metrics,
    _field_macro_metrics,
    _field_micro_metrics,
    _line_item_metrics,
    _reference_text_extraction_metrics,
    cer,
    run_benchmark,
    wer,
)
from services.ocr.custom_model.benchmark import _extract_generated_fields, _field_matches, run_custom_benchmark
from services.ocr.custom_model.dataset import (
    generate_character_dataset,
    generate_dataset,
    generate_document_dataset,
    generate_document_line_dataset,
    generate_numeric_field_dataset,
    import_correction_dataset,
    run_cli,
)
from services.ocr.custom_model.evaluate import evaluate_custom_ocr_checkpoint, evaluate_predictions
from services.ocr.custom_model.infer import (
    _crnn_candidate_payload,
    _decoder_blank_penalty_from_metadata,
    _infer_line_role,
    _merge_overlapping_prediction_text,
    _pipeline_bundle_metadata,
    _select_crnn_challenger,
    _validated_challenger_route_evidence,
    _should_use_character_line_prediction,
    _should_use_fourier_line_prediction,
    _should_use_long_line_challenger,
    CustomOcrPrediction,
    decode_ctc_prediction,
)
from services.ocr.custom_model.line_images import (
    ctc_input_length_for_width,
    deskew_line_image,
    estimate_line_skew_degrees,
    line_image_to_tensor,
    prepare_cropped_line_image,
    prepare_cropped_line_windows,
)
from services.ocr.custom_model.model import CRNNOCR
from services.ocr.custom_model.registry import find_ready_model
from services.ocr.custom_model.train import (
    LineDataset,
    _bounded_split_rows,
    _checkpoint_selection_score,
    _prepare_combined_manifest_dataset,
    collate,
    ctc_required_input_length,
    field_line_sample_weights,
    is_key_field_line,
    line_task_labels,
    task_balanced_sample_weights,
    train_custom_ocr_model,
)
from services.ocr.custom_model.vocab import CHARS, VOCAB, VOCAB_VERSION, decode, encode


class CustomOCRModelTests(unittest.TestCase):
    def test_vocab_round_trips_turkish_receipt_characters(self) -> None:
        text = "Çağrı MARKET İÇECEK TOPLAM 72,05 ₺"
        encoded = encode(text)
        self.assertEqual(decode(encoded), text)
        self.assertGreater(len(VOCAB), 80)

    def test_dataset_generation_is_deterministic_and_has_splits(self) -> None:
        with tempfile.TemporaryDirectory() as left_dir, tempfile.TemporaryDirectory() as right_dir:
            left = generate_dataset(Path(left_dir), count=12, seed=123)
            right = generate_dataset(Path(right_dir), count=12, seed=123)

            self.assertEqual([sample.text for sample in left], [sample.text for sample in right])
            manifest = [
                json.loads(line)
                for line in (Path(left_dir) / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual({row["split"] for row in manifest}, {"train", "validation", "test"})
            self.assertTrue(all((Path(left_dir) / row["image"]).exists() for row in manifest))
            turkish_characters = set("çğıİöşüÇĞÖŞÜ₺")
            for split in ("train", "validation", "test"):
                split_text = " ".join(row["text"] for row in manifest if row["split"] == split)
                self.assertTrue(
                    any(character in split_text for character in turkish_characters),
                    f"{split} split should include Turkish OCR characters",
                )
            generated_lines = [row["text"] for row in manifest]
            self.assertTrue(any(line.startswith(("FİŞ NO", "FATURA NO")) for line in generated_lines))
            self.assertTrue(any(line.startswith("TARİH ") for line in generated_lines))
            self.assertTrue(any(" x " in line and " TL " in line for line in generated_lines))
            self.assertTrue(any(line.startswith("KDV ") for line in generated_lines))
            self.assertTrue(any(line.startswith("TOPLAM ") for line in generated_lines))

    def test_document_line_dataset_uses_rendered_document_crops(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            samples = generate_document_line_dataset(root, count=32, seed=124)
            manifest = [
                json.loads(line)
                for line in (root / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            texts = [str(row["text"]) for row in manifest]

            self.assertEqual(len(samples), 32)
            self.assertEqual({row["source"] for row in manifest}, {"synthetic_document_line_crop"})
            self.assertTrue(all((root / row["image"]).exists() for row in manifest))
            self.assertTrue(any(" NO " in text for text in texts))
            self.assertTrue(any(text.startswith("TAR") for text in texts))
            self.assertTrue(any(text.startswith("KDV ") for text in texts))
            self.assertTrue(any(text.startswith("TOPLAM ") for text in texts))
            self.assertTrue(all(row["bbox"] for row in manifest))
            dataset = LineDataset(root / "manifest.jsonl", root, split="train")
            image, _target, _target_length, _input_length = dataset[0]
            self.assertEqual(tuple(image.shape[1:]), (64, 384))

    def test_document_line_dataset_can_mix_project_fixture_snippets(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture_root = root / "fixtures" / "tr"
            ground_truth = fixture_root / "ground-truth"
            ground_truth.mkdir(parents=True)
            (ground_truth / "valid-fis-01.json").write_text(
                json.dumps(
                    {
                        "documentType": "receipt",
                        "expectedOcrTextSnippets": ["SPENDLENS MARKET", "FİŞ NO", "ÖDEME KART", "72,05 TL"],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (ground_truth / "valid-fis-02.json").write_text(
                json.dumps(
                    {
                        "documentType": "receipt",
                        "expectedOcrTextSnippets": [
                            "SPENDLENS MARKET",
                            "FIS NO",
                            "TARIH",
                            "EKMEK",
                            "SUT",
                            "KDV",
                            "GENEL TOPLAM",
                            "72,05 TL",
                            "ODEME KART",
                            "TESEKKURLER",
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            samples = generate_document_line_dataset(root / "data", count=8, seed=124, include_project_fixtures=True, fixture_root=fixture_root)
            manifest = [
                json.loads(line)
                for line in (root / "data" / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            all_fixture_rows = [row for row in manifest if row["source"] == "project_real_fixture_rendered_snippet"]
            fixture_rows = all_fixture_rows[:4]
            fixture_splits = [row["split"] for row in all_fixture_rows]

            self.assertGreater(len(samples), 8)
            self.assertEqual(len(all_fixture_rows), 14)
            self.assertEqual(all_fixture_rows[-1]["text"], "TESEKKURLER")
            self.assertEqual(fixture_splits.count("train"), 10)
            self.assertEqual(fixture_splits.count("validation"), 2)
            self.assertEqual(fixture_splits.count("test"), 2)
            self.assertEqual([row["text"] for row in fixture_rows], ["SPENDLENS MARKET", "FİŞ NO", "ÖDEME KART", "72,05 TL"])
            self.assertTrue(all((root / "data" / row["image"]).exists() for row in all_fixture_rows))
            self.assertTrue(all("not a real segmented crop" in row["manualReviewNote"] for row in all_fixture_rows))

    def test_line_dataset_reads_manifest_line_crop_boxes_from_full_documents(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            full_image = Image.new("L", (240, 120), color=245)
            draw = ImageDraw.Draw(full_image)
            draw.text((30, 44), "TOPLAM 72,05 TL", fill=20)
            full_image.save(root / "receipt.png")
            (root / "manifest.jsonl").write_text(
                json.dumps(
                    {
                        "image": "receipt.png",
                        "text": "TOPLAM 72,05 TL",
                        "split": "train",
                        "source": "SROIE",
                        "lineCropBox": [24, 36, 170, 72],
                        "lineCropBoxFormat": "xyxy",
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )

            dataset = LineDataset(root / "manifest.jsonl", root, split="train")
            image, target, target_length, input_length = dataset[0]

            self.assertEqual(tuple(image.shape[0:2]), (1, 64))
            self.assertGreaterEqual(image.shape[2], 384)
            self.assertEqual(target_length, len(target))
            self.assertGreaterEqual(input_length, target_length)

            compact = LineDataset(
                root / "manifest.jsonl",
                root,
                split="train",
                temporal_downsample=4,
                line_image_min_width=128,
            )
            compact_image, _target, _target_length, compact_input_length = compact[0]
            self.assertLess(compact_image.shape[2], 384)
            self.assertEqual(compact_input_length, compact_image.shape[2] // 4)

    def test_line_image_deskew_reduces_rotated_photo_line_angle(self) -> None:
        image = Image.new("L", (280, 80), color=245)
        draw = ImageDraw.Draw(image)
        draw.text((22, 28), "TOPLAM 245,90 TL", fill=20)
        rotated = image.rotate(8, expand=True, fillcolor=245)

        before = abs(estimate_line_skew_degrees(rotated))
        after = abs(estimate_line_skew_degrees(deskew_line_image(rotated)))

        self.assertGreater(before, 2.0)
        self.assertLess(after, before)

    def test_inverted_line_tensor_maps_white_background_to_zero_and_ink_to_one(self) -> None:
        image = Image.new("L", (8, 4), color=255)
        ImageDraw.Draw(image).point((2, 1), fill=0)

        tensor = line_image_to_tensor(image, invert=True)

        self.assertEqual(float(tensor[0, 0, 0]), 0.0)
        self.assertEqual(float(tensor[0, 1, 2]), 1.0)

    def test_crnn_training_can_prepare_combined_manifest_dataset_with_source_mix(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            combined = root / "combined"
            combined.mkdir()
            image = Image.new("L", (220, 100), color=245)
            draw = ImageDraw.Draw(image)
            draw.text((20, 30), "TOPLAM 72,05 TL", fill=20)
            image_path = root / "receipt.png"
            image.save(image_path)
            train_rows = [
                {
                    "image": str(image_path),
                    "text": "TOPLAM 72,05 TL",
                    "split": "train",
                    "source": "SROIE",
                    "usableForTraining": True,
                    "lineCropBox": [12, 20, 180, 70],
                },
                {
                    "image": str(image_path),
                    "text": "KDV 12,01 TL",
                    "split": "train",
                    "source": "CORD",
                    "usableForTraining": True,
                    "lineCropBox": [12, 20, 180, 70],
                },
            ]
            validation_rows = [
                {
                    "image": str(image_path),
                    "text": "TOPLAM 72,05 TL",
                    "split": "validation",
                    "source": "SROIE",
                    "usableForTraining": True,
                    "lineCropBox": [12, 20, 180, 70],
                }
            ]
            (combined / "line_train.jsonl").write_text(
                "\n".join(json.dumps(row, ensure_ascii=False) for row in train_rows) + "\n",
                encoding="utf-8",
            )
            (combined / "line_validation.jsonl").write_text(
                "\n".join(json.dumps(row, ensure_ascii=False) for row in validation_rows) + "\n",
                encoding="utf-8",
            )

            metrics = train_custom_ocr_model(
                data_dir=root / "prepared",
                artifact_dir=root / "artifact",
                samples=2,
                epochs=1,
                seed=129,
                profile="tiny",
                batch_size=1,
                min_epochs=1,
                dataset_mode="combined_manifest",
                combined_manifest_dir=combined,
                include_sources={"SROIE"},
                blank_bias_init=-1.5,
                space_regularization=0.25,
                space_bias_init=-1.0,
                alignment_auxiliary_weight=0.1,
            )

            prepared_rows = [
                json.loads(line)
                for line in (root / "prepared" / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(prepared_rows), 2)
            self.assertEqual({row["split"] for row in prepared_rows}, {"train", "validation"})
            self.assertEqual(sum(metrics["datasetSourceMix"].values()), 2)
            self.assertEqual(metrics["includeSources"], ["SROIE"])
            self.assertEqual(metrics["minEpochs"], 1)
            self.assertEqual(metrics["blankBiasInit"], -1.5)
            self.assertEqual(metrics["spaceRegularization"], 0.25)
            self.assertEqual(metrics["spaceBiasInit"], -1.0)
            self.assertEqual(metrics["alignmentAuxiliaryWeight"], 0.1)
            self.assertEqual(metrics["trainSourceMix"], {"SROIE": 1})
            self.assertEqual(metrics["validationSourceMix"], {"SROIE": 1})
            self.assertEqual(metrics["hardcaseReasonMix"], {})
            self.assertIn("bySource", metrics["finalValidation"])
            self.assertIn("SROIE", metrics["finalValidation"]["bySource"])
            self.assertIn("tokenF1", metrics["finalValidation"]["bySource"]["SROIE"])
            checkpoint = torch.load(root / "artifact" / "model.pt", map_location="cpu")
            self.assertEqual(checkpoint["metadata"]["dataset_mode"], "combined_manifest")
            self.assertEqual(checkpoint["metadata"]["metrics"]["datasetSourceMix"], metrics["datasetSourceMix"])
            self.assertEqual(checkpoint["metadata"]["metrics"]["validationSourceMix"], metrics["validationSourceMix"])

    def test_combined_manifest_sampling_preserves_each_available_source(self) -> None:
        train_rows = [
            {"id": f"{source}-{index}", "source": source, "split": "train"}
            for source in ("CORD", "SROIE", "OCRTurk", "project_fixture_synthetic")
            for index in range(20)
        ]
        validation_rows = [
            {"id": f"validation-{source}-{index}", "source": source, "split": "validation"}
            for source in ("CORD", "SROIE", "OCRTurk", "project_fixture_synthetic")
            for index in range(5)
        ]

        sampled = _bounded_split_rows(train_rows, validation_rows, samples=24, seed=41)
        sampled_train_sources = {str(row["source"]) for row in sampled if row["split"] == "train"}
        sampled_validation_sources = {str(row["source"]) for row in sampled if row["split"] == "validation"}

        self.assertEqual(len(sampled), 24)
        self.assertEqual(sampled_train_sources, {"CORD", "SROIE", "OCRTurk", "project_fixture_synthetic"})
        self.assertEqual(sampled_validation_sources, {"CORD", "SROIE", "OCRTurk", "project_fixture_synthetic"})

    def test_combined_manifest_preparation_adds_weighted_hardcase_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            combined = root / "combined"
            combined.mkdir()
            image = Image.new("L", (220, 80), color=245)
            image_path = root / "line.png"
            image.save(image_path)
            train_rows = [
                {"id": "plain", "image": str(image_path), "text": "MARKET RAF", "split": "train", "source": "OCRTurk", "usableForTraining": True},
                {
                    "id": "hard",
                    "image": str(image_path),
                    "text": "FİŞ TOPLAM 22,23 TL",
                    "split": "train",
                    "source": "OCRTurk",
                    "usableForTraining": True,
                },
            ]
            validation_rows = [
                {"id": "valid", "image": str(image_path), "text": "KDV 12,01 TL", "split": "validation", "source": "OCRTurk", "usableForTraining": True}
            ]
            hardcase_rows = [
                {
                    **train_rows[1],
                    "id": "hard:hardcase",
                    "hardcaseReasons": ["turkish_special_character", "amount_or_decimal_comma", "field_keyword"],
                    "hardcaseWeight": 3,
                }
            ]
            (combined / "line_train.jsonl").write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in train_rows) + "\n", encoding="utf-8")
            (combined / "line_validation.jsonl").write_text(
                "\n".join(json.dumps(row, ensure_ascii=False) for row in validation_rows) + "\n",
                encoding="utf-8",
            )
            (combined / "hardcase_train.jsonl").write_text(
                "\n".join(json.dumps(row, ensure_ascii=False) for row in hardcase_rows) + "\n",
                encoding="utf-8",
            )
            (combined / "hardcase_validation.jsonl").write_text("", encoding="utf-8")

            prepared_path = root / "prepared" / "manifest.jsonl"
            _prepare_combined_manifest_dataset(combined, prepared_path, samples=5, seed=12, include_sources={"OCRTurk"})
            prepared_rows = [json.loads(line) for line in prepared_path.read_text(encoding="utf-8").splitlines() if line]
            hardcase_prepared = [row for row in prepared_rows if row.get("text") == "FİŞ TOPLAM 22,23 TL" and row["split"] == "train"]

            self.assertEqual(len(hardcase_prepared), 1)
            self.assertTrue(all(row.get("hardcaseReasons") for row in hardcase_prepared))
            self.assertEqual(hardcase_prepared[0]["hardcaseWeight"], 3)
            self.assertIn("validation", {row["split"] for row in prepared_rows})

    def test_combined_manifest_requires_independent_validation_rows(self) -> None:
        train_rows = [{"id": "train", "source": "OCRTurk", "split": "train"}]

        with self.assertRaisesRegex(ValueError, "independent non-empty validation"):
            _bounded_split_rows(train_rows, [], samples=1, seed=41)

    def test_numeric_field_dataset_covers_financial_identifier_formats(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            samples = generate_numeric_field_dataset(root, count=64, seed=125)
            manifest = [
                json.loads(line)
                for line in (root / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]

            self.assertEqual(len(samples), 64)
            self.assertEqual({row["fieldKind"] for row in manifest}, {"amount", "date", "document_no", "vkn"})
            self.assertEqual({row["split"] for row in manifest}, {"train", "validation", "test"})
            self.assertEqual({row["source"] for row in manifest}, {"synthetic_numeric_field_crop"})
            self.assertTrue(all(row["vocabVersion"] == VOCAB_VERSION for row in manifest))
            self.assertTrue(any("," in row["text"] for row in manifest if row["fieldKind"] == "amount"))
            self.assertTrue(any(row["text"].startswith(("FIS-", "INV-")) for row in manifest if row["fieldKind"] == "document_no"))
            self.assertTrue(all((root / row["image"]).exists() for row in manifest))

    def test_character_dataset_covers_vocabulary_turkish_variants_and_splits(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            samples = generate_character_dataset(root, count=len(CHARS) + 24, seed=456)
            manifest = [
                json.loads(line)
                for line in (root / "character_manifest.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]

            self.assertEqual(len(samples), len(CHARS) + 24)
            self.assertEqual({row["split"] for row in manifest}, {"train", "validation", "test"})
            self.assertTrue(set(CHARS).issubset({row["character"] for row in manifest}))
            self.assertTrue({"ç", "ğ", "ı", "İ", "ö", "ş", "ü", "₺"}.issubset({row["character"] for row in manifest}))
            self.assertTrue(all(row["vocabVersion"] == VOCAB_VERSION for row in manifest))
            self.assertTrue(all((root / row["image"]).exists() for row in manifest))
            self.assertTrue(any(row["oversampled"] for row in manifest))

    def test_document_dataset_generates_receipts_invoices_variants_and_ground_truth(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            samples = generate_document_dataset(root, count=12, seed=321)
            manifest = [
                json.loads(line)
                for line in (root / "document_manifest.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]

            self.assertEqual(len(samples), 12)
            self.assertEqual(len(manifest), 12)
            self.assertEqual({row["split"] for row in manifest}, {"train", "validation", "test"})
            self.assertEqual({row["documentType"] for row in manifest}, {"receipt", "invoice"})
            self.assertEqual(
                {row["variant"] for row in manifest},
                {"clean", "thermal", "scanned", "noisy", "rotated", "blurred", "cropped"},
            )
            self.assertTrue(all((root / row["image"]).exists() for row in manifest))
            self.assertTrue(all(row["fields"]["total"].endswith("TL") for row in manifest))
            self.assertTrue(all(row["lineItems"] for row in manifest))
            self.assertTrue(all(row["blocks"][0]["bbox"] for row in manifest))
            self.assertTrue(all("ARA TOPLAM" in row["text"] for row in manifest))

    def test_document_dataset_cli_supports_profiles_and_clean(self) -> None:
        generated_parent = Path.cwd() / "data" / "generated"
        generated_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=generated_parent) as temp_dir:
            root = Path(temp_dir) / "synthetic"
            with redirect_stdout(StringIO()):
                result = run_cli(["--output-dir", str(root), "--profile", "tiny", "--mode", "documents", "--seed", "55"])
            self.assertEqual(result, 0)
            manifest = root / "document_manifest.jsonl"
            self.assertTrue(manifest.exists())
            self.assertEqual(len([line for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]), 12)

            self.assertEqual(run_cli(["--output-dir", str(root), "--clean"]), 0)
            self.assertFalse(root.exists())

    def test_dataset_cli_supports_character_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "characters"
            with redirect_stdout(StringIO()) as stdout:
                result = run_cli(["--output-dir", str(root), "--profile", "tiny", "--mode", "characters", "--seed", "57"])

            self.assertEqual(result, 0)
            payload = json.loads(stdout.getvalue())
            self.assertEqual(payload["mode"], "characters")
            self.assertEqual(payload["manifest"], "character_manifest.jsonl")
            self.assertTrue((root / "character_manifest.jsonl").exists())

    def test_document_dataset_cli_refuses_clean_outside_generated_artifact_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "not-generated"
            root.mkdir()
            sentinel = root / "sentinel.txt"
            sentinel.write_text("keep", encoding="utf-8")

            with self.assertRaises(SystemExit) as raised:
                run_cli(["--output-dir", str(root), "--clean"])

            self.assertIn("--clean only removes", str(raised.exception))
            self.assertTrue(sentinel.exists())

    def test_correction_export_import_writes_training_manifest_with_optional_anonymization(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            export = root / "dataset-export.jsonl"
            export.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "document": {
                            "id": "doc_1",
                            "kind": "RECEIPT",
                            "safeName": "market-fis.png",
                            "mimeType": "image/png",
                            "sha256": "abc123",
                            "bucket": "documents",
                            "objectKey": "tenants/t1/documents/doc_1.png",
                        },
                        "labels": [
                            {
                                "label": "ocr_full_text",
                                "payload": {
                                    "engine": "CUSTOM_CRNN",
                                    "modelVersion": "custom-crnn-v1",
                                    "previousOcrText": "TOPLAM 95,00 TL",
                                },
                            }
                        ],
                        "corrections": [
                            {"fieldName": "ocr_text", "beforeValue": "TOPLAM 95,00 TL", "afterValue": "TOPLAM 100,00 TL"},
                            {"fieldName": "total", "beforeValue": "95,00", "afterValue": "100,00"},
                        ],
                        "activeLearningSuggestions": [
                            {"reasonCode": "HUMAN_CORRECTION", "score": "1.000000", "payload": {"field": "total"}}
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )

            samples = import_correction_dataset(export, root / "corrections")

            self.assertEqual(len(samples), 1)
            self.assertEqual(samples[0].corrected_text, "TOPLAM 100,00 TL")
            self.assertEqual(samples[0].corrected_fields["total"], "100,00")
            manifest_rows = [
                json.loads(line)
                for line in (root / "corrections" / "correction_manifest.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(manifest_rows[0]["source"], "review_dataset_export")
            self.assertEqual(manifest_rows[0]["image"]["objectKey"], "tenants/t1/documents/doc_1.png")
            self.assertEqual(manifest_rows[0]["labels"][0]["payload"]["engine"], "CUSTOM_CRNN")
            self.assertEqual(manifest_rows[0]["activeLearningSuggestions"][0]["reasonCode"], "HUMAN_CORRECTION")

            anonymized = import_correction_dataset(export, root / "anonymous-corrections", anonymize=True)
            self.assertEqual(anonymized[0].corrected_fields["total"], "000,00")
            self.assertEqual(anonymized[0].corrected_text, "XXXXXX 000,00 XX")

    def test_crnn_forward_shape_and_ctc_loss_are_valid(self) -> None:
        model = CRNNOCR(num_classes=len(VOCAB), hidden_size=16)
        high_resolution_model = CRNNOCR(num_classes=len(VOCAB), hidden_size=16, temporal_downsample=2)
        images = torch.rand(2, 1, 64, 384)
        log_probs = model(images)
        length_aware_log_probs = model(images, torch.tensor([96, 80], dtype=torch.long))
        high_resolution_log_probs = high_resolution_model(images)

        self.assertEqual(log_probs.ndim, 3)
        self.assertEqual(log_probs.shape[1], 2)
        self.assertEqual(log_probs.shape[2], len(VOCAB))
        self.assertEqual(length_aware_log_probs.shape, log_probs.shape)
        self.assertTrue(torch.isfinite(length_aware_log_probs).all())
        self.assertEqual(high_resolution_log_probs.shape[0], log_probs.shape[0] * 2)

        targets = torch.tensor(encode("TOPLAM") + encode("MARKET"), dtype=torch.long)
        target_lengths = torch.tensor([6, 6], dtype=torch.long)
        input_lengths = torch.full(size=(2,), fill_value=log_probs.size(0), dtype=torch.long)
        loss = nn.CTCLoss(blank=0, zero_infinity=True)(log_probs, targets, input_lengths, target_lengths)
        self.assertTrue(torch.isfinite(loss))

    def test_training_dataset_collate_shapes_match_model_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            generate_dataset(data_dir, count=8, seed=42)
            dataset = LineDataset(data_dir / "manifest.jsonl", data_dir)
            batch = collate([dataset[0], dataset[1]])

            images, targets, lengths, input_lengths = batch
            self.assertEqual(images.shape[0:3], (2, 1, 64))
            self.assertGreaterEqual(images.shape[3], 384)
            self.assertEqual(targets.ndim, 1)
            self.assertEqual(lengths.tolist(), [len(dataset[0][1]), len(dataset[1][1])])
            self.assertEqual(input_lengths.tolist(), [dataset[0][3], dataset[1][3]])
            self.assertTrue(all(length <= input_length for length, input_length in zip(lengths.tolist(), input_lengths.tolist(), strict=True)))

    def test_training_collate_pads_dynamic_line_widths_and_validates_ctc_lengths(self) -> None:
        short = torch.ones(1, 64, 128)
        long = torch.ones(1, 64, 512)
        short_target = torch.tensor(encode("KISA"), dtype=torch.long)
        long_target = torch.tensor(encode("UZUN SATIR"), dtype=torch.long)

        images, targets, target_lengths, input_lengths = collate(
            [
                (short, short_target, len(short_target), ctc_input_length_for_width(short.shape[2])),
                (long, long_target, len(long_target), ctc_input_length_for_width(long.shape[2])),
            ]
        )

        self.assertEqual(images.shape, (2, 1, 64, 512))
        self.assertEqual(targets.ndim, 1)
        self.assertEqual(target_lengths.tolist(), [4, 10])
        self.assertEqual(input_lengths.tolist(), [32, 128])
        self.assertTrue(torch.allclose(images[0, :, :, 128:], torch.full((1, 64, 384), 245 / 255.0)))

        with self.assertRaises(ValueError):
            collate([(short, torch.ones(40, dtype=torch.long), 40, ctc_input_length_for_width(short.shape[2]))])

    def test_cropped_document_line_preparation_preserves_stroke_scale(self) -> None:
        crop = Image.new("L", (150, 24), color=245)
        ImageDraw.Draw(crop).rectangle((8, 8, 142, 17), fill=20)

        prepared = prepare_cropped_line_image(crop)
        pixels = prepared.load()
        dark_rows = [
            y
            for y in range(prepared.height)
            if any(pixels[x, y] < 128 for x in range(prepared.width))
        ]

        self.assertEqual(prepared.size, (384, 64))
        self.assertLessEqual(max(dark_rows) - min(dark_rows) + 1, 12)

    def test_long_cropped_line_uses_overlapping_windows_without_destructive_squeeze(self) -> None:
        crop = Image.new("L", (1800, 32), color=245)
        ImageDraw.Draw(crop).rectangle((20, 10, 1780, 21), fill=20)

        windows = prepare_cropped_line_windows(crop)
        dark_heights = []
        for window in windows:
            pixels = window.load()
            dark_rows = [
                y
                for y in range(window.height)
                if any(pixels[x, y] < 128 for x in range(window.width))
            ]
            dark_heights.append(max(dark_rows) - min(dark_rows) + 1)

        self.assertGreater(len(windows), 1)
        self.assertTrue(all(window.size == (768, 64) for window in windows))
        self.assertTrue(all(height >= 10 for height in dark_heights))

    def test_sliding_window_text_merge_removes_character_and_token_overlap(self) -> None:
        self.assertEqual(
            _merge_overlapping_prediction_text("UZUN FATURA SATIRI TOPLAM", "SATIRI TOPLAM 1.234,56 TL"),
            "UZUN FATURA SATIRI TOPLAM 1.234,56 TL",
        )
        self.assertEqual(_merge_overlapping_prediction_text("SPENDLENS MAR", "MARKET"), "SPENDLENS MARKET")

    def test_long_line_challenger_requires_calibrated_gain_and_preserves_amounts(self) -> None:
        champion = CustomOcrPrediction(text="FATURA TOPLAM 1.234,56 TL", confidence=0.42)
        useful = CustomOcrPrediction(
            text="UZUN E ARSIV FATURA SATIRI GENEL TOPLAM 1.234,56 TL",
            confidence=0.61,
        )
        lower_confidence = CustomOcrPrediction(
            text="UZUN E ARSIV FATURA SATIRI GENEL TOPLAM 1.234,56 TL",
            confidence=0.45,
        )
        conflicting_amount = CustomOcrPrediction(
            text="UZUN E ARSIV FATURA SATIRI GENEL TOPLAM 1.284,56 TL",
            confidence=0.72,
        )

        self.assertTrue(_should_use_long_line_challenger(champion, useful))
        self.assertFalse(_should_use_long_line_challenger(champion, lower_confidence))
        self.assertFalse(_should_use_long_line_challenger(champion, conflicting_amount))

    def test_fourier_fallback_cannot_replace_meaningful_crnn_with_conflicting_or_weak_text(self) -> None:
        self.assertFalse(_should_use_fourier_line_prediction("TOPLAM 64,50 TL", 0.42, "TOPLAM 84,50 TL", 0.92))
        self.assertFalse(_should_use_fourier_line_prediction("SPENDLENS MARKET", 0.48, "MAVI KIR", 0.62))
        self.assertTrue(_should_use_fourier_line_prediction("", 0.0, "FİŞ NO 12345", 0.45))

    def test_real_fixture_and_ocrturk_rows_use_cropped_line_preparation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            crop = Image.new("L", (150, 24), color=245)
            ImageDraw.Draw(crop).rectangle((8, 8, 142, 17), fill=20)
            crop.save(root / "line.png")
            for source in ("project_fixture_real_crop", "OCRTurk"):
                (root / "manifest.jsonl").write_text(
                    json.dumps({"image": "line.png", "text": "TOPLAM", "split": "train", "source": source}),
                    encoding="utf-8",
                )
                tensor, _target, _target_length, _input_length = LineDataset(
                    root / "manifest.jsonl",
                    root,
                )[0]
                dark_rows = [
                    y
                    for y in range(tensor.shape[1])
                    if bool((tensor[0, y, :] < (128 / 255.0)).any())
                ]

                self.assertEqual(tensor.shape[2], 384)
                self.assertLessEqual(max(dark_rows) - min(dark_rows) + 1, 12)

    def test_crnn_training_writes_validation_metrics_and_best_checkpoint_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            metrics = train_custom_ocr_model(
                data_dir=root / "data",
                artifact_dir=root / "artifact",
                samples=8,
                epochs=1,
                seed=99,
                profile="local_full",
                batch_size=2,
                learning_rate=5e-4,
                early_stopping_patience=2,
                field_oversample_factor=2.5,
            )

            self.assertEqual(metrics["epochs"], 1)
            self.assertEqual(metrics["completedEpochs"], 1)
            self.assertEqual(metrics["batchSize"], 2)
            self.assertEqual(metrics["learningRate"], 5e-4)
            self.assertEqual(metrics["earlyStoppingPatience"], 2)
            self.assertFalse(metrics["stoppedEarly"])
            self.assertIsNone(metrics["resumeFrom"])
            self.assertIsNone(metrics["resumeFromModelVersion"])
            self.assertGreater(metrics["trainSamples"], 0)
            self.assertGreater(metrics["validationSamples"], 0)
            self.assertIn("bestValidationCer", metrics)
            self.assertEqual(metrics["profile"], "local_full")
            self.assertEqual(metrics["datasetMode"], "lines")
            self.assertEqual(metrics["fieldOversampleFactor"], 2.5)
            self.assertEqual(metrics["temporalDownsample"], 4)
            self.assertEqual(metrics["blankRegularization"], 0.0)
            self.assertFalse(metrics["fieldOnlyTraining"])
            self.assertEqual(metrics["model_version"], "custom-crnn-local-full-seed-99")
            self.assertIn("Local full", metrics["accuracy_note"])
            self.assertIn("finalValidation", metrics)
            self.assertIn("averageWer", metrics["finalValidation"])
            self.assertIn("turkishSpecialCharacterAccuracy", metrics["finalValidation"])
            self.assertEqual(metrics["validationHistory"][0]["epoch"], 1)
            checkpoint = torch.load(root / "artifact" / "model.pt", map_location="cpu")
            self.assertEqual(checkpoint["metadata"]["profile"], "local_full")
            self.assertEqual(checkpoint["metadata"]["dataset_mode"], "lines")
            self.assertEqual(checkpoint["metadata"]["model_version"], metrics["model_version"])
            self.assertEqual(checkpoint["metadata"]["metrics"]["bestEpoch"], metrics["bestEpoch"])
            self.assertEqual(checkpoint["metadata"]["metrics"]["bestValidationCer"], metrics["bestValidationCer"])
            self.assertEqual(checkpoint["metadata"]["metrics"]["batchSize"], 2)
            self.assertEqual(checkpoint["metadata"]["metrics"]["learningRate"], 5e-4)
            self.assertEqual(checkpoint["metadata"]["metrics"]["earlyStoppingPatience"], 2)
            self.assertEqual(checkpoint["metadata"]["metrics"]["fieldOversampleFactor"], 2.5)
            self.assertEqual(checkpoint["metadata"]["temporal_downsample"], 4)
            self.assertEqual(checkpoint["metadata"]["architecture_version"], "crnn-ctc-v3-length-aware")
            self.assertEqual(checkpoint["metadata"]["decoder_blank_penalty"], 0.5)
            self.assertEqual(checkpoint["metadata"]["metrics"]["blankRegularization"], 0.0)
            self.assertFalse(checkpoint["metadata"]["metrics"]["fieldOnlyTraining"])
            self.assertIsNone(checkpoint["metadata"]["metrics"]["initialValidation"])
            registry_path = Path(metrics["registryPath"])
            self.assertTrue(registry_path.exists())
            self.assertEqual(metrics["registryEntry"]["model_code"], "CUSTOM_CRNN")
            self.assertEqual(metrics["registryEntry"]["version"], metrics["model_version"])
            self.assertEqual(metrics["registryEntry"]["vocabulary_version"], VOCAB_VERSION)
            self.assertEqual(metrics["registryEntry"]["status"], "CANDIDATE")
            ready_model = find_ready_model(registry_path, "CUSTOM_CRNN")
            self.assertIsNone(ready_model)

    def test_residual_crnn_backbone_preserves_ctc_width_and_has_distinct_metadata(self) -> None:
        model = CRNNOCR(num_classes=len(VOCAB), temporal_downsample=2, backbone_version="residual")
        images = torch.zeros((2, 1, 64, 256), dtype=torch.float32)
        input_lengths = torch.tensor([128, 96], dtype=torch.long)

        output = model(images, input_lengths)

        self.assertEqual(tuple(output.shape), (128, 2, len(VOCAB)))
        self.assertEqual(model.backbone_version, "residual")
        self.assertTrue(torch.isfinite(output).all())

    def test_crnn_training_can_resume_from_existing_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = train_custom_ocr_model(
                data_dir=root / "data",
                artifact_dir=root / "artifact-initial",
                samples=8,
                epochs=1,
                seed=101,
                profile="local_full",
                batch_size=2,
            )
            resumed = train_custom_ocr_model(
                data_dir=root / "data",
                artifact_dir=root / "artifact-resumed",
                samples=8,
                epochs=1,
                seed=102,
                profile="local_full",
                batch_size=2,
                resume_from=root / "artifact-initial" / "model.pt",
            )

            self.assertEqual(resumed["resumeFrom"], str(root / "artifact-initial" / "model.pt"))
            self.assertEqual(resumed["resumeFromModelVersion"], first["model_version"])
            self.assertIn("resume-artifact-initial", resumed["model_version"])
            self.assertIsNotNone(resumed["initialValidation"])
            checkpoint = torch.load(root / "artifact-resumed" / "model.pt", map_location="cpu")
            self.assertEqual(checkpoint["metadata"]["resumeFrom"], str(root / "artifact-initial" / "model.pt"))
            self.assertEqual(checkpoint["metadata"]["resumeFromModelVersion"], first["model_version"])
            self.assertEqual(checkpoint["metadata"]["metrics"]["initialValidation"], resumed["initialValidation"])
            self.assertEqual(resumed["registryEntry"]["artifact_path"], str(root / "artifact-resumed" / "model.pt"))

            with self.assertRaisesRegex(ValueError, "temporal downsample"):
                train_custom_ocr_model(
                    data_dir=root / "data-v2-mismatch",
                    artifact_dir=root / "artifact-v2-mismatch",
                    samples=8,
                    epochs=1,
                    seed=103,
                    profile="local_full",
                    batch_size=2,
                    resume_from=root / "artifact-initial" / "model.pt",
                    temporal_downsample=2,
                )

    def test_crnn_training_rejects_invalid_training_parameters(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with self.assertRaises(ValueError):
                train_custom_ocr_model(root / "data-a", root / "artifact-a", batch_size=0)
            with self.assertRaises(ValueError):
                train_custom_ocr_model(root / "data-b", root / "artifact-b", learning_rate=0)
            with self.assertRaises(ValueError):
                train_custom_ocr_model(root / "data-c", root / "artifact-c", early_stopping_patience=-1)
            with self.assertRaises(ValueError):
                train_custom_ocr_model(root / "data-d", root / "artifact-d", field_oversample_factor=0.5)
            with self.assertRaises(ValueError):
                train_custom_ocr_model(root / "data-e", root / "artifact-e", temporal_downsample=3)
            with self.assertRaises(ValueError):
                train_custom_ocr_model(root / "data-e2", root / "artifact-e2", backbone_version="unknown")
            with self.assertRaises(ValueError):
                train_custom_ocr_model(root / "data-e3", root / "artifact-e3", line_image_min_width=32)
            with self.assertRaises(ValueError):
                train_custom_ocr_model(root / "data-f", root / "artifact-f", blank_regularization=-0.01)
            with self.assertRaises(ValueError):
                train_custom_ocr_model(root / "data-f2", root / "artifact-f2", validation_blank_penalty=6.0)
            with self.assertRaises(ValueError):
                train_custom_ocr_model(root / "data-g", root / "artifact-g", validation_scope="unknown")

    def test_crnn_field_only_training_filters_only_the_train_split(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            metrics = train_custom_ocr_model(
                data_dir=root / "data",
                artifact_dir=root / "artifact",
                samples=32,
                epochs=1,
                seed=104,
                profile="tiny",
                batch_size=2,
                dataset_mode="document_lines",
                field_only_training=True,
            )

            self.assertTrue(metrics["fieldOnlyTraining"])
            self.assertLess(metrics["trainSamples"], 22)
            self.assertGreater(metrics["validationSamples"], 0)

    def test_crnn_field_validation_scope_selects_checkpoint_on_field_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            metrics = train_custom_ocr_model(
                data_dir=root / "data",
                artifact_dir=root / "artifact",
                samples=64,
                epochs=1,
                seed=105,
                profile="tiny",
                batch_size=2,
                dataset_mode="document_lines",
                field_only_training=True,
                validation_scope="fields",
            )

            self.assertEqual(metrics["validationScope"], "fields")
            self.assertLess(metrics["selectionValidationSamples"], metrics["validationSamples"])
            self.assertEqual(metrics["bestValidationCer"], metrics["selectionValidation"]["averageCer"])
            self.assertEqual(metrics["validationHistory"][0]["validationScope"], "fields")
            checkpoint = torch.load(root / "artifact" / "model.pt", map_location="cpu")
            checkpoint_metrics = checkpoint["metadata"]["metrics"]
            self.assertEqual(checkpoint_metrics["validationScope"], "fields")
            self.assertEqual(checkpoint_metrics["selectionValidation"], metrics["selectionValidation"])

    def test_crnn_can_reuse_existing_dataset_without_regenerating_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "data"
            generate_document_line_dataset(data_dir, count=32, seed=106)
            manifest = data_dir / "manifest.jsonl"
            before = manifest.read_bytes()

            metrics = train_custom_ocr_model(
                data_dir=data_dir,
                artifact_dir=root / "artifact",
                samples=999,
                epochs=1,
                seed=107,
                profile="tiny",
                batch_size=2,
                dataset_mode="document_lines",
                reuse_existing_dataset=True,
            )

            self.assertTrue(metrics["datasetReused"])
            self.assertEqual(manifest.read_bytes(), before)
            checkpoint = torch.load(root / "artifact" / "model.pt", map_location="cpu")
            self.assertTrue(checkpoint["metadata"]["metrics"]["datasetReused"])

            with self.assertRaises(FileNotFoundError):
                train_custom_ocr_model(
                    data_dir=root / "missing",
                    artifact_dir=root / "missing-artifact",
                    reuse_existing_dataset=True,
                )

    def test_key_field_lines_can_be_oversampled_without_changing_other_rows(self) -> None:
        rows = [
            {"text": "MAVI MARKET"},
            {"text": "TARİH 18.05.2026"},
            {"text": "ARA TOPLAM 900,00 TL"},
            {"text": "TOPLAM 1031,07 TL"},
            {"text": "ODEME NAKİT"},
        ]

        self.assertEqual(field_line_sample_weights(rows, 1.0), [1.0, 1.0, 1.0, 1.0, 1.0])
        self.assertEqual(field_line_sample_weights(rows, 3.0), [1.0, 3.0, 3.0, 3.0, 1.0])
        self.assertTrue(is_key_field_line({"text": "KDV 180,00 TL"}))
        self.assertFalse(is_key_field_line({"text": "ODEME KART"}))

    def test_task_balanced_sampling_prioritizes_real_turkish_finance_hardcases(self) -> None:
        rows = [
            {"source": "CORD", "text": "PLAIN ITEM"},
            {
                "source": "OCRTurk",
                "text": "FİŞ NO 12345 TOPLAM 1.234,56 TL",
                "hardcaseReasons": ["turkish_special_character", "amount_or_decimal_comma"],
                "hardcaseWeight": 2,
            },
            {"source": "OCRTurk", "text": "30 EYLÜL 2025 TARİHİNDE SONA EREN DÖNEME İLİŞKİN UZUN SATIR"},
        ]

        weights = task_balanced_sample_weights(
            rows,
            field_oversample_factor=2.0,
            source_weights={"OCRTurk": 1.5},
            task_weights={"amount": 1.4, "turkish_special": 1.5, "hardcase": 1.2, "long_line": 1.3},
        )

        self.assertEqual(weights[0], 1.0)
        self.assertEqual(weights[1], 8.0)
        self.assertGreater(weights[2], weights[0])
        self.assertEqual(
            set(line_task_labels(rows[1])),
            {"amount", "hardcase", "identifier", "key_field", "turkish_special"},
        )

    def test_ctc_required_length_accounts_for_adjacent_repeated_characters(self) -> None:
        target = torch.tensor(encode("FİŞ NO 100,00 TL"), dtype=torch.long)

        required = ctc_required_input_length(target)

        self.assertGreater(required, len(target))
        with self.assertRaisesRegex(ValueError, "repeated-character separators"):
            collate([(torch.zeros((1, 64, required - 1)), target, len(target), required - 1)])

    def test_checkpoint_selection_is_multi_objective_and_penalizes_worst_source_regression(self) -> None:
        balanced = {
            "averageCer": 0.22,
            "tokenF1": 0.78,
            "turkishSpecialCharacterF1": 0.93,
            "amountF1": 0.88,
            "exactMatchRate": 0.42,
            "bySource": {"OCRTurk": {"averageCer": 0.28}, "project": {"averageCer": 0.18}},
        }
        cer_only_gain = {
            **balanced,
            "averageCer": 0.20,
            "tokenF1": 0.60,
            "turkishSpecialCharacterF1": 0.72,
            "amountF1": 0.55,
            "bySource": {"OCRTurk": {"averageCer": 0.18}, "project": {"averageCer": 0.62}},
        }

        self.assertGreater(_checkpoint_selection_score(balanced), _checkpoint_selection_score(cer_only_gain))

    def test_benchmark_field_metrics_use_true_positive_false_positive_and_false_negative_counts(self) -> None:
        prediction = "\n".join(
            [
                "SPENDLENS MARKET",
                "FİŞ NO 12345",
                "TARİH 02.06.2026",
                "KDV 10,00 TL",
                "GENEL TOPLAM 72,05 TL",
                "ÖDEME KART",
            ]
        )
        predicted_fields = _extract_structured_fields(prediction, "receipt")
        matches, counts = _evaluate_structured_fields(
            {
                "merchant": "SPENDLENS MARKET",
                "date": "2026-06-02",
                "total": "72.05",
                "currency": "TRY",
                "paymentMethod": "KART",
                "tax": None,
            },
            predicted_fields,
        )

        self.assertTrue(all(matches[field] for field in ("merchant", "date", "total", "currency", "paymentMethod")))
        self.assertEqual(counts["tax"], {"tp": 0, "fp": 1, "fn": 0})
        metrics = _field_micro_metrics([SimpleNamespace(field_counts=counts)])
        self.assertEqual(metrics["fieldTruePositive"], 5)
        self.assertEqual(metrics["fieldFalsePositive"], 1)
        self.assertEqual(metrics["fieldFalseNegative"], 0)
        self.assertNotEqual(metrics["fieldPrecision"], metrics["fieldRecall"])

        macro = _field_macro_metrics([SimpleNamespace(field_counts=counts)])
        self.assertAlmostEqual(macro["fieldMacroPrecision"], 5 / 6)
        self.assertAlmostEqual(macro["fieldMacroRecall"], 5 / 6)
        self.assertAlmostEqual(macro["fieldMacroF1"], 5 / 6)

    def test_benchmark_separates_reference_text_and_ocr_extraction_metrics(self) -> None:
        sample = BenchmarkSample(
            image_path=Path("receipt.png"),
            text="MAVI MARKET\nTARIH 02.06.2026\nTOPLAM 72,05 TL",
            split="test",
            document_type="receipt",
            fields={"merchant": "MAVI MARKET", "date": "2026-06-02", "total": "72,05", "currency": "TRY"},
        )
        reference_metrics = _reference_text_extraction_metrics([sample])
        predictions = _extract_structured_fields(sample.text, sample.document_type)
        matches, counts = _evaluate_structured_fields(sample.fields or {}, predictions)
        ocr_metrics = _extraction_metrics(
            [
                PredictionRow(
                    engine="CUSTOM_CRNN",
                    image="receipt.png",
                    document_type="receipt",
                    reference=sample.text,
                    prediction=sample.text,
                    confidence=0.9,
                    latency_ms=1.0,
                    error_code=None,
                    field_matches=matches,
                    field_predictions=predictions,
                    field_counts=counts,
                )
            ]
        )

        self.assertEqual(reference_metrics["fieldF1"], 1.0)
        self.assertEqual(reference_metrics["fieldMacroF1"], 1.0)
        self.assertEqual(ocr_metrics["fieldF1"], 1.0)
        self.assertEqual(ocr_metrics["fieldMacroF1"], 1.0)

    def test_benchmark_line_item_metrics_require_description_and_amount(self) -> None:
        references = (
            {"description": "SÜT", "amount": "32.50"},
            {"description": "KAHVE", "amount": "12.00"},
        )
        predictions = _extract_line_items("SÜT %10 32,50 TL\nKAHVE %20 11,00 TL\nÇAY 12,00 TL")
        counts = _evaluate_line_items(references, predictions)

        self.assertEqual(counts, {"tp": 1, "fp": 2, "fn": 1})
        metrics = _line_item_metrics([SimpleNamespace(line_item_counts=counts)])
        self.assertEqual(metrics["lineItemPrecision"], 1 / 3)
        self.assertEqual(metrics["lineItemRecall"], 1 / 2)
        self.assertAlmostEqual(metrics["lineItemF1"], 0.4)

    def test_benchmark_line_item_parser_removes_vat_and_quantity_evidence(self) -> None:
        items = _extract_line_items(
            "SÜT %10 2 x 16,25 TL 32,50 TL\nOfis kırtasiye 1 %20 420,00 TL\nGENEL TOPLAM 452,50 TL"
        )

        self.assertEqual(
            items,
            [
                {"description": "SÜT", "amount": "3250"},
                {"description": "Ofis kırtasiye", "amount": "42000"},
            ],
        )

    def test_benchmark_structured_fields_prefer_labeled_invoice_seller(self) -> None:
        fields = _extract_structured_fields(
            "SPENDLENS FATURA SANDBOX\nSATICI: SPENDLENS MARKET SANDBOX\nGENEL TOPLAM 600,00 TL",
            "invoice",
        )

        self.assertEqual(fields["merchant"], "SPENDLENS MARKET SANDBOX")

    def test_benchmark_structured_fields_reconcile_missing_or_implausible_total(self) -> None:
        repaired = _extract_structured_fields(
            "SPENDLENS FATURA\nARA TOPLAM 500,00 TL\nKDV 100,00 TL\nGENEL TOPLAM 00,0 TL",
            "invoice",
        )
        conflicting = _extract_structured_fields(
            "SPENDLENS FATURA\nARA TOPLAM 500,00 TL\nKDV 100,00 TL\nGENEL TOPLAM 700,00 TL",
            "invoice",
        )

        self.assertEqual(repaired["total"], "60000")
        self.assertEqual(conflicting["total"], "70000")

    def test_benchmark_confidence_metrics_report_calibration_and_risk_coverage(self) -> None:
        rows = [
            PredictionRow("CUSTOM_CRNN", "a", "receipt", "TOPLAM 10,00", "TOPLAM 10,00", 0.9, 1.0, None),
            PredictionRow("CUSTOM_CRNN", "b", "receipt", "TARİH 01.01.2026", "GARBAGE", 0.8, 1.0, None),
            PredictionRow("CUSTOM_CRNN", "c", "receipt", "KDV 2,00", "KDV 2,00", 0.6, 1.0, None),
            PredictionRow("CUSTOM_CRNN", "d", "receipt", "MARKET", "", 0.2, 1.0, None),
        ]

        metrics = _confidence_calibration_metrics(rows)

        self.assertEqual(len(metrics["confidenceCalibrationBuckets"]), 4)
        self.assertEqual(len(metrics["riskCoverage"]), 4)
        self.assertGreater(metrics["expectedCalibrationError"], 0)
        self.assertGreater(metrics["brierScore"], 0)

    def test_ctc_prediction_returns_calibrated_confidence(self) -> None:
        class_count = len(VOCAB)
        blank = 0
        a_index = VOCAB.index("A")
        b_index = VOCAB.index("B")

        def timestep(index: int, probability: float) -> torch.Tensor:
            row = torch.full((class_count,), (1.0 - probability) / (class_count - 1), dtype=torch.float32)
            row[index] = probability
            return row

        probabilities = torch.stack(
            [
                timestep(a_index, 0.94),
                timestep(a_index, 0.91),
                timestep(blank, 0.88),
                timestep(b_index, 0.92),
            ]
        ).unsqueeze(1)

        prediction = decode_ctc_prediction(probabilities.log())

        self.assertEqual(prediction.text, "AB")
        self.assertGreater(prediction.confidence, 0.8)
        self.assertLessEqual(prediction.confidence, 1.0)

    def test_character_line_assist_rejects_amount_conflicts(self) -> None:
        better_text = SimpleNamespace(text="KDV 100,00TL", confidence=0.99)
        conflicting_amount = SimpleNamespace(text="ARA TOPLAM 61,S0 TL", confidence=0.96)
        trusted_field_amount = SimpleNamespace(text="ARA TOPLAM 500,00 TL", confidence=0.97)

        self.assertTrue(_should_use_character_line_prediction("1110,0 TL", 0.57, better_text, 0.94))
        self.assertFalse(_should_use_character_line_prediction("ARA TOPLAM 64,50 TL", 1.0, conflicting_amount, 0.94))
        self.assertTrue(
            _should_use_character_line_prediction(
                "ARA OPA 0,00 TL",
                0.84,
                SimpleNamespace(text="ARATOPVM 000,00 TL", confidence=0.92),
                0.86,
                allow_numeric_arbitration=True,
            )
        )
        self.assertTrue(_should_use_character_line_prediction("ARA OPA 50,00 TL", 0.62, trusted_field_amount, 0.94))

    def test_ctc_prediction_penalizes_under_emitted_text(self) -> None:
        class_count = len(VOCAB)
        blank = 0
        a_index = VOCAB.index("A")
        b_index = VOCAB.index("B")

        def timestep(index: int, probability: float) -> torch.Tensor:
            row = torch.full((class_count,), (1.0 - probability) / (class_count - 1), dtype=torch.float32)
            row[index] = probability
            return row

        rows = [timestep(blank, 0.98) for _ in range(24)]
        rows[5] = timestep(a_index, 0.94)
        rows[18] = timestep(b_index, 0.93)
        probabilities = torch.stack(rows).unsqueeze(1)

        prediction = decode_ctc_prediction(probabilities.log(), method="greedy")

        self.assertEqual(prediction.text, "AB")
        self.assertLess(prediction.confidence, 0.35)

    def test_ctc_prediction_reports_zero_confidence_for_blank_output(self) -> None:
        class_count = len(VOCAB)
        probabilities = torch.full((3, 1, class_count), 0.01 / (class_count - 1), dtype=torch.float32)
        probabilities[:, :, 0] = 0.99

        prediction = decode_ctc_prediction(probabilities.log())

        self.assertEqual(prediction.text, "")
        self.assertEqual(prediction.confidence, 0.0)

    def test_ctc_prediction_reports_zero_confidence_for_whitespace_only_output(self) -> None:
        class_count = len(VOCAB)
        space_index = VOCAB.index(" ")
        probabilities = torch.full((3, 1, class_count), 0.01 / (class_count - 1), dtype=torch.float32)
        probabilities[:, :, space_index] = 0.99

        greedy_prediction = decode_ctc_prediction(probabilities.log(), method="greedy")
        beam_prediction = decode_ctc_prediction(probabilities.log(), method="beam", beam_width=4)

        self.assertEqual(greedy_prediction.text, " ")
        self.assertEqual(greedy_prediction.confidence, 0.0)
        self.assertEqual(beam_prediction.text, " ")
        self.assertEqual(beam_prediction.confidence, 0.0)

    def test_ctc_blank_penalty_can_reduce_overblanking(self) -> None:
        class_count = len(VOCAB)
        digit_index = VOCAB.index("0")
        probabilities = torch.full((1, 1, class_count), 0.02 / (class_count - 2), dtype=torch.float32)
        probabilities[:, :, 0] = 0.55
        probabilities[:, :, digit_index] = 0.43

        default_prediction = decode_ctc_prediction(probabilities.log(), method="greedy")
        penalized_prediction = decode_ctc_prediction(probabilities.log(), method="greedy", blank_penalty=0.5)

        self.assertEqual(default_prediction.text, "")
        self.assertEqual(penalized_prediction.text, "0")

    def test_checkpoint_decoder_blank_penalty_is_used_unless_explicitly_overridden(self) -> None:
        self.assertEqual(_decoder_blank_penalty_from_metadata({"decoder_blank_penalty": 2.0}, None), 2.0)
        self.assertEqual(_decoder_blank_penalty_from_metadata({"decoder_blank_penalty": 2.0}, 0.75), 0.75)
        self.assertEqual(_decoder_blank_penalty_from_metadata({}, None), 0.5)

    def test_crnn_challenger_shadow_mode_preserves_champion_and_scores_both_candidates(self) -> None:
        champion = CustomOcrPrediction(text="MEVCUT METIN", confidence=0.2)
        challenger = CustomOcrPrediction(text="DAHA UZUN VE ANLAMLI BIR METIN", confidence=0.8)

        selected, reason, scores = _select_crnn_challenger(
            champion,
            challenger,
            line_role="general_text",
            aspect_ratio=12.0,
            mode="shadow",
        )

        self.assertFalse(selected)
        self.assertEqual(reason, "shadow_evaluation_only")
        self.assertIn("score", scores["champion"])
        self.assertIn("score", scores["challenger"])

    def test_crnn_challenger_validated_mode_routes_only_safe_long_general_lines(self) -> None:
        champion = CustomOcrPrediction(text="KISA", confidence=0.08)
        challenger = CustomOcrPrediction(text="UZUN VE TUTARLI GENEL METIN", confidence=0.55)

        selected, reason, _scores = _select_crnn_challenger(
            champion,
            challenger,
            line_role="general_text",
            aspect_ratio=8.0,
            mode="validated",
        )
        protected, protected_reason, _protected_scores = _select_crnn_challenger(
            CustomOcrPrediction(text="TOPLAM 22,23 TL", confidence=0.1),
            CustomOcrPrediction(text="TOPLAM 72,05 TL", confidence=0.9),
            line_role="amount_with_label",
            aspect_ratio=8.0,
            mode="validated",
        )

        self.assertTrue(selected)
        self.assertEqual(reason, "validated_long_line_challenger_margin")
        self.assertFalse(protected)
        self.assertEqual(protected_reason, "champion_fallback_protected_role")

        numeric_evidence, numeric_reason, _numeric_scores = _select_crnn_challenger(
            CustomOcrPrediction(text="RN TOLA 0,0 TL", confidence=0.82),
            CustomOcrPrediction(text="AM OAM O,0 TL", confidence=0.73),
            line_role="general_text",
            aspect_ratio=12.0,
            mode="validated",
            route_evidence={"status": "SPECIALIST_ACTIVE"},
        )

        self.assertFalse(numeric_evidence)
        self.assertEqual(numeric_reason, "champion_fallback_numeric_evidence")

    def test_crnn_challenger_can_override_miscalibrated_champion_only_with_holdout_evidence(self) -> None:
        evidence = _validated_challenger_route_evidence(
            {
                "validated_specialist_routes": {
                    "long_general_text": {
                        "status": "SPECIALIST_ACTIVE",
                        "samples": 85,
                        "champion_cer": 0.93,
                        "challenger_cer": 0.71,
                        "regressions": 2,
                        "regression_rate": 2 / 85,
                        "significant_regressions": 0,
                        "benchmark_sha256": "a" * 64,
                    }
                }
            },
            "long_general_text",
        )
        selected, reason, _scores = _select_crnn_challenger(
            CustomOcrPrediction(text="YANLIS YUKSEK GUVENLI CHAMPION", confidence=0.91),
            CustomOcrPrediction(text="daha tutarlı uzun satır metni", confidence=0.08),
            line_role="general_text",
            aspect_ratio=10.0,
            mode="validated",
            route_evidence=evidence,
        )

        self.assertIsNotNone(evidence)
        self.assertTrue(selected)
        self.assertEqual(reason, "validated_holdout_long_line_specialist")

    def test_crnn_candidate_payload_preserves_raw_provenance_and_selection_reason(self) -> None:
        payload = _crnn_candidate_payload(
            source="crnn_challenger",
            prediction=CustomOcrPrediction(text="Çağrı MARKET", confidence=0.61, decoder="beam"),
            metadata={"model_version": "challenger-v1"},
            line_role=_infer_line_role("Çağrı MARKET"),
            selected=False,
            selection_reason="shadow_evaluation_only",
            latency_ms=12.5,
            candidate_scores={"score": 0.6},
        )

        self.assertEqual(payload["raw_text"], "Çağrı MARKET")
        self.assertEqual(payload["component_version"], "challenger-v1")
        self.assertEqual(payload["selection_reason"], "shadow_evaluation_only")
        self.assertEqual(payload["candidate_scores"], {"score": 0.6})

    def test_pipeline_bundle_metadata_versions_every_active_component(self) -> None:
        bundle = _pipeline_bundle_metadata(
            champion_metadata={"model_version": "champion-v1"},
            numeric_metadata={"modelVersion": "numeric-v1"},
            character_metadata={"modelVersion": "character-v1"},
            challenger_metadata={"model_version": "long-line-v1", "component_status": "SPECIALIST_ACTIVE"},
            challenger_mode="validated",
        )

        self.assertEqual(bundle["crnnChampion"], "champion-v1")
        self.assertEqual(bundle["crnnChallengers"], ["long-line-v1"])
        self.assertEqual(bundle["numericSpecialist"], "numeric-v1")
        self.assertEqual(bundle["characterSpecialist"], "character-v1")
        self.assertEqual(bundle["componentStatus"]["crnnChallenger"], "SPECIALIST_ACTIVE")
        self.assertEqual(bundle["challengerMode"], "validated")

    def test_ctc_beam_decoder_preserves_repeated_characters_separated_by_blank(self) -> None:
        class_count = len(VOCAB)
        blank = 0
        a_index = VOCAB.index("A")

        def timestep(index: int, probability: float) -> torch.Tensor:
            row = torch.full((class_count,), (1.0 - probability) / (class_count - 1), dtype=torch.float32)
            row[index] = probability
            return row

        probabilities = torch.stack(
            [
                timestep(a_index, 0.96),
                timestep(blank, 0.94),
                timestep(a_index, 0.95),
            ]
        ).unsqueeze(1)

        prediction = decode_ctc_prediction(probabilities.log(), method="beam", beam_width=4)

        self.assertEqual(prediction.text, "AA")
        self.assertEqual(prediction.decoder, "beam")
        self.assertGreater(prediction.confidence, 0.8)

    def test_ctc_decoder_rejects_unknown_method(self) -> None:
        class_count = len(VOCAB)
        probabilities = torch.full((2, 1, class_count), 1.0 / class_count, dtype=torch.float32)

        with self.assertRaises(ValueError):
            decode_ctc_prediction(probabilities.log(), method="unknown")

    def test_checkpoint_evaluation_writes_report_and_predictions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "data"
            artifact_dir = root / "artifact"
            artifact_dir.mkdir()
            generate_dataset(data_dir, count=10, seed=77)
            checkpoint = artifact_dir / "model.pt"
            model = CRNNOCR(num_classes=len(VOCAB))
            torch.save({"model_state": model.state_dict(), "vocab": VOCAB, "seed": 77}, checkpoint)

            report = evaluate_custom_ocr_checkpoint(
                checkpoint=checkpoint,
                data_dir=data_dir,
                split="test",
                report_path=artifact_dir / "evaluation.json",
                predictions_path=artifact_dir / "predictions.jsonl",
            )

            self.assertEqual(report["engine"], "CUSTOM_CRNN")
            self.assertEqual(report["decoder"]["method"], "beam")
            self.assertEqual(report["dataset"]["split"], "test")
            self.assertGreater(report["metrics"]["samples"], 0)
            self.assertGreaterEqual(report["metrics"]["averageCer"], 0)
            self.assertGreaterEqual(report["metrics"]["averageWer"], 0)
            self.assertTrue((artifact_dir / "evaluation.json").exists())
            predictions = [
                json.loads(line)
                for line in (artifact_dir / "predictions.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(predictions), report["metrics"]["samples"])
            self.assertTrue(all("confidence" in row for row in predictions))
            self.assertTrue(all(row["decoder"] == "beam" for row in predictions))
            self.assertIn("turkishSpecialCharacterAccuracy", report["metrics"])
            self.assertIn("turkishSpecialCharacterPrecision", report["metrics"])
            self.assertIn("turkishSpecialCharacterRecall", report["metrics"])
            self.assertIn("turkishSpecialCharacterF1", report["metrics"])
            self.assertIn("tokenPrecision", report["metrics"])
            self.assertIn("tokenRecall", report["metrics"])
            self.assertIn("tokenF1", report["metrics"])
            self.assertIn("sourceMix", report["metrics"])
            self.assertIn("bySource", report["metrics"])
            self.assertIn("characterConfusionMatrix", report["metrics"])
            self.assertIn("confidenceCalibrationBuckets", report["metrics"])
            self.assertIn("highConfidenceWrongCount", report["metrics"])

    def test_prediction_evaluation_reports_turkish_character_confusions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            predictions_path = Path(temp_dir) / "predictions.jsonl"
            rows = [
                {
                    "reference": "FİŞ TOPLAM 100,00 ₺",
                    "prediction": "FIS TOPLAM 100,00 TL",
                    "confidence": 0.64,
                    "cer": cer("FİŞ TOPLAM 100,00 ₺", "FIS TOPLAM 100,00 TL"),
                    "wer": wer("FİŞ TOPLAM 100,00 ₺", "FIS TOPLAM 100,00 TL"),
                    "exactMatch": False,
                },
                {
                    "reference": "ÖDEME KART",
                    "prediction": "ÖDEME KART",
                    "confidence": 0.93,
                    "cer": 0,
                    "wer": 0,
                    "exactMatch": True,
                },
                {
                    "reference": "TOPLAM 88,00 TL",
                    "prediction": "FD TL",
                    "confidence": 0.91,
                    "cer": cer("TOPLAM 88,00 TL", "FD TL"),
                    "wer": wer("TOPLAM 88,00 TL", "FD TL"),
                    "exactMatch": False,
                },
            ]
            predictions_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows), encoding="utf-8")

            metrics = evaluate_predictions(predictions_path)

            self.assertEqual(metrics["samples"], 3)
            self.assertGreater(metrics["turkishSpecialCharacterSupport"], 0)
            self.assertLess(metrics["turkishSpecialCharacterAccuracy"], 1)
            self.assertIn("turkishSpecialCharacterPrecision", metrics)
            self.assertIn("turkishSpecialCharacterRecall", metrics)
            self.assertIn("turkishSpecialCharacterF1", metrics)
            self.assertGreater(metrics["tokenRecall"], 0)
            self.assertGreater(metrics["tokenF1"], 0)
            self.assertIn(
                {"reference": "İ", "prediction": "I", "count": 1},
                metrics["characterConfusionMatrix"],
            )
            self.assertEqual(len(metrics["confidenceCalibrationBuckets"]), 4)
            self.assertEqual(metrics["highConfidenceWrongCount"], 1)

    def test_custom_benchmark_field_extraction_helpers_match_generated_fields(self) -> None:
        reference = {
            "merchant": "MAVI MARKET",
            "documentNo": "FIS-2026-00001",
            "date": "16.06.2026",
            "subtotal": "80,00 TL",
            "taxAmount": "8,00 TL",
            "total": "88,00 TL",
            "currency": "TRY",
            "paymentMethod": "KART",
        }
        predicted = _extract_generated_fields(
            "MAVI MARKET\nFİŞ NO FIS-2026-00001\nTARİH 16.06.2026\nARA TOPLAM 80,00 TL\nKDV 8,00 TL\nTOPLAM 88,00 TL\nÖDEME KART"
        )

        self.assertEqual(predicted["documentNo"], "FIS-2026-00001")
        self.assertEqual(predicted["currency"], "TRY")
        self.assertTrue(all(_field_matches(reference, predicted).values()))

    def test_custom_benchmark_writes_turkish_metrics_and_markdown_summary(self) -> None:
        class FakePrediction:
            text = "FIS NO 1\nTARIH 01.05.2026\nTOPLAM 100,00 TL"
            confidence = 0.62
            warnings = ["CUSTOM_OCR_LOW_CONFIDENCE"]

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with patch("services.ocr.custom_model.benchmark.infer_document", return_value=FakePrediction()):
                report = run_custom_benchmark(
                    output_dir=root / "benchmark",
                    checkpoint=root / "fake-model.pt",
                    profile="tiny",
                    samples=2,
                    seed=12,
                )

            custom = report["engines"]["CUSTOM_OCR"]
            self.assertEqual(report["decoder"]["method"], "beam")
            self.assertIn("turkishSpecialCharacterAccuracy", custom)
            self.assertIn("characterConfusionMatrix", custom)
            self.assertIn("fieldExtraction", custom)
            self.assertIn("perVariant", custom)
            self.assertTrue(custom["perVariant"])
            self.assertEqual(custom["warningCounts"], {"CUSTOM_OCR_LOW_CONFIDENCE": 2})
            self.assertEqual(custom["failureCounts"], {})
            self.assertGreater(custom["fieldExtraction"]["support"], 0)
            self.assertTrue((root / "benchmark" / "reports" / "custom-ocr-benchmark.json").exists())
            predictions = [
                json.loads(line)
                for line in (root / "benchmark" / "reports" / "custom-ocr-predictions.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertIn("referenceFields", predictions[0])
            self.assertIn("predictedFields", predictions[0])
            self.assertIn("fieldMatches", predictions[0])
            self.assertIn("variant", predictions[0])
            markdown = (root / "benchmark" / "reports" / "custom-ocr-benchmark.md").read_text(encoding="utf-8")
            self.assertIn("Decoder", markdown)
            self.assertIn("Turkish special character accuracy", markdown)
            self.assertIn("Field extraction accuracy", markdown)
            self.assertIn("Document Variants", markdown)
            self.assertIn("Warning counts", markdown)
            self.assertIn("Tesseract output is not used", markdown)

    def test_benchmark_smoke_report_does_not_mock_unavailable_engines(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = run_benchmark(
                data_dir=root / "data",
                output_dir=root / "reports",
                samples=4,
                seed=9,
                skip_tesseract=True,
            )

            self.assertEqual(report["dataset"]["samples"], 4)
            self.assertEqual(report["engines"]["TESSERACT"]["status"], "skipped")
            self.assertEqual(report["engines"]["CUSTOM_CRNN"]["status"], "unavailable")
            self.assertIn("onReferenceText", report["extractionEvaluation"])
            self.assertEqual(report["extractionEvaluation"]["onOcrText"], {})
            self.assertIn("Extraction by Input Text", (root / "reports" / "summary.md").read_text(encoding="utf-8"))
            self.assertTrue((root / "reports" / "benchmark-report.json").exists())
            self.assertTrue((root / "reports" / "predictions.jsonl").exists())

    def test_benchmark_golden_suite_contains_receipts_and_invoices(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            report = run_benchmark(
                data_dir=root / "golden",
                output_dir=root / "reports",
                samples=6,
                seed=9,
                dataset_mode="golden",
                skip_tesseract=True,
            )
            manifest = [
                json.loads(line)
                for line in (root / "golden" / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]

            self.assertEqual(report["dataset"]["mode"], "golden")
            self.assertEqual(report["dataset"]["samples"], 6)
            self.assertEqual(report["dataset"]["documentTypes"], {"receipt": 3, "invoice": 3})
            self.assertGreater(report["extractionEvaluation"]["onReferenceText"]["fieldF1"], 0.0)
            self.assertIsNotNone(report["extractionEvaluation"]["onReferenceText"]["fieldMacroF1"])
            self.assertEqual({row["documentType"] for row in manifest}, {"receipt", "invoice"})
            self.assertTrue(all((root / "golden" / row["image"]).exists() for row in manifest))
            self.assertTrue(all(row["fields"]["total"] for row in manifest))

    def test_benchmark_combined_manifest_line_mode_reports_source_mix(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "combined"
            data_dir.mkdir()
            image_path = data_dir / "receipt.png"
            Image.new("RGB", (180, 64), "white").save(image_path)
            manifest_path = data_dir / "line_validation.jsonl"
            manifest_path.write_text(
                json.dumps(
                    {
                        "id": "OCRTurk:sample:line:0",
                        "source": "OCRTurk",
                        "image": image_path.name,
                        "text": "TOPLAM 72,05 TL",
                        "split": "validation",
                        "documentType": "receipt",
                        "fields": {"category": "total.total_price"},
                        "usableForBenchmark": True,
                        "lineCropBox": [4, 8, 160, 48],
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            checkpoint = root / "model.pt"
            checkpoint.write_bytes(b"fake-checkpoint")
            numeric_checkpoint = root / "numeric-char.pt"
            numeric_checkpoint.write_bytes(b"fake-numeric-checkpoint")
            character_checkpoint = root / "character-char.pt"
            character_checkpoint.write_bytes(b"fake-character-checkpoint")
            calls: list[dict[str, object]] = []

            def fake_infer_with_confidence(_checkpoint: Path, _image_path: Path, **kwargs):
                calls.append({"image": _image_path, **kwargs})
                return SimpleNamespace(text="TOPLAM 72,05 TL", confidence=0.93)

            with patch("services.ocr.benchmarks.ocr_benchmark.infer_with_confidence", side_effect=fake_infer_with_confidence):
                report = run_benchmark(
                    data_dir=data_dir,
                    output_dir=root / "reports",
                    samples=1,
                    seed=9,
                    dataset_mode="combined_manifest_lines",
                    manifest_path=manifest_path,
                    include_sources=("OCRTurk",),
                    checkpoint=checkpoint,
                    numeric_char_checkpoint=numeric_checkpoint,
                    character_checkpoint=character_checkpoint,
                    skip_tesseract=True,
                )

            self.assertEqual(report["dataset"]["mode"], "combined_manifest_lines")
            self.assertEqual(report["dataset"]["samples"], 1)
            self.assertEqual(report["dataset"]["sourceMix"], {"OCRTurk": 1})
            self.assertEqual(report["dataset"]["benchmarkLevels"], {"line": 1})
            self.assertEqual(calls[0]["image"], image_path)
            self.assertTrue(calls[0]["cropped_line"])
            self.assertEqual(calls[0]["line_crop_box"], (4, 8, 160, 48))
            self.assertEqual(calls[0]["numeric_char_checkpoint"], numeric_checkpoint)
            self.assertEqual(calls[0]["character_checkpoint"], character_checkpoint)
            custom = report["engines"]["CUSTOM_CRNN"]
            self.assertEqual(custom["status"], "ok")
            self.assertEqual(custom["tokenF1"], 1.0)
            self.assertEqual(custom["amountPrecision"], 1.0)
            self.assertEqual(custom["amountRecall"], 1.0)
            self.assertEqual(custom["amountF1"], 1.0)
            self.assertIsNone(custom["fieldF1"])
            predictions = [
                json.loads(line)
                for line in (root / "reports" / "predictions.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(predictions[0]["source"], "OCRTurk")
            self.assertEqual(predictions[0]["benchmarkLevel"], "line")
            self.assertEqual(predictions[0]["amountF1"], 1.0)
            self.assertIn("Source mix", (root / "reports" / "summary.md").read_text(encoding="utf-8"))
            self.assertIn("Amount F1", (root / "reports" / "summary.md").read_text(encoding="utf-8"))

    def test_benchmark_real_fixture_mode_reports_explicit_custom_checkpoint_prerequisite(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "tr"
            ground_truth = data_dir / "ground-truth"
            ground_truth.mkdir(parents=True)
            (data_dir / "valid-fis-01.jpg").write_bytes(b"fake-image")
            (ground_truth / "valid-fis-01.json").write_text(
                """{
  "merchant": "SPENDLENS MARKET",
  "date": "2026-06-02",
  "currency": "TRY",
  "total": "72.05",
  "paymentMethod": "KART",
  "documentType": "receipt",
  "expectedOcrTextSnippets": ["SPENDLENS MARKET", "F\u00c4\u00b0\u00c5\u009e NO", "72,05 TL"]
}""",
                encoding="utf-8",
            )

            report = run_benchmark(
                data_dir=data_dir,
                output_dir=root / "reports",
                samples=4,
                seed=9,
                dataset_mode="real_fixtures",
                skip_tesseract=True,
            )

            self.assertEqual(report["dataset"]["mode"], "real_fixtures")
            self.assertEqual(report["dataset"]["samples"], 1)
            self.assertEqual(report["dataset"]["documentTypes"], {"receipt": 1})
            self.assertEqual(report["engines"]["CUSTOM_CRNN"]["status"], "unavailable")
            self.assertIn("checkpoint not provided", report["engines"]["CUSTOM_CRNN"]["detail"])
            self.assertTrue((root / "reports" / "benchmark-report.json").exists())
            self.assertTrue((root / "reports" / "predictions.jsonl").exists())
            self.assertTrue((root / "reports" / "summary.md").exists())
            self.assertIn("CER/WER are error rates", (root / "reports" / "summary.md").read_text(encoding="utf-8"))

    def test_benchmark_real_fixture_pdf_uses_custom_document_inference(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "tr"
            ground_truth = data_dir / "ground-truth"
            ground_truth.mkdir(parents=True)
            pdf_path = data_dir / "valid-fatura-01.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n% minimal benchmark fixture\n")
            (ground_truth / "valid-fatura-01.json").write_text(
                json.dumps(
                    {
                        "merchant": "SPENDLENS LTD",
                        "date": "2026-06-02",
                        "currency": "TRY",
                        "total": "245.90",
                        "paymentMethod": "KART",
                        "documentType": "invoice",
                        "expectedOcrTextSnippets": ["SPENDLENS LTD", "TOPLAM", "245,90 TL"],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            checkpoint = root / "model.pt"
            checkpoint.write_bytes(b"fake-checkpoint")
            calls: list[tuple[Path, str]] = []

            def fake_infer_document(_checkpoint: Path, image_path: Path, source_mime_type: str = "", **_kwargs):
                calls.append((image_path, source_mime_type))
                return SimpleNamespace(text="SPENDLENS LTD\nTOPLAM 245,90 TL", confidence=0.81)

            with patch("services.ocr.benchmarks.ocr_benchmark.infer_document", side_effect=fake_infer_document):
                report = run_benchmark(
                    data_dir=data_dir,
                    output_dir=root / "reports",
                    samples=1,
                    seed=9,
                    dataset_mode="real_fixtures",
                    checkpoint=checkpoint,
                    skip_tesseract=True,
                )

            self.assertEqual(calls, [(pdf_path, "application/pdf")])
            custom = report["engines"]["CUSTOM_CRNN"]
            self.assertEqual(custom["status"], "ok")
            self.assertEqual(custom["failed"], 0)
            recognizer_provenance = report["provenance"]["checkpoints"]["recognizer"]
            self.assertEqual(recognizer_provenance["path"], checkpoint.resolve().as_posix())
            self.assertTrue(recognizer_provenance["exists"])
            self.assertEqual(recognizer_provenance["sizeBytes"], checkpoint.stat().st_size)
            self.assertEqual(len(recognizer_provenance["sha256"]), 64)
            self.assertGreater(custom["averageSnippetRecall"], 0)
            self.assertIn("fieldPrecision", custom)
            self.assertIn("fieldRecall", custom)
            self.assertIn("fieldF1", custom)
            self.assertGreater(custom["fieldF1"], 0)
            self.assertLess(custom["fieldF1"], 1)
            self.assertIn("Field F1", (root / "reports" / "summary.md").read_text(encoding="utf-8"))

    def test_benchmark_reports_runtime_metrics_for_tesseract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with (
                patch(
                    "services.ocr.benchmarks.ocr_benchmark.check_tesseract_availability",
                    return_value={"available": True, "binary_path": "/usr/bin/tesseract", "languages": ["eng", "tur"], "missing_languages": []},
                ),
                patch(
                    "services.ocr.benchmarks.ocr_benchmark._run_tesseract_text",
                    return_value=("CAGRI MARKET\nTOPLAM 61,25 TL", 0.82),
                ),
            ):
                report = run_benchmark(
                    data_dir=root / "golden",
                    output_dir=root / "reports",
                    samples=2,
                    seed=9,
                    dataset_mode="golden",
                    skip_tesseract=False,
                )

            tesseract = report["engines"]["TESSERACT"]
            self.assertEqual(tesseract["status"], "ok")
            self.assertEqual(tesseract["attempted"], 2)
            self.assertEqual(tesseract["succeeded"], 2)
            self.assertEqual(tesseract["failureRate"], 0)
            self.assertIsNotNone(tesseract["averageCer"])
            self.assertIsNotNone(tesseract["averageWer"])
            self.assertIsNotNone(tesseract["averageLatencyMs"])
            self.assertAlmostEqual(tesseract["averageConfidence"], 0.82)

            predictions = [
                json.loads(line)
                for line in (root / "reports" / "predictions.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual([row["engine"] for row in predictions], ["TESSERACT", "TESSERACT"])

    def test_benchmark_error_rates(self) -> None:
        self.assertEqual(cer("ABC", "ABC"), 0)
        self.assertGreater(cer("ABC", "AXC"), 0)
        self.assertEqual(wer("MAVI MARKET", "MAVI MARKET"), 0)
        self.assertGreater(wer("MAVI MARKET", "MAVI"), 0)

    def test_benchmark_amount_tokens_preserve_thousand_and_three_digit_groups(self) -> None:
        self.assertEqual(_amount_token_set("TOTAL 76,000"), {"76000"})
        self.assertEqual(_amount_token_set("33,636"), {"33636"})
        self.assertEqual(_amount_token_set("1.234,56 TL"), {"123456"})
        self.assertEqual(_amount_token_set("72,05 TL"), {"7205"})


if __name__ == "__main__":
    unittest.main()
