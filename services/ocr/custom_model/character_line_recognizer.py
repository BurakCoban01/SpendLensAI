from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from services.ocr.custom_model.char_cnn import CharacterCNN
from services.ocr.custom_model.numeric_field_recognizer import classify_character_boxes, image_to_gray_and_binary
from services.ocr.custom_model.segmentation import SegmentBox, segment_characters, segment_words
from services.ocr.custom_model.vocab import CHARS, VOCAB, VOCAB_VERSION


@dataclass(frozen=True)
class CharacterLinePrediction:
    text: str
    confidence: float
    model_version: str
    tokens: list[dict[str, object]]


def load_character_line_model(checkpoint: Path) -> tuple[CharacterCNN, dict[str, object]]:
    if not checkpoint.is_file():
        raise FileNotFoundError(f"Character checkpoint not found: {checkpoint}")
    payload = torch.load(checkpoint, map_location="cpu")
    if str(payload.get("vocab_version") or "") != VOCAB_VERSION:
        raise ValueError("Character checkpoint vocabulary does not match the active OCR vocabulary.")
    model = CharacterCNN(num_classes=len(VOCAB))
    model.load_state_dict(payload["model_state"])
    model.eval()
    metadata = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    return model, metadata


def recognize_line_with_character_model(
    model: CharacterCNN,
    metadata: dict[str, object],
    gray: np.ndarray,
    line: SegmentBox,
) -> CharacterLinePrediction | None:
    local_image = Image.fromarray(gray[line.y : line.y + line.h, line.x : line.x + line.w]).convert("L")
    local_gray, local_binary = image_to_gray_and_binary(local_image)
    local_line = SegmentBox(0, 0, local_gray.shape[1], local_gray.shape[0], "line")
    words = segment_words(local_binary, local_line)
    if not words:
        return None

    text_parts: list[str] = []
    confidences: list[float] = []
    tokens: list[dict[str, object]] = []
    model_version = str(metadata.get("modelVersion") or "custom-char-cnn")
    for word in words:
        boxes = segment_characters(local_binary, word)
        if not boxes:
            continue
        text, confidence, character_confidences = classify_character_boxes(model, local_gray, boxes, CHARS)
        if not text:
            continue
        text_parts.append(text)
        confidences.extend(character_confidences)
        tokens.extend(
            {
                "text": character,
                "confidence": round(character_confidence, 4),
                "bbox": [line.x + box.x, line.y + box.y, box.w, box.h],
                "level": "char",
                "source": "char_cnn_real_crop",
                "model_version": model_version,
            }
            for character, character_confidence, box in zip(text, character_confidences, boxes, strict=True)
        )
    if not text_parts or not confidences:
        return None
    return CharacterLinePrediction(
        text=" ".join(text_parts),
        confidence=round(sum(confidences) / len(confidences), 4),
        model_version=model_version,
        tokens=tokens,
    )
