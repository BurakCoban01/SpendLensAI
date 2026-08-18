from __future__ import annotations

import math
from dataclasses import dataclass

import torch

from services.ocr.custom_model.vocab import INDEX_TO_CHAR, decode


@dataclass(frozen=True)
class CtcDecodedPrediction:
    text: str
    confidence: float
    decoder: str = "greedy"


def greedy_decode(log_probs: torch.Tensor, blank_penalty: float = 0.0) -> CtcDecodedPrediction:
    if log_probs.ndim != 3 or log_probs.shape[1] != 1:
        raise ValueError("Expected CTC log probabilities with shape [timesteps, 1, classes].")
    probabilities = _decoder_probabilities(log_probs, blank_penalty)
    best_probs, best_indices = probabilities.max(dim=1)
    text = decode(best_indices.tolist())
    confidence = 0.0 if not text.strip() else _calibrate(probabilities, best_indices, best_probs, text)
    return CtcDecodedPrediction(text=text, confidence=confidence, decoder="greedy")


def prefix_beam_search_decode(
    log_probs: torch.Tensor,
    beam_width: int = 8,
    per_timestep_candidates: int | None = None,
    blank_penalty: float = 0.0,
) -> CtcDecodedPrediction:
    if log_probs.ndim != 3 or log_probs.shape[1] != 1:
        raise ValueError("Expected CTC log probabilities with shape [timesteps, 1, classes].")
    if beam_width < 1:
        raise ValueError("beam_width must be at least 1.")

    probabilities = _decoder_probabilities(log_probs, blank_penalty)
    class_count = probabilities.shape[1]
    candidate_count = min(class_count, per_timestep_candidates or max(beam_width * 4, beam_width + 1))
    beams: dict[tuple[int, ...], tuple[float, float]] = {(): (1.0, 0.0)}

    for timestep in probabilities:
        top_indices = set(timestep.topk(candidate_count).indices.tolist())
        top_indices.add(0)
        next_beams: dict[tuple[int, ...], tuple[float, float]] = {}
        for prefix, (blank_probability, non_blank_probability) in beams.items():
            total_probability = blank_probability + non_blank_probability
            for character_index in top_indices:
                probability = float(timestep[character_index])
                if character_index == 0:
                    current_blank, current_non_blank = next_beams.get(prefix, (0.0, 0.0))
                    next_beams[prefix] = (current_blank + total_probability * probability, current_non_blank)
                    continue

                last_character = prefix[-1] if prefix else None
                if character_index == last_character:
                    current_blank, current_non_blank = next_beams.get(prefix, (0.0, 0.0))
                    next_beams[prefix] = (current_blank, current_non_blank + non_blank_probability * probability)

                    repeated_prefix = (*prefix, character_index)
                    repeated_blank, repeated_non_blank = next_beams.get(repeated_prefix, (0.0, 0.0))
                    next_beams[repeated_prefix] = (repeated_blank, repeated_non_blank + blank_probability * probability)
                else:
                    extended_prefix = (*prefix, character_index)
                    current_blank, current_non_blank = next_beams.get(extended_prefix, (0.0, 0.0))
                    next_beams[extended_prefix] = (current_blank, current_non_blank + total_probability * probability)

        beams = dict(
            sorted(next_beams.items(), key=lambda item: item[1][0] + item[1][1], reverse=True)[:beam_width]
        )

    best_prefix, (blank_probability, non_blank_probability) = max(
        beams.items(),
        key=lambda item: item[1][0] + item[1][1],
    )
    text = _prefix_to_text(best_prefix)
    confidence = _beam_confidence(probabilities, blank_probability + non_blank_probability, text)
    return CtcDecodedPrediction(text=text, confidence=confidence, decoder="beam")


def _decoder_probabilities(log_probs: torch.Tensor, blank_penalty: float = 0.0) -> torch.Tensor:
    if blank_penalty < 0:
        raise ValueError("blank_penalty must be non-negative.")
    adjusted = log_probs
    if blank_penalty:
        adjusted = log_probs.clone()
        adjusted[:, :, 0] = adjusted[:, :, 0] - blank_penalty
        adjusted = torch.log_softmax(adjusted, dim=2)
    return adjusted.exp().squeeze(1).clamp(min=1e-9, max=1.0).detach()


def _prefix_to_text(prefix: tuple[int, ...]) -> str:
    return "".join(INDEX_TO_CHAR.get(index, "") for index in prefix if index != 0)


def _beam_confidence(probabilities: torch.Tensor, sequence_probability: float, text: str) -> float:
    if not text.strip():
        return 0.0
    entropy = -(probabilities * probabilities.log()).sum(dim=1)
    certainty = float((1.0 - entropy / math.log(probabilities.shape[1])).mean().item())
    probability_score = max(0.0, min(1.0, sequence_probability ** (1.0 / max(1, probabilities.shape[0]))))
    base_confidence = max(0.0, min(1.0, probability_score * 0.65 + certainty * 0.35))
    return round(max(0.0, min(1.0, base_confidence * _emission_support(probabilities, text))), 4)


def _calibrate(probabilities: torch.Tensor, best_indices: torch.Tensor, best_probs: torch.Tensor, text: str) -> float:
    emitted_probs: list[float] = []
    previous = 0
    for index, probability in zip(best_indices.tolist(), best_probs.tolist(), strict=True):
        if index != 0 and index != previous:
            emitted_probs.append(float(probability))
        previous = index
    if not emitted_probs:
        return 0.0
    entropy = -(probabilities * probabilities.log()).sum(dim=1)
    certainty = float((1.0 - entropy / math.log(probabilities.shape[1])).mean().item())
    base_confidence = max(0.0, min(1.0, sum(emitted_probs) / len(emitted_probs) * 0.7 + certainty * 0.3))
    return round(max(0.0, min(1.0, base_confidence * _emission_support(probabilities, text))), 4)


def _emission_support(probabilities: torch.Tensor, text: str) -> float:
    if not text.strip():
        return 0.0
    best_indices = probabilities.max(dim=1).indices
    non_blank_best_ratio = float((best_indices != 0).float().mean().item())
    non_blank_mass = float((1.0 - probabilities[:, 0]).mean().item())
    max_non_blank = float(probabilities[:, 1:].max(dim=1).values.mean().item()) if probabilities.shape[1] > 1 else 0.0
    best_support = min(1.0, non_blank_best_ratio / 0.18)
    mass_support = min(1.0, non_blank_mass / 0.25)
    peak_support = min(1.0, max_non_blank / 0.18)
    return max(0.0, min(1.0, best_support * mass_support * peak_support))
