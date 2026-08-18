from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from services.ocr.custom_model.fourier_features import cosine_similarity, embedding
from services.ocr.custom_model.segmentation import SegmentBox, segment_characters, segment_words
from services.ocr.custom_model.vocab import VOCAB


@dataclass(frozen=True)
class ClassicalPrediction:
    text: str
    confidence: float
    top_k: list[tuple[str, float]]


def predict_character(binary_crop: np.ndarray, top_k: int = 3) -> ClassicalPrediction:
    vector = embedding(binary_crop)
    scored = sorted(
        ((char, cosine_similarity(vector, prototype)) for char, prototype in _prototype_embeddings().items()),
        key=lambda item: item[1],
        reverse=True,
    )[:top_k]
    if not scored:
        return ClassicalPrediction(text="", confidence=0.0, top_k=[])
    best, score = scored[0]
    runner_up = scored[1][1] if len(scored) > 1 else -1.0
    margin = max(0.0, score - runner_up)
    raw_confidence = max(0.0, min(1.0, (score + 1.0) / 2.0))
    calibrated = min(0.72, raw_confidence * 0.55 + min(margin * 2.0, 1.0) * 0.25)
    return ClassicalPrediction(text=best, confidence=round(calibrated, 4), top_k=scored)


def recognize_line_with_fourier(binary: np.ndarray, line: SegmentBox) -> tuple[str, float, list[dict[str, object]]]:
    words = segment_words(binary, line)
    text_parts: list[str] = []
    confidences: list[float] = []
    tokens: list[dict[str, object]] = []
    for word in words:
        chars: list[str] = []
        for char_box in segment_characters(binary, word):
            crop = binary[char_box.y : char_box.y + char_box.h, char_box.x : char_box.x + char_box.w]
            prediction = predict_character(crop)
            chars.append(prediction.text)
            confidences.append(prediction.confidence)
            tokens.append(
                {
                    "text": prediction.text,
                    "confidence": prediction.confidence,
                    "bbox": [char_box.x, char_box.y, char_box.w, char_box.h],
                    "level": "char",
                    "source": "fourier_baseline",
                }
            )
        text_parts.append("".join(chars))
    text = " ".join(part for part in text_parts if part)
    confidence = min(0.58, sum(confidences) / len(confidences)) if confidences else 0.0
    return text, round(confidence, 4), tokens


@lru_cache(maxsize=1)
def _prototype_embeddings() -> dict[str, np.ndarray]:
    font = _load_font(28)
    prototypes: dict[str, np.ndarray] = {}
    for char in VOCAB:
        if char in {"<blank>", " "}:
            continue
        image = Image.new("L", (48, 48), color=255)
        draw = ImageDraw.Draw(image)
        bbox = draw.textbbox((0, 0), char, font=font)
        x = max(0, (48 - (bbox[2] - bbox[0])) // 2)
        y = max(0, (48 - (bbox[3] - bbox[1])) // 2)
        draw.text((x, y), char, fill=0, font=font)
        array = np.array(image, dtype=np.uint8)
        binary = cv2.threshold(array, 200, 255, cv2.THRESH_BINARY_INV)[1]
        prototypes[char] = embedding(binary)
    return prototypes


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for font_name in ("arial.ttf", "DejaVuSans.ttf", "NotoSans-Regular.ttf", "LiberationSans-Regular.ttf"):
        try:
            return ImageFont.truetype(font_name, size=size)
        except OSError:
            continue
    return ImageFont.load_default()