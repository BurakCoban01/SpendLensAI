from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from services.ocr.custom_model.cli import configure_utf8_stdout


KNOWN_DATASETS: dict[str, dict[str, object]] = {
    "CORD": {
        "aliases": ["CORD", "Consolidated Receipt"],
        "source_url": "https://github.com/clovaai/cord",
        "license_note": "Use only if local copy/license permits research usage.",
        "manual_review_note": "English/Indonesian receipt layout source; not Turkish proof.",
        "contains_turkish": False,
        "default_use": "layout benchmark only",
        "usable_for_character_training": False,
        "usable_for_line_training": True,
        "usable_for_document_benchmark": True,
        "usable_for_extraction_benchmark": True,
        "required_transform": "parse CORD annotations into receipt layout fields and line crops; do not claim Turkish accuracy",
    },
    "SROIE": {
        "aliases": ["SROIE", "Scanned Receipts"],
        "source_url": "https://rrc.cvc.uab.es/?ch=13",
        "license_note": "Use only if local copy/license permits research usage.",
        "manual_review_note": "English receipt layout source; not Turkish proof.",
        "contains_turkish": False,
        "default_use": "receipt layout benchmark only",
        "usable_for_character_training": False,
        "usable_for_line_training": True,
        "usable_for_document_benchmark": True,
        "usable_for_extraction_benchmark": True,
        "required_transform": "parse SROIE box/transcription labels into receipt layout fields and line crops when present",
    },
    "EMNIST": {
        "aliases": ["EMNIST", "Extended MNIST"],
        "source_url": "https://www.nist.gov/itl/products-and-services/emnist-dataset",
        "license_note": "Public character dataset; adapter is optional and explicit.",
        "manual_review_note": "Alphanumeric only; no Turkish special character claim.",
        "contains_turkish": False,
        "default_use": "alphanumeric pretraining/benchmark",
        "usable_for_character_training": True,
        "usable_for_line_training": False,
        "usable_for_document_benchmark": False,
        "usable_for_extraction_benchmark": False,
        "required_transform": "convert IDX/MAT files to labeled character crops if local license allows",
    },
    "OCRTurk": {
        "aliases": ["OCRTurk"],
        "source_url": "local/manual Turkish OCR source",
        "license_note": "Local/manual source must be verified before training use.",
        "manual_review_note": "Use only parseable, locally licensed Turkish OCR labels.",
        "contains_turkish": True,
        "default_use": "Turkish OCR benchmark/training when license allows",
        "usable_for_character_training": True,
        "usable_for_line_training": True,
        "usable_for_document_benchmark": True,
        "usable_for_extraction_benchmark": False,
        "required_transform": "parse image/text pairs or annotation files; skip unknown structures",
    },
    "Turkish-Hun-Eng": {
        "aliases": ["Turkish-Hun-Eng", "T-H-E", "Handwritten Char"],
        "source_url": "local/manual Turkish-Hungarian-English character dataset",
        "license_note": "Local/manual source must be verified before training use.",
        "manual_review_note": "Turkish special character character-model source when labels are parseable.",
        "contains_turkish": True,
        "default_use": "Turkish special character training/evaluation",
        "usable_for_character_training": True,
        "usable_for_line_training": False,
        "usable_for_document_benchmark": False,
        "usable_for_extraction_benchmark": False,
        "required_transform": "parse labeled character folders/files; skip unknown structures",
    },
}
MAX_CHECKSUM_BYTES = 50 * 1024 * 1024
DATASET_ADAPTER_CACHE_SCHEMA_VERSION = 1
DATASET_ADAPTER_IMPLEMENTATION_VERSION = "2026-07-10-real-source-cache-v1"
DATASET_ADAPTER_SOURCE_VERSIONS = {
    "OCRTurk": "2026-07-10-ocrturk-long-line-chunks-v2",
}
SAMPLE_CHECKSUM_FILE_LIMIT = 24
SAMPLE_CHECKSUM_BYTES_PER_EDGE = 4096
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".gif", ".pdf"}
EMNIST_BALANCED_CHARACTERS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabdefghnqrt"
EMNIST_TRAIN_SAMPLES_PER_CLASS = 100
EMNIST_VALIDATION_SAMPLES_PER_CLASS = 20
THE_CLASS_LABELS = {
    **{index + 1: character for index, character in enumerate("abcdefghijklmnopqrstuvwxyz")},
    27: "ç",
    28: "ğ",
    29: "ı",
    30: "ş",
    31: "ö",
    32: "ü",
    40: "A",
    41: "B",
    42: "C",
    43: "D",
    44: "E",
    45: "F",
    46: "G",
    47: "H",
    48: "I",
    49: "J",
    50: "K",
    51: "L",
    52: "M",
    53: "N",
    54: "O",
    55: "P",
    56: "Q",
    57: "R",
    58: "S",
    59: "T",
    60: "U",
    61: "V",
    62: "W",
    63: "X",
    64: "Y",
    65: "Z",
    66: "Ç",
    67: "Ğ",
    68: "İ",
    69: "Ş",
    70: "Ö",
    71: "Ü",
}
THE_VERSION_II_LABELS = {
    1: "ç",
    2: "ğ",
    3: "ı",
    4: "ş",
    5: "ö",
    6: "ü",
    7: "Ç",
    8: "Ğ",
    9: "İ",
    10: "Ş",
    11: "Ö",
    12: "Ü",
}
THE_TRAIN_SAMPLES_PER_CLASS = 120
THE_VALIDATION_SAMPLES_PER_CLASS = 30
COMBINED_MANIFEST_KEYS = (
    "character_train",
    "character_validation",
    "line_train",
    "line_validation",
    "document_benchmark",
    "project_fixture_benchmark",
    "hardcase_train",
    "hardcase_validation",
)
TURKISH_SPECIAL_CHARACTERS = set("çğıİöşüÇĞIÖŞÜ")
HARDCONFUSION_CHARACTERS = set("Iİıil1OÖ0SŞ5GĞcçuü,.;:₺")
FIELD_KEYWORD_RE = re.compile(
    r"\b("
    r"toplam|total|tutar|amount|kdv|vat|tax|ara\s*toplam|subtotal|"
    r"indirim|discount|nakit|kart|visa|mastercard|iban|dekont|fis|fiş|"
    r"fatura|invoice|tarih|date|saat|time"
    r")\b",
    re.IGNORECASE,
)
AMOUNT_RE = re.compile(r"(?:₺\s*)?\d{1,3}(?:[.\s]\d{3})*[,.]\d{1,2}(?:\s*(?:TL|TRY|₺))?|\b\d+[,.]\d{1,2}\s*(?:TL|TRY|₺)?", re.IGNORECASE)
DATE_RE = re.compile(r"\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b")


def _empty_combined_rows() -> dict[str, list[dict[str, object]]]:
    return {key: [] for key in COMBINED_MANIFEST_KEYS}


def _empty_adapter_summary(reason: str) -> dict[str, object]:
    return {
        "parseability_status": "not_present" if reason == "dataset not present" else "not_parseable",
        "sample_count_imported": 0,
        "skipped_count": 0,
        "skipped_reason": reason,
        "imported_manifest_counts": {key: 0 for key in COMBINED_MANIFEST_KEYS},
        "rows": _empty_combined_rows(),
    }


def _collect_parseable_dataset_rows(
    name: str,
    path: Path,
    metadata: dict[str, object],
    asset_root: Path | None = None,
    *,
    generate_missing_character_assets: bool = True,
) -> dict[str, object]:
    rows = _empty_combined_rows()
    skipped_reason = ""
    skipped_count = 0
    if name == "CORD":
        _collect_cord_rows(
            path,
            metadata,
            rows,
            asset_root / "cord-numeric-characters" if asset_root else None,
            generate_missing_character_assets=generate_missing_character_assets,
        )
        parseability_status = "parseable_cord_json" if rows["line_train"] or rows["line_validation"] or rows["document_benchmark"] else "not_parseable"
    elif name == "SROIE":
        _collect_sroie_rows(
            path,
            metadata,
            rows,
            asset_root / "sroie-numeric-characters" if asset_root else None,
            generate_missing_character_assets=generate_missing_character_assets,
        )
        parseability_status = "parseable_sroie_box_entities" if rows["line_train"] or rows["line_validation"] or rows["document_benchmark"] else "not_parseable"
    elif name == "OCRTurk":
        _collect_ocrturk_rows(path, metadata, rows, asset_root / "ocrturk-lines" if asset_root else None)
        parseability_status = (
            "parseable_pdf_text_lines"
            if rows["line_train"] or rows["line_validation"]
            else "parseable_text_pdf_pairs"
            if rows["document_benchmark"]
            else "inventory_only"
        )
        if not rows["document_benchmark"]:
            skipped_reason = "No Markdown/PDF source pairs were found."
    elif name == "EMNIST":
        imported, available = _collect_emnist_rows(path, metadata, rows, asset_root / "emnist-balanced" if asset_root else None)
        parseability_status = "parseable_emnist_balanced_idx" if imported else "not_parseable"
        skipped_count = max(0, available - imported)
        if imported:
            skipped_reason = (
                "The canonical balanced split is sampled deterministically per class; overlapping EMNIST variants "
                "are not duplicated, and EMNIST is not Turkish-character evidence."
            )
        else:
            skipped_reason = "A matching EMNIST balanced image/label IDX pair was not found or failed validation."
    elif name == "Turkish-Hun-Eng":
        if _has_lfs_pointer_csv(path):
            parseability_status = "blocked_lfs_pointer"
            skipped_reason = "CSV files are Git LFS pointer files; real character data is not present locally."
        else:
            imported, available, skipped_reason = _collect_turkish_hun_eng_rows(
                path,
                metadata,
                rows,
                asset_root / "turkish-hun-eng-characters" if asset_root else None,
            )
            skipped_count = max(0, available - imported)
            parseability_status = "parseable_the_character_payload" if imported else "not_parseable"
            if imported and not skipped_reason:
                skipped_reason = (
                    "Only characters present in the active OCR vocabulary are imported; unsupported Hungarian-only "
                    "classes are inventoried but not used for Custom OCR training."
                )
    else:
        parseability_status = "inventory_only"
        skipped_reason = "No adapter is implemented for this dataset."

    imported_counts = {key: len(value) for key, value in rows.items()}
    imported_total = sum(imported_counts.values())
    if imported_total == 0 and not skipped_reason:
        skipped_reason = "Local structure was inventoried, but no parseable labeled rows were imported."
    return {
        "parseability_status": parseability_status,
        "sample_count_imported": imported_total,
        "skipped_count": skipped_count if imported_total else _count_dataset_files(path),
        "skipped_reason": skipped_reason or None,
        "imported_manifest_counts": imported_counts,
        "rows": rows,
    }


def _collect_cord_rows(
    path: Path,
    metadata: dict[str, object],
    rows: dict[str, list[dict[str, object]]],
    character_asset_dir: Path | None = None,
    *,
    generate_missing_character_assets: bool = True,
) -> None:
    for json_path in sorted(path.rglob("*.json")):
        try:
            payload = json.loads(json_path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        split = _split_from_parts(json_path.parts)
        image_path = _cord_image_for_json(json_path)
        lines: list[str] = []
        for index, line in enumerate(payload.get("valid_line", [])):
            words = line.get("words", []) if isinstance(line, dict) else []
            text = " ".join(str(word.get("text", "")).strip() for word in words if isinstance(word, dict) and str(word.get("text", "")).strip()).strip()
            if not text:
                continue
            line_crop_box = _cord_line_crop_box(words)
            if image_path is None or line_crop_box is None:
                continue
            row = _dataset_row(
                row_id=f"CORD:{json_path.stem}:line:{index}",
                source="CORD",
                image=image_path,
                text=text,
                split=split,
                document_type="receipt",
                fields={"category": line.get("category")} if isinstance(line, dict) else {},
                license_note=str(metadata["license_note"]),
                usable_for_training=True,
                usable_for_benchmark=True,
                manual_review_note="CORD is not Turkish proof; use for layout/receipt line learning only.",
                line_crop_box=line_crop_box,
            )
            rows["line_train" if split == "train" else "line_validation"].append(row)
            _append_real_numeric_character_rows(
                rows,
                source="CORD_numeric_character",
                row_id_prefix=f"CORD:{json_path.stem}:line:{index}",
                image_path=image_path,
                line_crop_box=line_crop_box,
                text=text,
                split=split,
                document_type="receipt",
                license_note=str(metadata["license_note"]),
                character_asset_dir=character_asset_dir,
                generate_missing_character_assets=generate_missing_character_assets,
            )
            lines.append(text)
        if lines and image_path is not None:
            rows["document_benchmark"].append(
                _dataset_row(
                    row_id=f"CORD:{json_path.stem}:document",
                    source="CORD",
                    image=image_path,
                    text="\n".join(lines),
                    split="benchmark",
                    document_type="receipt",
                    fields={},
                    license_note=str(metadata["license_note"]),
                    usable_for_training=False,
                    usable_for_benchmark=True,
                    manual_review_note="CORD layout benchmark; not a Turkish OCR readiness claim.",
                )
            )


def _collect_sroie_rows(
    path: Path,
    metadata: dict[str, object],
    rows: dict[str, list[dict[str, object]]],
    character_asset_dir: Path | None = None,
    *,
    generate_missing_character_assets: bool = True,
) -> None:
    for box_path in sorted(path.rglob("box/*.txt")):
        split = _split_from_parts(box_path.parts)
        image_path = box_path.parent.parent / "img" / f"{box_path.stem}.jpg"
        lines: list[str] = []
        try:
            raw_lines = box_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for index, raw_line in enumerate(raw_lines):
            parts = raw_line.split(",", 8)
            if len(parts) < 9:
                continue
            text = parts[8].strip()
            if not text:
                continue
            if _has_corrupt_label_text(text):
                continue
            if not image_path.exists():
                continue
            line_crop_box = _sroie_line_crop_box(parts[:8])
            if line_crop_box is None:
                continue
            row = _dataset_row(
                row_id=f"SROIE:{box_path.stem}:line:{index}",
                source="SROIE",
                image=image_path,
                text=text,
                split=split,
                document_type="receipt",
                fields={},
                license_note=str(metadata["license_note"]),
                usable_for_training=True,
                usable_for_benchmark=True,
                manual_review_note="SROIE is non-Turkish receipt/layout data; do not use as Turkish success proof.",
                line_crop_box=line_crop_box,
            )
            rows["line_train" if split == "train" else "line_validation"].append(row)
            _append_real_numeric_character_rows(
                rows,
                source="SROIE_numeric_character",
                row_id_prefix=f"SROIE:{box_path.stem}:line:{index}",
                image_path=image_path,
                line_crop_box=line_crop_box,
                text=text,
                split=split,
                document_type="receipt",
                license_note=str(metadata["license_note"]),
                character_asset_dir=character_asset_dir,
                generate_missing_character_assets=generate_missing_character_assets,
            )
            lines.append(text)
        if lines and image_path.exists():
            fields = _load_sroie_entity_fields(box_path.parent.parent / "entities" / box_path.name)
            rows["document_benchmark"].append(
                _dataset_row(
                    row_id=f"SROIE:{box_path.stem}:document",
                    source="SROIE",
                    image=image_path,
                    text="\n".join(lines),
                    split="benchmark",
                    document_type="receipt",
                    fields=fields,
                    license_note=str(metadata["license_note"]),
                    usable_for_training=False,
                    usable_for_benchmark=True,
                    manual_review_note="SROIE extraction/layout benchmark; not a Turkish OCR readiness claim.",
                )
            )


def _append_real_numeric_character_rows(
    rows: dict[str, list[dict[str, object]]],
    *,
    source: str,
    row_id_prefix: str,
    image_path: Path,
    line_crop_box: list[int],
    text: str,
    split: str,
    document_type: str,
    license_note: str,
    character_asset_dir: Path | None,
    generate_missing_character_assets: bool,
) -> None:
    if character_asset_dir is None:
        return
    numeric_tokens = _numeric_training_tokens(text)
    if not numeric_tokens:
        return
    from services.ocr.custom_model.vocab import CHAR_TO_INDEX

    manifest_key = "character_train" if split == "train" else "character_validation"
    character_asset_dir.mkdir(parents=True, exist_ok=True)
    if _append_cached_numeric_character_rows(
        rows,
        source=source,
        row_id_prefix=row_id_prefix,
        numeric_tokens=numeric_tokens,
        split=split,
        document_type=document_type,
        license_note=license_note,
        character_asset_dir=character_asset_dir,
        manifest_key=manifest_key,
        supported_characters=set(CHAR_TO_INDEX),
    ):
        return
    if not generate_missing_character_assets:
        return
    try:
        image = Image.open(image_path).convert("L").crop(tuple(line_crop_box))
    except OSError:
        return

    from services.ocr.custom_model.numeric_field_recognizer import character_box_to_tensor, image_to_gray_and_binary
    from services.ocr.custom_model.segmentation import SegmentBox, segment_characters, segment_words

    local_gray, local_binary = image_to_gray_and_binary(image)
    local_line = SegmentBox(0, 0, local_gray.shape[1], local_gray.shape[0], "line")
    label_words = text.split()
    visual_words = segment_words(local_binary, local_line)
    if len(label_words) != len(visual_words):
        return

    for word_index, token in numeric_tokens:
        if word_index >= len(visual_words):
            continue
        characters = segment_characters(local_binary, visual_words[word_index])
        if len(characters) != len(token) or any(character not in CHAR_TO_INDEX for character in token):
            continue
        for character_index, (character, character_box) in enumerate(zip(token, characters, strict=True)):
            tensor = character_box_to_tensor(local_gray, character_box)
            character_image = Image.fromarray(
                np.clip(tensor.squeeze(0).numpy() * 255.0, 0, 255).astype(np.uint8),
                mode="L",
            )
            character_path = character_asset_dir / f"{_safe_asset_name(row_id_prefix)}-w{word_index:02d}-c{character_index:02d}.png"
            if not character_path.is_file():
                character_image.save(character_path, format="PNG")
            rows[manifest_key].append(
                {
                    "id": f"{source}:{row_id_prefix}:word:{word_index}:char:{character_index}",
                    "image": _workspace_relative(character_path),
                    "text": character,
                    "character": character,
                    "split": split,
                    "source": source,
                    "documentType": document_type,
                    "usableForTraining": True,
                    "usableForBenchmark": True,
                    "licenseNote": license_note,
                    "manualReviewNote": (
                        "Receipt amount character crop retained only when numeric label length exactly matches "
                        "the visual character segmentation."
                    ),
                }
            )


def _append_cached_numeric_character_rows(
    rows: dict[str, list[dict[str, object]]],
    *,
    source: str,
    row_id_prefix: str,
    numeric_tokens: list[tuple[int, str]],
    split: str,
    document_type: str,
    license_note: str,
    character_asset_dir: Path,
    manifest_key: str,
    supported_characters: set[str],
) -> bool:
    expected_paths: list[tuple[int, int, str, Path]] = []
    safe_prefix = _safe_asset_name(row_id_prefix)
    for word_index, token in numeric_tokens:
        if any(character not in supported_characters for character in token):
            return False
        for character_index, character in enumerate(token):
            character_path = character_asset_dir / f"{safe_prefix}-w{word_index:02d}-c{character_index:02d}.png"
            if not character_path.is_file():
                return False
            expected_paths.append((word_index, character_index, character, character_path))
    if not expected_paths:
        return False
    for word_index, character_index, character, character_path in expected_paths:
        rows[manifest_key].append(
            {
                "id": f"{source}:{row_id_prefix}:word:{word_index}:char:{character_index}",
                "image": _workspace_relative(character_path),
                "text": character,
                "character": character,
                "split": split,
                "source": source,
                "documentType": document_type,
                "usableForTraining": True,
                "usableForBenchmark": True,
                "licenseNote": license_note,
                "manualReviewNote": (
                    "Receipt amount character crop reused from a previously verified exact-length numeric segmentation."
                ),
            }
        )
    return True


def _numeric_training_tokens(text: str) -> list[tuple[int, str]]:
    tokens: list[tuple[int, str]] = []
    for index, raw_word in enumerate(text.split()):
        token = raw_word.strip().strip("()[]{}:;")
        token = token.removeprefix("₺").removeprefix("$").removesuffix("TL").removesuffix("TRY")
        token = token.strip()
        if re.fullmatch(r"\d+(?:[,.]\d+)+|\d{2,}", token):
            tokens.append((index, token))
    return tokens


def _safe_asset_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")[:96] or "numeric-character"


def _collect_ocrturk_rows(
    path: Path,
    metadata: dict[str, object],
    rows: dict[str, list[dict[str, object]]],
    line_asset_dir: Path | None = None,
) -> None:
    markdown_paths = sorted(path.rglob("data_*.md"))
    for document_index, md_path in enumerate(markdown_paths):
        try:
            text = _repair_mojibake(md_path.read_text(encoding="utf-8", errors="replace")).strip()
        except OSError:
            continue
        if not text:
            continue
        pdf_path = md_path.with_suffix(".pdf")
        rows["document_benchmark"].append(
            _dataset_row(
                row_id=f"OCRTurk:{md_path.parent.name}",
                source="OCRTurk",
                image=pdf_path if pdf_path.exists() else md_path,
                text=text,
                split="benchmark",
                document_type="unknown",
                fields={},
                license_note=str(metadata["license_note"]),
                usable_for_training=False,
                usable_for_benchmark=True,
                manual_review_note="OCRTurk text/PDF pair; use for Turkish OCR qualitative/document benchmark unless line boxes are added.",
            )
        )
        if pdf_path.exists() and line_asset_dir is not None:
            _collect_ocrturk_pdf_line_rows(
                pdf_path,
                document_index=document_index,
                document_count=len(markdown_paths),
                metadata=metadata,
                rows=rows,
                output_dir=line_asset_dir,
            )


def _collect_ocrturk_pdf_line_rows(
    pdf_path: Path,
    *,
    document_index: int,
    document_count: int,
    metadata: dict[str, object],
    rows: dict[str, list[dict[str, object]]],
    output_dir: Path,
) -> None:
    try:
        import fitz  # type: ignore[import-not-found]
    except ImportError:
        return

    split = _ocrturk_line_split(document_index, document_count)
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        document = fitz.open(pdf_path)
    except (OSError, RuntimeError, ValueError):
        return
    try:
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            page_dict = page.get_text("dict")
            scaled_page_size = (max(1, round(float(page.rect.width) * 2.0)), max(1, round(float(page.rect.height) * 2.0)))
            candidate_lines: list[tuple[str, str, tuple[int, int, int, int], Path, str]] = []
            line_index = 0
            for block in page_dict.get("blocks", []):
                if not isinstance(block, dict) or block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    if not isinstance(line, dict):
                        continue
                    text = _normalized_pdf_line_text(line)
                    bbox = line.get("bbox")
                    if not _usable_ocrturk_line(text, bbox):
                        continue
                    crop_box = _scaled_pdf_crop_box(bbox, scaled_page_size, scale=2.0, padding=4)
                    if crop_box is None:
                        continue
                    file_name = f"{pdf_path.stem}-p{page_index + 1:03d}-l{line_index:04d}.png"
                    crop_path = output_dir / file_name
                    candidate_lines.append((str(line_index), text, crop_box, crop_path, "full_line"))
                    for chunk_index, (chunk_text, chunk_bbox) in enumerate(_ocrturk_line_chunks(line)):
                        chunk_crop_box = _scaled_pdf_crop_box(chunk_bbox, scaled_page_size, scale=2.0, padding=4)
                        if chunk_crop_box is None:
                            continue
                        chunk_path = output_dir / (
                            f"{pdf_path.stem}-p{page_index + 1:03d}-l{line_index:04d}-c{chunk_index:02d}.png"
                        )
                        candidate_lines.append(
                            (f"{line_index}:chunk:{chunk_index}", chunk_text, chunk_crop_box, chunk_path, "long_line_chunk")
                        )
                    line_index += 1
            missing_crops = [
                crop_path
                for _line_id, _text, _crop_box, crop_path, _line_kind in candidate_lines
                if not crop_path.is_file()
            ]
            page_image: Image.Image | None = None
            if missing_crops:
                matrix = fitz.Matrix(2.0, 2.0)
                pixmap = page.get_pixmap(matrix=matrix, colorspace=fitz.csGRAY, alpha=False)
                page_image = Image.frombytes("L", (pixmap.width, pixmap.height), pixmap.samples)
            for line_id, text, crop_box, crop_path, line_kind in candidate_lines:
                if page_image is not None and not crop_path.is_file():
                    crop = page_image.crop(crop_box)
                    if crop.width < 4 or crop.height < 4:
                        continue
                    crop.save(crop_path, format="PNG")
                if not crop_path.is_file():
                    continue
                rows["line_train" if split == "train" else "line_validation"].append(
                    _dataset_row(
                        row_id=f"OCRTurk:{pdf_path.parent.name}:p{page_index + 1}:line:{line_id}",
                        source="OCRTurk",
                        image=crop_path,
                        text=text,
                        split=split,
                        document_type="unknown",
                        fields={},
                        license_note=str(metadata["license_note"]),
                        usable_for_training=True,
                        usable_for_benchmark=True,
                        manual_review_note=(
                            "OCRTurk PDF text-layer long-line chunk; preserves readable glyph scale for CRNN training."
                            if line_kind == "long_line_chunk"
                            else "OCRTurk PDF text-layer line crop; Turkish printed-text training/evaluation source."
                        ),
                    )
                )
    finally:
        document.close()


def _normalized_pdf_line_text(line: dict[str, object]) -> str:
    spans = line.get("spans")
    if not isinstance(spans, list):
        return ""
    text = "".join(str(span.get("text") or "") for span in spans if isinstance(span, dict))
    return re.sub(r"\s+", " ", _repair_mojibake(text)).strip()


def _ocrturk_line_chunks(
    line: dict[str, object],
    *,
    maximum_characters: int = 48,
    minimum_line_characters: int = 56,
) -> list[tuple[str, tuple[float, float, float, float]]]:
    text = _normalized_pdf_line_text(line)
    if len(text) < minimum_line_characters:
        return []
    spans = line.get("spans")
    if not isinstance(spans, list):
        return []
    positioned_tokens: list[tuple[str, tuple[float, float, float, float]]] = []
    for span in spans:
        if not isinstance(span, dict):
            continue
        span_text = _repair_mojibake(str(span.get("text") or ""))
        bbox = span.get("bbox")
        if not isinstance(bbox, list | tuple) or len(bbox) != 4 or not span_text:
            continue
        try:
            x0, y0, x1, y1 = (float(value) for value in bbox)
        except (TypeError, ValueError):
            continue
        span_width = max(1.0, x1 - x0)
        for match in re.finditer(r"\S+", span_text):
            token = match.group(0)
            token_x0 = x0 + span_width * match.start() / max(len(span_text), 1)
            token_x1 = x0 + span_width * match.end() / max(len(span_text), 1)
            if len(token) <= maximum_characters:
                positioned_tokens.append((token, (token_x0, y0, token_x1, y1)))
                continue
            for offset in range(0, len(token), maximum_characters):
                part = token[offset : offset + maximum_characters]
                part_x0 = token_x0 + (token_x1 - token_x0) * offset / len(token)
                part_x1 = token_x0 + (token_x1 - token_x0) * (offset + len(part)) / len(token)
                positioned_tokens.append((part, (part_x0, y0, part_x1, y1)))
    if len(positioned_tokens) < 2:
        return []

    chunks: list[tuple[str, tuple[float, float, float, float]]] = []
    current: list[tuple[str, tuple[float, float, float, float]]] = []
    current_length = 0
    for token in positioned_tokens:
        added_length = len(token[0]) + (1 if current else 0)
        if current and current_length + added_length > maximum_characters:
            chunks.append(_ocrturk_chunk_from_tokens(current))
            current = []
            current_length = 0
            added_length = len(token[0])
        current.append(token)
        current_length += added_length
    if current:
        chunks.append(_ocrturk_chunk_from_tokens(current))
    return chunks if len(chunks) > 1 else []


def _ocrturk_chunk_from_tokens(
    tokens: list[tuple[str, tuple[float, float, float, float]]],
) -> tuple[str, tuple[float, float, float, float]]:
    boxes = [bbox for _text, bbox in tokens]
    return (
        " ".join(text for text, _bbox in tokens),
        (
            min(box[0] for box in boxes),
            min(box[1] for box in boxes),
            max(box[2] for box in boxes),
            max(box[3] for box in boxes),
        ),
    )


def _usable_ocrturk_line(text: str, bbox: object) -> bool:
    if not text or len(text) > 140 or len(text) < 2:
        return False
    if _has_corrupt_label_text(text):
        return False
    if not isinstance(bbox, list | tuple) or len(bbox) != 4:
        return False
    return sum(character.isalnum() for character in text) >= 2


def _has_corrupt_label_text(text: str) -> bool:
    return "\ufffd" in text


def _scaled_pdf_crop_box(
    bbox: list[object] | tuple[object, ...],
    image_size: tuple[int, int],
    *,
    scale: float,
    padding: int,
) -> tuple[int, int, int, int] | None:
    try:
        left, top, right, bottom = [float(value) for value in bbox]
    except (TypeError, ValueError):
        return None
    image_width, image_height = image_size
    scaled = (
        max(0, int(left * scale) - padding),
        max(0, int(top * scale) - padding),
        min(image_width, int(right * scale + 0.999) + padding),
        min(image_height, int(bottom * scale + 0.999) + padding),
    )
    if scaled[2] <= scaled[0] or scaled[3] <= scaled[1]:
        return None
    return scaled


def _ocrturk_line_split(document_index: int, document_count: int) -> str:
    if document_count <= 1:
        return "train"
    return "validation" if document_index % 5 == 4 else "train"


def _dataset_row(
    *,
    row_id: str,
    source: str,
    image: Path | str | None,
    text: str,
    split: str,
    document_type: str,
    fields: dict[str, object],
    license_note: str,
    usable_for_training: bool,
    usable_for_benchmark: bool,
    manual_review_note: str,
    line_crop_box: list[int] | None = None,
) -> dict[str, object]:
    row: dict[str, object] = {
        "id": row_id,
        "source": source,
        "image": _workspace_relative(image),
        "text": text,
        "split": split,
        "documentType": document_type,
        "fields": fields,
        "licenseNote": license_note,
        "usableForTraining": usable_for_training,
        "usableForBenchmark": usable_for_benchmark,
        "manualReviewNote": manual_review_note,
    }
    if line_crop_box is not None:
        row["lineCropBox"] = line_crop_box
        row["lineCropBoxFormat"] = "xyxy"
    return row


def _split_from_parts(parts: tuple[str, ...]) -> str:
    lowered = {part.lower() for part in parts}
    if "train" in lowered or "training" in lowered:
        return "train"
    if "validation" in lowered or "valid" in lowered or "val" in lowered or "dev" in lowered or "eval" in lowered:
        return "validation"
    if "test" in lowered or "testing" in lowered:
        return "test"
    return "validation"


def _cord_image_for_json(json_path: Path) -> Path | None:
    parts = list(json_path.parts)
    try:
        json_index = [part.lower() for part in parts].index("json")
    except ValueError:
        return None
    parts[json_index] = "image"
    candidate = Path(*parts).with_suffix(".png")
    return candidate if candidate.exists() else None


def _cord_line_crop_box(words: list[object]) -> list[int] | None:
    coordinates: list[tuple[int, int]] = []
    for word in words:
        if not isinstance(word, dict):
            continue
        quad = word.get("quad")
        if not isinstance(quad, dict):
            continue
        for index in range(1, 5):
            x = quad.get(f"x{index}")
            y = quad.get(f"y{index}")
            if isinstance(x, int | float) and isinstance(y, int | float):
                coordinates.append((int(x), int(y)))
    return _padded_xyxy_from_points(coordinates, padding=4)


def _sroie_line_crop_box(values: list[str]) -> list[int] | None:
    if len(values) != 8:
        return None
    try:
        numbers = [int(value) for value in values]
    except ValueError:
        return None
    coordinates = [(numbers[index], numbers[index + 1]) for index in range(0, 8, 2)]
    return _padded_xyxy_from_points(coordinates, padding=3)


def _padded_xyxy_from_points(points: list[tuple[int, int]], padding: int) -> list[int] | None:
    if not points:
        return None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    left = max(0, min(xs) - padding)
    top = max(0, min(ys) - padding)
    right = max(left + 1, max(xs) + padding)
    bottom = max(top + 1, max(ys) + padding)
    return [left, top, right, bottom]


def _load_sroie_entity_fields(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {str(key): value for key, value in payload.items() if isinstance(value, (str, int, float))}


def _count_emnist_label_items(path: Path) -> int:
    total = 0
    for labels_path in sorted(path.rglob("*labels-idx1-ubyte")):
        try:
            header = labels_path.read_bytes()[:8]
        except OSError:
            continue
        if len(header) == 8:
            total += int.from_bytes(header[4:8], "big")
    return total


def _collect_emnist_rows(
    path: Path,
    metadata: dict[str, object],
    rows: dict[str, list[dict[str, object]]],
    asset_dir: Path | None,
) -> tuple[int, int]:
    if asset_dir is None:
        return 0, 0
    imported = 0
    available = 0
    for split, limit in (
        ("train", EMNIST_TRAIN_SAMPLES_PER_CLASS),
        ("validation", EMNIST_VALIDATION_SAMPLES_PER_CLASS),
    ):
        idx_split = "train" if split == "train" else "test"
        images_path = next(iter(sorted(path.rglob(f"emnist-balanced-{idx_split}-images-idx3-ubyte"))), None)
        labels_path = next(iter(sorted(path.rglob(f"emnist-balanced-{idx_split}-labels-idx1-ubyte"))), None)
        if images_path is None or labels_path is None:
            continue
        pair = _read_emnist_idx_pair(images_path, labels_path)
        if pair is None:
            continue
        images, labels = pair
        available += len(labels)
        class_counts = {index: 0 for index in range(len(EMNIST_BALANCED_CHARACTERS))}
        split_dir = asset_dir / split
        split_dir.mkdir(parents=True, exist_ok=True)
        for sample_index, label_value in enumerate(labels):
            label = int(label_value)
            if label not in class_counts or class_counts[label] >= limit:
                continue
            character = EMNIST_BALANCED_CHARACTERS[label]
            class_sample = class_counts[label]
            crop_path = split_dir / f"class-{label:02d}-sample-{class_sample:03d}.png"
            if not crop_path.is_file():
                Image.fromarray(np.asarray(images[sample_index]).T, mode="L").save(crop_path)
            row = _dataset_row(
                row_id=f"EMNIST:balanced:{split}:{label}:{class_sample}",
                source="EMNIST",
                image=crop_path,
                text=character,
                split=split,
                document_type="character",
                fields={"classIndex": label, "emnistSplit": "balanced"},
                license_note=str(metadata["license_note"]),
                usable_for_training=True,
                usable_for_benchmark=True,
                manual_review_note="EMNIST supports alphanumeric character learning only; it is not Turkish OCR proof.",
            )
            rows["character_train" if split == "train" else "character_validation"].append(row)
            class_counts[label] += 1
            imported += 1
            if all(count >= limit for count in class_counts.values()):
                break
    return imported, available


def _read_emnist_idx_pair(images_path: Path, labels_path: Path) -> tuple[np.memmap, np.memmap] | None:
    try:
        image_header = images_path.read_bytes()[:16]
        label_header = labels_path.read_bytes()[:8]
    except OSError:
        return None
    if len(image_header) != 16 or len(label_header) != 8:
        return None
    if int.from_bytes(image_header[:4], "big") != 2051 or int.from_bytes(label_header[:4], "big") != 2049:
        return None
    image_count = int.from_bytes(image_header[4:8], "big")
    label_count = int.from_bytes(label_header[4:8], "big")
    rows = int.from_bytes(image_header[8:12], "big")
    columns = int.from_bytes(image_header[12:16], "big")
    if image_count <= 0 or image_count != label_count or rows <= 0 or columns <= 0:
        return None
    try:
        images = np.memmap(images_path, dtype=np.uint8, mode="r", offset=16, shape=(image_count, rows, columns))
        labels = np.memmap(labels_path, dtype=np.uint8, mode="r", offset=8, shape=(label_count,))
    except (OSError, ValueError):
        return None
    return images, labels


def _collect_turkish_hun_eng_rows(
    path: Path,
    metadata: dict[str, object],
    rows: dict[str, list[dict[str, object]]],
    asset_dir: Path | None,
) -> tuple[int, int, str]:
    if asset_dir is None:
        return 0, 0, "No asset directory is available for T-H-E character crop export."
    try:
        from services.ocr.custom_model.vocab import CHAR_TO_INDEX
    except ImportError:
        return 0, 0, "Active OCR vocabulary is unavailable."

    imported = 0
    available = 0
    mat_files = sorted(path.rglob("*.mat"))
    for mat_path in mat_files:
        imported_count, available_count = _collect_the_mat_rows(
            mat_path,
            metadata,
            rows,
            asset_dir,
            set(CHAR_TO_INDEX),
        )
        imported += imported_count
        available += available_count

    image_files = [file for file in sorted(path.rglob("*")) if file.is_file() and file.suffix.lower() in IMAGE_EXTENSIONS - {".pdf"}]
    for image_path in image_files:
        label = _the_character_from_labeled_path(image_path)
        if label is None:
            continue
        available += 1
        if label not in CHAR_TO_INDEX:
            continue
        split = _split_from_parts(image_path.parts)
        manifest_key = "character_train" if split == "train" else "character_validation"
        rows[manifest_key].append(
            _dataset_row(
                row_id=f"Turkish-Hun-Eng:image:{_safe_asset_name(str(image_path.relative_to(path)))}",
                source="Turkish-Hun-Eng",
                image=image_path,
                text=label,
                split=split,
                document_type="character",
                fields={"labelSource": "path"},
                license_note=str(metadata["license_note"]),
                usable_for_training=True,
                usable_for_benchmark=True,
                manual_review_note="T-H-E labeled character crop; use for Turkish special character evaluation/training only.",
            )
        )
        imported += 1

    if imported:
        return imported, available, ""
    if mat_files:
        return 0, available, "T-H-E .mat files were found, but no supported labeled character samples could be imported."
    if image_files:
        return 0, available, "Image files were found, but parent/stem labels did not match supported T-H-E class names."
    return 0, 0, "No T-H-E .mat payload or labeled character image folders were found."


def _collect_the_mat_rows(
    mat_path: Path,
    metadata: dict[str, object],
    rows: dict[str, list[dict[str, object]]],
    asset_dir: Path,
    supported_characters: set[str],
) -> tuple[int, int]:
    try:
        from scipy.io import loadmat  # type: ignore[import-not-found]
    except ImportError:
        return 0, 0
    try:
        payload = loadmat(mat_path)
    except (OSError, ValueError, NotImplementedError):
        return 0, 0
    sample_matrix, labels = _the_mat_image_label_arrays(payload)
    if sample_matrix is None or labels is None:
        return 0, 0
    sample_count = min(_the_sample_count(sample_matrix), int(labels.size))
    if sample_count <= 0:
        return 0, 0
    label_map = _the_label_map_for_path(mat_path)
    per_split_counts: dict[tuple[str, str], int] = {}
    imported = 0
    split_asset_dir = asset_dir / _safe_asset_name(mat_path.stem)
    split_asset_dir.mkdir(parents=True, exist_ok=True)
    for sample_index in range(sample_count):
        label_value = int(np.ravel(labels)[sample_index])
        character = label_map.get(label_value)
        if character is None or character not in supported_characters:
            continue
        split = _the_sample_split(sample_index)
        limit = THE_TRAIN_SAMPLES_PER_CLASS if split == "train" else THE_VALIDATION_SAMPLES_PER_CLASS
        key = (split, character)
        if per_split_counts.get(key, 0) >= limit:
            continue
        image_array = _the_sample_image(sample_matrix, sample_index)
        if image_array is None:
            continue
        class_index = per_split_counts.get(key, 0)
        crop_path = split_asset_dir / split / f"class-{label_value:02d}-{_safe_asset_name(character)}-{class_index:04d}.png"
        crop_path.parent.mkdir(parents=True, exist_ok=True)
        if not crop_path.is_file():
            Image.fromarray(image_array, mode="L").save(crop_path, format="PNG")
        rows["character_train" if split == "train" else "character_validation"].append(
            _dataset_row(
                row_id=f"Turkish-Hun-Eng:{mat_path.stem}:{split}:{label_value}:{class_index}",
                source="Turkish-Hun-Eng",
                image=crop_path,
                text=character,
                split=split,
                document_type="character",
                fields={"classIndex": label_value, "sourceFile": mat_path.name},
                license_note=str(metadata["license_note"]),
                usable_for_training=True,
                usable_for_benchmark=True,
                manual_review_note="T-H-E character sample; use as Turkish special character evidence, not receipt-layout evidence.",
            )
        )
        per_split_counts[key] = class_index + 1
        imported += 1
    return imported, sample_count


def _the_mat_image_label_arrays(payload: dict[str, object]) -> tuple[np.ndarray | None, np.ndarray | None]:
    arrays = {key: value for key, value in payload.items() if not key.startswith("__") and isinstance(value, np.ndarray)}
    labels: np.ndarray | None = None
    for key, value in arrays.items():
        lowered = key.lower()
        if lowered in {"y", "label", "labels", "target", "targets"} and value.size > 0:
            labels = np.asarray(value).reshape(-1)
            break
    if labels is None:
        label_candidates = [value for value in arrays.values() if value.ndim <= 2 and value.size > 0 and np.issubdtype(value.dtype, np.number)]
        if label_candidates:
            labels = np.asarray(min(label_candidates, key=lambda candidate: candidate.size)).reshape(-1)
    if labels is None:
        return None, None
    sample_count = int(labels.size)
    image_candidates = [
        value
        for key, value in arrays.items()
        if value.size >= sample_count * 28 * 28 and value.ndim in {3, 4} and key.lower() not in {"y", "label", "labels", "target", "targets"}
    ]
    if not image_candidates:
        return None, None
    return np.asarray(max(image_candidates, key=lambda candidate: candidate.size)), labels


def _the_sample_count(samples: np.ndarray) -> int:
    if samples.ndim == 4:
        return int(samples.shape[3] if samples.shape[0] == 28 and samples.shape[1] == 28 else samples.shape[0])
    if samples.ndim == 3:
        return int(samples.shape[2] if samples.shape[0] == 28 and samples.shape[1] == 28 else samples.shape[0])
    return 0


def _the_sample_image(samples: np.ndarray, index: int) -> np.ndarray | None:
    if samples.ndim == 4 and samples.shape[0] == 28 and samples.shape[1] == 28:
        image = samples[:, :, 0, index] if samples.shape[2] == 1 else samples[:, :, index, 0]
    elif samples.ndim == 4:
        image = samples[index, :, :, 0] if samples.shape[-1] == 1 else samples[index, 0, :, :]
    elif samples.ndim == 3 and samples.shape[0] == 28 and samples.shape[1] == 28:
        image = samples[:, :, index]
    elif samples.ndim == 3:
        image = samples[index, :, :]
    else:
        return None
    image = np.asarray(image)
    if image.shape != (28, 28):
        try:
            image = image.reshape(28, 28)
        except ValueError:
            return None
    if image.max(initial=0) <= 1:
        image = image * 255
    return np.clip(image, 0, 255).astype(np.uint8)


def _the_label_map_for_path(path: Path) -> dict[int, str]:
    lowered = " ".join(part.lower() for part in path.parts)
    if "version ii" in lowered or "version_ii" in lowered or "version2" in lowered or "turkish special" in lowered:
        return THE_VERSION_II_LABELS
    return THE_CLASS_LABELS


def _the_sample_split(index: int) -> str:
    return "validation" if index % 5 == 0 else "train"


def _the_character_from_labeled_path(path: Path) -> str | None:
    candidates = [path.parent.name, path.stem]
    for value in candidates:
        normalized = value.strip()
        if not normalized:
            continue
        if len(normalized) == 1:
            return normalized
        match = re.search(r"(?:class[-_\s]*)?(\d{1,2})", normalized, flags=re.IGNORECASE)
        if match:
            label_value = int(match.group(1))
            character = THE_CLASS_LABELS.get(label_value) or THE_VERSION_II_LABELS.get(label_value)
            if character:
                return character
    return None


def _has_lfs_pointer_csv(path: Path) -> bool:
    csv_files = sorted(path.glob("*.csv"))
    if not csv_files:
        return False
    for csv_path in csv_files[:3]:
        try:
            head = csv_path.read_text(encoding="utf-8", errors="replace")[:200]
        except OSError:
            continue
        if "version https://git-lfs.github.com/spec/v1" in head:
            return True
    return False


def _count_dataset_files(path: Path) -> int:
    return sum(1 for item in path.rglob("*") if item.is_file()) if path.exists() else 0


def _workspace_relative(path: Path | str | None) -> str | None:
    if path is None:
        return None
    candidate = Path(path)
    try:
        return str(candidate.relative_to(Path.cwd())).replace("\\", "/")
    except ValueError:
        return str(candidate).replace("\\", "/")


def _merge_project_fixture_rows(combined_rows: dict[str, list[dict[str, object]]], project_rows: dict[str, list[dict[str, object]]]) -> None:
    for row in project_rows["character_rows"]:
        key = "character_train" if row.get("split") == "train" else "character_validation"
        combined_rows[key].append(_project_row_to_combined(row, source="project_fixture", usable_for_training=False, usable_for_benchmark=True))
    for row in project_rows["real_character_rows"]:
        key = "character_train" if row.get("split") == "train" else "character_validation"
        combined_rows[key].append(
            _project_row_to_combined(
                row,
                source="project_fixture_real_character",
                usable_for_training=True,
                usable_for_benchmark=True,
            )
        )
    for row in project_rows["line_rows"]:
        key = "line_train" if row.get("split") == "train" else "line_validation"
        combined_rows[key].append(_project_row_to_combined(row, source="project_fixture", usable_for_training=False, usable_for_benchmark=True))
    for row in project_rows["training_line_rows"]:
        key = "line_train" if row.get("split") == "train" else "line_validation"
        combined_rows[key].append(
            _project_row_to_combined(
                row,
                source="project_fixture_synthetic",
                usable_for_training=True,
                usable_for_benchmark=False,
            )
        )
    for row in project_rows["real_line_rows"]:
        key = "line_train" if row.get("split") == "train" else "line_validation"
        combined_rows[key].append(
            _project_row_to_combined(
                row,
                source="project_fixture_real_crop",
                usable_for_training=True,
                usable_for_benchmark=True,
            )
        )
    for row in project_rows["benchmark_rows"]:
        combined = _project_row_to_combined(row, source="project_fixture", usable_for_training=False, usable_for_benchmark=True)
        combined_rows["document_benchmark"].append(combined)
        combined_rows["project_fixture_benchmark"].append(combined)


def _project_row_to_combined(
    row: dict[str, object],
    *,
    source: str,
    usable_for_training: bool,
    usable_for_benchmark: bool,
) -> dict[str, object]:
    text = str(row.get("text") or row.get("character") or "")
    return {
        "id": row.get("id"),
        "source": source,
        "image": row.get("image"),
        "text": text,
        "split": row.get("split", "benchmark"),
        "documentType": row.get("documentType", "unknown"),
        "fields": row.get("fields", {}),
        "licenseNote": "Project-local fixture ground truth.",
        "usableForTraining": usable_for_training,
        "usableForBenchmark": usable_for_benchmark,
        "manualReviewNote": row.get("manualReviewNote", "Project fixture row."),
    }


def _write_combined_manifests(output_dir: Path, rows: dict[str, list[dict[str, object]]]) -> dict[str, str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "dataset_sources": output_dir / "dataset_sources.json",
        "character_train": output_dir / "character_train.jsonl",
        "character_validation": output_dir / "character_validation.jsonl",
        "line_train": output_dir / "line_train.jsonl",
        "line_validation": output_dir / "line_validation.jsonl",
        "document_benchmark": output_dir / "document_benchmark.jsonl",
        "project_fixture_benchmark": output_dir / "project_fixture_benchmark.jsonl",
        "hardcase_train": output_dir / "hardcase_train.jsonl",
        "hardcase_validation": output_dir / "hardcase_validation.jsonl",
    }
    for key, path in paths.items():
        if key == "dataset_sources":
            continue
        _write_jsonl(path, rows[key])
    return {key: str(path) for key, path in paths.items()}


def _populate_hardcase_manifests(rows: dict[str, list[dict[str, object]]]) -> None:
    rows["hardcase_train"] = _hardcase_rows_for_split(rows["line_train"], split="train")
    rows["hardcase_validation"] = _hardcase_rows_for_split(rows["line_validation"], split="validation")


def _hardcase_rows_for_split(rows: list[dict[str, object]], *, split: str) -> list[dict[str, object]]:
    selected: list[dict[str, object]] = []
    seen_ids: set[str] = set()
    for row in rows:
        if row.get("usableForTraining") is not True:
            continue
        if not isinstance(row.get("image"), str) or not str(row.get("image")).strip():
            continue
        reasons = _hardcase_reasons(row)
        if not reasons:
            continue
        row_id = str(row.get("id") or "")
        hardcase_id = f"{row_id}:hardcase" if row_id else f"{row.get('source', 'unknown')}:{len(selected)}:hardcase"
        if hardcase_id in seen_ids:
            continue
        seen_ids.add(hardcase_id)
        selected.append({**row, "id": hardcase_id, "split": split, "hardcaseReasons": reasons, "hardcaseWeight": _hardcase_weight(reasons)})
    return selected


def _hardcase_reasons(row: dict[str, object]) -> list[str]:
    text = str(row.get("text") or "")
    source = str(row.get("source") or "")
    reasons: list[str] = []
    if any(character in TURKISH_SPECIAL_CHARACTERS for character in text):
        reasons.append("turkish_special_character")
    if AMOUNT_RE.search(text):
        reasons.append("amount_or_decimal_comma")
    if DATE_RE.search(text):
        reasons.append("date_pattern")
    if FIELD_KEYWORD_RE.search(text):
        reasons.append("field_keyword")
    if _has_hard_confusion(text):
        reasons.append("hard_character_confusion")
    if source in {"OCRTurk", "project_fixture_real_crop", "project_fixture_synthetic"}:
        reasons.append("priority_turkish_or_project_source")
    fields = row.get("fields")
    if isinstance(fields, dict) and any(key in fields for key in ("category", "entities", "lineItem", "expectedOcrTextSnippets")):
        reasons.append("layout_or_extraction_field")
    return sorted(set(reasons))


def _has_hard_confusion(text: str) -> bool:
    return sum(1 for character in text if character in HARDCONFUSION_CHARACTERS) >= 2


def _hardcase_weight(reasons: list[str]) -> int:
    return min(4, 1 + len(reasons) // 2)


def _hardcase_reason_counts(rows: list[dict[str, object]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        reasons = row.get("hardcaseReasons")
        if not isinstance(reasons, list):
            continue
        for reason in reasons:
            reason_key = str(reason)
            counts[reason_key] = counts.get(reason_key, 0) + 1
    return dict(sorted(counts.items()))


def write_dataset_source_manifest(
    dataset_root: Path,
    output_path: Path,
    fixture_root: Path = Path("data/demo-fixtures"),
    *,
    progress: bool = False,
    generate_missing_character_assets: bool = True,
) -> dict[str, object]:
    entries: list[dict[str, object]] = []
    combined_rows = _empty_combined_rows()
    asset_root = output_path.parent / "custom-ocr" / "assets"
    source_cache_root = output_path.parent / "custom-ocr" / "source-cache"
    for name, metadata in KNOWN_DATASETS.items():
        started_at = time.perf_counter()
        if progress:
            print(f"[dataset-inventory] {name}: inventory", file=sys.stderr, flush=True)
        candidate = _find_dataset_path(dataset_root, metadata)
        inventory = _inventory_dataset(candidate) if candidate else _empty_inventory()
        adapter_cache_status = "not_present"
        if candidate:
            adapter_fingerprint = _dataset_adapter_fingerprint(
                name,
                candidate,
                inventory,
                generate_missing_character_assets=generate_missing_character_assets,
            )
            source_cache_dir = source_cache_root / _safe_asset_name(name).lower()
            adapter = _load_source_adapter_cache(source_cache_dir, adapter_fingerprint)
            if adapter is None:
                adapter_cache_status = "miss"
                if progress:
                    print(f"[dataset-inventory] {name}: parse", file=sys.stderr, flush=True)
                adapter = _collect_parseable_dataset_rows(
                    name,
                    candidate,
                    metadata,
                    asset_root,
                    generate_missing_character_assets=generate_missing_character_assets,
                )
                _write_source_adapter_cache(source_cache_dir, adapter_fingerprint, adapter)
            else:
                adapter_cache_status = "hit"
        else:
            adapter = _empty_adapter_summary("dataset not present")
        for key, rows in adapter["rows"].items():
            combined_rows[key].extend(rows)
        elapsed_seconds = round(time.perf_counter() - started_at, 3)
        if progress:
            print(
                f"[dataset-inventory] {name}: {adapter_cache_status} "
                f"({adapter['sample_count_imported']} rows, {elapsed_seconds:.3f}s)",
                file=sys.stderr,
                flush=True,
            )
        entries.append(
            {
                "name": name,
                "present": candidate is not None,
                "path": str(candidate) if candidate else None,
                "file_count": inventory["file_count"],
                "size_bytes": inventory["size_bytes"],
                "license_note": metadata["license_note"],
                "manual_review_note": metadata["manual_review_note"],
                "contains_turkish": metadata["contains_turkish"],
                "usable_for_character_training": metadata["usable_for_character_training"],
                "usable_for_line_training": metadata["usable_for_line_training"],
                "usable_for_document_benchmark": metadata["usable_for_document_benchmark"],
                "usable_for_extraction_benchmark": metadata["usable_for_extraction_benchmark"],
                "required_transform": metadata["required_transform"],
                "split_summary": inventory["split_summary"],
                "checksum_sha256": inventory["checksum_sha256"],
                "checksum_note": inventory["checksum_note"],
                "sample_checksum_sha256": inventory["sample_checksum_sha256"],
                "metadata_fingerprint_sha256": inventory["metadata_fingerprint_sha256"],
                "parseability_status": adapter["parseability_status"],
                "sample_count_imported": adapter["sample_count_imported"],
                "skipped_count": adapter["skipped_count"],
                "skipped_reason": adapter["skipped_reason"],
                "imported_manifest_counts": adapter["imported_manifest_counts"],
                "adapter_cache_status": adapter_cache_status,
                "adapter_elapsed_seconds": elapsed_seconds,
                "generated_missing_character_assets": generate_missing_character_assets,
            }
        )
    generated = _write_project_fixture_manifests(fixture_root, output_path.parent / "custom-ocr-dataset-manifests")
    _merge_project_fixture_rows(combined_rows, generated["rows"])
    _populate_hardcase_manifests(combined_rows)
    combined_manifest_counts = {key: len(value) for key, value in combined_rows.items()}
    combined_manifest_paths = _write_combined_manifests(output_path.parent / "custom-ocr", combined_rows)
    manifest = {
        "schema_version": 1,
        "dataset_root": str(dataset_root),
        "project_fixture_root": str(fixture_root),
        "download_policy": "manual/local only; this adapter never downloads datasets silently",
        "datasets": entries,
        "project_fixtures": generated["summary"],
        "generated_manifests": generated["paths"],
        "combined_manifests": combined_manifest_paths,
        "combined_manifest_counts": combined_manifest_counts,
        "hardcase_reason_counts": {
            "train": _hardcase_reason_counts(combined_rows["hardcase_train"]),
            "validation": _hardcase_reason_counts(combined_rows["hardcase_validation"]),
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    combined_sources_path = output_path.parent / "custom-ocr" / "dataset_sources.json"
    combined_sources_path.parent.mkdir(parents=True, exist_ok=True)
    combined_sources_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def _find_dataset_path(dataset_root: Path, metadata: dict[str, object]) -> Path | None:
    if not dataset_root.exists():
        return None
    aliases = [str(alias).lower() for alias in metadata.get("aliases", []) if str(alias).strip()]
    for path in sorted(dataset_root.iterdir()):
        lowered = path.name.lower()
        if any(alias in lowered for alias in aliases):
            return path
    return None


def _empty_inventory() -> dict[str, object]:
    return {
        "size_bytes": 0,
        "file_count": 0,
        "split_summary": {},
        "checksum_sha256": None,
        "checksum_note": "dataset not present",
        "sample_checksum_sha256": None,
        "metadata_fingerprint_sha256": None,
    }


def _inventory_dataset(path: Path) -> dict[str, object]:
    files = [file for file in sorted(path.rglob("*")) if file.is_file()] if path.is_dir() else [path]
    file_stats = [(file, file.stat()) for file in files]
    size_bytes = sum(stat.st_size for _file, stat in file_stats)
    split_summary = _detect_splits(files)
    checksum = None
    checksum_note = "checksum skipped because dataset exceeds adapter checksum cap"
    if size_bytes <= MAX_CHECKSUM_BYTES:
        checksum = _tree_sha256(path, files)
        checksum_note = f"sha256 over {len(files)} files"
    return {
        "size_bytes": size_bytes,
        "file_count": len(files),
        "split_summary": split_summary,
        "checksum_sha256": checksum,
        "checksum_note": checksum_note,
        "sample_checksum_sha256": _sample_tree_sha256(path, file_stats),
        "metadata_fingerprint_sha256": _metadata_tree_sha256(path, file_stats),
    }


def _metadata_tree_sha256(root: Path, file_stats: list[tuple[Path, object]]) -> str:
    digest = hashlib.sha256()
    for file, stat in file_stats:
        relative = file.relative_to(root) if root.is_dir() else Path(file.name)
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(getattr(stat, "st_size")).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(getattr(stat, "st_mtime_ns")).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _sample_tree_sha256(root: Path, file_stats: list[tuple[Path, object]]) -> str | None:
    if not file_stats:
        return None
    if len(file_stats) <= SAMPLE_CHECKSUM_FILE_LIMIT:
        selected = file_stats
    else:
        last_index = len(file_stats) - 1
        selected_indexes = {
            round(index * last_index / (SAMPLE_CHECKSUM_FILE_LIMIT - 1))
            for index in range(SAMPLE_CHECKSUM_FILE_LIMIT)
        }
        selected = [file_stats[index] for index in sorted(selected_indexes)]
    digest = hashlib.sha256()
    for file, stat in selected:
        relative = file.relative_to(root) if root.is_dir() else Path(file.name)
        size = int(getattr(stat, "st_size"))
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        try:
            with file.open("rb") as handle:
                digest.update(handle.read(SAMPLE_CHECKSUM_BYTES_PER_EDGE))
                if size > SAMPLE_CHECKSUM_BYTES_PER_EDGE:
                    handle.seek(max(0, size - SAMPLE_CHECKSUM_BYTES_PER_EDGE))
                    digest.update(handle.read(SAMPLE_CHECKSUM_BYTES_PER_EDGE))
        except OSError:
            digest.update(b"<unreadable>")
        digest.update(b"\n")
    return digest.hexdigest()


def _dataset_adapter_fingerprint(
    name: str,
    path: Path,
    inventory: dict[str, object],
    *,
    generate_missing_character_assets: bool,
) -> str:
    payload = {
        "schema": DATASET_ADAPTER_CACHE_SCHEMA_VERSION,
        "implementation": DATASET_ADAPTER_SOURCE_VERSIONS.get(name, DATASET_ADAPTER_IMPLEMENTATION_VERSION),
        "name": name,
        "path": str(path.resolve()),
        "file_count": inventory["file_count"],
        "size_bytes": inventory["size_bytes"],
        "metadata_fingerprint_sha256": inventory["metadata_fingerprint_sha256"],
        "sample_checksum_sha256": inventory["sample_checksum_sha256"],
        "generate_missing_character_assets": generate_missing_character_assets,
    }
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _load_source_adapter_cache(cache_dir: Path, fingerprint: str) -> dict[str, object] | None:
    metadata_path = cache_dir / "metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if (
        metadata.get("schema_version") != DATASET_ADAPTER_CACHE_SCHEMA_VERSION
        or metadata.get("fingerprint") != fingerprint
    ):
        return None
    rows = _empty_combined_rows()
    try:
        for key in COMBINED_MANIFEST_KEYS:
            rows[key] = _read_jsonl(cache_dir / f"{key}.jsonl")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    summary = metadata.get("summary")
    if not isinstance(summary, dict):
        return None
    return {**summary, "rows": rows}


def _write_source_adapter_cache(cache_dir: Path, fingerprint: str, adapter: dict[str, object]) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    rows = adapter.get("rows")
    if not isinstance(rows, dict):
        raise ValueError("Dataset adapter cache requires row manifests")
    for key in COMBINED_MANIFEST_KEYS:
        value = rows.get(key)
        if not isinstance(value, list):
            raise ValueError(f"Dataset adapter cache row list missing: {key}")
        _write_jsonl(cache_dir / f"{key}.jsonl", value)
    summary = {key: value for key, value in adapter.items() if key != "rows"}
    metadata = {
        "schema_version": DATASET_ADAPTER_CACHE_SCHEMA_VERSION,
        "fingerprint": fingerprint,
        "summary": summary,
    }
    (cache_dir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _detect_splits(files: list[Path]) -> dict[str, int]:
    counts = {"train": 0, "validation": 0, "test": 0, "unknown": 0}
    for file in files:
        parts = {part.lower() for part in file.parts}
        if "train" in parts or "training" in parts:
            counts["train"] += 1
        elif "validation" in parts or "valid" in parts or "val" in parts:
            counts["validation"] += 1
        elif "test" in parts or "testing" in parts:
            counts["test"] += 1
        else:
            counts["unknown"] += 1
    return {key: value for key, value in counts.items() if value > 0}


def _write_project_fixture_manifests(fixture_root: Path, output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    character_rows: list[dict[str, object]] = []
    line_rows: list[dict[str, object]] = []
    training_line_texts: set[str] = set()
    document_rows: list[dict[str, object]] = []
    benchmark_rows: list[dict[str, object]] = []
    qualitative_rows: list[dict[str, object]] = []

    ground_truth_root = fixture_root / "ground-truth"
    truth_files = sorted(ground_truth_root.glob("*.json")) if ground_truth_root.exists() else []
    for index, truth_file in enumerate(truth_files):
        truth = _load_repaired_json(truth_file)
        image_path = _matching_fixture_path(fixture_root, truth_file.stem)
        snippets = [str(item).strip() for item in truth.get("expectedOcrTextSnippets", []) if str(item).strip()]
        training_line_texts.update(_project_fixture_training_texts(truth, snippets))
        text = "\n".join(snippets)
        split = _fixture_split(index, len(truth_files))
        base_row = {
            "id": truth_file.stem,
            "image": _relative_or_name(image_path, fixture_root) if image_path else None,
            "groundTruth": _relative_or_name(truth_file, fixture_root),
            "text": text,
            "split": split,
            "source": "project_real_fixture",
            "documentType": truth.get("documentType", "unknown"),
            "fields": {
                "merchant": truth.get("merchant"),
                "date": truth.get("date"),
                "currency": truth.get("currency"),
                "subtotal": truth.get("subtotal"),
                "tax": truth.get("tax"),
                "total": truth.get("total"),
                "paymentMethod": truth.get("paymentMethod"),
            },
            "lineItems": truth.get("lineItems", []),
            "expectedOcrTextSnippets": snippets,
            "manualReviewNote": "Ground truth comes from project fixture JSON; snippets are acceptance expectations.",
        }
        document_rows.append(base_row)
        benchmark_rows.append(
            {
                **base_row,
                "usableForOcrBenchmark": image_path is not None and bool(snippets),
                "usableForExtractionBenchmark": image_path is not None,
            }
        )
        for snippet_index, snippet in enumerate(snippets):
            line_rows.append(
                {
                    "id": f"{truth_file.stem}:snippet:{snippet_index}",
                    "image": base_row["image"],
                    "text": snippet,
                    "split": split,
                    "source": "project_real_fixture_snippet",
                    "documentId": truth_file.stem,
                    "usableForTraining": False,
                    "manualReviewNote": "Snippet label has no crop box; benchmark only unless manually segmented.",
                }
            )
        for character in sorted(set(text)):
            if character.strip():
                character_rows.append(
                    {
                        "id": f"{truth_file.stem}:char:{ord(character)}",
                        "character": character,
                        "text": character,
                        "split": split,
                        "source": "project_real_fixture_text",
                        "documentId": truth_file.stem,
                        "usableForTraining": False,
                        "manualReviewNote": "Text-only character inventory; not a labeled character crop.",
                    }
                )

    training_line_rows = _render_project_fixture_training_lines(training_line_texts, output_dir / "project-fixture-training-lines")
    real_line_rows, real_character_rows = _extract_project_fixture_crops(
        fixture_root,
        output_dir / "project-fixture-real-lines",
        output_dir / "project-fixture-real-characters",
    )
    if fixture_root.exists():
        truth_stems = {truth_file.stem for truth_file in truth_files}
        for path in sorted(fixture_root.iterdir()):
            if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            if path.stem in truth_stems:
                continue
            qualitative_rows.append(
                {
                    "id": path.stem,
                    "image": path.name,
                    "source": "project_qualitative_fixture",
                    "usableForOcrBenchmark": False,
                    "manualReviewNote": "No ground truth JSON found; use for qualitative review only.",
                }
            )

    paths = {
        "character_manifest": output_dir / "character_manifest.jsonl",
        "line_manifest": output_dir / "line_manifest.jsonl",
        "training_line_manifest": output_dir / "training_line_manifest.jsonl",
        "real_line_manifest": output_dir / "real_line_manifest.jsonl",
        "real_character_manifest": output_dir / "real_character_manifest.jsonl",
        "document_manifest": output_dir / "document_manifest.jsonl",
        "benchmark_manifest": output_dir / "benchmark_manifest.jsonl",
        "qualitative_manifest": output_dir / "qualitative_manifest.jsonl",
    }
    _write_jsonl(paths["character_manifest"], character_rows)
    _write_jsonl(paths["line_manifest"], line_rows)
    _write_jsonl(paths["training_line_manifest"], training_line_rows)
    _write_jsonl(paths["real_line_manifest"], real_line_rows)
    _write_jsonl(paths["real_character_manifest"], real_character_rows)
    _write_jsonl(paths["document_manifest"], document_rows)
    _write_jsonl(paths["benchmark_manifest"], benchmark_rows)
    _write_jsonl(paths["qualitative_manifest"], qualitative_rows)
    return {
        "summary": {
            "present": fixture_root.exists(),
            "ground_truth_count": len(truth_files),
            "benchmark_count": len(benchmark_rows),
            "line_snippet_count": len(line_rows),
            "synthetic_training_line_count": len(training_line_rows),
            "real_training_line_count": sum(1 for row in real_line_rows if row.get("split") == "train"),
            "real_validation_line_count": sum(1 for row in real_line_rows if row.get("split") == "validation"),
            "real_training_character_count": sum(1 for row in real_character_rows if row.get("split") == "train"),
            "real_validation_character_count": sum(1 for row in real_character_rows if row.get("split") == "validation"),
            "qualitative_count": len(qualitative_rows),
            "contains_turkish": True,
            "usable_for_document_benchmark": len(benchmark_rows) > 0,
            "usable_for_extraction_benchmark": len(benchmark_rows) > 0,
        },
        "paths": {key: str(value) for key, value in paths.items()},
        "rows": {
            "character_rows": character_rows,
            "line_rows": line_rows,
            "training_line_rows": training_line_rows,
            "real_line_rows": real_line_rows,
            "real_character_rows": real_character_rows,
            "document_rows": document_rows,
            "benchmark_rows": benchmark_rows,
            "qualitative_rows": qualitative_rows,
        },
    }


def _extract_project_fixture_crops(
    fixture_root: Path,
    line_output_dir: Path,
    character_output_dir: Path,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    annotation_path = fixture_root / "annotations" / "fixture-lines.json"
    if not annotation_path.is_file():
        return [], []

    from services.ocr.custom_model.numeric_field_recognizer import character_box_to_tensor, image_to_gray_and_binary
    from services.ocr.custom_model.preprocessing import crop_gray, preprocess_custom_document
    from services.ocr.custom_model.segmentation import SegmentBox, segment_characters, segment_words
    from services.ocr.custom_model.vocab import CHAR_TO_INDEX

    payload = _load_repaired_json(annotation_path)
    documents = payload.get("documents") if isinstance(payload, dict) else None
    if not isinstance(documents, list):
        raise ValueError(f"Project fixture line annotation must contain a documents list: {annotation_path}")

    line_output_dir.mkdir(parents=True, exist_ok=True)
    character_output_dir.mkdir(parents=True, exist_ok=True)
    line_rows: list[dict[str, object]] = []
    character_rows: list[dict[str, object]] = []
    for document in documents:
        if not isinstance(document, dict):
            raise ValueError(f"Project fixture line annotation document must be an object: {annotation_path}")
        document_id = str(document.get("id") or "").strip()
        fixture_value = str(document.get("fixture") or "").strip()
        split = str(document.get("split") or "").strip()
        lines = document.get("lines")
        if not document_id or not fixture_value or split not in {"train", "validation"} or not isinstance(lines, list):
            raise ValueError(f"Invalid project fixture line annotation document: {document!r}")
        fixture_path = fixture_root / fixture_value
        if not fixture_path.is_file():
            raise FileNotFoundError(f"Annotated project fixture not found: {fixture_path}")
        pages = preprocess_custom_document(fixture_path)
        if not pages:
            raise ValueError(f"Annotated project fixture produced no pages: {fixture_path}")

        for line_index, line in enumerate(lines):
            if not isinstance(line, dict):
                raise ValueError(f"Project fixture line annotation must be an object: {document_id}:{line_index}")
            text = str(_repair_mojibake(line.get("text") or "")).strip()
            bbox = line.get("bbox")
            page_number = int(line.get("page", 1))
            if not text or not isinstance(bbox, list) or len(bbox) != 4:
                raise ValueError(f"Invalid project fixture line annotation: {document_id}:{line_index}")
            try:
                x, y, width, height = [int(value) for value in bbox]
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Invalid project fixture line bbox: {document_id}:{line_index}") from exc
            if width <= 0 or height <= 0 or page_number < 1 or page_number > len(pages):
                raise ValueError(f"Out-of-range project fixture line annotation: {document_id}:{line_index}")
            page = pages[page_number - 1]
            if x < 0 or y < 0 or x + width > page.gray.shape[1] or y + height > page.gray.shape[0]:
                raise ValueError(f"Project fixture line bbox exceeds the page: {document_id}:{line_index}")
            crop = crop_gray(page.gray, (x, y, width, height), padding=4)
            crop_path = line_output_dir / f"{document_id}-p{page_number:03d}-l{line_index:03d}.png"
            crop.save(crop_path, format="PNG")
            line_rows.append(
                {
                    "id": f"project-fixture-real:{document_id}:p{page_number}:line:{line_index}",
                    "image": _workspace_relative(crop_path),
                    "text": text,
                    "split": split,
                    "source": "project_fixture_real_crop",
                    "documentType": str(document.get("documentType") or "unknown"),
                    "documentId": document_id,
                    "page": page_number,
                    "bbox": [x, y, width, height],
                    "usableForTraining": True,
                    "usableForBenchmark": True,
                    "manualReviewNote": "Manually reviewed line annotation cropped from a project fixture; no inference lookup is used.",
                }
            )
            local_gray, local_binary = image_to_gray_and_binary(crop)
            line_box = SegmentBox(0, 0, local_gray.shape[1], local_gray.shape[0], "line")
            label_words = text.split()
            visual_words = segment_words(local_binary, line_box)
            if len(label_words) != len(visual_words):
                continue
            for word_index, (label_word, visual_word) in enumerate(zip(label_words, visual_words, strict=True)):
                character_boxes = segment_characters(local_binary, visual_word)
                if len(character_boxes) != len(label_word) or any(character not in CHAR_TO_INDEX for character in label_word):
                    continue
                for character_index, (character, character_box) in enumerate(zip(label_word, character_boxes, strict=True)):
                    tensor = character_box_to_tensor(local_gray, character_box)
                    character_image = Image.fromarray(
                        np.clip(tensor.squeeze(0).numpy() * 255.0, 0, 255).astype(np.uint8),
                        mode="L",
                    )
                    character_path = character_output_dir / (
                        f"{document_id}-p{page_number:03d}-l{line_index:03d}-w{word_index:02d}-c{character_index:02d}.png"
                    )
                    character_image.save(character_path, format="PNG")
                    character_rows.append(
                        {
                            "id": (
                                f"project-fixture-real-char:{document_id}:p{page_number}:"
                                f"line:{line_index}:word:{word_index}:char:{character_index}"
                            ),
                            "image": _workspace_relative(character_path),
                            "text": character,
                            "character": character,
                            "split": split,
                            "source": "project_fixture_real_character",
                            "documentType": str(document.get("documentType") or "unknown"),
                            "documentId": document_id,
                            "usableForTraining": True,
                            "usableForBenchmark": True,
                            "manualReviewNote": "Character crop retained only when word component count exactly matches its annotation.",
                        }
                    )
    return line_rows, character_rows


def _project_fixture_training_texts(truth: dict[str, object], snippets: list[str]) -> set[str]:
    texts = {snippet for snippet in snippets if snippet}
    merchant = str(truth.get("merchant") or "").strip()
    document_type = str(truth.get("documentType") or "unknown")
    date = str(truth.get("date") or "").strip()
    payment = str(truth.get("paymentMethod") or "").strip()
    total = _turkish_amount_text(truth.get("total"))
    tax = _turkish_amount_text(truth.get("tax"))
    subtotal = _turkish_amount_text(truth.get("subtotal"))
    if merchant:
        texts.add(merchant)
    if date:
        day, month, year = (date.split("-") + ["", "", ""])[:3]
        if day and month and year:
            texts.add(f"TARİH {year}.{month}.{day}")
    if total:
        texts.add(f"GENEL TOPLAM {total} TL")
    if tax:
        texts.add(f"KDV {tax} TL")
    if subtotal:
        texts.add(f"ARA TOPLAM {subtotal} TL")
    if payment:
        texts.add(f"ÖDEME {payment}")
    texts.add("FATURA NO SLF202600001" if document_type == "invoice" else "FİŞ NO SL-2026-0001")
    for item in truth.get("lineItems", []):
        if not isinstance(item, dict):
            continue
        description = str(item.get("description") or "").strip()
        amount = _turkish_amount_text(item.get("amount"))
        if description and amount:
            texts.add(f"{description} {amount} TL")
    return {text for text in texts if 2 <= len(text) <= 100}


def _turkish_amount_text(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if "." in text and "," not in text:
        whole, fraction = text.rsplit(".", 1)
        if whole.replace("-", "").isdigit() and fraction.isdigit():
            return f"{whole},{fraction[:2].ljust(2, '0')}"
    return text


def _render_project_fixture_training_lines(texts: set[str], output_dir: Path) -> list[dict[str, object]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for text_index, text in enumerate(sorted(texts)):
        for variant in range(6):
            font = _fixture_training_font(variant)
            image = _render_fixture_training_line(text, font, variant)
            image_path = output_dir / f"line-{text_index:04d}-v{variant}.png"
            image.save(image_path, format="PNG")
            rows.append(
                {
                    "id": f"project-fixture-synthetic:{text_index}:{variant}",
                    "image": _workspace_relative(image_path),
                    "text": text,
                    "split": "validation" if variant == 5 else "train",
                    "source": "project_fixture_synthetic",
                    "documentType": "line",
                    "fields": {},
                    "usableForTraining": True,
                    "usableForBenchmark": False,
                    "manualReviewNote": "Synthetic augmentation rendered from project fixture fields; never counted as real-fixture validation.",
                }
            )
    return rows


def _fixture_training_font(variant: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    size = (24, 30, 36, 42, 32, 38)[variant]
    bold = variant in {2, 3, 5}
    candidates = [
        Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
        Path("C:/Windows/Fonts/calibrib.ttf" if bold else "C:/Windows/Fonts/calibri.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", size)
    except OSError:
        return ImageFont.load_default()


def _render_fixture_training_line(
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    variant: int,
) -> Image.Image:
    probe = Image.new("L", (16, 16), color=245)
    bounds = ImageDraw.Draw(probe).textbbox((0, 0), text, font=font)
    width = max(128, bounds[2] - bounds[0] + 32)
    height = max(48, bounds[3] - bounds[1] + 24)
    background = 235 if variant == 4 else 250
    foreground = 55 if variant == 4 else 15
    image = Image.new("L", (width, height), color=background)
    ImageDraw.Draw(image).text((16 - bounds[0], 12 - bounds[1]), text, font=font, fill=foreground)
    if variant == 1:
        image = image.rotate(0.8, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=background)
    elif variant == 4:
        image = image.filter(ImageFilter.GaussianBlur(radius=0.45))
    elif variant == 5:
        image = image.rotate(-0.6, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=background)
    return image


def _load_repaired_json(path: Path) -> dict[str, Any]:
    return _repair_mojibake(json.loads(path.read_text(encoding="utf-8")))


def _repair_mojibake(value: Any) -> Any:
    if isinstance(value, str):
        if any(marker in value for marker in ("Ã", "Ä", "Å", "â")):
            try:
                return value.encode("latin1").decode("utf-8")
            except UnicodeError:
                return value
        return value
    if isinstance(value, list):
        return [_repair_mojibake(item) for item in value]
    if isinstance(value, dict):
        return {key: _repair_mojibake(item) for key, item in value.items()}
    return value


def _matching_fixture_path(fixture_root: Path, stem: str) -> Path | None:
    for path in (sorted(fixture_root.iterdir()) if fixture_root.exists() else []):
        if path.is_file() and path.stem == stem and path.suffix.lower() in IMAGE_EXTENSIONS:
            return path
    return None


def _relative_or_name(path: Path | None, root: Path) -> str | None:
    if path is None:
        return None
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except ValueError:
        return path.name


def _fixture_split(index: int, count: int) -> str:
    if count <= 2:
        return "test"
    ratio = index / max(count, 1)
    if ratio < 0.7:
        return "train"
    if ratio < 0.85:
        return "validation"
    return "test"


def _write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows), encoding="utf-8")


def _read_jsonl(path: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise json.JSONDecodeError("JSONL row must be an object", line, 0)
                rows.append(row)
    return rows


def _tree_sha256(root: Path, files: list[Path]) -> str:
    digest = hashlib.sha256()
    for file in files:
        relative = file.relative_to(root) if root.is_dir() else Path(file.name)
        digest.update(str(relative).replace("\\", "/").encode("utf-8"))
        digest.update(b"\0")
        digest.update(file.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    configure_utf8_stdout()
    parser = argparse.ArgumentParser(description="Write guarded OCR public dataset adapter manifest.")
    parser.add_argument("--dataset-root", type=Path, default=Path("data/datasets"))
    parser.add_argument("--fixture-root", type=Path, default=Path("data/demo-fixtures"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/datasets/custom-ocr-dataset-sources.json"))
    parser.add_argument(
        "--generate-missing-character-assets",
        action="store_true",
        help="Generate missing CORD/SROIE numeric character crops; intentionally off for fast repeatable inventory.",
    )
    args = parser.parse_args()
    print(
        json.dumps(
            write_dataset_source_manifest(
                args.dataset_root,
                args.output,
                args.fixture_root,
                progress=True,
                generate_missing_character_assets=args.generate_missing_character_assets,
            ),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
