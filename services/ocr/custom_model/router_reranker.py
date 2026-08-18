from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import json
import math
from typing import Any

from services.ocr.custom_model.segmentation import SegmentBox


ROUTER_FEATURE_VERSION = "pairwise-router-features-v1"
ROUTER_ROLES = (
    "general_text",
    "merchant_header",
    "amount",
    "amount_with_label",
    "date",
    "time",
    "identifier",
    "line_item",
)
TEXT_STAT_NAMES = (
    "length",
    "token_count",
    "alphanumeric_count",
    "digit_count",
    "letter_count",
    "space_count",
    "punctuation_count",
    "replacement_count",
    "alphanumeric_ratio",
    "digit_ratio",
    "letter_ratio",
    "unique_token_ratio",
)
ROUTER_FEATURE_NAMES = (
    "aspect_ratio",
    "box_width",
    "box_height",
    "box_x",
    "box_y",
    "champion_confidence",
    "challenger_confidence",
    "confidence_delta",
    "champion_quality_score",
    "challenger_quality_score",
    "quality_score_delta",
    "candidate_edit_ratio",
    *(f"champion_{name}" for name in TEXT_STAT_NAMES),
    *(f"challenger_{name}" for name in TEXT_STAT_NAMES),
    *(f"challenger_to_champion_{name}" for name in TEXT_STAT_NAMES),
    *(f"role_{role}" for role in ROUTER_ROLES),
)


@dataclass(frozen=True)
class PairwiseRouter:
    metadata: dict[str, object]
    means: tuple[float, ...]
    scales: tuple[float, ...]
    coefficients: tuple[float, ...]
    intercept: float

    @property
    def threshold(self) -> float:
        return float(self.metadata["decisionThreshold"])

    def challenger_probability(self, features: list[float]) -> float:
        if len(features) != len(ROUTER_FEATURE_NAMES):
            raise ValueError("Pairwise router feature count does not match the active feature schema.")
        standardized = [
            (float(value) - mean) / scale
            for value, mean, scale in zip(features, self.means, self.scales, strict=True)
        ]
        logit = self.intercept + sum(
            coefficient * value for coefficient, value in zip(self.coefficients, standardized, strict=True)
        )
        if logit >= 0:
            return 1.0 / (1.0 + math.exp(-logit))
        exponential = math.exp(logit)
        return exponential / (1.0 + exponential)


def load_pairwise_router(path: Path) -> PairwiseRouter:
    if not path.is_file():
        raise FileNotFoundError(f"Pairwise router checkpoint not found: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("model"), dict) or not isinstance(payload.get("metadata"), dict):
        raise ValueError("Pairwise router checkpoint payload is invalid.")
    metadata = payload["metadata"]
    if metadata.get("featureVersion") != ROUTER_FEATURE_VERSION:
        raise ValueError("Pairwise router feature version does not match the active implementation.")
    if metadata.get("featureNames") != list(ROUTER_FEATURE_NAMES):
        raise ValueError("Pairwise router feature names do not match the active implementation.")
    threshold = metadata.get("decisionThreshold")
    if not isinstance(threshold, int | float) or not 0.5 <= float(threshold) <= 1.0:
        raise ValueError("Pairwise router decision threshold is invalid.")
    model = payload["model"]
    means = _fixed_float_tuple(model.get("means"), "means")
    scales = _fixed_float_tuple(model.get("scales"), "scales")
    coefficients = _fixed_float_tuple(model.get("coefficients"), "coefficients")
    intercept = model.get("intercept")
    if not isinstance(intercept, int | float) or any(scale <= 0 for scale in scales):
        raise ValueError("Pairwise router numeric parameters are invalid.")
    return PairwiseRouter(
        metadata=metadata,
        means=means,
        scales=scales,
        coefficients=coefficients,
        intercept=float(intercept),
    )


def _fixed_float_tuple(value: object, name: str) -> tuple[float, ...]:
    if not isinstance(value, list) or len(value) != len(ROUTER_FEATURE_NAMES):
        raise ValueError(f"Pairwise router {name} do not match the active feature schema.")
    if not all(isinstance(item, int | float) for item in value):
        raise ValueError(f"Pairwise router {name} contain invalid values.")
    return tuple(float(item) for item in value)


def candidate_pair_features(
    *,
    champion_text: str,
    challenger_text: str,
    champion_confidence: float,
    challenger_confidence: float,
    line: SegmentBox,
    aspect_ratio: float,
    line_role: str,
    champion_quality_score: float,
    challenger_quality_score: float,
) -> list[float]:
    champion_stats = _text_stats(champion_text)
    challenger_stats = _text_stats(challenger_text)
    ratios = [(challenger + 1.0) / (champion + 1.0) for champion, challenger in zip(champion_stats, challenger_stats)]
    return [
        float(aspect_ratio),
        float(line.w),
        float(line.h),
        float(line.x),
        float(line.y),
        float(champion_confidence),
        float(challenger_confidence),
        float(challenger_confidence - champion_confidence),
        float(champion_quality_score),
        float(challenger_quality_score),
        float(challenger_quality_score - champion_quality_score),
        _normalized_edit_distance(champion_text, challenger_text),
        *champion_stats,
        *challenger_stats,
        *ratios,
        *(float(line_role == role) for role in ROUTER_ROLES),
    ]


def comparison_row_features(row: dict[str, Any]) -> list[float]:
    x1, y1, x2, y2 = (int(value) for value in row["bbox"])
    candidate_scores = row["candidateScores"]
    return candidate_pair_features(
        champion_text=str(row["championPrediction"]),
        challenger_text=str(row["challengerPrediction"]),
        champion_confidence=float(row["championConfidence"]),
        challenger_confidence=float(row["challengerConfidence"]),
        line=SegmentBox(x1, y1, x2 - x1, y2 - y1, "line"),
        aspect_ratio=float(row["aspectRatio"]),
        line_role=str(row["lineRole"]),
        champion_quality_score=float(candidate_scores["champion"]["score"]),
        challenger_quality_score=float(candidate_scores["challenger"]["score"]),
    )


def pair_semantic_guard_reason(champion_text: str, challenger_text: str) -> str | None:
    if _amount_tokens(champion_text) != _amount_tokens(challenger_text):
        return "champion_fallback_pairwise_amount_disagreement"
    if _date_tokens(champion_text) != _date_tokens(challenger_text):
        return "champion_fallback_pairwise_date_disagreement"
    if _currency_tokens(champion_text) != _currency_tokens(challenger_text):
        return "champion_fallback_pairwise_currency_disagreement"
    if sum(character.isalnum() for character in challenger_text) < 3:
        return "champion_fallback_pairwise_empty_challenger"
    if _repeated_token_ratio(challenger_text) > 0.35:
        return "champion_fallback_pairwise_repetition_risk"
    return None


def _text_stats(text: str) -> list[float]:
    length = max(len(text), 1)
    tokens = text.split()
    alphanumeric = sum(character.isalnum() for character in text)
    digits = sum(character.isdigit() for character in text)
    letters = sum(character.isalpha() for character in text)
    spaces = sum(character.isspace() for character in text)
    punctuation = sum(not character.isalnum() and not character.isspace() for character in text)
    return [
        float(len(text)),
        float(len(tokens)),
        float(alphanumeric),
        float(digits),
        float(letters),
        float(spaces),
        float(punctuation),
        float(text.count("\ufffd")),
        alphanumeric / length,
        digits / length,
        letters / length,
        len(set(tokens)) / max(len(tokens), 1),
    ]


def _normalized_edit_distance(left: str, right: str) -> float:
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, 1):
        current = [left_index] + [0] * len(right)
        for right_index, right_character in enumerate(right, 1):
            current[right_index] = min(
                current[right_index - 1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_character != right_character),
            )
        previous = current
    return previous[-1] / max(len(left), len(right), 1)


def _amount_tokens(text: str) -> set[str]:
    return set(re.findall(r"(?<!\d)\d{1,3}(?:[.,]\d{3})*[.,]\d{2}(?!\d)", text))


def _date_tokens(text: str) -> set[str]:
    return set(
        re.findall(
            r"(?<!\d)(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})(?!\d)",
            text,
        )
    )


def _currency_tokens(text: str) -> set[str]:
    return {
        match.upper()
        for match in re.findall(r"(?:\bTL\b|\bTRY\b|\bUSD\b|\bEUR\b|\bGBP\b|[$€£₺])", text, flags=re.IGNORECASE)
    }


def _repeated_token_ratio(text: str) -> float:
    tokens = [token.casefold() for token in text.split() if token]
    if len(tokens) < 2:
        return 0.0
    return 1.0 - len(set(tokens)) / len(tokens)
