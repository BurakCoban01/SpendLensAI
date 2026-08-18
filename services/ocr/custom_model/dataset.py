from __future__ import annotations

import argparse
import json
import random
import shutil
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from services.ocr.custom_model.cli import configure_utf8_stdout
from services.ocr.custom_model.vocab import CHARS, VOCAB_VERSION


MERCHANTS = [
    "MAVI MARKET",
    "ANKARA KIRTASIYE",
    "KARADENIZ FIRIN",
    "EGE AKARYAKIT",
    "BILGI OFIS",
    "ÇAĞRI MARKET",
    "İZMİR KIRTASİYE",
    "ÖZEL GÜNEŞ ECZANESİ",
]
ITEMS = ["EKMEK", "SÜT", "KALEM", "DEFTER", "YEMEK", "KARGO", "ABONELİK", "İÇECEK", "ÖĞLE YEMEĞİ"]
PAYMENT_METHODS = ["KART", "NAKİT", "HAVALE"]
TURKISH_LINE_TEMPLATES = (
    "{merchant} {item} TOPLAM {total}",
    "FİŞ NO {number} ÖDEME {payment} TOPLAM {total}",
    "İZMİR ŞUBE KDV %10 {tax} ₺ TOPLAM {total}",
    "ÖĞRENCİ YEMEK ÜCRETİ {total}",
)
DOCUMENT_LINE_TEMPLATES = (
    "{merchant}",
    "FİŞ NO FIS-2026-{number}",
    "FATURA NO INV-2026-{number}",
    "VKN {vkn}",
    "TARİH {date}",
    "{item} {quantity} x {unit_price} TL {line_total} TL",
    "KDV {tax} TL",
    "ARA TOPLAM {subtotal}",
    "TOPLAM {total}",
    "ODEME {payment}",
    "FİŞ NO FIS-2026-{number}",
    "FATURA NO INV-2026-{number}",
    "İŞLEM NO {vkn}",
    "VKN {vkn}",
    "TARİH {date}",
    "TARİH {date}",
    "{item} {quantity} x {unit_price} TL {line_total} TL",
    "KDV {tax} TL",
    "TOPLAM {total}",
)
DOCUMENT_VARIANTS = ("clean", "thermal", "scanned", "noisy", "rotated", "blurred", "cropped")
CHARACTER_VARIANTS = ("plain", "rotated", "blurred", "low_contrast", "thermal", "noisy")
DOCUMENT_PROFILE_COUNTS = {"tiny": 12, "demo": 72, "benchmark": 360, "local_full": 1024}
LINE_PROFILE_COUNTS = {"tiny": 16, "demo": 96, "benchmark": 512, "local_full": 2048}
NUMERIC_FIELD_PROFILE_COUNTS = {"tiny": 64, "demo": 512, "benchmark": 4096, "local_full": 16384}
CHARACTER_PROFILE_COUNTS = {"tiny": 128, "demo": 768, "benchmark": 4096, "local_full": 12288}
TURKISH_OVERSAMPLE = set("çğıİöşüÇĞÖŞÜ₺")
CONFUSING_CHARACTER_GROUPS = (
    set("Iİıil1"),
    set("OÖ0"),
    set("SŞ5"),
    set("GĞ"),
    set("cçCÇ"),
    set("uüUÜ"),
)


@dataclass(frozen=True)
class GeneratedSample:
    image_path: Path
    text: str


@dataclass(frozen=True)
class GeneratedDocumentSample:
    image_path: Path
    text: str
    document_type: str
    variant: str
    fields: dict[str, str]
    line_items: list[dict[str, str]]


@dataclass(frozen=True)
class GeneratedCharacterSample:
    image_path: Path
    character: str
    variant: str
    font_name: str


@dataclass(frozen=True)
class CorrectionSample:
    document_id: str
    image_reference: dict[str, object]
    corrected_text: str | None
    corrected_fields: dict[str, str]
    previous_fields: dict[str, str | None]
    labels: list[dict[str, object]]
    active_learning_suggestions: list[dict[str, object]]


def generate_dataset(output_dir: Path, count: int = 32, seed: int = 42) -> list[GeneratedSample]:
    random.seed(seed)
    output_dir.mkdir(parents=True, exist_ok=True)
    samples: list[GeneratedSample] = []
    manifest: list[dict[str, str]] = []
    font = _load_turkish_font(18)
    turkish_anchor_indices = _split_anchor_indices(count)

    for index in range(count):
        merchant = random.choice(MERCHANTS)
        item = random.choice(ITEMS)
        total = f"{random.randint(10, 950)},{random.randint(0, 99):02d} TL"
        if index % len(DOCUMENT_LINE_TEMPLATES) == 0 or index in turkish_anchor_indices:
            tax = f"{random.randint(1, 99)},{random.randint(0, 99):02d}"
            text = TURKISH_LINE_TEMPLATES[(index // 4) % len(TURKISH_LINE_TEMPLATES)].format(
                merchant=merchant,
                item=item,
                total=total,
                number=f"{index:06d}",
                payment=random.choice(PAYMENT_METHODS),
                tax=tax,
            )
        else:
            text = _document_training_line(random, index, merchant, item, total)
        image = _render_line_image(text, font)
        if index % 3 == 0:
            image = image.rotate(random.uniform(-2.5, 2.5), expand=False, fillcolor=245)
        if index % 5 == 0:
            image = image.filter(ImageFilter.GaussianBlur(radius=0.6))
        path = output_dir / f"sample_{index:04d}.png"
        image.save(path)
        samples.append(GeneratedSample(image_path=path, text=text))
        manifest.append({"image": path.name, "text": text, "split": _split(index, count)})

    (output_dir / "manifest.jsonl").write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in manifest), encoding="utf-8")
    return samples


def generate_document_line_dataset(
    output_dir: Path,
    count: int = 32,
    seed: int = 42,
    include_project_fixtures: bool = False,
    fixture_root: Path = Path("data/demo-fixtures"),
) -> list[GeneratedSample]:
    rng = random.Random(seed)
    output_dir.mkdir(parents=True, exist_ok=True)
    font = _load_turkish_font(18)
    samples: list[GeneratedSample] = []
    manifest: list[dict[str, object]] = []
    document_index = 0

    while len(samples) < count:
        document_type = "receipt" if document_index % 2 == 0 else "invoice"
        document = _build_document(rng, document_type, document_index)
        page, blocks = _render_document(document["lines"], document_type, font)
        variant = DOCUMENT_VARIANTS[document_index % len(DOCUMENT_VARIANTS)]
        for block in blocks:
            if len(samples) >= count:
                break
            bbox = _padded_bbox([int(value) for value in block["bbox"]], page.size, padding=4)
            crop = page.crop(bbox)
            crop = _apply_line_crop_variant(crop, variant, rng)
            sample_index = len(samples)
            filename = f"document_line_{sample_index:05d}.png"
            path = output_dir / filename
            crop.save(path)
            text = str(block["text"])
            samples.append(GeneratedSample(image_path=path, text=text))
            manifest.append(
                {
                    "image": filename,
                    "text": text,
                    "split": _split(sample_index, count),
                    "source": "synthetic_document_line_crop",
                    "documentType": document_type,
                    "documentIndex": document_index,
                    "lineIndex": block["lineIndex"],
                    "variant": variant,
                    "bbox": list(bbox),
                }
            )
        document_index += 1

    if include_project_fixtures:
        _append_project_fixture_rendered_lines(output_dir, samples, manifest, font, rng, fixture_root)

    (output_dir / "manifest.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in manifest),
        encoding="utf-8",
    )
    return samples


def _append_project_fixture_rendered_lines(
    output_dir: Path,
    samples: list[GeneratedSample],
    manifest: list[dict[str, object]],
    font: ImageFont.ImageFont,
    rng: random.Random,
    fixture_root: Path,
) -> None:
    ground_truth_root = fixture_root / "ground-truth"
    truth_files = sorted(ground_truth_root.glob("*.json")) if ground_truth_root.exists() else []
    snippets: list[tuple[str, str]] = []
    for truth_file in truth_files:
        truth = _load_repaired_fixture_json(truth_file)
        for snippet in truth.get("expectedOcrTextSnippets", []):
            text = str(snippet).strip()
            if text:
                snippets.append((truth_file.stem, text))
    total_snippets = max(len(snippets), 1)
    for snippet_index, (document_id, text) in enumerate(snippets):
        split = _split(snippet_index, total_snippets)
        sample_index = len(samples)
        filename = f"project_fixture_line_{sample_index:05d}.png"
        path = output_dir / filename
        image = _render_line_image(text, font)
        variant = DOCUMENT_VARIANTS[sample_index % len(DOCUMENT_VARIANTS)]
        image = _apply_line_crop_variant(image, variant, rng)
        image.save(path)
        samples.append(GeneratedSample(image_path=path, text=text))
        manifest.append(
            {
                "image": filename,
                "text": text,
                "split": split,
                "source": "project_real_fixture_rendered_snippet",
                "documentId": document_id,
                "variant": variant,
                "vocabVersion": VOCAB_VERSION,
                "manualReviewNote": "Rendered from project real-fixture expected OCR snippets; not a real segmented crop.",
            }
        )


def _load_repaired_fixture_json(path: Path) -> dict[str, object]:
    return _repair_mojibake(json.loads(path.read_text(encoding="utf-8")))


def _repair_mojibake(value):
    if isinstance(value, str):
        try:
            repaired = value.encode("latin1").decode("utf-8")
        except UnicodeError:
            return value
        original_score = _turkish_text_score(value)
        repaired_score = _turkish_text_score(repaired)
        return repaired if repaired_score > original_score else value
    if isinstance(value, list):
        return [_repair_mojibake(item) for item in value]
    if isinstance(value, dict):
        return {key: _repair_mojibake(item) for key, item in value.items()}
    return value


def _turkish_text_score(value: str) -> int:
    score = sum(value.count(character) for character in "çğıİöşüÇĞÖŞÜ")
    score -= value.count("Ã") + value.count("Ä") + value.count("Å") + value.count("Â")
    return score


def generate_numeric_field_dataset(output_dir: Path, count: int = 64, seed: int = 42) -> list[GeneratedSample]:
    rng = random.Random(seed)
    output_dir.mkdir(parents=True, exist_ok=True)
    fonts = [font for _name, font in _load_turkish_fonts()]
    samples: list[GeneratedSample] = []
    manifest: list[dict[str, object]] = []
    field_kinds = ("amount", "date", "document_no", "vkn")

    for index in range(count):
        field_kind = field_kinds[index % len(field_kinds)]
        text = _numeric_field_value(rng, field_kind, index)
        font = fonts[index % len(fonts)]
        image = _render_tight_text_crop(text, font)
        variant = DOCUMENT_VARIANTS[(index // len(field_kinds)) % len(DOCUMENT_VARIANTS)]
        image = _apply_line_crop_variant(image, variant, rng)
        filename = f"numeric_field_{index:05d}.png"
        path = output_dir / filename
        image.save(path)
        samples.append(GeneratedSample(image_path=path, text=text))
        manifest.append(
            {
                "image": filename,
                "text": text,
                "split": _split(index, count),
                "source": "synthetic_numeric_field_crop",
                "fieldKind": field_kind,
                "variant": variant,
                "vocabVersion": VOCAB_VERSION,
            }
        )

    (output_dir / "manifest.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in manifest),
        encoding="utf-8",
    )
    return samples


def _render_line_image(text: str, font: ImageFont.ImageFont) -> Image.Image:
    probe = Image.new("L", (1, 1), color=245)
    draw = ImageDraw.Draw(probe)
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = max(1, bbox[2] - bbox[0])
    width = min(768, max(384, text_width + 32))
    image = Image.new("L", (width, 64), color=245)
    ImageDraw.Draw(image).text((12, 22), text, fill=20, font=font)
    return image


def _render_tight_text_crop(text: str, font: ImageFont.ImageFont) -> Image.Image:
    probe = Image.new("L", (1, 1), color=245)
    draw = ImageDraw.Draw(probe)
    bbox = draw.textbbox((0, 0), text, font=font)
    width = max(1, bbox[2] - bbox[0])
    height = max(1, bbox[3] - bbox[1])
    image = Image.new("L", (width + 8, height + 8), color=245)
    ImageDraw.Draw(image).text((4 - bbox[0], 4 - bbox[1]), text, fill=20, font=font)
    return image


def _numeric_field_value(rng: random.Random, field_kind: str, index: int) -> str:
    if field_kind == "amount":
        return _format_minor(rng.randint(1, 9_999_999))
    if field_kind == "date":
        return f"{rng.randint(1, 28):02d}.{rng.randint(1, 12):02d}.{rng.randint(2020, 2032):04d}"
    if field_kind == "document_no":
        prefix = "FIS" if index % 2 == 0 else "INV"
        return f"{prefix}-{rng.randint(2020, 2032)}-{rng.randint(0, 99999):05d}"
    if field_kind == "vkn":
        return "".join(str(rng.randint(0, 9)) for _ in range(10))
    raise ValueError(f"Unsupported numeric field kind: {field_kind}")


def _padded_bbox(bbox: list[int], image_size: tuple[int, int], padding: int = 4) -> tuple[int, int, int, int]:
    left, top, right, bottom = bbox
    width, height = image_size
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(width, right + padding),
        min(height, bottom + padding),
    )


def _apply_line_crop_variant(crop: Image.Image, variant: str, rng: random.Random) -> Image.Image:
    if variant == "thermal":
        return crop.point(lambda pixel: 255 if pixel > 230 else max(0, pixel - 35)).filter(ImageFilter.GaussianBlur(radius=0.12))
    if variant == "scanned":
        return crop.rotate(rng.uniform(-1.0, 1.0), expand=False, fillcolor=248)
    if variant == "noisy":
        noisy = crop.copy()
        pixels = noisy.load()
        for y in range(noisy.height):
            for x in range(noisy.width):
                if rng.random() < 0.008:
                    pixels[x, y] = rng.choice([0, 80, 220])
        return noisy
    if variant == "rotated":
        return crop.rotate(rng.uniform(-2.0, 2.0), expand=False, fillcolor=248)
    if variant == "blurred":
        return crop.filter(ImageFilter.GaussianBlur(radius=0.55))
    if variant == "cropped" and crop.width > 8 and crop.height > 6:
        return crop.crop((2, 1, crop.width - 2, crop.height - 1))
    return crop


def _document_training_line(rng: random.Random, index: int, merchant: str, item: str, total: str) -> str:
    unit_minor = rng.randint(1200, 45000)
    quantity = rng.randint(1, 3)
    line_total_minor = unit_minor * quantity
    tax = f"{rng.randint(1, 999)},{rng.randint(0, 99):02d}"
    template = DOCUMENT_LINE_TEMPLATES[index % len(DOCUMENT_LINE_TEMPLATES)]
    return template.format(
        merchant=merchant,
        item=item,
        total=total,
        number=f"{index + 1:05d}",
        vkn=f"{1000000000 + index:010d}",
        date=f"{rng.randint(1, 28):02d}.05.2026",
        quantity=quantity,
        unit_price=_format_minor(unit_minor),
        line_total=_format_minor(line_total_minor),
        tax=tax,
        subtotal=total,
        payment=rng.choice(PAYMENT_METHODS),
    )


def import_correction_dataset(export_path: Path, output_dir: Path, anonymize: bool = False) -> list[CorrectionSample]:
    if not export_path.exists():
        raise FileNotFoundError(f"Correction export JSONL not found: {export_path}")
    output_dir.mkdir(parents=True, exist_ok=True)
    samples: list[CorrectionSample] = []
    manifest_rows: list[dict[str, object]] = []
    for line_number, line in enumerate(export_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        document = _object(row.get("document"))
        corrections = [_object(item) for item in _list(row.get("corrections"))]
        labels = [_object(item) for item in _list(row.get("labels"))]
        suggestions = [_object(item) for item in _list(row.get("activeLearningSuggestions"))]
        corrected_fields: dict[str, str] = {}
        previous_fields: dict[str, str | None] = {}
        corrected_text: str | None = None
        for correction in corrections:
            field_name = str(correction.get("fieldName") or "full_text")
            before_value = _optional_string(correction.get("beforeValue"))
            after_value = str(correction.get("afterValue") or "")
            if field_name in {"ocr_text", "raw_ocr_text", "normalized_ocr_text", "full_text"}:
                corrected_text = after_value
            else:
                corrected_fields[field_name] = after_value
                previous_fields[field_name] = before_value
        image_reference = {
            "bucket": document.get("bucket"),
            "objectKey": document.get("objectKey"),
            "safeName": document.get("safeName"),
            "mimeType": document.get("mimeType"),
            "sha256": document.get("sha256"),
        }
        sample = CorrectionSample(
            document_id=str(document.get("id") or f"line-{line_number}"),
            image_reference=_anonymize_image_reference(image_reference) if anonymize else image_reference,
            corrected_text=_mask_text(corrected_text) if anonymize and corrected_text is not None else corrected_text,
            corrected_fields=_mask_mapping(corrected_fields) if anonymize else corrected_fields,
            previous_fields=_mask_mapping(previous_fields) if anonymize else previous_fields,
            labels=[_mask_payload(label) if anonymize else label for label in labels],
            active_learning_suggestions=[_mask_payload(suggestion) if anonymize else suggestion for suggestion in suggestions],
        )
        samples.append(sample)
        manifest_rows.append(
            {
                "schemaVersion": 1,
                "source": "review_dataset_export",
                "split": "train",
                "documentId": sample.document_id,
                "documentType": document.get("kind"),
                "image": sample.image_reference,
                "correctedText": sample.corrected_text,
                "correctedFields": sample.corrected_fields,
                "previousFields": sample.previous_fields,
                "labels": sample.labels,
                "activeLearningSuggestions": sample.active_learning_suggestions,
            }
        )
    (output_dir / "correction_manifest.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in manifest_rows),
        encoding="utf-8",
    )
    return samples


def generate_character_dataset(output_dir: Path, count: int = 128, seed: int = 42) -> list[GeneratedCharacterSample]:
    rng = random.Random(seed)
    output_dir.mkdir(parents=True, exist_ok=True)
    fonts = _load_turkish_fonts()
    weighted_chars = _weighted_character_inventory()
    required_chars = list(dict.fromkeys(CHARS))
    samples: list[GeneratedCharacterSample] = []
    manifest: list[dict[str, object]] = []

    for index in range(count):
        char = required_chars[index] if index < len(required_chars) else rng.choice(weighted_chars)
        font_name, font = fonts[index % len(fonts)]
        variant = CHARACTER_VARIANTS[index % len(CHARACTER_VARIANTS)]
        image = _render_character_crop(char, font, variant, rng)
        filename = f"char_{index:05d}.png"
        path = output_dir / filename
        image.save(path)
        sample = GeneratedCharacterSample(image_path=path, character=char, variant=variant, font_name=font_name)
        samples.append(sample)
        manifest.append(
            {
                "image": filename,
                "text": char,
                "character": char,
                "split": _split(index, count),
                "variant": variant,
                "font": font_name,
                "vocabVersion": VOCAB_VERSION,
                "source": "synthetic_character",
                "oversampled": char in TURKISH_OVERSAMPLE or any(char in group for group in CONFUSING_CHARACTER_GROUPS),
            }
        )

    (output_dir / "character_manifest.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in manifest),
        encoding="utf-8",
    )
    return samples


def generate_document_dataset(output_dir: Path, count: int = 24, seed: int = 42) -> list[GeneratedDocumentSample]:
    rng = random.Random(seed)
    output_dir.mkdir(parents=True, exist_ok=True)
    font = _load_turkish_font(18)
    samples: list[GeneratedDocumentSample] = []
    manifest: list[dict[str, object]] = []

    for index in range(count):
        document_type = "receipt" if index % 2 == 0 else "invoice"
        variant = DOCUMENT_VARIANTS[index % len(DOCUMENT_VARIANTS)]
        document = _build_document(rng, document_type, index)
        image, blocks = _render_document(document["lines"], document_type, font)
        image = _apply_document_variant(image, variant, rng)
        filename = f"{document_type}_{variant}_{index:04d}.png"
        path = output_dir / filename
        image.save(path)
        sample = GeneratedDocumentSample(
            image_path=path,
            text="\n".join(document["lines"]),
            document_type=document_type,
            variant=variant,
            fields=document["fields"],
            line_items=document["line_items"],
        )
        samples.append(sample)
        manifest.append(
            {
                "image": filename,
                "text": sample.text,
                "split": _split(index, count),
                "documentType": document_type,
                "variant": variant,
                "fields": sample.fields,
                "lineItems": sample.line_items,
                "blocks": blocks,
                "source": "synthetic_local",
            }
        )

    (output_dir / "document_manifest.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in manifest),
        encoding="utf-8",
    )
    return samples


def _split(index: int, count: int) -> str:
    ratio = index / max(count, 1)
    if ratio < 0.7:
        return "train"
    if ratio < 0.85:
        return "validation"
    return "test"


def _split_anchor_indices(count: int) -> set[int]:
    anchors: set[int] = set()
    for split in ("train", "validation", "test"):
        for index in range(count):
            if _split(index, count) == split:
                anchors.add(index)
                break
    return anchors


def _build_document(rng: random.Random, document_type: str, index: int) -> dict[str, object]:
    merchant = rng.choice(MERCHANTS)
    date = f"{rng.randint(1, 28):02d}.05.2026"
    payment_method = rng.choice(PAYMENT_METHODS)
    line_items: list[dict[str, str]] = []
    subtotal_minor = 0
    for line_index in range(rng.randint(2, 4)):
        quantity = rng.randint(1, 3)
        unit_minor = rng.randint(1200, 45000)
        total_minor = quantity * unit_minor
        subtotal_minor += total_minor
        line_items.append(
            {
                "name": rng.choice(ITEMS),
                "quantity": str(quantity),
                "unitPrice": _format_minor(unit_minor),
                "lineTotal": _format_minor(total_minor),
                "taxRate": "20" if document_type == "invoice" else "10",
            }
        )
    tax_minor = (subtotal_minor * (20 if document_type == "invoice" else 10)) // 100
    total_minor = subtotal_minor + tax_minor
    document_no = f"{'INV' if document_type == 'invoice' else 'FIS'}-2026-{index + 1:05d}"
    lines = [merchant, f"{'FATURA' if document_type == 'invoice' else 'FİŞ'} NO {document_no}", f"TARİH {date}"]
    lines.extend(
        f"{item['name']} {item['quantity']} x {item['unitPrice']} TL {item['lineTotal']} TL"
        for item in line_items
    )
    lines.extend(
        [
            f"ARA TOPLAM {_format_minor(subtotal_minor)} TL",
            f"KDV {_format_minor(tax_minor)} TL",
            f"TOPLAM {_format_minor(total_minor)} TL",
            f"ODEME {payment_method}",
        ]
    )
    if document_type == "invoice":
        synthetic_vkn = f"{1000000000 + index:010d}"
        lines.insert(2, f"VKN {synthetic_vkn}")
    else:
        synthetic_vkn = ""
    return {
        "lines": lines,
        "fields": {
            "merchant": merchant,
            "documentNo": document_no,
            "date": date,
            "subtotal": f"{_format_minor(subtotal_minor)} TL",
            "taxAmount": f"{_format_minor(tax_minor)} TL",
            "total": f"{_format_minor(total_minor)} TL",
            "currency": "TRY",
            "paymentMethod": payment_method,
            "syntheticVkn": synthetic_vkn,
        },
        "line_items": line_items,
    }


def _render_document(lines: list[str], document_type: str, font: ImageFont.ImageFont) -> tuple[Image.Image, list[dict[str, object]]]:
    width = 520 if document_type == "receipt" else 680
    height = max(260, 54 + len(lines) * 28)
    image = Image.new("L", (width, height), color=246)
    draw = ImageDraw.Draw(image)
    draw.rectangle((18, 14, width - 18, height - 16), outline=190, width=1)
    y = 34
    blocks: list[dict[str, object]] = []
    for line_index, line in enumerate(lines):
        x = 38
        draw.text((x, y), line, fill=22, font=font)
        left, top, right, bottom = draw.textbbox((x, y), line, font=font)
        blocks.append({"lineIndex": line_index, "text": line, "bbox": [left, top, right, bottom]})
        y += 28
    return image, blocks


def _apply_document_variant(image: Image.Image, variant: str, rng: random.Random) -> Image.Image:
    if variant == "thermal":
        return image.point(lambda pixel: 255 if pixel > 230 else max(0, pixel - 35)).filter(ImageFilter.GaussianBlur(radius=0.15))
    if variant == "scanned":
        return image.rotate(rng.uniform(-1.5, 1.5), expand=False, fillcolor=248)
    if variant == "noisy":
        pixels = image.load()
        for y in range(image.height):
            for x in range(image.width):
                if rng.random() < 0.012:
                    pixels[x, y] = rng.choice([0, 80, 220])
        return image
    if variant == "rotated":
        return image.rotate(rng.uniform(-4.0, 4.0), expand=False, fillcolor=248)
    if variant == "blurred":
        return image.filter(ImageFilter.GaussianBlur(radius=0.75))
    if variant == "cropped":
        crop_margin = 8
        return image.crop((crop_margin, crop_margin, image.width - crop_margin, image.height - crop_margin))
    return image


def _format_minor(value: int) -> str:
    return f"{value // 100},{value % 100:02d}"


def run_cli(argv: list[str] | None = None) -> int:
    configure_utf8_stdout()
    parser = argparse.ArgumentParser(description="Generate local synthetic OCR datasets for SpendLens AI.")
    parser.add_argument("--output-dir", type=Path, default=Path("data/generated/custom-ocr-documents"))
    parser.add_argument("--profile", choices=("tiny", "demo", "benchmark", "local_full"), default="tiny")
    parser.add_argument("--max-disk-gb", type=float, default=12.0)
    parser.add_argument(
        "--mode",
        choices=("characters", "documents", "lines", "document_lines", "numeric_fields", "corrections"),
        default="documents",
    )
    parser.add_argument("--correction-export", type=Path, default=None)
    parser.add_argument("--anonymize-corrections", action="store_true")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--count", type=int, default=None)
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args(argv)

    if args.clean:
        _clean_generated_output_dir(args.output_dir)
        if args.count is None:
            return 0

    count = args.count
    if count is None:
        if args.mode == "documents":
            count = DOCUMENT_PROFILE_COUNTS[args.profile]
        elif args.mode == "characters":
            count = CHARACTER_PROFILE_COUNTS[args.profile]
        elif args.mode == "numeric_fields":
            count = NUMERIC_FIELD_PROFILE_COUNTS[args.profile]
        else:
            count = LINE_PROFILE_COUNTS[args.profile]
    if count <= 0:
        raise SystemExit("--count must be positive when generation is requested")
    if args.profile == "local_full" and args.max_disk_gb < 1:
        raise SystemExit("--max-disk-gb is too small for local_full generation")

    if args.mode == "corrections":
        if args.correction_export is None:
            raise SystemExit("--correction-export is required when --mode corrections is used")
        samples = import_correction_dataset(args.correction_export, args.output_dir, anonymize=args.anonymize_corrections)
        manifest_name = "correction_manifest.jsonl"
    elif args.mode == "characters":
        samples = generate_character_dataset(args.output_dir, count=count, seed=args.seed)
        manifest_name = "character_manifest.jsonl"
    elif args.mode == "documents":
        samples = generate_document_dataset(args.output_dir, count=count, seed=args.seed)
        manifest_name = "document_manifest.jsonl"
    elif args.mode == "numeric_fields":
        samples = generate_numeric_field_dataset(args.output_dir, count=count, seed=args.seed)
        manifest_name = "manifest.jsonl"
    elif args.mode == "document_lines":
        samples = generate_document_line_dataset(args.output_dir, count=count, seed=args.seed)
        manifest_name = "manifest.jsonl"
    else:
        samples = generate_dataset(args.output_dir, count=count, seed=args.seed)
        manifest_name = "manifest.jsonl"

    print(
        json.dumps(
            {
                "outputDir": str(args.output_dir),
                "mode": args.mode,
                "profile": args.profile,
                "seed": args.seed,
                "count": len(samples),
                "manifest": manifest_name,
                "maxDiskGb": args.max_disk_gb,
            },
            ensure_ascii=False,
        )
    )
    return 0


def _load_turkish_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for font_name in ("arial.ttf", "DejaVuSans.ttf", "NotoSans-Regular.ttf", "LiberationSans-Regular.ttf"):
        try:
            return ImageFont.truetype(font_name, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _load_turkish_fonts() -> list[tuple[str, ImageFont.ImageFont]]:
    fonts: list[tuple[str, ImageFont.ImageFont]] = []
    for font_name in ("arial.ttf", "DejaVuSans.ttf", "NotoSans-Regular.ttf", "LiberationSans-Regular.ttf"):
        for size in (20, 24, 28):
            try:
                fonts.append((f"{font_name}:{size}", ImageFont.truetype(font_name, size=size)))
            except OSError:
                pass
    return fonts or [("pil-default", ImageFont.load_default())]


def _weighted_character_inventory() -> list[str]:
    weighted: list[str] = []
    for char in CHARS:
        weight = 1
        if char in TURKISH_OVERSAMPLE:
            weight += 5
        if any(char in group for group in CONFUSING_CHARACTER_GROUPS):
            weight += 3
        weighted.extend([char] * weight)
    return weighted


def _render_character_crop(char: str, font: ImageFont.ImageFont, variant: str, rng: random.Random) -> Image.Image:
    background = 245
    foreground = 20
    if variant == "thermal":
        background = 232
        foreground = 0
    elif variant == "low_contrast":
        background = 218
        foreground = 92
    image = Image.new("L", (40, 40), color=background)
    draw = ImageDraw.Draw(image)
    bbox = draw.textbbox((0, 0), char, font=font)
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    x = max(1, (40 - width) // 2 + rng.randint(-2, 2))
    y = max(1, (40 - height) // 2 + rng.randint(-2, 2))
    draw.text((x, y), char, fill=foreground, font=font)
    if variant == "rotated":
        image = image.rotate(rng.uniform(-10, 10), expand=False, fillcolor=background)
    if variant == "blurred":
        image = image.filter(ImageFilter.GaussianBlur(radius=0.45))
    if variant == "thermal":
        image = image.point(lambda pixel: 255 if pixel > 225 else max(0, pixel - 20))
    if variant == "noisy":
        pixels = image.load()
        for y_pos in range(image.height):
            for x_pos in range(image.width):
                if rng.random() < 0.025:
                    pixels[x_pos, y_pos] = rng.choice([0, 80, 220])
    return image.resize((32, 32))


def _clean_generated_output_dir(output_dir: Path) -> None:
    workspace_root = Path.cwd().resolve()
    target = output_dir.resolve()
    allowed_roots = [
        (workspace_root / "data" / "generated").resolve(),
        (workspace_root / "artifacts").resolve(),
    ]
    protected_roots = [
        workspace_root,
        workspace_root / ".git",
        workspace_root / ".github",
        workspace_root / "apps",
        workspace_root / "docs",
        workspace_root / "packages",
        workspace_root / "scripts",
        workspace_root / "services",
    ]

    if not any(_is_relative_to(target, root) and target != root for root in allowed_roots):
        raise SystemExit(
            "--clean only removes a specific generated Custom OCR output directory under data/generated or artifacts."
        )
    if any(target == root or _is_relative_to(root, target) for root in protected_roots):
        raise SystemExit(f"Refusing to clean protected project path: {target}")

    shutil.rmtree(target, ignore_errors=True)


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _object(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _list(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _mask_mapping(mapping: dict[str, str | None]) -> dict[str, str | None]:
    return {key: (_mask_text(value) if value is not None else None) for key, value in mapping.items()}


def _mask_payload(value: object) -> object:
    if isinstance(value, dict):
        return {key: _mask_payload(nested) for key, nested in value.items()}
    if isinstance(value, list):
        return [_mask_payload(item) for item in value]
    if isinstance(value, str):
        return _mask_text(value)
    return value


def _mask_text(value: str) -> str:
    return "".join("0" if char.isdigit() else "X" if char.isalpha() else char for char in value)


def _anonymize_image_reference(reference: dict[str, object]) -> dict[str, object]:
    anonymized = dict(reference)
    for key in ("safeName", "sha256", "objectKey"):
        if isinstance(anonymized.get(key), str):
            anonymized[key] = _mask_text(str(anonymized[key]))
    return anonymized


if __name__ == "__main__":
    raise SystemExit(run_cli())
