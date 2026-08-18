from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image

from services.ocr.custom_model.char_cnn import CharacterCNN
from services.ocr.custom_model.segmentation import SegmentBox, segment_characters, segment_words
from services.ocr.custom_model.vocab import CHAR_TO_INDEX, VOCAB, VOCAB_VERSION


_ASCII_FOLD = str.maketrans(
    {
        "ç": "c",
        "Ç": "C",
        "ğ": "g",
        "Ğ": "G",
        "ı": "i",
        "İ": "I",
        "ö": "o",
        "Ö": "O",
        "ş": "s",
        "Ş": "S",
        "ü": "u",
        "Ü": "U",
    }
)
_ALLOWED_BY_KIND = {
    "amount": "0123456789,.",
    "date": "0123456789.",
    "document_no": "0123456789-FISINV",
    "quantity": "0123456789",
    "vkn": "0123456789",
}


@dataclass(frozen=True)
class NumericFieldPrediction:
    field_kind: str
    text: str
    confidence: float
    normalized_line: str
    model_version: str
    tokens: list[dict[str, object]]


def load_numeric_character_model(checkpoint: Path) -> tuple[CharacterCNN, dict[str, object]]:
    if not checkpoint.exists():
        raise FileNotFoundError(f"Numeric character checkpoint not found: {checkpoint}")
    payload = torch.load(checkpoint, map_location="cpu")
    checkpoint_vocab = str(payload.get("vocab_version") or "")
    if checkpoint_vocab != VOCAB_VERSION:
        raise ValueError(
            f"Numeric character checkpoint vocabulary {checkpoint_vocab!r} does not match {VOCAB_VERSION!r}."
        )
    model = CharacterCNN(num_classes=len(VOCAB))
    model.load_state_dict(payload["model_state"])
    model.eval()
    metadata = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    return model, metadata


def recognize_numeric_field_line(
    model: CharacterCNN,
    metadata: dict[str, object],
    gray: np.ndarray,
    binary: np.ndarray,
    line: SegmentBox,
    raw_line_text: str,
    *,
    minimum_confidence: float = 0.9,
) -> NumericFieldPrediction | None:
    local_image = Image.fromarray(gray[line.y : line.y + line.h, line.x : line.x + line.w]).convert("L")
    local_gray, local_binary = image_to_gray_and_binary(local_image)
    local_line = SegmentBox(0, 0, local_gray.shape[1], local_gray.shape[0], "line")
    line_item_offsets = _line_item_offsets(raw_line_text)
    if line_item_offsets is not None:
        prediction = _recognize_line_item_fields(
            model,
            metadata,
            local_gray,
            local_binary,
            local_line,
            raw_line_text,
            line_item_offsets,
            minimum_confidence,
        )
        return _offset_prediction_tokens(prediction, line.x, line.y)
    spec = _field_spec(raw_line_text)
    if spec is None:
        return None
    field_kind, word_offset = spec
    words = segment_words(local_binary, local_line)
    if len(words) < abs(word_offset):
        return None
    word = words[word_offset]
    characters = segment_characters(local_binary, word)
    if not characters:
        return None
    text, confidence, character_confidences = classify_character_boxes(
        model,
        local_gray,
        characters,
        _allowed_characters_for_field(field_kind, characters),
    )
    if confidence < minimum_confidence or not _valid_field_value(field_kind, text):
        return None
    normalized_line = _replace_field_token(raw_line_text, word_offset, text)
    if normalized_line is None:
        return None
    model_version = str(metadata.get("modelVersion") or metadata.get("model_version") or "custom-char-cnn-numeric")
    tokens = [
        {
            "text": character,
            "confidence": round(character_confidence, 4),
            "bbox": [box.x, box.y, box.w, box.h],
            "level": "char",
            "source": "char_cnn_numeric_constrained",
            "field_kind": field_kind,
            "model_version": model_version,
        }
        for character, character_confidence, box in zip(text, character_confidences, characters, strict=True)
    ]
    return _offset_prediction_tokens(NumericFieldPrediction(
        field_kind=field_kind,
        text=text,
        confidence=round(confidence, 4),
        normalized_line=normalized_line,
        model_version=model_version,
        tokens=tokens,
    ), line.x, line.y)


def recognize_visual_amount_line(
    model: CharacterCNN,
    metadata: dict[str, object],
    gray: np.ndarray,
    binary: np.ndarray,
    line: SegmentBox,
    raw_line_text: str,
    *,
    minimum_confidence: float = 0.92,
) -> NumericFieldPrediction | None:
    if not _visual_amount_context_allowed(raw_line_text):
        return None
    local_image = Image.fromarray(gray[line.y : line.y + line.h, line.x : line.x + line.w]).convert("L")
    local_gray, local_binary = image_to_gray_and_binary(local_image)
    local_line = SegmentBox(0, 0, local_gray.shape[1], local_gray.shape[0], "line")
    best_prediction: tuple[str, float, list[float], list[SegmentBox]] | None = None
    for word in segment_words(local_binary, local_line):
        characters = segment_characters(local_binary, word)
        if len(characters) < 4 or len(characters) > 10:
            continue
        try:
            text, confidence, character_confidences = classify_character_boxes(
                model,
                local_gray,
                characters,
                _allowed_characters_for_field("amount", characters),
            )
        except (RuntimeError, ValueError):
            continue
        text, geometry_repaired = _repair_amount_separator_by_geometry(text, characters)
        effective_minimum_confidence = min(minimum_confidence, 0.72) if geometry_repaired else minimum_confidence
        if confidence < effective_minimum_confidence or not _valid_visual_amount_value(text):
            continue
        if best_prediction is None or confidence > best_prediction[1]:
            best_prediction = (text, confidence, character_confidences, characters)
    if best_prediction is None:
        return None
    text, confidence, character_confidences, characters = best_prediction
    normalized_line = _merge_visual_amount_candidate(raw_line_text, text)
    model_version = str(metadata.get("modelVersion") or metadata.get("model_version") or "custom-char-cnn-numeric")
    tokens = [
        {
            "text": character,
            "confidence": round(character_confidence, 4),
            "bbox": [box.x, box.y, box.w, box.h],
            "level": "char",
            "source": "char_cnn_numeric_visual_amount",
            "field_kind": "amount",
            "model_version": model_version,
        }
        for character, character_confidence, box in zip(text, character_confidences, characters, strict=True)
    ]
    return _offset_prediction_tokens(
        NumericFieldPrediction(
            field_kind="amount",
            text=text,
            confidence=round(confidence, 4),
            normalized_line=normalized_line,
            model_version=model_version,
            tokens=tokens,
        ),
        line.x,
        line.y,
    )


def _offset_prediction_tokens(
    prediction: NumericFieldPrediction | None,
    offset_x: int,
    offset_y: int,
) -> NumericFieldPrediction | None:
    if prediction is None:
        return None
    tokens = []
    for token in prediction.tokens:
        bbox = token.get("bbox")
        if isinstance(bbox, list) and len(bbox) == 4:
            bbox = [int(bbox[0]) + offset_x, int(bbox[1]) + offset_y, int(bbox[2]), int(bbox[3])]
        tokens.append({**token, "bbox": bbox})
    return NumericFieldPrediction(
        field_kind=prediction.field_kind,
        text=prediction.text,
        confidence=prediction.confidence,
        normalized_line=prediction.normalized_line,
        model_version=prediction.model_version,
        tokens=tokens,
    )


def _recognize_line_item_fields(
    model: CharacterCNN,
    metadata: dict[str, object],
    gray: np.ndarray,
    binary: np.ndarray,
    line: SegmentBox,
    raw_line_text: str,
    offsets: tuple[int, int, int],
    minimum_confidence: float,
) -> NumericFieldPrediction | None:
    raw_words = raw_line_text.split()
    words = segment_words(binary, line)
    if len(words) != len(raw_words):
        return None
    field_specs = (
        ("line_item_quantity", "quantity", offsets[0]),
        ("line_item_unit_price", "amount", offsets[1]),
        ("line_item_total", "amount", offsets[2]),
    )
    replacements: dict[int, str] = {}
    all_tokens: list[dict[str, object]] = []
    all_confidences: list[float] = []
    model_version = str(metadata.get("modelVersion") or metadata.get("model_version") or "custom-char-cnn-numeric")
    predicted_values: list[str] = []
    for evidence_kind, value_kind, word_index in field_specs:
        characters = segment_characters(binary, words[word_index])
        if not characters:
            return None
        text, confidence, character_confidences = classify_character_boxes(
            model,
            gray,
            characters,
            _allowed_characters_for_field(value_kind, characters),
        )
        if confidence < minimum_confidence or not _valid_field_value(value_kind, text):
            return None
        replacements[word_index] = text
        predicted_values.append(text)
        all_confidences.extend(character_confidences)
        all_tokens.extend(
            {
                "text": character,
                "confidence": round(character_confidence, 4),
                "bbox": [box.x, box.y, box.w, box.h],
                "level": "char",
                "source": "char_cnn_numeric_constrained",
                "field_kind": evidence_kind,
                "model_version": model_version,
            }
            for character, character_confidence, box in zip(text, character_confidences, characters, strict=True)
        )
    normalized_words = list(raw_words)
    for word_index, replacement in replacements.items():
        normalized_words[word_index] = replacement
    return NumericFieldPrediction(
        field_kind="line_item",
        text="|".join(predicted_values),
        confidence=round(sum(all_confidences) / len(all_confidences), 4),
        normalized_line=" ".join(normalized_words),
        model_version=model_version,
        tokens=all_tokens,
    )


def classify_character_boxes(
    model: CharacterCNN,
    gray: np.ndarray,
    boxes: list[SegmentBox],
    allowed_characters: str,
) -> tuple[str, float, list[float]]:
    if not boxes:
        return "", 0.0, []
    allowed_indices = torch.tensor([CHAR_TO_INDEX[character] for character in allowed_characters], dtype=torch.long)
    images = torch.stack([character_box_to_tensor(gray, box) for box in boxes])
    model.eval()
    with torch.no_grad():
        logits = model(images)[:, allowed_indices]
        probabilities = torch.softmax(logits, dim=1)
        candidate_indices = probabilities.argmax(dim=1)
        confidences = probabilities.max(dim=1).values.tolist()
    text = "".join(allowed_characters[index] for index in candidate_indices.tolist())
    return text, sum(confidences) / len(confidences), confidences


def _allowed_characters_for_field(field_kind: str, characters: list[SegmentBox]) -> str:
    return _ALLOWED_BY_KIND[field_kind]


def character_box_to_tensor(gray: np.ndarray, box: SegmentBox) -> torch.Tensor:
    crop = gray[box.y : box.y + box.h, box.x : box.x + box.w]
    if crop.size == 0:
        raise ValueError("Character crop is empty.")
    scale = min(24 / max(crop.shape[1], 1), 24 / max(crop.shape[0], 1))
    width = max(1, round(crop.shape[1] * scale))
    height = max(1, round(crop.shape[0] * scale))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    resized = cv2.resize(crop, (width, height), interpolation=interpolation)
    canvas = np.full((32, 32), 245, dtype=np.uint8)
    left = (32 - width) // 2
    top = (32 - height) // 2
    canvas[top : top + height, left : left + width] = resized
    return torch.from_numpy(canvas.astype(np.float32) / 255.0).unsqueeze(0)


def image_to_gray_and_binary(image: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    gray = np.asarray(image.convert("L"), dtype=np.uint8)
    _threshold, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return gray, binary


def _field_spec(raw_line_text: str) -> tuple[str, int] | None:
    folded = " ".join(raw_line_text.translate(_ASCII_FOLD).upper().split())
    words = folded.split()
    if len(words) >= 2 and words[0] == "ARA" and words[1] == "TOPLAM":
        return "amount", -2
    if words and words[0] in {"KDV", "TOPLAM", "TOTAL", "AMOUNT"}:
        return "amount", -2
    if words and words[0] == "TARIH":
        return "date", -1
    if words and words[0] == "VKN":
        return "vkn", -1
    if len(words) >= 2 and words[1] == "NO" and words[0] in {"FIS", "FATURA"}:
        return "document_no", -1
    if not words:
        return None

    last_token = words[-1]
    first_token = words[0].strip(":")
    if _token_similarity(first_token, "TARIH") >= 0.4 and any(character.isdigit() for character in last_token):
        return "date", -1
    if (
        any(_token_similarity(first_token, prefix) >= 0.6 for prefix in ("FIS", "FATURA"))
        and any(character.isdigit() for character in last_token)
    ):
        return "document_no", -1
    if len(words) >= 2 and sum(character.isdigit() for character in last_token) >= 7:
        return "vkn", -1
    if (
        len(words) >= 3
        and words[-1] in {"TL", "TRY"}
        and any(character.isdigit() for character in words[-2])
    ):
        return "amount", -2
    return None


def _token_similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_character != right_character),
                )
            )
        previous = current
    return 1.0 - previous[-1] / max(len(left), len(right))


def _line_item_offsets(raw_line_text: str) -> tuple[int, int, int] | None:
    words = " ".join(raw_line_text.translate(_ASCII_FOLD).upper().split()).split()
    try:
        multiplication_index = words.index("X")
    except ValueError:
        return None
    quantity_index = multiplication_index - 1
    unit_price_index = multiplication_index + 1
    first_currency_index = multiplication_index + 2
    total_index = multiplication_index + 3
    final_currency_index = multiplication_index + 4
    if quantity_index < 1 or final_currency_index >= len(words):
        return None
    currencies = {"TL", "TRY", "₺"}
    if words[first_currency_index] not in currencies or words[final_currency_index] not in currencies:
        return None
    return quantity_index, unit_price_index, total_index


def _replace_field_token(raw_line_text: str, word_offset: int, replacement: str) -> str | None:
    words = raw_line_text.split()
    if len(words) < abs(word_offset):
        return None
    words[word_offset] = replacement
    return " ".join(words)


def _valid_field_value(field_kind: str, text: str) -> bool:
    if field_kind == "amount":
        return (
            re.fullmatch(
                r"(?:\d{1,8}[,.]\d{1,2}|\d{1,3}(?:[,.]\d{3})+|\d{1,3}(?:\.\d{3})+,\d{1,2})",
                text,
            )
            is not None
        )
    if field_kind == "date":
        if re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", text) is None:
            return False
        try:
            datetime.strptime(text, "%d.%m.%Y")
        except ValueError:
            return False
        return True
    if field_kind == "vkn":
        return re.fullmatch(r"\d{10}", text) is not None
    if field_kind == "quantity":
        return re.fullmatch(r"\d{1,3}", text) is not None
    if field_kind == "document_no":
        return re.fullmatch(r"(?:FIS|INV)-\d{4}-\d{5}", text) is not None
    return False


def _valid_visual_amount_value(text: str) -> bool:
    return re.fullmatch(r"(?:\d{1,8}[,.]\d{2}|\d{1,3}(?:[,.]\d{3})+|\d{1,3}(?:\.\d{3})+,\d{2})", text) is not None


def _repair_amount_separator_by_geometry(text: str, characters: list[SegmentBox]) -> tuple[str, bool]:
    if len(text) != len(characters) or len(text) < 4:
        return text, False
    digit_heights = [box.h for character, box in zip(text, characters, strict=True) if character.isdigit()]
    if len(digit_heights) < 3:
        return text, False
    median_digit_height = float(np.median(digit_heights))
    repaired = list(text)
    changed = False
    for index, (character, box) in enumerate(zip(text, characters, strict=True)):
        if index == 0 or index == len(text) - 1:
            continue
        if character in {",", "."}:
            continue
        if not (text[index - 1].isdigit() and text[index + 1].isdigit()):
            continue
        lower_position = box.y + box.h
        neighbor_bottom = max(characters[index - 1].y + characters[index - 1].h, characters[index + 1].y + characters[index + 1].h)
        looks_like_low_separator = box.y > min(characters[index - 1].y, characters[index + 1].y) + median_digit_height * 0.45
        looks_smaller_than_digits = box.h < median_digit_height * 0.8
        if not (looks_like_low_separator and looks_smaller_than_digits and lower_position >= neighbor_bottom - median_digit_height * 0.35):
            continue
        right_digits = sum(1 for value in text[index + 1 :] if value.isdigit())
        separator = "," if right_digits == 3 else "."
        if repaired[index] != separator:
            repaired[index] = separator
            changed = True
    candidate = "".join(repaired)
    if not changed or not _valid_visual_amount_value(candidate):
        return text, False
    return candidate, True


def _merge_visual_amount_candidate(raw_line_text: str, amount: str) -> str:
    words = raw_line_text.split()
    if not words:
        return amount
    if _looks_like_short_amount_garbage(raw_line_text):
        return amount
    for index, word in enumerate(words):
        if _valid_field_value("amount", word.strip()):
            words[index] = amount
            return " ".join(words)
    folded_words = [word.translate(_ASCII_FOLD).upper().strip(":") for word in words]
    for index, word in enumerate(folded_words):
        if word in {"TL", "TRY", "₺", "â‚º"}:
            words.insert(index, amount)
            return " ".join(words)
    return f"{raw_line_text} {amount}"


def _looks_like_short_amount_garbage(raw_line_text: str) -> bool:
    words = raw_line_text.split()
    if len(words) > 2:
        return False
    folded = raw_line_text.translate(_ASCII_FOLD).upper()
    if any(keyword in folded for keyword in {"SAAT", "TARIH", "VKN", "FIS", "FATURA", "IBAN"}):
        return False
    alphanumeric_count = sum(character.isalnum() for character in folded)
    digit_count = sum(character.isdigit() for character in folded)
    return alphanumeric_count <= 4 and digit_count >= 1


def _visual_amount_context_allowed(raw_line_text: str) -> bool:
    folded = " ".join(raw_line_text.translate(_ASCII_FOLD).upper().split())
    if re.search(r"\b\d{1,2}:\d{2}\b", folded):
        return False
    blocked_keywords = {"SAAT", "TARIH", "VKN", "TCKN", "IBAN", "FIS NO", "FATURA NO", "PARA BIRIMI"}
    if any(keyword in folded for keyword in blocked_keywords):
        return False
    amount_context = {"TOPLAM", "TOTAL", "AMOUNT", "KDV", "VAT", "CASH", "SUBTOTAL", "ARA TOPLAM", "TL", "TRY", "₺"}
    alphabetic_count = sum(character.isalpha() for character in folded)
    digit_count = sum(character.isdigit() for character in folded)
    if (
        alphabetic_count >= 6
        and digit_count <= 2
        and not any(keyword in folded for keyword in amount_context)
        and not _looks_like_short_amount_garbage(raw_line_text)
    ):
        return False
    return True
