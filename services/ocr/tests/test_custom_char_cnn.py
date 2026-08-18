from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import torch
from PIL import Image
from torch import nn

from services.ocr.custom_model.char_cnn import CharacterCNN, checkpoint_payload
from services.ocr.custom_model.registry import find_ready_model
from services.ocr.custom_model.train_char_cnn import train_character_cnn
from services.ocr.custom_model.vocab import VOCAB, VOCAB_VERSION


class CustomCharacterCNNTests(unittest.TestCase):
    def test_forward_loss_and_checkpoint_round_trip(self) -> None:
        model = CharacterCNN(num_classes=len(VOCAB))
        images = torch.rand(4, 1, 32, 32)
        labels = torch.tensor([1, 2, 3, 4], dtype=torch.long)
        logits = model(images)
        self.assertEqual(logits.shape, (4, len(VOCAB)))
        loss = nn.CrossEntropyLoss()(logits, labels)
        self.assertTrue(torch.isfinite(loss))

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "char-cnn.pt"
            torch.save(checkpoint_payload(model, vocab_version=VOCAB_VERSION, seed=7), path)
            payload = torch.load(path, map_location="cpu")
            loaded = CharacterCNN(num_classes=len(VOCAB))
            loaded.load_state_dict(payload["model_state"])
            self.assertEqual(payload["vocab_version"], VOCAB_VERSION)

    def test_training_writes_per_character_topk_and_confusion_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_dir = Path(temp_dir) / "char-cnn"

            metrics = train_character_cnn(artifact_dir=artifact_dir, samples=16, epochs=1, seed=123)

            self.assertEqual(metrics["model"], "custom-char-cnn")
            self.assertEqual(metrics["vocabVersion"], VOCAB_VERSION)
            self.assertIn("accuracy", metrics)
            self.assertIn("top3Accuracy", metrics)
            self.assertIn("macroF1", metrics)
            self.assertGreaterEqual(metrics["top3Accuracy"], metrics["accuracy"])
            self.assertIn("perCharacter", metrics)
            self.assertIn("confusionMatrix", metrics)
            self.assertIn("turkishSpecialCharacterMetrics", metrics)
            self.assertGreater(metrics["turkishSpecialCharacterMetrics"]["support"], 0)
            self.assertTrue((artifact_dir / "char-cnn-metrics.json").exists())
            self.assertTrue((Path(metrics["registryPath"])).exists())
            self.assertEqual(metrics["registryEntry"]["model_code"], "CUSTOM_CHAR_CNN")
            self.assertEqual(metrics["registryEntry"]["vocabulary_version"], VOCAB_VERSION)
            self.assertEqual(find_ready_model(Path(metrics["registryPath"]), "CUSTOM_CHAR_CNN")["version"], metrics["modelVersion"])
            payload = torch.load(artifact_dir / "char-cnn.pt", map_location="cpu")
            self.assertEqual(payload["metrics"]["top3Accuracy"], metrics["top3Accuracy"])

    def test_training_can_resume_on_real_character_manifests(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_dir = root / "manifest"
            manifest_dir.mkdir()
            for split in ("train", "validation"):
                rows = []
                for index, character in enumerate("ABCD"):
                    image_path = root / f"{split}-{index}.png"
                    Image.new("L", (32, 32), color=245).save(image_path)
                    rows.append(
                        {
                            "image": str(image_path),
                            "text": character,
                            "source": "project_fixture_real_character",
                            "usableForTraining": True,
                        }
                    )
                (manifest_dir / f"character_{split}.jsonl").write_text(
                    "\n".join(json.dumps(row) for row in rows),
                    encoding="utf-8",
                )
            base_dir = root / "base"
            train_character_cnn(base_dir, samples=16, epochs=1, seed=123)

            metrics = train_character_cnn(
                root / "finetuned",
                samples=8,
                epochs=1,
                seed=124,
                manifest_dir=manifest_dir,
                include_sources={"project_fixture_real_character"},
                resume_from=base_dir / "char-cnn.pt",
                synthetic_replay_samples=16,
                learning_rate=1e-4,
                freeze_backbone=True,
                component_status="SHADOW_ONLY",
            )

            self.assertEqual(metrics["datasetScope"], "combined_manifest")
            self.assertEqual(
                metrics["trainSourceMix"],
                {"project_fixture_real_character": 4, "synthetic_character_replay": 16},
            )
            self.assertEqual(metrics["validationSourceMix"], {"project_fixture_real_character": 4})
            self.assertEqual(metrics["includeSources"], ["project_fixture_real_character"])
            self.assertEqual(metrics["samples"], 20)
            self.assertEqual(metrics["syntheticReplaySamples"], 16)
            self.assertEqual(metrics["learningRate"], 1e-4)
            self.assertTrue(metrics["freezeBackbone"])
            self.assertGreater(metrics["trainableParameterCount"], 0)
            self.assertEqual(metrics["componentStatus"], "SHADOW_ONLY")
            self.assertIn("replay-16-frozen-lr-1e-04", metrics["modelVersion"])
            self.assertEqual(metrics["registryEntry"]["status"], "SHADOW_ONLY")
            self.assertGreater(metrics["syntheticReplayValidation"]["turkishSpecialCharacterMetrics"]["support"], 0)


if __name__ == "__main__":
    unittest.main()
