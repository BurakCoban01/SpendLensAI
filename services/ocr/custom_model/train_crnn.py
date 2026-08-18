from __future__ import annotations

import argparse
import json
from pathlib import Path

from services.ocr.custom_model.cli import configure_utf8_stdout
from services.ocr.custom_model.train import parse_named_weights, train_custom_ocr_model
from services.ocr.custom_model.infer import DEFAULT_BLANK_PENALTY


PROFILE_DEFAULTS = {
    "tiny": {"samples": 32, "epochs": 1},
    "demo": {"samples": 128, "epochs": 2},
    "benchmark": {"samples": 512, "epochs": 3},
    "local_full": {"samples": 2048, "epochs": 5},
}


def main() -> None:
    configure_utf8_stdout()
    parser = argparse.ArgumentParser(description="Train the project-owned CRNN+CTC OCR recognizer.")
    parser.add_argument("--profile", choices=tuple(PROFILE_DEFAULTS), default="local_full")
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument("--artifact-dir", type=Path, default=Path("artifacts/models/custom-crnn-local-full"))
    parser.add_argument("--samples", type=int, default=None)
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--early-stopping-patience", type=int, default=None)
    parser.add_argument("--min-epochs", type=int, default=0)
    parser.add_argument("--resume-from", type=Path, default=None)
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
    parser.add_argument("--progress-interval-batches", type=int, default=100)
    args = parser.parse_args()

    defaults = PROFILE_DEFAULTS[args.profile]
    data_dir = args.data_dir or Path("data/generated") / f"ocr-{args.profile}-{args.dataset_mode}"
    metrics = train_custom_ocr_model(
        data_dir=data_dir,
        artifact_dir=args.artifact_dir,
        samples=args.samples or defaults["samples"],
        epochs=args.epochs or defaults["epochs"],
        seed=args.seed,
        profile=args.profile,
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
        progress_callback=_print_progress,
        progress_interval_batches=args.progress_interval_batches,
    )
    print(json.dumps({"profile": args.profile, **metrics}, ensure_ascii=False, indent=2))


def _print_progress(payload: dict[str, object]) -> None:
    print(json.dumps({"type": "custom_ocr_training_progress", **payload}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
