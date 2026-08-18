from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from torch import nn
from torch.utils.data import ConcatDataset, DataLoader, Dataset

from services.ocr.custom_model.char_cnn import CharacterCNN, checkpoint_payload
from services.ocr.custom_model.cli import configure_utf8_stdout
from services.ocr.custom_model.registry import LocalModelArtifact, write_local_registry_entry
from services.ocr.custom_model.vocab import CHAR_TO_INDEX, CHARS, VOCAB, VOCAB_VERSION


PROFILE_DEFAULTS = {
    "tiny": {"samples": 128, "epochs": 1},
    "demo": {"samples": 512, "epochs": 2},
    "benchmark": {"samples": 2048, "epochs": 3},
    "local_full": {"samples": 8192, "epochs": 5},
}
TURKISH_OVERSAMPLE = set("çğıİöşüÇĞÖŞÜ₺")
TURKISH_SPECIAL_CHARACTERS = set("çğıİöşüÇĞÖŞÜ₺")


class SyntheticCharacterDataset(Dataset):
    def __init__(self, samples: int, seed: int):
        self.samples = samples
        self.rng = random.Random(seed)
        weighted_chars: list[str] = []
        for char in CHARS:
            weighted_chars.extend([char] * (5 if char in TURKISH_OVERSAMPLE else 1))
        self.rows = [self.rng.choice(weighted_chars) for _ in range(samples)]
        self.fonts = _load_fonts()

    def __len__(self) -> int:
        return self.samples

    def __getitem__(self, index: int) -> tuple[torch.Tensor, int]:
        char = self.rows[index]
        image = _render_char(char, self.fonts[index % len(self.fonts)], self.rng)
        tensor = torch.from_numpy(np.array(image, dtype=np.float32) / 255.0).unsqueeze(0)
        return tensor, CHAR_TO_INDEX[char]


class ManifestCharacterDataset(Dataset):
    def __init__(self, manifest_dir: Path, split: str, include_sources: set[str] | None = None):
        manifest_path = manifest_dir / f"character_{split}.jsonl"
        if not manifest_path.is_file():
            raise FileNotFoundError(f"Character manifest not found: {manifest_path}")
        rows = [json.loads(line) for line in manifest_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.rows = [
            row
            for row in rows
            if bool(row.get("usableForTraining"))
            and (include_sources is None or str(row.get("source")) in include_sources)
            and str(row.get("text") or "") in CHAR_TO_INDEX
        ]
        if not self.rows:
            raise ValueError(f"No usable character rows found in {manifest_path} for sources {sorted(include_sources or set())}.")

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, int]:
        row = self.rows[index]
        image = Image.open(Path(str(row["image"]))).convert("L").resize((32, 32), _resampling_bilinear())
        tensor = torch.from_numpy(np.array(image, dtype=np.float32) / 255.0).unsqueeze(0)
        return tensor, CHAR_TO_INDEX[str(row["text"])]


def train_character_cnn(
    artifact_dir: Path,
    samples: int,
    epochs: int,
    seed: int,
    registry_path: Path | None = None,
    manifest_dir: Path | None = None,
    include_sources: set[str] | None = None,
    resume_from: Path | None = None,
    synthetic_replay_samples: int = 0,
    learning_rate: float = 1e-3,
    freeze_backbone: bool = False,
    component_status: str = "READY",
) -> dict[str, object]:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if not 0 < learning_rate <= 1e-2:
        raise ValueError("learning_rate must be greater than zero and at most 0.01")
    if component_status not in {"READY", "SPECIALIST_ACTIVE", "SHADOW_ONLY", "REJECTED"}:
        raise ValueError("component_status must be READY, SPECIALIST_ACTIVE, SHADOW_ONLY, or REJECTED")

    if manifest_dir is None:
        dataset: Dataset = SyntheticCharacterDataset(samples=samples, seed=seed)
        validation_samples = max(len(VOCAB), min(2048, max(16, samples // 5)))
        validation_dataset: Dataset = SyntheticCharacterDataset(samples=validation_samples, seed=seed + 10_000)
        train_source_mix = {"synthetic": len(dataset)}
        validation_source_mix = {"synthetic": len(validation_dataset)}
        dataset_scope = "synthetic"
        dataset_manifest_id = f"synthetic-character-seed-{seed}"
    else:
        manifest_dataset = ManifestCharacterDataset(manifest_dir, "train", include_sources)
        validation_dataset = ManifestCharacterDataset(manifest_dir, "validation", include_sources)
        validation_samples = len(validation_dataset)
        train_source_mix = _source_mix(manifest_dataset.rows)
        validation_source_mix = _source_mix(validation_dataset.rows)
        if synthetic_replay_samples > 0:
            replay_dataset = SyntheticCharacterDataset(samples=synthetic_replay_samples, seed=seed + 20_000)
            dataset = ConcatDataset([manifest_dataset, replay_dataset])
            train_source_mix["synthetic_character_replay"] = len(replay_dataset)
        else:
            dataset = manifest_dataset
        dataset_scope = "combined_manifest"
        dataset_manifest_id = str(manifest_dir)
    generator = torch.Generator().manual_seed(seed)
    loader = DataLoader(dataset, batch_size=32, shuffle=True, generator=generator)
    model = CharacterCNN(num_classes=len(VOCAB))
    resume_model_version = None
    if resume_from is not None:
        if not resume_from.is_file():
            raise FileNotFoundError(f"Character checkpoint not found: {resume_from}")
        payload = torch.load(resume_from, map_location="cpu")
        if str(payload.get("vocab_version") or "") != VOCAB_VERSION:
            raise ValueError("Character checkpoint vocabulary does not match the active OCR vocabulary.")
        model.load_state_dict(payload["model_state"])
        resume_metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
        resume_model_version = resume_metrics.get("modelVersion")
    if freeze_backbone:
        for parameter in model.parameters():
            parameter.requires_grad = False
        for parameter in model.net[-1].parameters():
            parameter.requires_grad = True
    trainable_parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(trainable_parameters, lr=learning_rate)
    criterion = nn.CrossEntropyLoss()
    losses: list[float] = []

    model.train()
    for _epoch in range(epochs):
        for images, labels in loader:
            optimizer.zero_grad()
            loss = criterion(model(images), labels)
            loss.backward()
            optimizer.step()
            losses.append(float(loss.detach()))

    evaluation = evaluate_character_cnn(model, validation_dataset)
    replay_validation = None
    if synthetic_replay_samples > 0:
        replay_validation_dataset = SyntheticCharacterDataset(
            samples=max(len(VOCAB) * 4, min(2048, synthetic_replay_samples // 3)),
            seed=seed + 30_000,
        )
        replay_validation = evaluate_character_cnn(model, replay_validation_dataset)
    source_label = "synthetic" if manifest_dir is None else "-".join(sorted(include_sources or {"combined"}))
    source_label = re.sub(r"[^a-z0-9]+", "-", source_label.lower()).strip("-")
    variant_parts: list[str] = []
    if synthetic_replay_samples > 0:
        variant_parts.append(f"replay-{synthetic_replay_samples}")
    if freeze_backbone:
        variant_parts.append("frozen")
    if learning_rate != 1e-3:
        variant_parts.append(f"lr-{learning_rate:.0e}".replace("+", ""))
    variant = f"-{'-'.join(variant_parts)}" if variant_parts else ""
    model_version = f"custom-char-cnn-{source_label}-seed-{seed}{variant}"
    metrics = {
        "model": "custom-char-cnn",
        "modelVersion": model_version,
        "samples": len(dataset),
        "requestedSamples": samples,
        "validationSamples": validation_samples,
        "epochs": epochs,
        "loss": losses[-1] if losses else None,
        "vocabVersion": VOCAB_VERSION,
        "turkishOversampling": True,
        "datasetScope": dataset_scope,
        "datasetManifestId": dataset_manifest_id,
        "includeSources": sorted(include_sources) if include_sources else None,
        "trainSourceMix": train_source_mix,
        "validationSourceMix": validation_source_mix,
        "resumeFrom": str(resume_from) if resume_from else None,
        "resumeFromModelVersion": resume_model_version,
        "syntheticReplaySamples": synthetic_replay_samples,
        "learningRate": learning_rate,
        "freezeBackbone": freeze_backbone,
        "trainableParameterCount": sum(parameter.numel() for parameter in trainable_parameters),
        "componentStatus": component_status,
        "syntheticReplayValidation": replay_validation,
        "accuracy": evaluation["accuracy"],
        "top3Accuracy": evaluation["top3Accuracy"],
        "macroF1": evaluation["macroF1"],
        "perCharacter": evaluation["perCharacter"],
        "confusionMatrix": evaluation["confusionMatrix"],
        "turkishSpecialCharacterMetrics": evaluation["turkishSpecialCharacterMetrics"],
        "accuracyNote": (
            "Local synthetic character validation; this is not production-readiness evidence."
            if manifest_dir is None
            else "Validation metrics apply only to the explicitly listed manifest sources and do not imply broader OCR readiness."
        ),
    }
    artifact_dir.mkdir(parents=True, exist_ok=True)
    model_path = artifact_dir / "char-cnn.pt"
    torch.save(checkpoint_payload(model, vocab_version=VOCAB_VERSION, seed=seed, metrics=metrics), model_path)
    registry_path = registry_path or artifact_dir.parent / "local-model-registry.json"
    registry_metrics = json.loads(json.dumps(metrics, ensure_ascii=False))
    registry_entry = write_local_registry_entry(
        registry_path,
        LocalModelArtifact(
            model_code="CUSTOM_CHAR_CNN",
            version=model_version,
            artifact_path=str(model_path),
            dataset_manifest_id=dataset_manifest_id,
            vocabulary_version=VOCAB_VERSION,
            metrics=registry_metrics,
            status=component_status,
        ),
    )
    metrics["registryPath"] = str(registry_path)
    metrics["registryEntry"] = registry_entry
    (artifact_dir / "char-cnn-metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    return metrics


def _source_mix(rows: list[dict[str, object]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        source = str(row.get("source") or "unknown")
        counts[source] = counts.get(source, 0) + 1
    return dict(sorted(counts.items()))


def _resampling_bilinear() -> int:
    resampling = getattr(Image, "Resampling", None)
    return int(resampling.BILINEAR if resampling is not None else Image.BILINEAR)


def evaluate_character_cnn(model: CharacterCNN, dataset: Dataset, batch_size: int = 64) -> dict[str, object]:
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False)
    correct = 0
    top3_correct = 0
    total = 0
    true_counts: dict[int, int] = {}
    predicted_counts: dict[int, int] = {}
    true_positive_counts: dict[int, int] = {}
    confusion: dict[tuple[int, int], int] = {}
    turkish_total = 0
    turkish_correct = 0

    model.eval()
    with torch.no_grad():
        for images, labels in loader:
            logits = model(images)
            predictions = logits.argmax(dim=1)
            top_k = torch.topk(logits, k=min(3, logits.shape[1]), dim=1).indices
            for label, prediction, candidates in zip(labels.tolist(), predictions.tolist(), top_k.tolist(), strict=True):
                total += 1
                true_counts[label] = true_counts.get(label, 0) + 1
                predicted_counts[prediction] = predicted_counts.get(prediction, 0) + 1
                confusion[(label, prediction)] = confusion.get((label, prediction), 0) + 1
                if label == prediction:
                    correct += 1
                    true_positive_counts[label] = true_positive_counts.get(label, 0) + 1
                if label in candidates:
                    top3_correct += 1
                if VOCAB[label] in TURKISH_SPECIAL_CHARACTERS:
                    turkish_total += 1
                    if label == prediction:
                        turkish_correct += 1

    per_character: list[dict[str, object]] = []
    f1_scores: list[float] = []
    turkish_f1_scores: list[float] = []
    for label in sorted(true_counts):
        true_positives = true_positive_counts.get(label, 0)
        precision = true_positives / predicted_counts.get(label, 1)
        recall = true_positives / true_counts[label]
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        row = {
            "character": VOCAB[label],
            "support": true_counts[label],
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "f1": round(f1, 6),
        }
        per_character.append(row)
        f1_scores.append(f1)
        if VOCAB[label] in TURKISH_SPECIAL_CHARACTERS:
            turkish_f1_scores.append(f1)

    confusion_rows = [
        {
            "reference": VOCAB[reference],
            "prediction": VOCAB[prediction],
            "count": count,
        }
        for (reference, prediction), count in sorted(confusion.items(), key=lambda item: (VOCAB[item[0][0]], VOCAB[item[0][1]]))
    ]
    return {
        "accuracy": round(correct / total, 6) if total else 0.0,
        "top3Accuracy": round(top3_correct / total, 6) if total else 0.0,
        "macroF1": round(sum(f1_scores) / len(f1_scores), 6) if f1_scores else 0.0,
        "perCharacter": per_character,
        "confusionMatrix": confusion_rows,
        "turkishSpecialCharacterMetrics": {
            "support": turkish_total,
            "accuracy": round(turkish_correct / turkish_total, 6) if turkish_total else None,
            "macroF1": round(sum(turkish_f1_scores) / len(turkish_f1_scores), 6) if turkish_f1_scores else None,
        },
    }


def _render_char(char: str, font: ImageFont.ImageFont, rng: random.Random) -> Image.Image:
    image = Image.new("L", (32, 32), color=245)
    draw = ImageDraw.Draw(image)
    bbox = draw.textbbox((0, 0), char, font=font)
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    x = max(1, (32 - width) // 2 + rng.randint(-2, 2))
    y = max(1, (32 - height) // 2 + rng.randint(-2, 2))
    draw.text((x, y), char, fill=rng.randint(0, 40), font=font)
    if rng.random() < 0.35:
        image = image.rotate(rng.uniform(-8, 8), expand=False, fillcolor=245)
    if rng.random() < 0.2:
        image = image.filter(ImageFilter.GaussianBlur(radius=0.35))
    return image


def _load_fonts() -> list[ImageFont.ImageFont]:
    fonts: list[ImageFont.ImageFont] = []
    for font_name in ("arial.ttf", "DejaVuSans.ttf", "NotoSans-Regular.ttf", "LiberationSans-Regular.ttf"):
        for size in (18, 22, 26):
            try:
                fonts.append(ImageFont.truetype(font_name, size=size))
            except OSError:
                pass
    return fonts or [ImageFont.load_default()]


def main() -> None:
    configure_utf8_stdout()
    parser = argparse.ArgumentParser(description="Train the custom CNN character classifier.")
    parser.add_argument("--profile", choices=tuple(PROFILE_DEFAULTS), default="local_full")
    parser.add_argument("--artifact-dir", type=Path, default=Path("artifacts/models/custom-char-cnn-local-full"))
    parser.add_argument("--samples", type=int, default=None)
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--manifest-dir", type=Path)
    parser.add_argument("--include-sources", nargs="+")
    parser.add_argument("--resume-from", type=Path)
    parser.add_argument(
        "--synthetic-replay-samples",
        type=int,
        default=0,
        help="Mix deterministic synthetic Turkish/general characters into manifest fine-tuning to reduce forgetting.",
    )
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--freeze-backbone", action="store_true")
    parser.add_argument(
        "--component-status",
        choices=("READY", "SPECIALIST_ACTIVE", "SHADOW_ONLY", "REJECTED"),
        default="READY",
    )
    args = parser.parse_args()
    defaults = PROFILE_DEFAULTS[args.profile]
    metrics = train_character_cnn(
        artifact_dir=args.artifact_dir,
        samples=args.samples or defaults["samples"],
        epochs=args.epochs or defaults["epochs"],
        seed=args.seed,
        manifest_dir=args.manifest_dir,
        include_sources=set(args.include_sources) if args.include_sources else None,
        resume_from=args.resume_from,
        synthetic_replay_samples=max(0, args.synthetic_replay_samples),
        learning_rate=args.learning_rate,
        freeze_backbone=args.freeze_backbone,
        component_status=args.component_status,
    )
    print(json.dumps({"profile": args.profile, **metrics}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
