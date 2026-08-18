from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
import json
from pathlib import Path
import random

import cv2
import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

from services.ocr.custom_model.char_cnn import CharacterCNN, checkpoint_payload
from services.ocr.custom_model.cli import configure_utf8_stdout
from services.ocr.custom_model.dataset import NUMERIC_FIELD_PROFILE_COUNTS, generate_numeric_field_dataset
from services.ocr.custom_model.numeric_field_recognizer import character_box_to_tensor
from services.ocr.custom_model.registry import LocalModelArtifact, write_local_registry_entry
from services.ocr.custom_model.segmentation import SegmentBox, segment_characters
from services.ocr.custom_model.vocab import CHAR_TO_INDEX, VOCAB, VOCAB_VERSION


@dataclass(frozen=True)
class NumericSequence:
    start: int
    length: int
    text: str
    field_kind: str
    variant: str


class SegmentedNumericCharacterDataset(Dataset):
    def __init__(self, data_dir: Path, split: str):
        manifest_path = data_dir / "manifest.jsonl"
        if not manifest_path.exists():
            raise FileNotFoundError(f"Numeric field manifest not found: {manifest_path}")
        rows = [json.loads(line) for line in manifest_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        rows = [row for row in rows if row.get("split") == split]
        self.samples: list[tuple[torch.Tensor, int]] = []
        self.sequences: list[NumericSequence] = []
        self.skipped_by_kind: Counter[str] = Counter()
        for row in rows:
            gray = cv2.imread(str(data_dir / str(row["image"])), cv2.IMREAD_GRAYSCALE)
            if gray is None:
                raise ValueError(f"Numeric field image could not be read: {row['image']}")
            _threshold, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            foreground_y, foreground_x = np.where(binary > 0)
            if not len(foreground_x):
                self.skipped_by_kind[str(row["fieldKind"])] += 1
                continue
            word = SegmentBox(
                int(foreground_x.min()),
                int(foreground_y.min()),
                int(foreground_x.max() - foreground_x.min() + 1),
                int(foreground_y.max() - foreground_y.min() + 1),
                "word",
            )
            boxes = segment_characters(binary, word)
            text = str(row["text"])
            if len(boxes) != len(text):
                self.skipped_by_kind[str(row["fieldKind"])] += 1
                continue
            start = len(self.samples)
            self.samples.extend(
                (character_box_to_tensor(gray, box), CHAR_TO_INDEX[character])
                for character, box in zip(text, boxes, strict=True)
            )
            self.sequences.append(
                NumericSequence(start, len(text), text, str(row["fieldKind"]), str(row["variant"]))
            )

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, int]:
        return self.samples[index]


def train_numeric_character_cnn(
    data_dir: Path,
    artifact_dir: Path,
    *,
    samples: int,
    epochs: int,
    seed: int,
    base_checkpoint: Path | None = None,
    registry_path: Path | None = None,
    learning_rate: float = 5e-4,
    batch_size: int = 256,
    reuse_existing_dataset: bool = False,
) -> dict[str, object]:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    manifest_path = data_dir / "manifest.jsonl"
    if manifest_path.exists():
        if not reuse_existing_dataset:
            raise FileExistsError("Numeric field dataset exists; pass reuse_existing_dataset=True to preserve and reuse it.")
    else:
        if data_dir.exists() and any(data_dir.iterdir()):
            raise FileExistsError(f"Refusing to generate into non-empty dataset directory: {data_dir}")
        generate_numeric_field_dataset(data_dir, count=samples, seed=seed)
    if artifact_dir.exists() and any(artifact_dir.iterdir()):
        raise FileExistsError(f"Refusing to overwrite non-empty artifact directory: {artifact_dir}")

    train_dataset = SegmentedNumericCharacterDataset(data_dir, "train")
    validation_dataset = SegmentedNumericCharacterDataset(data_dir, "validation")
    test_dataset = SegmentedNumericCharacterDataset(data_dir, "test")
    if not train_dataset.samples or not validation_dataset.samples or not test_dataset.samples:
        raise ValueError("Numeric character dataset must contain aligned train, validation and test samples.")

    counts = Counter(label for _image, label in train_dataset.samples)
    sample_weights = [1 / (counts[label] ** 0.5) for _image, label in train_dataset.samples]
    sampler = WeightedRandomSampler(
        sample_weights,
        len(sample_weights),
        replacement=True,
        generator=torch.Generator().manual_seed(seed),
    )
    loader = DataLoader(train_dataset, batch_size=batch_size, sampler=sampler)
    model = CharacterCNN(num_classes=len(VOCAB))
    if base_checkpoint is not None:
        payload = torch.load(base_checkpoint, map_location="cpu")
        if str(payload.get("vocab_version") or "") != VOCAB_VERSION:
            raise ValueError("Base character checkpoint vocabulary does not match the central OCR vocabulary.")
        model.load_state_dict(payload["model_state"])

    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=1e-4)
    criterion = nn.CrossEntropyLoss()
    history: list[dict[str, object]] = []
    for epoch in range(1, epochs + 1):
        model.train()
        loss_sum = 0.0
        observed = 0
        for images, labels in loader:
            optimizer.zero_grad()
            loss = criterion(model(images), labels)
            loss.backward()
            optimizer.step()
            loss_sum += float(loss.detach()) * len(labels)
            observed += len(labels)
        validation = evaluate_numeric_character_cnn(model, validation_dataset, batch_size=batch_size * 2)
        history.append({"epoch": epoch, "loss": loss_sum / observed, **validation})

    validation = evaluate_numeric_character_cnn(model, validation_dataset, batch_size=batch_size * 2)
    test = evaluate_numeric_character_cnn(model, test_dataset, batch_size=batch_size * 2)
    model_version = f"custom-char-cnn-numeric-{seed}"
    metrics: dict[str, object] = {
        "model": "custom-char-cnn-numeric-fields",
        "modelVersion": model_version,
        "vocabVersion": VOCAB_VERSION,
        "seed": seed,
        "baseCheckpoint": str(base_checkpoint) if base_checkpoint is not None else None,
        "datasetManifest": str(manifest_path),
        "trainCharacters": len(train_dataset),
        "validationCharacters": len(validation_dataset),
        "testCharacters": len(test_dataset),
        "trainSequences": len(train_dataset.sequences),
        "validationSequences": len(validation_dataset.sequences),
        "testSequences": len(test_dataset.sequences),
        "skippedSequences": {
            "train": dict(train_dataset.skipped_by_kind),
            "validation": dict(validation_dataset.skipped_by_kind),
            "test": dict(test_dataset.skipped_by_kind),
        },
        "epochs": epochs,
        "learningRate": learning_rate,
        "batchSize": batch_size,
        "history": history,
        "validation": validation,
        "test": test,
    }
    artifact_dir.mkdir(parents=True, exist_ok=True)
    model_path = artifact_dir / "char-cnn.pt"
    torch.save(checkpoint_payload(model, vocab_version=VOCAB_VERSION, seed=seed, metrics=metrics), model_path)
    registry_path = registry_path or artifact_dir.parent / "local-model-registry.json"
    registry_entry = write_local_registry_entry(
        registry_path,
        LocalModelArtifact(
            model_code="CUSTOM_CHAR_CNN_NUMERIC",
            version=model_version,
            artifact_path=str(model_path),
            dataset_manifest_id=str(manifest_path),
            vocabulary_version=VOCAB_VERSION,
            metrics=json.loads(json.dumps(metrics, ensure_ascii=False)),
            status="READY",
        ),
    )
    metrics["registryPath"] = str(registry_path)
    metrics["registryEntry"] = registry_entry
    (artifact_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    return metrics


def evaluate_numeric_character_cnn(
    model: CharacterCNN,
    dataset: SegmentedNumericCharacterDataset,
    *,
    batch_size: int = 512,
) -> dict[str, object]:
    predictions: list[int] = []
    references: list[int] = []
    model.eval()
    with torch.no_grad():
        for images, labels in DataLoader(dataset, batch_size=batch_size, shuffle=False):
            predictions.extend(model(images).argmax(dim=1).tolist())
            references.extend(labels.tolist())
    character_correct = sum(prediction == reference for prediction, reference in zip(predictions, references, strict=True))
    by_kind: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    exact = 0
    for sequence in dataset.sequences:
        predicted_text = "".join(VOCAB[index] for index in predictions[sequence.start : sequence.start + sequence.length])
        matched = predicted_text == sequence.text
        exact += int(matched)
        by_kind[sequence.field_kind][0] += int(matched)
        by_kind[sequence.field_kind][1] += 1
    return {
        "characterAccuracy": character_correct / len(references),
        "sequenceExactMatch": exact / len(dataset.sequences),
        "sequenceExactByKind": {
            field_kind: matches / total for field_kind, (matches, total) in sorted(by_kind.items())
        },
    }


def main() -> None:
    configure_utf8_stdout()
    parser = argparse.ArgumentParser(description="Train the segmented numeric-field character CNN.")
    parser.add_argument("--profile", choices=tuple(NUMERIC_FIELD_PROFILE_COUNTS), default="local_full")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--samples", type=int)
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--seed", type=int, default=20260620)
    parser.add_argument("--base-checkpoint", type=Path)
    parser.add_argument("--learning-rate", type=float, default=5e-4)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--reuse-existing-dataset", action="store_true")
    args = parser.parse_args()
    metrics = train_numeric_character_cnn(
        args.data_dir,
        args.artifact_dir,
        samples=args.samples or NUMERIC_FIELD_PROFILE_COUNTS[args.profile],
        epochs=args.epochs,
        seed=args.seed,
        base_checkpoint=args.base_checkpoint,
        learning_rate=args.learning_rate,
        batch_size=args.batch_size,
        reuse_existing_dataset=args.reuse_existing_dataset,
    )
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
