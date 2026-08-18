from __future__ import annotations

import argparse
import copy
import json
import random
import re
from pathlib import Path
from typing import Callable

import numpy as np
import torch
from PIL import Image
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

from services.ocr.custom_model.cli import configure_utf8_stdout
from services.ocr.custom_model.dataset import generate_dataset, generate_document_line_dataset, generate_numeric_field_dataset
from services.ocr.custom_model.evaluate import cer, summarize_prediction_rows, wer
from services.ocr.custom_model.infer import DEFAULT_BLANK_PENALTY, decode_ctc_prediction
from services.ocr.custom_model.line_images import ctc_input_length_for_width, line_image_to_tensor, prepare_cropped_line_image, prepare_line_image
from services.ocr.custom_model.crnn import crnn_architecture_version
from services.ocr.custom_model.model import CRNNOCR
from services.ocr.custom_model.registry import LocalModelArtifact, write_local_registry_entry
from services.ocr.custom_model.vocab import CHAR_TO_INDEX, VOCAB, VOCAB_VERSION, encode


class LineDataset(Dataset):
    def __init__(
        self,
        manifest_path: Path,
        image_dir: Path,
        split: str = "train",
        temporal_downsample: int = 4,
        line_image_min_width: int = 384,
        input_inverted: bool = False,
    ):
        self.rows = [json.loads(line) for line in manifest_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.rows = [row for row in self.rows if split == "all" or row["split"] == split]
        self.image_dir = image_dir
        self.temporal_downsample = temporal_downsample
        self.line_image_min_width = line_image_min_width
        self.input_inverted = input_inverted

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor, int, int]:
        row = self.rows[index]
        image_path = _resolve_manifest_image_path(self.image_dir, row.get("image"))
        raw_image = Image.open(image_path)
        line_crop_box = _line_crop_box(row)
        if line_crop_box is not None:
            raw_image = raw_image.crop(line_crop_box)
        if _is_presegmented_line(row) or line_crop_box is not None:
            image = prepare_cropped_line_image(raw_image, min_width=self.line_image_min_width)
        else:
            image = prepare_line_image(raw_image)
        tensor = line_image_to_tensor(image, invert=self.input_inverted)
        target = torch.tensor(encode(row["text"]), dtype=torch.long)
        return tensor, target, len(target), ctc_input_length_for_width(image.width, self.temporal_downsample)


def _is_presegmented_line(row: dict[str, object]) -> bool:
    return row.get("source") in {
        "synthetic_document_line_crop",
        "OCRTurk",
        "project_fixture_real_crop",
    }


def _resolve_manifest_image_path(image_dir: Path, image_value: object) -> Path:
    if not isinstance(image_value, str) or not image_value.strip():
        raise ValueError("CRNN manifest row is missing a usable image path.")
    image_path = Path(image_value)
    if image_path.is_absolute():
        return image_path
    candidate = image_dir / image_path
    if candidate.exists():
        return candidate
    return image_path


def _line_crop_box(row: dict[str, object]) -> tuple[int, int, int, int] | None:
    value = row.get("lineCropBox")
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError("lineCropBox must be a four-value [left, top, right, bottom] list.")
    try:
        left, top, right, bottom = [int(item) for item in value]
    except (TypeError, ValueError) as exc:
        raise ValueError("lineCropBox values must be integers.") from exc
    if right <= left or bottom <= top:
        raise ValueError("lineCropBox must have positive width and height.")
    return (left, top, right, bottom)


KEY_FIELD_LINE_PREFIXES = ("FİŞ NO", "FATURA NO", "VKN ", "TARİH ", "ARA TOPLAM ", "KDV ", "TOPLAM ")
TURKISH_SPECIAL_CHARACTERS = frozenset("çğıİöşüÇĞÖŞÜ")
DEFAULT_SOURCE_SAMPLE_WEIGHTS = {
    "CORD": 1.0,
    "SROIE": 1.15,
    "OCRTurk": 1.6,
    "project_fixture_synthetic": 1.25,
    "project_fixture_real_crop": 2.0,
}
DEFAULT_TASK_SAMPLE_WEIGHTS = {
    "key_field": 1.35,
    "amount": 1.4,
    "date_or_time": 1.25,
    "identifier": 1.25,
    "turkish_special": 1.5,
    "long_line": 1.35,
    "hardcase": 1.25,
}
_AMOUNT_LINE_RE = re.compile(r"(?:\d{1,3}(?:[. ]\d{3})*|\d+)[,.]\d{2}(?:\s*(?:TL|TRY|₺|EUR|€|USD|\$))?", re.IGNORECASE)
_DATE_OR_TIME_RE = re.compile(r"(?:\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b)")
_IDENTIFIER_RE = re.compile(r"(?:\b(?:IBAN|VKN|TCKN|FİŞ\s*NO|FIS\s*NO|FATURA\s*NO|BELGE\s*NO|REF(?:ERANS)?\s*NO)\b|\bTR\d{2}[A-Z0-9]{8,}\b)", re.IGNORECASE)


def is_key_field_line(row: dict[str, object]) -> bool:
    return str(row.get("text") or "").strip().upper().startswith(KEY_FIELD_LINE_PREFIXES)


def field_line_sample_weights(rows: list[dict[str, object]], oversample_factor: float) -> list[float]:
    if oversample_factor < 1.0:
        raise ValueError("field_oversample_factor must be at least 1.0.")
    weights: list[float] = []
    for row in rows:
        weights.append(oversample_factor if is_key_field_line(row) else 1.0)
    return weights


def task_balanced_sample_weights(
    rows: list[dict[str, object]],
    *,
    field_oversample_factor: float = 1.0,
    source_weights: dict[str, float] | None = None,
    task_weights: dict[str, float] | None = None,
    maximum_weight: float = 8.0,
) -> list[float]:
    if field_oversample_factor < 1.0:
        raise ValueError("field_oversample_factor must be at least 1.0.")
    if maximum_weight < 1.0:
        raise ValueError("maximum_weight must be at least 1.0.")
    source_weights = source_weights or {}
    task_weights = task_weights or {}
    _validate_sampling_weights(source_weights, "source")
    _validate_sampling_weights(task_weights, "task")
    weights: list[float] = []
    for row in rows:
        weight = float(source_weights.get(str(row.get("source") or "unknown"), 1.0))
        labels = line_task_labels(row)
        if "key_field" in labels:
            weight *= field_oversample_factor
        for label in labels:
            weight *= float(task_weights.get(label, 1.0))
        try:
            hardcase_weight = int(row.get("hardcaseWeight") or 1)
        except (TypeError, ValueError):
            hardcase_weight = 1
        if "hardcase" in labels:
            weight *= max(1, min(hardcase_weight, 4))
        weights.append(round(min(maximum_weight, max(1.0, weight)), 6))
    return weights


def line_task_labels(row: dict[str, object]) -> tuple[str, ...]:
    text = str(row.get("text") or "").strip()
    labels: set[str] = set()
    if is_key_field_line(row):
        labels.add("key_field")
    if _AMOUNT_LINE_RE.search(text):
        labels.add("amount")
    if _DATE_OR_TIME_RE.search(text):
        labels.add("date_or_time")
    if _IDENTIFIER_RE.search(text):
        labels.add("identifier")
    if any(character in TURKISH_SPECIAL_CHARACTERS for character in text):
        labels.add("turkish_special")
    if len(text) > 40:
        labels.add("long_line")
    reasons = row.get("hardcaseReasons")
    if isinstance(reasons, list) and reasons:
        labels.add("hardcase")
    if not labels:
        labels.add("general_text")
    return tuple(sorted(labels))


def _validate_sampling_weights(weights: dict[str, float], label: str) -> None:
    invalid = {key: value for key, value in weights.items() if not isinstance(value, int | float) or float(value) <= 0}
    if invalid:
        raise ValueError(f"{label} sampling weights must be positive numbers: {invalid}")


def collate(batch):
    images, targets, target_lengths, input_lengths = zip(*batch)
    for target, target_length, input_length in zip(targets, target_lengths, input_lengths, strict=True):
        required_input_length = ctc_required_input_length(target)
        if required_input_length > input_length:
            raise ValueError(
                f"CTC target requires {required_input_length} timesteps including repeated-character separators, "
                f"but the prepared line provides {input_length}."
            )
    max_width = max(image.shape[2] for image in images)
    padded = torch.full((len(images), 1, 64, max_width), 245 / 255.0, dtype=torch.float32)
    for index, image in enumerate(images):
        padded[index, :, :, : image.shape[2]] = image
    return (
        padded,
        torch.cat(targets),
        torch.tensor(target_lengths, dtype=torch.long),
        torch.tensor(input_lengths, dtype=torch.long),
    )


def ctc_required_input_length(target: torch.Tensor) -> int:
    if target.ndim != 1:
        raise ValueError("CTC target must be a one-dimensional encoded sequence.")
    values = target.tolist()
    adjacent_repeats = sum(left == right for left, right in zip(values, values[1:]))
    return len(values) + adjacent_repeats


def train_custom_ocr_model(
    data_dir: Path,
    artifact_dir: Path,
    samples: int = 32,
    epochs: int = 1,
    seed: int = 42,
    profile: str = "smoke",
    registry_path: Path | None = None,
    batch_size: int = 4,
    learning_rate: float = 1e-3,
    early_stopping_patience: int | None = None,
    min_epochs: int = 0,
    resume_from: Path | None = None,
    dataset_mode: str = "lines",
    field_oversample_factor: float = 1.0,
    temporal_downsample: int = 4,
    backbone_version: str = "legacy",
    line_image_min_width: int = 384,
    input_inverted: bool = False,
    validation_blank_penalty: float = DEFAULT_BLANK_PENALTY,
    blank_regularization: float = 0.0,
    blank_bias_init: float | None = None,
    space_regularization: float = 0.0,
    space_bias_init: float | None = None,
    alignment_auxiliary_weight: float = 0.0,
    field_only_training: bool = False,
    validation_scope: str = "all",
    reuse_existing_dataset: bool = False,
    combined_manifest_dir: Path = Path("artifacts/datasets/custom-ocr"),
    include_sources: set[str] | None = None,
    source_sample_weights: dict[str, float] | None = None,
    task_sample_weights: dict[str, float] | None = None,
    allow_train_validation_fallback: bool = False,
    progress_callback: Callable[[dict[str, object]], None] | None = None,
    progress_interval_batches: int | None = None,
) -> dict[str, object]:
    if batch_size < 1:
        raise ValueError("batch_size must be at least 1.")
    if learning_rate <= 0:
        raise ValueError("learning_rate must be positive.")
    if early_stopping_patience is not None and early_stopping_patience < 0:
        raise ValueError("early_stopping_patience must be non-negative when provided.")
    if min_epochs < 0:
        raise ValueError("min_epochs must be non-negative.")
    if field_oversample_factor < 1.0:
        raise ValueError("field_oversample_factor must be at least 1.0.")
    if temporal_downsample not in {2, 4}:
        raise ValueError("temporal_downsample must be 2 or 4.")
    if backbone_version not in {"legacy", "residual"}:
        raise ValueError("backbone_version must be 'legacy' or 'residual'.")
    if line_image_min_width < 64 or line_image_min_width > 384:
        raise ValueError("line_image_min_width must be between 64 and 384 pixels.")
    if blank_regularization < 0:
        raise ValueError("blank_regularization must be non-negative.")
    if space_regularization < 0:
        raise ValueError("space_regularization must be non-negative.")
    if alignment_auxiliary_weight < 0:
        raise ValueError("alignment_auxiliary_weight must be non-negative.")
    if validation_blank_penalty < 0 or validation_blank_penalty > 5:
        raise ValueError("validation_blank_penalty must be between 0 and 5.")
    if validation_scope not in {"all", "fields"}:
        raise ValueError("validation_scope must be 'all' or 'fields'.")
    if progress_interval_batches is not None and progress_interval_batches < 1:
        raise ValueError("progress_interval_batches must be at least 1 when provided.")
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    manifest_path = data_dir / "manifest.jsonl"
    _emit_progress(
        progress_callback,
        {
            "event": "dataset_start",
            "dataDir": str(data_dir),
            "datasetMode": dataset_mode,
            "samples": samples,
            "reuseExistingDataset": reuse_existing_dataset,
        },
    )
    if reuse_existing_dataset:
        if not manifest_path.is_file():
            raise FileNotFoundError(f"Existing CRNN dataset manifest not found: {manifest_path}")
    elif dataset_mode == "lines":
        generate_dataset(data_dir, count=samples, seed=seed)
    elif dataset_mode == "document_lines":
        generate_document_line_dataset(data_dir, count=samples, seed=seed, include_project_fixtures=True)
    elif dataset_mode == "numeric_fields":
        generate_numeric_field_dataset(data_dir, count=samples, seed=seed)
    elif dataset_mode == "combined_manifest":
        _prepare_combined_manifest_dataset(
            combined_manifest_dir,
            manifest_path,
            samples=samples,
            seed=seed,
            include_sources=include_sources,
        )
    else:
        raise ValueError(f"Unsupported CRNN training dataset mode: {dataset_mode}")
    _emit_progress(progress_callback, {"event": "dataset_ready", "manifest": str(manifest_path)})
    train_dataset = LineDataset(
        manifest_path,
        data_dir,
        split="train",
        temporal_downsample=temporal_downsample,
        line_image_min_width=line_image_min_width,
        input_inverted=input_inverted,
    )
    validation_split = "validation"
    validation_dataset = LineDataset(
        manifest_path,
        data_dir,
        split=validation_split,
        temporal_downsample=temporal_downsample,
        line_image_min_width=line_image_min_width,
        input_inverted=input_inverted,
    )
    if field_only_training:
        train_dataset.rows = [row for row in train_dataset.rows if is_key_field_line(row)]
        if not train_dataset.rows:
            raise ValueError("field_only_training selected but no key field rows were found.")
    if len(validation_dataset) == 0:
        if not allow_train_validation_fallback:
            raise ValueError(
                "A non-empty validation split is required. Train-to-validation fallback is disabled for quality-bearing training."
            )
        validation_split = "train"
        validation_dataset = LineDataset(
            manifest_path,
            data_dir,
            split=validation_split,
            temporal_downsample=temporal_downsample,
            line_image_min_width=line_image_min_width,
            input_inverted=input_inverted,
        )
    selection_validation_dataset = LineDataset(
        manifest_path,
        data_dir,
        split=validation_split,
        temporal_downsample=temporal_downsample,
        line_image_min_width=line_image_min_width,
        input_inverted=input_inverted,
    )
    if validation_scope == "fields":
        selection_validation_dataset.rows = [row for row in selection_validation_dataset.rows if is_key_field_line(row)]
        if not selection_validation_dataset.rows:
            raise ValueError("fields validation scope selected but no key field rows were found.")
    train_source_mix = _dataset_source_mix(train_dataset.rows)
    validation_source_mix = _dataset_source_mix(validation_dataset.rows)
    selection_validation_source_mix = _dataset_source_mix(selection_validation_dataset.rows)
    dataset_source_mix = _dataset_source_mix(train_dataset.rows + validation_dataset.rows)
    dataset_hardcase_reason_mix = _dataset_hardcase_reason_mix(train_dataset.rows + validation_dataset.rows)
    train_task_mix = _dataset_task_mix(train_dataset.rows)
    validation_task_mix = _dataset_task_mix(validation_dataset.rows)
    configured_source_weights = (
        dict(DEFAULT_SOURCE_SAMPLE_WEIGHTS) if dataset_mode == "combined_manifest" and source_sample_weights is None else dict(source_sample_weights or {})
    )
    configured_task_weights = (
        dict(DEFAULT_TASK_SAMPLE_WEIGHTS) if dataset_mode == "combined_manifest" and task_sample_weights is None else dict(task_sample_weights or {})
    )
    generator = torch.Generator().manual_seed(seed)
    sample_weights = task_balanced_sample_weights(
        train_dataset.rows,
        field_oversample_factor=field_oversample_factor,
        source_weights=configured_source_weights,
        task_weights=configured_task_weights,
    )
    sampler = None
    if any(abs(weight - 1.0) > 1e-9 for weight in sample_weights):
        sampler = WeightedRandomSampler(
            sample_weights,
            num_samples=len(train_dataset),
            replacement=True,
            generator=generator,
        )
    weighted_training_distribution = _weighted_training_distribution(train_dataset.rows, sample_weights)
    loader = DataLoader(
        train_dataset,
        batch_size=batch_size,
        shuffle=sampler is None,
        sampler=sampler,
        collate_fn=collate,
        generator=generator,
    )
    model = CRNNOCR(
        num_classes=len(VOCAB),
        temporal_downsample=temporal_downsample,
        backbone_version=backbone_version,
    )
    resume_metadata: dict[str, object] = {}
    if resume_from is not None:
        if not resume_from.exists():
            raise FileNotFoundError(f"Resume checkpoint not found: {resume_from}")
        resume_payload = torch.load(resume_from, map_location="cpu")
        model.load_state_dict(resume_payload["model_state"])
        resume_payload_metadata = resume_payload.get("metadata") if isinstance(resume_payload.get("metadata"), dict) else {}
        resume_temporal_downsample = resume_payload_metadata.get("temporal_downsample")
        if resume_temporal_downsample not in {2, 4}:
            resume_temporal_downsample = 2 if resume_payload_metadata.get("architecture_version") == "crnn-ctc-v2" else 4
        if int(resume_temporal_downsample) != temporal_downsample:
            raise ValueError(
                f"Resume checkpoint temporal downsample {resume_temporal_downsample} does not match {temporal_downsample}."
            )
        resume_backbone_version = str(resume_payload_metadata.get("backbone_version") or "legacy")
        if resume_backbone_version != backbone_version:
            raise ValueError(
                f"Resume checkpoint backbone {resume_backbone_version!r} does not match {backbone_version!r}."
            )
        resume_metadata = {
            "resumeFrom": str(resume_from),
            "resumeFromModelVersion": resume_payload_metadata.get("model_version"),
            "resumeFromVocabVersion": resume_payload_metadata.get("vocab_version"),
        }
        resume_vocab_version = resume_payload_metadata.get("vocab_version")
        if resume_vocab_version and resume_vocab_version != VOCAB_VERSION:
            raise ValueError(f"Resume checkpoint vocab version {resume_vocab_version!r} does not match {VOCAB_VERSION!r}.")
    elif blank_bias_init is not None:
        _initialize_blank_classifier_bias(model, blank_bias_init)
    if resume_from is None and space_bias_init is not None:
        _initialize_space_classifier_bias(model, space_bias_init)
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate)
    criterion = nn.CTCLoss(blank=0, zero_infinity=True)

    losses: list[float] = []
    best_epoch = 0
    initial_validation_metrics = (
        evaluate_crnn_model(model, validation_dataset, blank_penalty=validation_blank_penalty)
        if resume_from is not None
        else None
    )
    initial_selection_metrics = (
        initial_validation_metrics
        if resume_from is not None and validation_scope == "all"
        else evaluate_crnn_model(model, selection_validation_dataset, blank_penalty=validation_blank_penalty)
        if resume_from is not None
        else None
    )
    best_validation_cer = float(initial_selection_metrics["averageCer"]) if initial_selection_metrics else float("inf")
    best_selection_score = _checkpoint_selection_score(initial_selection_metrics) if initial_selection_metrics else float("-inf")
    best_state = copy.deepcopy(model.state_dict())
    validation_history: list[dict[str, object]] = []
    epochs_without_improvement = 0
    stopped_early = False
    for epoch in range(epochs):
        model.train()
        _emit_progress(
            progress_callback,
            {
                "event": "epoch_start",
                "epoch": epoch + 1,
                "epochs": epochs,
                "trainSamples": len(train_dataset),
                "batches": len(loader),
            },
        )
        for batch_index, (images, targets, target_lengths, input_lengths) in enumerate(loader, start=1):
            optimizer.zero_grad()
            log_probs = model(images, input_lengths)
            loss = criterion(log_probs, targets, input_lengths, target_lengths)
            if blank_regularization > 0:
                loss = loss + blank_regularization * log_probs[:, :, 0].exp().mean()
            if space_regularization > 0:
                loss = loss + space_regularization * log_probs[:, :, CHAR_TO_INDEX[" "]].exp().mean()
            if alignment_auxiliary_weight > 0:
                loss = loss + alignment_auxiliary_weight * _alignment_auxiliary_loss(
                    log_probs,
                    targets,
                    target_lengths,
                    input_lengths,
                )
            loss.backward()
            optimizer.step()
            losses.append(float(loss.detach()))
            if progress_interval_batches is not None and (
                batch_index == 1 or batch_index == len(loader) or batch_index % progress_interval_batches == 0
            ):
                _emit_progress(
                    progress_callback,
                    {
                        "event": "batch",
                        "epoch": epoch + 1,
                        "epochs": epochs,
                        "batch": batch_index,
                        "batches": len(loader),
                        "loss": round(float(loss.detach()), 6),
                    },
                )
        validation_metrics = evaluate_crnn_model(
            model,
            selection_validation_dataset,
            blank_penalty=validation_blank_penalty,
        )
        selection_score = _checkpoint_selection_score(validation_metrics)
        validation_history.append(
            {
                "epoch": epoch + 1,
                "validationScope": validation_scope,
                "checkpointSelectionScore": selection_score,
                **validation_metrics,
            }
        )
        validation_cer = float(validation_metrics["averageCer"])
        if selection_score > best_selection_score + 1e-8:
            best_selection_score = selection_score
            best_validation_cer = validation_cer
            best_epoch = epoch + 1
            best_state = copy.deepcopy(model.state_dict())
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
        if (
            early_stopping_patience is not None
            and epoch + 1 >= min_epochs
            and epochs_without_improvement > early_stopping_patience
        ):
            stopped_early = True
            _emit_progress(
                progress_callback,
                {
                    "event": "early_stopping",
                    "epoch": epoch + 1,
                    "epochsWithoutImprovement": epochs_without_improvement,
                    "patience": early_stopping_patience,
                },
            )
            break
        _emit_progress(
            progress_callback,
            {
                "event": "epoch_end",
                "epoch": epoch + 1,
                "epochs": epochs,
                "validationCer": validation_cer,
                "bestValidationCer": best_validation_cer,
                "checkpointSelectionScore": selection_score,
                "bestCheckpointSelectionScore": best_selection_score,
            },
        )

    artifact_dir.mkdir(parents=True, exist_ok=True)
    model.load_state_dict(best_state)
    final_validation_metrics = evaluate_crnn_model(
        model,
        validation_dataset,
        blank_penalty=validation_blank_penalty,
    )
    selection_validation_metrics = (
        final_validation_metrics
        if validation_scope == "all"
        else evaluate_crnn_model(model, selection_validation_dataset, blank_penalty=validation_blank_penalty)
    )
    profile_slug = _slugify_profile(profile)
    model_version = _model_version(profile_slug, seed, resume_from)
    metadata = {
        "model_name": "custom-crnn-ctc",
        "model_version": model_version,
        "architecture_version": crnn_architecture_version(temporal_downsample, backbone_version),
        "temporal_downsample": temporal_downsample,
        "backbone_version": backbone_version,
        "line_image_min_width": line_image_min_width,
        "input_inverted": input_inverted,
        "decoder_blank_penalty": validation_blank_penalty,
        "vocab_version": VOCAB_VERSION,
        "dataset_manifest_id": str(manifest_path),
        "dataset_mode": dataset_mode,
        "profile": profile,
        "seed": seed,
        "include_sources": sorted(include_sources) if include_sources else None,
        **resume_metadata,
        "metrics": {
            "bestValidationCer": best_validation_cer,
            "bestCheckpointSelectionScore": best_selection_score,
            "bestEpoch": best_epoch,
            "finalValidation": final_validation_metrics,
            "initialValidation": initial_validation_metrics,
            "selectionValidation": selection_validation_metrics,
            "initialSelectionValidation": initial_selection_metrics,
            "validationScope": validation_scope,
            "batchSize": batch_size,
            "learningRate": learning_rate,
            "earlyStoppingPatience": early_stopping_patience,
            "minEpochs": min_epochs,
            "stoppedEarly": stopped_early,
            "fieldOversampleFactor": field_oversample_factor,
            "temporalDownsample": temporal_downsample,
            "backboneVersion": backbone_version,
            "lineImageMinWidth": line_image_min_width,
            "inputInverted": input_inverted,
            "validationBlankPenalty": validation_blank_penalty,
            "blankRegularization": blank_regularization,
            "blankBiasInit": blank_bias_init,
            "spaceRegularization": space_regularization,
            "spaceBiasInit": space_bias_init,
            "alignmentAuxiliaryWeight": alignment_auxiliary_weight,
            "fieldOnlyTraining": field_only_training,
            "datasetReused": reuse_existing_dataset,
            "allowTrainValidationFallback": allow_train_validation_fallback,
            "datasetSourceMix": dataset_source_mix,
            "hardcaseReasonMix": dataset_hardcase_reason_mix,
            "trainSourceMix": train_source_mix,
            "validationSourceMix": validation_source_mix,
            "selectionValidationSourceMix": selection_validation_source_mix,
            "trainTaskMix": train_task_mix,
            "validationTaskMix": validation_task_mix,
            "sourceSampleWeights": configured_source_weights,
            "taskSampleWeights": configured_task_weights,
            "weightedTrainingDistribution": weighted_training_distribution,
            "includeSources": sorted(include_sources) if include_sources else None,
        },
    }
    model_path = artifact_dir / "model.pt"
    torch.save({"model_state": best_state, "vocab": VOCAB, "metadata": metadata, "seed": seed}, model_path)
    _emit_progress(progress_callback, {"event": "artifact_written", "modelPath": str(model_path)})
    metrics = {
        "epochs": epochs,
        "completedEpochs": len(validation_history),
        "samples": samples,
        "trainSamples": len(train_dataset),
        "validationSamples": len(validation_dataset),
        "selectionValidationSamples": len(selection_validation_dataset),
        "projectFixtureTrainingSamples": sum(
            1
            for row in train_dataset.rows + validation_dataset.rows
            if row.get("source") in {"project_real_fixture_rendered_snippet", "project_fixture_synthetic"}
        ),
        "batchSize": batch_size,
        "learningRate": learning_rate,
        "earlyStoppingPatience": early_stopping_patience,
        "minEpochs": min_epochs,
        "stoppedEarly": stopped_early,
        "resumeFrom": str(resume_from) if resume_from else None,
        "resumeFromModelVersion": resume_metadata.get("resumeFromModelVersion"),
        "initialValidation": initial_validation_metrics,
        "initialSelectionValidation": initial_selection_metrics,
        "loss": losses[-1] if losses else None,
        "vocab_version": VOCAB_VERSION,
        "model_version": metadata["model_version"],
        "profile": profile,
        "datasetMode": dataset_mode,
        "includeSources": sorted(include_sources) if include_sources else None,
        "fieldOversampleFactor": field_oversample_factor,
        "temporalDownsample": temporal_downsample,
        "backboneVersion": backbone_version,
        "lineImageMinWidth": line_image_min_width,
        "inputInverted": input_inverted,
        "validationBlankPenalty": validation_blank_penalty,
        "blankRegularization": blank_regularization,
        "blankBiasInit": blank_bias_init,
        "spaceRegularization": space_regularization,
        "spaceBiasInit": space_bias_init,
        "alignmentAuxiliaryWeight": alignment_auxiliary_weight,
        "fieldOnlyTraining": field_only_training,
        "datasetReused": reuse_existing_dataset,
        "allowTrainValidationFallback": allow_train_validation_fallback,
        "datasetSourceMix": dataset_source_mix,
        "hardcaseReasonMix": dataset_hardcase_reason_mix,
        "trainSourceMix": train_source_mix,
        "validationSourceMix": validation_source_mix,
        "selectionValidationSourceMix": selection_validation_source_mix,
        "trainTaskMix": train_task_mix,
        "validationTaskMix": validation_task_mix,
        "sourceSampleWeights": configured_source_weights,
        "taskSampleWeights": configured_task_weights,
        "weightedTrainingDistribution": weighted_training_distribution,
        "validationScope": validation_scope,
        "bestEpoch": best_epoch,
        "bestValidationCer": best_validation_cer,
        "bestCheckpointSelectionScore": best_selection_score,
        "finalValidation": final_validation_metrics,
        "selectionValidation": selection_validation_metrics,
        "validationHistory": validation_history,
        "accuracy_note": _accuracy_note(profile),
    }
    registry_path = registry_path or artifact_dir.parent / "local-model-registry.json"
    registry_metrics = json.loads(json.dumps(metrics, ensure_ascii=False))
    registry_entry = write_local_registry_entry(
        registry_path,
        LocalModelArtifact(
            model_code="CUSTOM_CRNN",
            version=str(metadata["model_version"]),
            artifact_path=str(model_path),
            dataset_manifest_id=str(manifest_path),
            vocabulary_version=VOCAB_VERSION,
            metrics=registry_metrics,
            status=_registry_status_for_profile(profile),
        ),
    )
    metrics["registryPath"] = str(registry_path)
    metrics["registryEntry"] = registry_entry
    (artifact_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    return metrics


def _emit_progress(progress_callback: Callable[[dict[str, object]], None] | None, payload: dict[str, object]) -> None:
    if progress_callback is not None:
        progress_callback(payload)


def _prepare_combined_manifest_dataset(
    combined_manifest_dir: Path,
    output_manifest_path: Path,
    samples: int,
    seed: int,
    include_sources: set[str] | None = None,
) -> None:
    train_manifest = combined_manifest_dir / "line_train.jsonl"
    validation_manifest = combined_manifest_dir / "line_validation.jsonl"
    if not train_manifest.is_file():
        raise FileNotFoundError(f"Combined Custom OCR line train manifest not found: {train_manifest}")
    if not validation_manifest.is_file():
        raise FileNotFoundError(f"Combined Custom OCR line validation manifest not found: {validation_manifest}")
    train_rows = _usable_training_rows(_read_manifest_rows(train_manifest), split="train")
    validation_rows = _usable_training_rows(_read_manifest_rows(validation_manifest), split="validation")
    if include_sources:
        train_rows = [row for row in train_rows if str(row.get("source") or "") in include_sources]
        validation_rows = [row for row in validation_rows if str(row.get("source") or "") in include_sources]
    hardcase_train_manifest = combined_manifest_dir / "hardcase_train.jsonl"
    hardcase_validation_manifest = combined_manifest_dir / "hardcase_validation.jsonl"
    if hardcase_train_manifest.is_file():
        train_rows = _merge_hardcase_rows(
            train_rows,
            _usable_training_rows(_read_manifest_rows(hardcase_train_manifest), split="train"),
            include_sources,
        )
    if hardcase_validation_manifest.is_file():
        validation_rows = _merge_hardcase_rows(
            validation_rows,
            _usable_training_rows(_read_manifest_rows(hardcase_validation_manifest), split="validation"),
            include_sources,
        )
    usable_rows = _bounded_split_rows(train_rows, validation_rows, samples=samples, seed=seed)
    if not usable_rows:
        raise ValueError(f"Combined Custom OCR manifests contain no usable line training rows: {combined_manifest_dir}")
    output_manifest_path.parent.mkdir(parents=True, exist_ok=True)
    output_manifest_path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in usable_rows) + "\n",
        encoding="utf-8",
    )


def _read_manifest_rows(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _usable_training_rows(rows: list[dict[str, object]], split: str) -> list[dict[str, object]]:
    usable_rows: list[dict[str, object]] = []
    for row in rows:
        if row.get("usableForTraining") is not True:
            continue
        if not isinstance(row.get("image"), str) or not str(row.get("image")).strip():
            continue
        usable_rows.append({**row, "split": split})
    return usable_rows


def _merge_hardcase_rows(
    base_rows: list[dict[str, object]],
    hardcase_rows: list[dict[str, object]],
    include_sources: set[str] | None,
) -> list[dict[str, object]]:
    merged_rows = [dict(row) for row in base_rows]
    row_indexes = {_training_row_identity(row): index for index, row in enumerate(merged_rows)}
    for row in hardcase_rows:
        if include_sources and str(row.get("source") or "") not in include_sources:
            continue
        identity = _training_row_identity(row)
        existing_index = row_indexes.get(identity)
        if existing_index is None:
            row_indexes[identity] = len(merged_rows)
            merged_rows.append(dict(row))
            continue
        existing = merged_rows[existing_index]
        existing_reasons = existing.get("hardcaseReasons") if isinstance(existing.get("hardcaseReasons"), list) else []
        incoming_reasons = row.get("hardcaseReasons") if isinstance(row.get("hardcaseReasons"), list) else []
        existing["hardcaseReasons"] = sorted({str(reason) for reason in (*existing_reasons, *incoming_reasons)})
        try:
            existing_weight = int(existing.get("hardcaseWeight") or 1)
        except (TypeError, ValueError):
            existing_weight = 1
        try:
            incoming_weight = int(row.get("hardcaseWeight") or 1)
        except (TypeError, ValueError):
            incoming_weight = 1
        existing["hardcaseWeight"] = max(1, min(max(existing_weight, incoming_weight), 4))
    return merged_rows


def _training_row_identity(row: dict[str, object]) -> tuple[object, ...]:
    crop = row.get("lineCropBox")
    crop_key = tuple(crop) if isinstance(crop, list) else None
    return (
        str(row.get("source") or "unknown"),
        str(row.get("split") or ""),
        str(row.get("image") or ""),
        crop_key,
        " ".join(str(row.get("text") or "").split()).casefold(),
    )


def _bounded_split_rows(train_rows: list[dict[str, object]], validation_rows: list[dict[str, object]], samples: int, seed: int) -> list[dict[str, object]]:
    if samples <= 0:
        raise ValueError("samples must be positive for combined manifest training.")
    total_available = len(train_rows) + len(validation_rows)
    if not train_rows:
        raise ValueError("Combined Custom OCR training requires a non-empty train split.")
    if not validation_rows:
        raise ValueError("Combined Custom OCR training requires an independent non-empty validation split.")
    if total_available <= samples:
        return [*train_rows, *validation_rows]
    rng = random.Random(seed)
    validation_target = max(1, min(len(validation_rows), round(samples * 0.15)))
    train_target = max(1, samples - validation_target)
    if train_target > len(train_rows):
        validation_target = min(len(validation_rows), validation_target + train_target - len(train_rows))
        train_target = len(train_rows)
    if train_target + validation_target > samples:
        train_target = max(0, samples - validation_target)
    return [
        *_source_balanced_sample(train_rows, train_target, rng),
        *_source_balanced_sample(validation_rows, validation_target, rng),
    ]


def _source_balanced_sample(
    rows: list[dict[str, object]],
    target: int,
    rng: random.Random,
) -> list[dict[str, object]]:
    if target <= 0:
        return []
    if len(rows) <= target:
        return list(rows)
    grouped: dict[str, list[dict[str, object]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("source") or "unknown"), []).append(row)
    for group in grouped.values():
        rng.shuffle(group)

    selected: list[dict[str, object]] = []
    remaining: list[dict[str, object]] = []
    source_names = sorted(grouped)
    base_quota, extra = divmod(target, len(source_names))
    for index, source in enumerate(source_names):
        group = grouped[source]
        quota = base_quota + (1 if index < extra else 0)
        take = min(len(group), quota)
        selected.extend(group[:take])
        remaining.extend(group[take:])
    if len(selected) < target:
        rng.shuffle(remaining)
        selected.extend(remaining[: target - len(selected)])
    rng.shuffle(selected)
    return selected


def _dataset_source_mix(rows: list[dict[str, object]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        source = str(row.get("source") or "unknown")
        counts[source] = counts.get(source, 0) + 1
    return dict(sorted(counts.items()))


def _dataset_hardcase_reason_mix(rows: list[dict[str, object]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        reasons = row.get("hardcaseReasons")
        if not isinstance(reasons, list):
            continue
        for reason in reasons:
            reason_key = str(reason)
            counts[reason_key] = counts.get(reason_key, 0) + 1
    return dict(sorted(counts.items()))


def _dataset_task_mix(rows: list[dict[str, object]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        for label in line_task_labels(row):
            counts[label] = counts.get(label, 0) + 1
    return dict(sorted(counts.items()))


def _weighted_training_distribution(rows: list[dict[str, object]], weights: list[float]) -> dict[str, object]:
    if len(rows) != len(weights):
        raise ValueError("Training rows and sampling weights must have equal length.")
    total_weight = sum(weights)
    by_source: dict[str, float] = {}
    by_task: dict[str, float] = {}
    for row, weight in zip(rows, weights, strict=True):
        source = str(row.get("source") or "unknown")
        by_source[source] = by_source.get(source, 0.0) + weight
        for label in line_task_labels(row):
            by_task[label] = by_task.get(label, 0.0) + weight

    def summarize(values: dict[str, float]) -> dict[str, dict[str, float]]:
        return {
            key: {
                "weight": round(value, 6),
                "expectedShare": round(value / total_weight, 6) if total_weight else 0.0,
            }
            for key, value in sorted(values.items())
        }

    return {
        "sampleCount": len(rows),
        "totalWeight": round(total_weight, 6),
        "minimumWeight": min(weights, default=0.0),
        "maximumWeight": max(weights, default=0.0),
        "bySource": summarize(by_source),
        "byTask": summarize(by_task),
    }


def _registry_status_for_profile(profile: str) -> str:
    if profile == "local_full":
        return "CANDIDATE"
    return "SMOKE_CHECK_ONLY"


def _initialize_blank_classifier_bias(model: CRNNOCR, blank_bias_init: float) -> None:
    classifier = getattr(model, "classifier", None)
    bias = getattr(classifier, "bias", None)
    if bias is None:
        raise ValueError("CRNN model classifier does not expose a bias tensor for blank initialization.")
    with torch.no_grad():
        bias[0] = float(blank_bias_init)


def _initialize_space_classifier_bias(model: CRNNOCR, space_bias_init: float) -> None:
    classifier = getattr(model, "classifier", None)
    bias = getattr(classifier, "bias", None)
    if bias is None:
        raise ValueError("CRNN model classifier does not expose a bias tensor for space initialization.")
    with torch.no_grad():
        bias[CHAR_TO_INDEX[" "]] = float(space_bias_init)


def _alignment_auxiliary_loss(
    log_probs: torch.Tensor,
    targets: torch.Tensor,
    target_lengths: torch.Tensor,
    input_lengths: torch.Tensor,
) -> torch.Tensor:
    losses: list[torch.Tensor] = []
    target_offset = 0
    for batch_index, target_length_value in enumerate(target_lengths.tolist()):
        target_length = int(target_length_value)
        input_length = int(input_lengths[batch_index].item())
        target = targets[target_offset : target_offset + target_length]
        target_offset += target_length
        if target_length <= 0 or input_length <= 0:
            continue
        if target_length == 1:
            positions = torch.tensor([max(0, input_length // 2)], device=log_probs.device, dtype=torch.long)
        else:
            positions = torch.linspace(
                0,
                max(0, input_length - 1),
                steps=target_length,
                device=log_probs.device,
            ).round().long()
        positions = positions.clamp(min=0, max=max(0, log_probs.shape[0] - 1))
        losses.append(F.nll_loss(log_probs[positions, batch_index, :], target.to(log_probs.device), reduction="mean"))
    if not losses:
        return log_probs.new_tensor(0.0)
    return torch.stack(losses).mean()


def _slugify_profile(profile: str) -> str:
    return "".join(character if character.isalnum() else "-" for character in profile.lower()).strip("-") or "custom"


def _model_version(profile_slug: str, seed: int, resume_from: Path | None = None) -> str:
    version = f"custom-crnn-{profile_slug}-seed-{seed}"
    if resume_from is None:
        return version
    resume_slug = _slugify_profile(resume_from.parent.name or resume_from.stem)
    return f"{version}-resume-{resume_slug}"


def _accuracy_note(profile: str) -> str:
    if profile == "local_full":
        return "Local full synthetic CRNN training run; evaluate benchmark metrics before production promotion."
    return "Smoke training only; not production accurate."


def parse_named_weights(values: list[str] | None, *, option_name: str) -> dict[str, float] | None:
    if not values:
        return None
    parsed: dict[str, float] = {}
    for value in values:
        name, separator, raw_weight = value.partition("=")
        if not separator or not name.strip():
            raise ValueError(f"{option_name} entries must use NAME=WEIGHT syntax: {value!r}")
        try:
            weight = float(raw_weight)
        except ValueError as exc:
            raise ValueError(f"{option_name} weight must be numeric: {value!r}") from exc
        if weight <= 0:
            raise ValueError(f"{option_name} weight must be positive: {value!r}")
        parsed[name.strip()] = weight
    return parsed


def evaluate_crnn_model(
    model: CRNNOCR,
    dataset: LineDataset,
    batch_size: int = 16,
    blank_penalty: float = DEFAULT_BLANK_PENALTY,
) -> dict[str, object]:
    if batch_size < 1:
        raise ValueError("evaluation batch_size must be at least 1.")
    rows: list[dict[str, object]] = []
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, collate_fn=collate)
    row_index = 0
    model.eval()
    with torch.no_grad():
        for images, _targets, _target_lengths, input_lengths in loader:
            log_probs = model(images, input_lengths)
            for batch_index, input_length in enumerate(input_lengths.tolist()):
                reference = str(dataset.rows[row_index]["text"])
                prediction = decode_ctc_prediction(
                    log_probs[:input_length, batch_index : batch_index + 1],
                    blank_penalty=blank_penalty,
                )
                rows.append(
                    {
                        "reference": reference,
                        "prediction": prediction.text,
                        "confidence": prediction.confidence,
                        "cer": cer(reference, prediction.text),
                        "wer": wer(reference, prediction.text),
                        "exactMatch": reference == prediction.text,
                        "source": dataset.rows[row_index].get("source") or "unknown",
                    }
                )
                row_index += 1
    metrics = summarize_prediction_rows(rows)
    metrics["sourceMix"] = _dataset_source_mix(dataset.rows)
    metrics["bySource"] = _summarize_prediction_rows_by_source(rows)
    return metrics


def _checkpoint_selection_score(metrics: dict[str, object]) -> float:
    cer_quality = 1.0 - min(max(float(metrics.get("averageCer") or 1.0), 0.0), 1.0)
    token_f1 = _bounded_metric(metrics.get("tokenF1"))
    turkish_f1 = _bounded_metric(metrics.get("turkishSpecialCharacterF1"))
    amount_f1 = _bounded_metric(metrics.get("amountF1"))
    exact_match = _bounded_metric(metrics.get("exactMatchRate"))
    by_source = metrics.get("bySource")
    source_cer_values = [
        float(source_metrics.get("averageCer") or 1.0)
        for source_metrics in by_source.values()
        if isinstance(source_metrics, dict)
    ] if isinstance(by_source, dict) else []
    worst_source_quality = 1.0 - min(max(source_cer_values, default=1.0), 1.0)
    return round(
        0.35 * cer_quality
        + 0.20 * token_f1
        + 0.15 * turkish_f1
        + 0.15 * amount_f1
        + 0.05 * exact_match
        + 0.10 * worst_source_quality,
        8,
    )


def _bounded_metric(value: object) -> float:
    if not isinstance(value, int | float):
        return 0.0
    return min(max(float(value), 0.0), 1.0)


def _summarize_prediction_rows_by_source(rows: list[dict[str, object]]) -> dict[str, object]:
    grouped: dict[str, list[dict[str, object]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("source") or "unknown"), []).append(row)
    return {source: summarize_prediction_rows(source_rows) for source, source_rows in sorted(grouped.items())}


def main() -> None:
    configure_utf8_stdout()
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path("data/generated/ocr-smoke"))
    parser.add_argument("--artifact-dir", type=Path, default=Path("artifacts/models/custom-crnn-smoke"))
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--early-stopping-patience", type=int)
    parser.add_argument("--min-epochs", type=int, default=0)
    parser.add_argument("--resume-from", type=Path)
    parser.add_argument("--dataset-mode", choices=("lines", "document_lines", "numeric_fields", "combined_manifest"), default="lines")
    parser.add_argument("--combined-manifest-dir", type=Path, default=Path("artifacts/datasets/custom-ocr"))
    parser.add_argument("--field-oversample-factor", type=float, default=1.0)
    parser.add_argument("--temporal-downsample", type=int, choices=(2, 4), default=4)
    parser.add_argument("--backbone-version", choices=("legacy", "residual"), default="legacy")
    parser.add_argument("--line-image-min-width", type=int, default=384)
    parser.add_argument("--invert-input", action="store_true")
    parser.add_argument("--validation-blank-penalty", type=float, default=DEFAULT_BLANK_PENALTY)
    parser.add_argument("--blank-regularization", type=float, default=0.0)
    parser.add_argument("--blank-bias-init", type=float)
    parser.add_argument("--space-regularization", type=float, default=0.0)
    parser.add_argument("--space-bias-init", type=float)
    parser.add_argument("--alignment-auxiliary-weight", type=float, default=0.0)
    parser.add_argument("--field-only-training", action="store_true")
    parser.add_argument("--validation-scope", choices=("all", "fields"), default="all")
    parser.add_argument("--reuse-existing-dataset", action="store_true")
    parser.add_argument("--allow-train-validation-fallback", action="store_true")
    parser.add_argument("--source-weight", action="append", metavar="SOURCE=WEIGHT")
    parser.add_argument("--task-weight", action="append", metavar="TASK=WEIGHT")
    parser.add_argument(
        "--include-sources",
        nargs="+",
        help="Limit combined_manifest training to these source names, for controlled source-specific experiments.",
    )
    args = parser.parse_args()

    metrics = train_custom_ocr_model(
        data_dir=args.data_dir,
        artifact_dir=args.artifact_dir,
        samples=args.samples,
        epochs=args.epochs,
        seed=args.seed,
        profile="smoke",
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        early_stopping_patience=args.early_stopping_patience,
        min_epochs=args.min_epochs,
        resume_from=args.resume_from,
        dataset_mode=args.dataset_mode,
        field_oversample_factor=args.field_oversample_factor,
        temporal_downsample=args.temporal_downsample,
        backbone_version=args.backbone_version,
        line_image_min_width=args.line_image_min_width,
        input_inverted=args.invert_input,
        validation_blank_penalty=args.validation_blank_penalty,
        blank_regularization=args.blank_regularization,
        blank_bias_init=args.blank_bias_init,
        space_regularization=args.space_regularization,
        space_bias_init=args.space_bias_init,
        alignment_auxiliary_weight=args.alignment_auxiliary_weight,
        field_only_training=args.field_only_training,
        validation_scope=args.validation_scope,
        reuse_existing_dataset=args.reuse_existing_dataset,
        combined_manifest_dir=args.combined_manifest_dir,
        include_sources=set(args.include_sources) if args.include_sources else None,
        source_sample_weights=parse_named_weights(args.source_weight, option_name="--source-weight"),
        task_sample_weights=parse_named_weights(args.task_weight, option_name="--task-weight"),
        allow_train_validation_fallback=args.allow_train_validation_fallback,
    )
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
