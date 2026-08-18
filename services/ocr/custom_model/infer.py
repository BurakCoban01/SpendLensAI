from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

import torch
from PIL import Image

from services.ocr.custom_model.classical_classifier import recognize_line_with_fourier
from services.ocr.custom_model.character_line_recognizer import load_character_line_model, recognize_line_with_character_model
from services.ocr.custom_model.cli import configure_utf8_stdout
from services.ocr.custom_model.ctc_decoder import greedy_decode, prefix_beam_search_decode
from services.ocr.custom_model.line_images import (
    line_image_to_tensor,
    prepare_cropped_line_image,
    prepare_cropped_line_windows,
    prepare_line_image,
)
from services.ocr.custom_model.normalization import normalize_for_extraction
from services.ocr.custom_model.numeric_field_recognizer import (
    image_to_gray_and_binary,
    load_numeric_character_model,
    recognize_numeric_field_line,
    recognize_visual_amount_line,
)
from services.ocr.custom_model.preprocessing import crop_gray, preprocess_custom_document
from services.ocr.custom_model.router_reranker import (
    PairwiseRouter,
    candidate_pair_features,
    load_pairwise_router,
    pair_semantic_guard_reason,
)
from services.ocr.custom_model.segmentation import SegmentBox, segment_lines
from services.ocr.custom_model.model import CRNNOCR
from services.ocr.custom_model.vocab import VOCAB, VOCAB_VERSION


DEFAULT_BLANK_PENALTY = 0.5
CUSTOM_OCR_PIPELINE_VERSION = "custom-ocr-pipeline-v5-hybrid-pairwise-router-20260711"
CUSTOM_OCR_SEGMENTATION_VERSION = "custom-lines-v5-padded-layout-tight-recognition"
CUSTOM_OCR_DECODER_POLICY_VERSION = "ctc-beam-metadata-blank-penalty-v2"
CUSTOM_OCR_CALIBRATION_VERSION = "heldout-risk-coverage-v2"
CUSTOM_OCR_ROUTER_VERSION = "role-aware-candidate-fusion-v3-pairwise-shortline"


@dataclass(frozen=True)
class CustomOcrPrediction:
    text: str
    confidence: float
    decoder: str = "greedy"
    raw_text: str | None = None
    normalized_text: str | None = None
    warnings: tuple[str, ...] = ()
    tokens: tuple[dict[str, object], ...] = ()


@dataclass(frozen=True)
class CustomOcrDocumentPrediction:
    engine: str
    actual_engine_used: str
    text: str
    normalized_text: str
    confidence: float
    model_version: str
    vocab_version: str
    pages: list[dict[str, object]]
    tokens: list[dict[str, object]]
    warnings: list[str]
    quality: dict[str, object]
    segmentation_manifest: str


def infer(checkpoint: Path, image_path: Path) -> str:
    return infer_with_confidence(checkpoint, image_path).text


def infer_with_confidence(
    checkpoint: Path,
    image_path: Path,
    decoder_method: str = "beam",
    beam_width: int = 8,
    blank_penalty: float | None = None,
    cropped_line: bool = False,
    line_crop_box: tuple[int, int, int, int] | None = None,
    numeric_char_checkpoint: Path | None = None,
    numeric_minimum_confidence: float = 0.9,
    character_checkpoint: Path | None = None,
    character_minimum_confidence: float = 0.94,
    challenger_checkpoint: Path | None = None,
    challenger_mode: str = "shadow",
) -> CustomOcrPrediction:
    if not checkpoint.exists():
        raise FileNotFoundError(f"Custom OCR checkpoint not found: {checkpoint}")
    payload = torch.load(checkpoint, map_location="cpu")
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    resolved_blank_penalty = _decoder_blank_penalty_from_metadata(metadata, blank_penalty)
    model = CRNNOCR(
        num_classes=len(VOCAB),
        temporal_downsample=_temporal_downsample_from_metadata(metadata),
        backbone_version=_backbone_version_from_metadata(metadata),
    )
    model.load_state_dict(payload["model_state"])
    model.eval()
    source_image = Image.open(image_path)
    if line_crop_box is not None:
        source_image = source_image.crop(line_crop_box)
        cropped_line = True
    line_reliability = _validation_reliability(metadata)
    raw_prediction = _predict_line(
        model,
        source_image,
        decoder_method=decoder_method,
        beam_width=beam_width,
        blank_penalty=resolved_blank_penalty,
        cropped_line=cropped_line,
        line_image_min_width=_line_image_min_width_from_metadata(metadata),
        input_inverted=_input_inverted_from_metadata(metadata),
    )
    prediction = _calibrate_line_prediction(raw_prediction, line_reliability)
    provisional_role = _infer_line_role(prediction.text)
    source_aspect_ratio = source_image.width / max(source_image.height, 1)
    if (
        challenger_checkpoint is not None
        and cropped_line
        and _crnn_challenger_applicable(provisional_role, source_aspect_ratio)
    ):
        challenger_model, challenger_metadata = _load_model(challenger_checkpoint)
        challenger_prediction = _calibrate_line_prediction(
            _predict_line(
                challenger_model,
                source_image,
                decoder_method=decoder_method,
                beam_width=beam_width,
                blank_penalty=_decoder_blank_penalty_from_metadata(challenger_metadata, blank_penalty),
                cropped_line=True,
                line_image_min_width=_line_image_min_width_from_metadata(challenger_metadata),
                input_inverted=_input_inverted_from_metadata(challenger_metadata),
            ),
            _validation_reliability(challenger_metadata),
        )
        use_challenger, reason, _scores = _select_crnn_challenger(
            prediction,
            challenger_prediction,
            line_role=provisional_role,
            aspect_ratio=source_aspect_ratio,
            mode=challenger_mode,
            route_evidence=_validated_challenger_route_evidence(challenger_metadata, "long_general_text"),
        )
        if use_challenger:
            prediction = CustomOcrPrediction(
                text=challenger_prediction.text,
                confidence=challenger_prediction.confidence,
                decoder=challenger_prediction.decoder,
                raw_text=prediction.text,
                normalized_text=challenger_prediction.normalized_text,
                warnings=tuple(dict.fromkeys((*challenger_prediction.warnings, "CUSTOM_OCR_CRNN_CHALLENGER_USED"))),
                tokens=challenger_prediction.tokens,
            )
        elif reason:
            prediction = CustomOcrPrediction(
                text=prediction.text,
                confidence=prediction.confidence,
                decoder=prediction.decoder,
                raw_text=challenger_prediction.text,
                normalized_text=prediction.normalized_text,
                warnings=tuple(dict.fromkeys((*prediction.warnings, "CUSTOM_OCR_CRNN_CHALLENGER_SHADOWED"))),
                tokens=prediction.tokens,
            )
    character_model = None
    character_metadata: dict[str, object] = {}
    if character_checkpoint is not None:
        character_model, character_metadata = load_character_line_model(character_checkpoint)
        gray, _binary = image_to_gray_and_binary(source_image)
        line = SegmentBox(0, 0, gray.shape[1], gray.shape[0], "line")
        character_prediction = recognize_line_with_character_model(character_model, character_metadata, gray, line)
        if _should_use_character_line_prediction(
            prediction.text,
            prediction.confidence,
            character_prediction,
            character_minimum_confidence,
            allow_numeric_arbitration=numeric_char_checkpoint is not None,
        ):
            prediction = CustomOcrPrediction(
                text=character_prediction.text,
                confidence=max(
                    prediction.confidence,
                    round(character_prediction.confidence * max(line_reliability, _character_validation_reliability(character_metadata)), 4),
                ),
                decoder=prediction.decoder,
                raw_text=prediction.text,
                normalized_text=character_prediction.text,
                warnings=("CUSTOM_OCR_CHARACTER_MODEL_USED",),
                tokens=tuple(character_prediction.tokens),
            )
    if numeric_char_checkpoint is None:
        return prediction
    numeric_model, numeric_metadata = load_numeric_character_model(numeric_char_checkpoint)
    gray, binary = image_to_gray_and_binary(source_image)
    line = SegmentBox(0, 0, gray.shape[1], gray.shape[0], "line")
    numeric_prediction = recognize_numeric_field_line(
        numeric_model,
        numeric_metadata,
        gray,
        binary,
        line,
        prediction.text,
        minimum_confidence=numeric_minimum_confidence,
    )
    if numeric_prediction is None:
        visual_minimum_confidence = max(0.92, numeric_minimum_confidence)
        if cropped_line and prediction.confidence < 0.5:
            visual_minimum_confidence = min(visual_minimum_confidence, 0.85)
        numeric_prediction = recognize_visual_amount_line(
            numeric_model,
            numeric_metadata,
            gray,
            binary,
            line,
            prediction.text,
            minimum_confidence=visual_minimum_confidence,
        )
    if numeric_prediction is None:
        return prediction
    return CustomOcrPrediction(
        text=numeric_prediction.normalized_line,
        confidence=max(prediction.confidence, round(numeric_prediction.confidence * line_reliability, 4)),
        decoder=prediction.decoder,
        raw_text=prediction.raw_text or prediction.text,
        normalized_text=numeric_prediction.normalized_line,
        warnings=tuple(dict.fromkeys((*prediction.warnings, "CUSTOM_OCR_NUMERIC_FIELD_ASSIST_USED"))),
        tokens=tuple((*prediction.tokens, *numeric_prediction.tokens)),
    )


def infer_document(
    checkpoint: Path,
    input_path: Path,
    source_mime_type: str = "",
    decoder_method: str = "beam",
    beam_width: int = 8,
    blank_penalty: float | None = None,
    numeric_char_checkpoint: Path | None = None,
    character_checkpoint: Path | None = None,
    challenger_checkpoint: Path | None = None,
    challenger_mode: str = "shadow",
    router_checkpoint: Path | None = None,
) -> CustomOcrDocumentPrediction:
    if not checkpoint.exists():
        raise FileNotFoundError(f"Custom OCR checkpoint not found: {checkpoint}")
    model, metadata = _load_model(checkpoint)
    if challenger_mode not in {"off", "shadow", "validated"}:
        raise ValueError("challenger_mode must be one of: off, shadow, validated.")
    challenger_model = None
    challenger_metadata: dict[str, object] = {}
    if challenger_checkpoint is not None and challenger_mode != "off":
        if challenger_checkpoint.resolve() == checkpoint.resolve():
            raise ValueError("Challenger checkpoint must differ from the champion checkpoint.")
        challenger_model, challenger_metadata = _load_model(challenger_checkpoint)
    pairwise_router = load_pairwise_router(router_checkpoint) if router_checkpoint is not None else None
    if pairwise_router is not None and challenger_model is None:
        raise ValueError("Pairwise router requires an enabled CRNN challenger checkpoint.")
    resolved_blank_penalty = _decoder_blank_penalty_from_metadata(metadata, blank_penalty)
    numeric_model = None
    numeric_metadata: dict[str, object] = {}
    if numeric_char_checkpoint is not None:
        numeric_model, numeric_metadata = load_numeric_character_model(numeric_char_checkpoint)
    character_model = None
    character_metadata: dict[str, object] = {}
    if character_checkpoint is not None:
        character_model, character_metadata = load_character_line_model(character_checkpoint)
    validation_reliability = _validation_reliability(metadata)
    if character_model is not None:
        validation_reliability = max(validation_reliability, _character_validation_reliability(character_metadata))
    pages = preprocess_custom_document(input_path, source_mime_type)
    all_text: list[str] = []
    all_normalized_text: list[str] = []
    all_tokens: list[dict[str, object]] = []
    page_payloads: list[dict[str, object]] = []
    warnings: set[str] = set()
    confidences: list[float] = []
    segmentation_factors: list[float] = []
    line_count = 0

    for page in pages:
        page_warnings: set[str] = set()

        def add_warning(code: str) -> None:
            warnings.add(code)
            page_warnings.add(code)

        lines = segment_lines(page.binary)
        page_segmentation_factor = _average([line.confidence for line in lines]) if lines else 0.0
        segmentation_factors.append(page_segmentation_factor)
        if not lines:
            add_warning("CUSTOM_OCR_NO_TEXT_LINES")
        page_lines: list[dict[str, object]] = []
        for line in lines:
            if line.confidence < 0.8:
                add_warning("CUSTOM_OCR_SEGMENTATION_SUSPECT")
            line_count += 1
            recognition_bbox = line.recognition_bbox or line.bbox
            recognition_line = SegmentBox(*recognition_bbox, line.level, confidence=line.confidence)
            crop = crop_gray(page.gray, recognition_bbox, padding=3)
            champion_started = perf_counter()
            crnn_prediction = _predict_line(
                model,
                crop,
                decoder_method=decoder_method,
                beam_width=beam_width,
                blank_penalty=resolved_blank_penalty,
                cropped_line=True,
                line_image_min_width=_line_image_min_width_from_metadata(metadata),
                input_inverted=_input_inverted_from_metadata(metadata),
            )
            champion_latency_ms = round((perf_counter() - champion_started) * 1000, 3)
            line_source = "crnn_long_line" if "CUSTOM_OCR_LONG_LINE_WINDOWING_USED" in crnn_prediction.warnings else "crnn"
            if line_source == "crnn_long_line":
                add_warning("CUSTOM_OCR_LONG_LINE_WINDOWING_USED")
            line_text = crnn_prediction.text
            line_confidence = crnn_prediction.confidence
            line_tokens: list[dict[str, object]] = []
            line_role = _infer_line_role(line_text, line=line, page_width=page.gray.shape[1])
            line_candidates: list[dict[str, object]] = [
                _crnn_candidate_payload(
                    source=line_source,
                    prediction=crnn_prediction,
                    metadata=metadata,
                    line_role=line_role,
                    selected=True,
                    selection_reason="champion_default",
                    latency_ms=champion_latency_ms,
                )
            ]
            crop_aspect_ratio = crop.width / max(crop.height, 1)
            if challenger_model is not None and (
                _crnn_challenger_applicable(line_role, crop_aspect_ratio) or pairwise_router is not None
            ):
                challenger_started = perf_counter()
                challenger_prediction = _predict_line(
                    challenger_model,
                    crop,
                    decoder_method=decoder_method,
                    beam_width=beam_width,
                    blank_penalty=_decoder_blank_penalty_from_metadata(challenger_metadata, blank_penalty),
                    cropped_line=True,
                    line_image_min_width=_line_image_min_width_from_metadata(challenger_metadata),
                    input_inverted=_input_inverted_from_metadata(challenger_metadata),
                )
                challenger_latency_ms = round((perf_counter() - challenger_started) * 1000, 3)
                use_challenger, challenger_reason, candidate_scores = _select_crnn_challenger(
                    crnn_prediction,
                    challenger_prediction,
                    line_role=line_role,
                    aspect_ratio=crop_aspect_ratio,
                    mode=challenger_mode,
                    route_evidence=_validated_challenger_route_evidence(
                        challenger_metadata,
                        "long_general_text",
                    ),
                )
                if pairwise_router is not None and not use_challenger and crop_aspect_ratio < 6.0:
                    router_features = candidate_pair_features(
                        champion_text=crnn_prediction.text,
                        challenger_text=challenger_prediction.text,
                        champion_confidence=crnn_prediction.confidence,
                        challenger_confidence=challenger_prediction.confidence,
                        line=recognition_line,
                        aspect_ratio=crop_aspect_ratio,
                        line_role=line_role,
                        champion_quality_score=float(candidate_scores["champion"]["score"]),
                        challenger_quality_score=float(candidate_scores["challenger"]["score"]),
                    )
                    router_probability = pairwise_router.challenger_probability(router_features)
                    use_challenger, challenger_reason = _select_pairwise_router_candidate(
                        crnn_prediction,
                        challenger_prediction,
                        pairwise_router,
                        router_probability,
                    )
                    candidate_scores["champion"]["pairwise_router_probability"] = round(
                        1.0 - router_probability, 4
                    )
                    candidate_scores["challenger"]["pairwise_router_probability"] = round(
                        router_probability, 4
                    )
                    candidate_scores["challenger"]["pairwise_router_threshold"] = pairwise_router.threshold
                line_candidates[0]["candidate_scores"] = candidate_scores["champion"]
                line_candidates[0]["selection_reason"] = (
                    "champion_fallback" if not use_challenger else "challenger_selected"
                )
                line_candidates.append(
                    _crnn_candidate_payload(
                        source="crnn_challenger",
                        prediction=challenger_prediction,
                        metadata=challenger_metadata,
                        line_role=line_role,
                        selected=use_challenger,
                        selection_reason=challenger_reason,
                        latency_ms=challenger_latency_ms,
                        candidate_scores=candidate_scores["challenger"],
                    )
                )
                if use_challenger:
                    line_candidates[0]["selected"] = False
                    line_text = challenger_prediction.text
                    line_confidence = challenger_prediction.confidence
                    line_source = "crnn_challenger"
                    add_warning("CUSTOM_OCR_CRNN_CHALLENGER_USED")
                else:
                    add_warning("CUSTOM_OCR_CRNN_CHALLENGER_SHADOWED")
            if character_model is not None:
                character_prediction = recognize_line_with_character_model(
                    character_model,
                    character_metadata,
                    page.gray,
                    recognition_line,
                )
                if character_prediction is not None:
                    use_character = _should_use_character_line_prediction(
                        line_text,
                        line_confidence,
                        character_prediction,
                        0.86,
                        allow_numeric_arbitration=numeric_model is not None,
                    )
                    line_candidates.append(
                        {
                            "source": "char_cnn_real_crop",
                            "component_version": str(
                                character_metadata.get("modelVersion")
                                or character_metadata.get("model_version")
                                or "custom-char-cnn"
                            ),
                            "raw_text": character_prediction.text,
                            "text": character_prediction.text,
                            "normalized_text": normalize_for_extraction(character_prediction.text),
                            "confidence": character_prediction.confidence,
                            "calibrated_confidence": character_prediction.confidence,
                            "line_role": line_role,
                            "candidate_scores": _candidate_quality_score(
                                CustomOcrPrediction(
                                    text=character_prediction.text,
                                    confidence=character_prediction.confidence,
                                ),
                                line_role,
                            ),
                            "selection_reason": (
                                "validated_character_specialist"
                                if use_character
                                else "champion_fallback_character_margin"
                            ),
                            "selected": use_character,
                            "warnings": [],
                            "latency_ms": None,
                        }
                    )
                if character_prediction is not None and use_character:
                    for candidate in line_candidates[:-1]:
                        candidate["selected"] = False
                    line_text = character_prediction.text
                    line_confidence = character_prediction.confidence
                    line_tokens = character_prediction.tokens
                    line_source = "char_cnn_real_crop"
                    add_warning("CUSTOM_OCR_CHARACTER_MODEL_USED")
            if line_confidence < 0.55 or sum(character.isalnum() for character in line_text) < 2:
                fourier_text, fourier_confidence, fourier_tokens = recognize_line_with_fourier(
                    page.binary,
                    recognition_line,
                )
                use_fourier = _should_use_fourier_line_prediction(
                    line_text,
                    line_confidence,
                    fourier_text,
                    fourier_confidence,
                )
                line_candidates.append(
                    {
                        "source": "fourier_baseline",
                        "component_version": "project-fourier-v1",
                        "raw_text": fourier_text,
                        "text": fourier_text,
                        "normalized_text": normalize_for_extraction(fourier_text),
                        "confidence": fourier_confidence,
                        "calibrated_confidence": fourier_confidence,
                        "line_role": line_role,
                        "candidate_scores": _candidate_quality_score(
                            CustomOcrPrediction(text=fourier_text, confidence=fourier_confidence),
                            line_role,
                        ),
                        "selection_reason": (
                            "validated_fourier_fallback" if use_fourier else "selected_recognizer_retained"
                        ),
                        "selected": use_fourier,
                        "warnings": [],
                        "latency_ms": None,
                    }
                )
                if use_fourier:
                    for candidate in line_candidates[:-1]:
                        candidate["selected"] = False
                    line_text, line_confidence, line_tokens = fourier_text, fourier_confidence, fourier_tokens
                    line_source = "fourier_baseline"
                    add_warning("CUSTOM_OCR_FOURIER_FALLBACK_USED")
            if not line_text.strip():
                add_warning("CUSTOM_OCR_EMPTY_LINE_OUTPUT")
            if line_confidence < 0.45:
                add_warning("CUSTOM_OCR_LOW_CONFIDENCE")
            normalized_line_text = line_text
            numeric_prediction = None
            if numeric_model is not None:
                numeric_prediction = recognize_numeric_field_line(
                    numeric_model,
                    numeric_metadata,
                    page.gray,
                    page.binary,
                    recognition_line,
                    line_text,
                )
                if numeric_prediction is None:
                    numeric_prediction = recognize_visual_amount_line(
                        numeric_model,
                        numeric_metadata,
                        page.gray,
                        page.binary,
                        recognition_line,
                        line_text,
                    )
                if numeric_prediction is not None:
                    normalized_line_text = numeric_prediction.normalized_line
                    line_candidates.append(
                        {
                            "source": "numeric_field_specialist",
                            "component_version": str(
                                numeric_metadata.get("modelVersion")
                                or numeric_metadata.get("model_version")
                                or "custom-numeric-char-cnn"
                            ),
                            "raw_text": line_text,
                            "text": numeric_prediction.normalized_line,
                            "normalized_text": numeric_prediction.normalized_line,
                            "confidence": numeric_prediction.confidence,
                            "calibrated_confidence": numeric_prediction.confidence,
                            "line_role": line_role,
                            "candidate_scores": {"role_validated": line_role in {"amount", "amount_with_label"}},
                            "selection_reason": "validated_numeric_normalization",
                            "selected": False,
                            "selected_for_normalization": True,
                            "warnings": [],
                            "latency_ms": None,
                        }
                    )
                    add_warning("CUSTOM_OCR_NUMERIC_FIELD_ASSIST_USED")
                    if any(token.get("source") == "char_cnn_numeric_visual_amount" for token in numeric_prediction.tokens):
                        add_warning("CUSTOM_OCR_NUMERIC_VISUAL_AMOUNT_ASSIST_USED")
            confidences.append(line_confidence)
            all_text.append(line_text)
            all_normalized_text.append(normalized_line_text)
            all_tokens.append(
                {
                    "text": line_text,
                    "confidence": line_confidence,
                    "page_number": page.page_number,
                    "bbox": [line.x, line.y, line.w, line.h],
                    "level": "line",
                    "source": line_source,
                    "decoder": crnn_prediction.decoder if line_source.startswith("crnn") else None,
                    "champion_raw": crnn_prediction.text,
                    "challenger_raw": next(
                        (
                            str(candidate.get("text") or "")
                            for candidate in line_candidates
                            if candidate.get("source") == "crnn_challenger"
                        ),
                        None,
                    ),
                    "selected_raw": line_text,
                    "selected_normalized": normalized_line_text,
                    "selection_reason": next(
                        (
                            str(candidate.get("selection_reason") or "")
                            for candidate in line_candidates
                            if candidate.get("selected") is True
                        ),
                        "champion_fallback",
                    ),
                    "candidates": line_candidates,
                }
            )
            for token in line_tokens:
                all_tokens.append({**token, "page_number": page.page_number})
            if numeric_prediction is not None:
                for token in numeric_prediction.tokens:
                    all_tokens.append({**token, "page_number": page.page_number})
            page_lines.append(
                {
                    "text": line_text,
                    "normalized_text": normalized_line_text,
                    "confidence": line_confidence,
                    "bbox": [line.x, line.y, line.w, line.h],
                    "source": line_source,
                    "decoder": crnn_prediction.decoder if line_source.startswith("crnn") else None,
                    "line_role": line_role,
                    "champion_raw": crnn_prediction.text,
                    "challenger_raw": next(
                        (
                            str(candidate.get("text") or "")
                            for candidate in line_candidates
                            if candidate.get("source") == "crnn_challenger"
                        ),
                        None,
                    ),
                    "selected_raw": line_text,
                    "selected_normalized": normalized_line_text,
                    "selection_reason": next(
                        (
                            str(candidate.get("selection_reason") or "")
                            for candidate in line_candidates
                            if candidate.get("selected") is True
                        ),
                        "champion_fallback",
                    ),
                    "candidates": line_candidates,
                }
            )
        raw_page_confidence = _average([float(line["confidence"]) for line in page_lines])
        page_quality_factor = _page_quality_factor(page.quality)
        page_text = "\n".join(str(line["text"]) for line in page_lines)
        normalized_page_text = normalize_for_extraction(
            "\n".join(str(line["normalized_text"]) for line in page_lines)
        )
        page_structure_factor = _document_structure_factor(normalized_page_text)
        calibrated_page_confidence = round(
            raw_page_confidence
            * validation_reliability
            * page_quality_factor
            * page_structure_factor
            * page_segmentation_factor,
            4,
        )
        if _fragmented_segment_text([str(line["text"]) for line in page_lines], page_segmentation_factor):
            add_warning("CUSTOM_OCR_GARBAGE_TEXT")
        if calibrated_page_confidence < 0.75:
            add_warning("CUSTOM_OCR_LOW_CONFIDENCE")
        if page_structure_factor <= 0.75:
            add_warning("CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE")
        page_payloads.append(
            {
                "page_number": page.page_number,
                "text": page_text,
                "normalized_text": normalized_page_text,
                "confidence": calibrated_page_confidence,
                "raw_confidence": raw_page_confidence,
                "structure_confidence_factor": page_structure_factor,
                "segmentation_confidence_factor": page_segmentation_factor,
                "tokens": [token for token in all_tokens if token.get("page_number") == page.page_number],
                "warnings": sorted(page_warnings),
                "quality": page.quality,
                "lines": page_lines,
            }
        )

    text = "\n".join(line for line in all_text if line.strip())
    normalized_text = normalize_for_extraction("\n".join(line for line in all_normalized_text if line.strip()))
    raw_confidence = _average(confidences)
    document_quality_factor = min((_page_quality_factor(page.quality) for page in pages), default=1.0)
    document_structure_factor = _document_structure_factor(normalized_text)
    document_segmentation_factor = min(segmentation_factors, default=0.0)
    confidence = round(
        raw_confidence
        * validation_reliability
        * document_quality_factor
        * document_structure_factor
        * document_segmentation_factor,
        4,
    )
    if line_count == 0:
        confidence = 0.0
    if confidence < 0.75:
        warnings.add("CUSTOM_OCR_LOW_CONFIDENCE")
    if document_structure_factor <= 0.75:
        warnings.add("CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE")
    return CustomOcrDocumentPrediction(
        engine="CUSTOM_OCR",
        actual_engine_used="CUSTOM_OCR",
        text=text,
        normalized_text=normalized_text,
        confidence=confidence,
        model_version=str(metadata.get("model_version") or metadata.get("model_name") or checkpoint.stem),
        vocab_version=str(metadata.get("vocab_version") or VOCAB_VERSION),
        pages=page_payloads,
        tokens=all_tokens,
        warnings=sorted(warnings),
        quality={
            "pages": [page.quality for page in pages],
            "confidence_calibration": {
                "raw_confidence": raw_confidence,
                "validation_reliability": validation_reliability,
                "page_quality_factor": document_quality_factor,
                "document_structure_factor": document_structure_factor,
                "segmentation_factor": document_segmentation_factor,
            },
            "numeric_field_assist": {
                "enabled": numeric_model is not None,
                "model_version": (
                    str(numeric_metadata.get("modelVersion") or numeric_metadata.get("model_version"))
                    if numeric_model is not None
                    else None
                ),
            },
            "character_line_assist": {
                "enabled": character_model is not None,
                "model_version": (
                    str(character_metadata.get("modelVersion") or "custom-char-cnn")
                    if character_model is not None
                    else None
                ),
            },
            "crnn_challenger": {
                "enabled": challenger_model is not None,
                "mode": challenger_mode,
                "model_version": (
                    str(challenger_metadata.get("model_version") or challenger_metadata.get("model_name"))
                    if challenger_model is not None
                    else None
                ),
            },
            "pairwise_router": {
                "enabled": pairwise_router is not None,
                "model_version": (
                    str(pairwise_router.metadata.get("modelVersion") or "custom-ocr-pairwise-router")
                    if pairwise_router is not None
                    else None
                ),
                "decision_threshold": pairwise_router.threshold if pairwise_router is not None else None,
            },
            "pipelineBundle": _pipeline_bundle_metadata(
                champion_metadata=metadata,
                numeric_metadata=numeric_metadata if numeric_model is not None else None,
                character_metadata=character_metadata if character_model is not None else None,
                challenger_metadata=challenger_metadata if challenger_model is not None else None,
                challenger_mode=challenger_mode,
                pairwise_router=pairwise_router,
            ),
        },
        segmentation_manifest=f"custom-lines:{line_count}",
    )


def decode_ctc_prediction(
    log_probs: torch.Tensor,
    method: str = "greedy",
    beam_width: int = 8,
    blank_penalty: float = 0.0,
) -> CustomOcrPrediction:
    if log_probs.ndim != 3 or log_probs.shape[1] != 1:
        raise ValueError("Expected CTC log probabilities with shape [timesteps, 1, classes].")
    if method == "greedy":
        prediction = greedy_decode(log_probs, blank_penalty=blank_penalty)
    elif method == "beam":
        prediction = prefix_beam_search_decode(log_probs, beam_width=beam_width, blank_penalty=blank_penalty)
    else:
        raise ValueError(f"Unsupported CTC decoder method: {method}")
    return CustomOcrPrediction(text=prediction.text, confidence=prediction.confidence, decoder=prediction.decoder)


def _load_model(checkpoint: Path) -> tuple[CRNNOCR, dict[str, object]]:
    payload = torch.load(checkpoint, map_location="cpu")
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    model = CRNNOCR(
        num_classes=len(VOCAB),
        temporal_downsample=_temporal_downsample_from_metadata(metadata),
        backbone_version=_backbone_version_from_metadata(metadata),
    )
    model.load_state_dict(payload["model_state"])
    model.eval()
    return model, metadata


def _predict_line(
    model: CRNNOCR,
    image: Image.Image,
    decoder_method: str = "beam",
    beam_width: int = 8,
    blank_penalty: float = DEFAULT_BLANK_PENALTY,
    cropped_line: bool = False,
    line_image_min_width: int = 384,
    input_inverted: bool = False,
) -> CustomOcrPrediction:
    champion_image = (
        prepare_cropped_line_image(image, min_width=line_image_min_width)
        if cropped_line
        else prepare_line_image(image)
    )
    champion = _predict_prepared_line(
        model,
        champion_image,
        decoder_method=decoder_method,
        beam_width=beam_width,
        blank_penalty=blank_penalty,
        input_inverted=input_inverted,
    )
    if not cropped_line:
        return champion
    prepared_windows = prepare_cropped_line_windows(image, min_width=line_image_min_width)
    if len(prepared_windows) == 1:
        return champion
    window_predictions = [
        _predict_prepared_line(
            model,
            prepared,
            decoder_method=decoder_method,
            beam_width=beam_width,
            blank_penalty=blank_penalty,
            input_inverted=input_inverted,
        )
        for prepared in prepared_windows
    ]
    text = window_predictions[0].text
    for prediction in window_predictions[1:]:
        text = _merge_overlapping_prediction_text(text, prediction.text)
    challenger = CustomOcrPrediction(
        text=text.strip(),
        confidence=round(sum(prediction.confidence for prediction in window_predictions) / len(window_predictions), 4),
        decoder=f"{decoder_method}+sliding-window",
        warnings=("CUSTOM_OCR_LONG_LINE_WINDOWING_USED",),
    )
    if _should_use_long_line_challenger(champion, challenger):
        return challenger
    return CustomOcrPrediction(
        text=champion.text,
        confidence=champion.confidence,
        decoder=champion.decoder,
        raw_text=challenger.text,
        warnings=("CUSTOM_OCR_LONG_LINE_CHALLENGER_REJECTED",),
    )


def _predict_prepared_line(
    model: CRNNOCR,
    image: Image.Image,
    *,
    decoder_method: str,
    beam_width: int,
    blank_penalty: float,
    input_inverted: bool,
) -> CustomOcrPrediction:
    tensor = line_image_to_tensor(image, invert=input_inverted).unsqueeze(0)
    with torch.no_grad():
        log_probs = model(tensor)
    return decode_ctc_prediction(log_probs, method=decoder_method, beam_width=beam_width, blank_penalty=blank_penalty)


def _crnn_candidate_payload(
    *,
    source: str,
    prediction: CustomOcrPrediction,
    metadata: dict[str, object],
    line_role: str,
    selected: bool,
    selection_reason: str,
    latency_ms: float,
    candidate_scores: dict[str, float | str | bool] | None = None,
) -> dict[str, object]:
    return {
        "source": source,
        "component_version": str(metadata.get("model_version") or metadata.get("model_name") or "unknown"),
        "raw_text": prediction.raw_text or prediction.text,
        "text": prediction.text,
        "normalized_text": prediction.normalized_text or normalize_for_extraction(prediction.text),
        "confidence": prediction.confidence,
        "calibrated_confidence": prediction.confidence,
        "decoder": prediction.decoder,
        "line_role": line_role,
        "candidate_scores": candidate_scores or {},
        "selection_reason": selection_reason,
        "selected": selected,
        "warnings": list(prediction.warnings),
        "latency_ms": latency_ms,
    }


def _pipeline_bundle_metadata(
    *,
    champion_metadata: dict[str, object],
    numeric_metadata: dict[str, object] | None,
    character_metadata: dict[str, object] | None,
    challenger_metadata: dict[str, object] | None,
    challenger_mode: str,
    pairwise_router: PairwiseRouter | None = None,
) -> dict[str, object]:
    champion_version = str(
        champion_metadata.get("model_version") or champion_metadata.get("model_name") or "unknown"
    )
    challenger_version = (
        str(challenger_metadata.get("model_version") or challenger_metadata.get("model_name") or "unknown")
        if challenger_metadata is not None
        else None
    )
    numeric_version = (
        str(numeric_metadata.get("modelVersion") or numeric_metadata.get("model_version") or "custom-numeric-char-cnn")
        if numeric_metadata is not None
        else None
    )
    character_version = (
        str(
            character_metadata.get("modelVersion")
            or character_metadata.get("model_version")
            or "custom-char-cnn"
        )
        if character_metadata is not None
        else None
    )
    return {
        "pipelineVersion": CUSTOM_OCR_PIPELINE_VERSION,
        "crnnChampion": champion_version,
        "crnnChallengers": [challenger_version] if challenger_version is not None else [],
        "numericSpecialist": numeric_version,
        "characterSpecialist": character_version,
        "segmentationVersion": CUSTOM_OCR_SEGMENTATION_VERSION,
        "decoderPolicyVersion": CUSTOM_OCR_DECODER_POLICY_VERSION,
        "calibrationVersion": CUSTOM_OCR_CALIBRATION_VERSION,
        "routerVersion": CUSTOM_OCR_ROUTER_VERSION,
        "pairwiseRouter": (
            str(pairwise_router.metadata.get("modelVersion") or "custom-ocr-pairwise-router")
            if pairwise_router is not None
            else None
        ),
        "componentStatus": {
            "crnnChampion": "GLOBAL_CHAMPION",
            "crnnChallenger": (
                str(challenger_metadata.get("component_status") or "SHADOW_ONLY")
                if challenger_metadata is not None
                else "DISABLED"
            ),
            "numericSpecialist": "SPECIALIST_ACTIVE" if numeric_metadata is not None else "DISABLED",
            "characterSpecialist": "SPECIALIST_ACTIVE" if character_metadata is not None else "DISABLED",
            "pairwiseRouter": "SPECIALIST_ACTIVE" if pairwise_router is not None else "DISABLED",
        },
        "challengerMode": challenger_mode,
    }


def _infer_line_role(
    text: str,
    *,
    line: SegmentBox | None = None,
    page_width: int | None = None,
) -> str:
    normalized = _ascii_fold(text)
    if DATE_PATTERN.search(text):
        return "date"
    if re.search(r"(?<!\d)\d{1,2}:\d{2}(?!\d)", text):
        return "time"
    if re.search(r"\b(?:iban|vkn|tckn|fis no|fatura no|receipt|invoice)\b", normalized):
        return "identifier"
    amounts = _amount_tokens(text)
    if amounts:
        if any(keyword in normalized for keyword in ("toplam", "total", "tutar", "amount", "kdv", "vat")):
            return "amount_with_label"
        return "amount"
    if any(keyword in normalized for keyword in ("urun", "adet", "miktar", "birim", "aciklama")):
        return "line_item"
    if line is not None and page_width and line.y <= max(80, round(line.h * 4)) and line.w >= page_width * 0.35:
        return "merchant_header"
    return "general_text"


def _candidate_quality_score(prediction: CustomOcrPrediction, line_role: str) -> dict[str, float | str | bool]:
    text = prediction.text.strip()
    alphanumeric_count = sum(character.isalnum() for character in text)
    repeated_ratio = _repeated_token_ratio(text)
    format_consistent = True
    if line_role in {"amount", "amount_with_label"}:
        format_consistent = bool(_amount_tokens(text))
    elif line_role == "date":
        format_consistent = DATE_PATTERN.search(text) is not None
    lexical_score = min(alphanumeric_count / 24.0, 1.0)
    score = (
        prediction.confidence * 0.55
        + lexical_score * 0.25
        + (0.15 if format_consistent else 0.0)
        + max(0.0, 0.05 - repeated_ratio * 0.05)
    )
    return {
        "score": round(max(0.0, min(score, 1.0)), 4),
        "role": line_role,
        "format_consistent": format_consistent,
        "alphanumeric_count": float(alphanumeric_count),
        "repeated_token_ratio": round(repeated_ratio, 4),
    }


def _crnn_challenger_applicable(line_role: str, aspect_ratio: float) -> bool:
    return line_role in {"general_text", "merchant_header"} and aspect_ratio >= 6.0


def _select_crnn_challenger(
    champion: CustomOcrPrediction,
    challenger: CustomOcrPrediction,
    *,
    line_role: str,
    aspect_ratio: float,
    mode: str,
    route_evidence: dict[str, object] | None = None,
) -> tuple[bool, str, dict[str, dict[str, float | str | bool]]]:
    if mode not in {"off", "shadow", "validated"}:
        raise ValueError("challenger_mode must be one of: off, shadow, validated.")
    champion_scores = _candidate_quality_score(champion, line_role)
    challenger_scores = _candidate_quality_score(challenger, line_role)
    scores = {"champion": champion_scores, "challenger": challenger_scores}
    if mode == "off":
        return False, "challenger_disabled", scores
    if mode == "shadow":
        return False, "shadow_evaluation_only", scores
    if line_role not in {"general_text", "merchant_header"}:
        return False, "champion_fallback_protected_role", scores
    if aspect_ratio < 6.0:
        return False, "champion_fallback_not_long_line", scores
    champion_amounts = _amount_tokens(champion.text)
    challenger_amounts = _amount_tokens(challenger.text)
    if champion_amounts != challenger_amounts:
        return False, "champion_fallback_amount_disagreement", scores
    has_currency_evidence = any(
        re.search(r"(?:₺|\$|€|£|\b(?:TL|TRY|USD|EUR|GBP)\b)", text, flags=re.IGNORECASE)
        for text in (champion.text, challenger.text)
    )
    if champion_amounts or challenger_amounts or has_currency_evidence:
        return False, "champion_fallback_numeric_evidence", scores
    if DATE_PATTERN.findall(champion.text) != DATE_PATTERN.findall(challenger.text):
        return False, "champion_fallback_date_disagreement", scores
    if route_evidence is not None:
        challenger_alnum = sum(character.isalnum() for character in challenger.text)
        champion_alnum = sum(character.isalnum() for character in champion.text)
        if challenger_alnum < max(6, round(champion_alnum * 0.65)):
            return False, "champion_fallback_challenger_incomplete", scores
        if _repeated_token_ratio(challenger.text) > 0.35:
            return False, "champion_fallback_repetition_risk", scores
        return True, "validated_holdout_long_line_specialist", scores
    if challenger.confidence < 0.02 or challenger.confidence + 0.02 < champion.confidence:
        return False, "champion_fallback_confidence_floor", scores
    champion_score = float(champion_scores["score"])
    challenger_score = float(challenger_scores["score"])
    if challenger_score < champion_score + 0.04:
        return False, "champion_fallback_insufficient_margin", scores
    if _repeated_token_ratio(challenger.text) > 0.35:
        return False, "champion_fallback_repetition_risk", scores
    return True, "validated_long_line_challenger_margin", scores


def _validated_challenger_route_evidence(
    metadata: dict[str, object],
    route: str,
) -> dict[str, object] | None:
    routes = metadata.get("validated_specialist_routes")
    if not isinstance(routes, dict):
        return None
    evidence = routes.get(route)
    if not isinstance(evidence, dict) or evidence.get("status") != "SPECIALIST_ACTIVE":
        return None
    samples = evidence.get("samples")
    champion_cer = evidence.get("champion_cer")
    challenger_cer = evidence.get("challenger_cer")
    regressions = evidence.get("regressions")
    regression_rate = evidence.get("regression_rate")
    significant_regressions = evidence.get("significant_regressions")
    benchmark_sha256 = evidence.get("benchmark_sha256")
    if not isinstance(samples, int) or samples < 30:
        return None
    if not isinstance(champion_cer, int | float) or not isinstance(challenger_cer, int | float):
        return None
    if float(champion_cer) - float(challenger_cer) < 0.05:
        return None
    if isinstance(regression_rate, int | float):
        measured_regression_rate = float(regression_rate)
    elif isinstance(regressions, int) and regressions >= 0:
        measured_regression_rate = regressions / samples
    else:
        return None
    if measured_regression_rate < 0.0 or measured_regression_rate > 0.05:
        return None
    if significant_regressions != 0:
        return None
    if not isinstance(benchmark_sha256, str) or len(benchmark_sha256) != 64:
        return None
    return evidence


def _select_pairwise_router_candidate(
    champion: CustomOcrPrediction,
    challenger: CustomOcrPrediction,
    router: PairwiseRouter,
    challenger_probability: float,
) -> tuple[bool, str]:
    if challenger_probability < router.threshold:
        return False, "champion_fallback_pairwise_router_threshold"
    guard_reason = pair_semantic_guard_reason(champion.text, challenger.text)
    if guard_reason is not None:
        return False, guard_reason
    return True, "validated_pairwise_router"


def _merge_overlapping_prediction_text(left: str, right: str) -> str:
    left = left.rstrip()
    right = right.lstrip()
    if not left:
        return right
    if not right:
        return left
    maximum_overlap = min(len(left), len(right), 96)
    for overlap in range(maximum_overlap, 1, -1):
        if left[-overlap:].casefold() == right[:overlap].casefold():
            return left + right[overlap:]
    left_tokens = left.split()
    right_tokens = right.split()
    maximum_token_overlap = min(len(left_tokens), len(right_tokens), 8)
    for overlap in range(maximum_token_overlap, 0, -1):
        if [token.casefold() for token in left_tokens[-overlap:]] == [
            token.casefold() for token in right_tokens[:overlap]
        ]:
            return " ".join((*left_tokens, *right_tokens[overlap:]))
    separator = " " if left[-1].isalnum() and right[0].isalnum() else ""
    return left + separator + right


def _should_use_long_line_challenger(
    champion: CustomOcrPrediction,
    challenger: CustomOcrPrediction,
) -> bool:
    challenger_alnum = sum(character.isalnum() for character in challenger.text)
    champion_alnum = sum(character.isalnum() for character in champion.text)
    if challenger.confidence < 0.3 or challenger.confidence < champion.confidence + 0.08:
        return False
    if challenger_alnum < max(6, round(champion_alnum * 1.2)):
        return False
    champion_amounts = _amount_tokens(champion.text)
    challenger_amounts = _amount_tokens(challenger.text)
    if champion_amounts and champion_amounts != challenger_amounts:
        return False
    repeated_token_ratio = _repeated_token_ratio(challenger.text)
    return repeated_token_ratio <= 0.45


def _repeated_token_ratio(text: str) -> float:
    tokens = [token.casefold() for token in text.split() if token]
    if len(tokens) < 2:
        return 0.0
    return 1.0 - len(set(tokens)) / len(tokens)


def _average(values: list[float]) -> float:
    return round(sum(values) / len(values), 4) if values else 0.0


def _temporal_downsample_from_metadata(metadata: dict[str, object]) -> int:
    value = metadata.get("temporal_downsample")
    if value in {2, 4}:
        return int(value)
    return 2 if metadata.get("architecture_version") == "crnn-ctc-v2" else 4


def _backbone_version_from_metadata(metadata: dict[str, object]) -> str:
    value = metadata.get("backbone_version")
    if value in {"legacy", "residual"}:
        return str(value)
    architecture_version = str(metadata.get("architecture_version") or "")
    return "residual" if "residual" in architecture_version else "legacy"


def _line_image_min_width_from_metadata(metadata: dict[str, object]) -> int:
    value = metadata.get("line_image_min_width")
    if isinstance(value, int) and 64 <= value <= 384:
        return value
    return 384


def _input_inverted_from_metadata(metadata: dict[str, object]) -> bool:
    return metadata.get("input_inverted") is True


def _decoder_blank_penalty_from_metadata(metadata: dict[str, object], explicit: float | None) -> float:
    if explicit is not None:
        if explicit < 0 or explicit > 5:
            raise ValueError("blank_penalty must be between 0 and 5.")
        return float(explicit)
    value = metadata.get("decoder_blank_penalty")
    if isinstance(value, int | float) and 0 <= float(value) <= 5:
        return float(value)
    return DEFAULT_BLANK_PENALTY


def _validation_reliability(metadata: dict[str, object]) -> float:
    metrics = metadata.get("metrics")
    if not isinstance(metrics, dict):
        return 1.0
    final_validation = metrics.get("finalValidation")
    if not isinstance(final_validation, dict):
        return 1.0
    average_cer = final_validation.get("averageCer")
    if not isinstance(average_cer, int | float):
        return 1.0
    return round(max(0.25, 1.0 - min(float(average_cer), 0.75)), 4)


def _calibrate_line_prediction(prediction: CustomOcrPrediction, reliability: float) -> CustomOcrPrediction:
    return CustomOcrPrediction(
        text=prediction.text,
        confidence=round(prediction.confidence * reliability, 4),
        decoder=prediction.decoder,
        raw_text=prediction.raw_text,
        normalized_text=prediction.normalized_text,
        warnings=prediction.warnings,
        tokens=prediction.tokens,
    )


def _character_validation_reliability(metadata: dict[str, object]) -> float:
    if metadata.get("datasetScope") != "combined_manifest":
        return 0.0
    accuracy = metadata.get("accuracy")
    if not isinstance(accuracy, int | float):
        return 0.0
    return round(max(0.0, min(float(accuracy), 0.95)), 4)


def _page_quality_factor(quality: dict[str, float | str]) -> float:
    factor = 1.0
    if quality.get("status") != "ok":
        factor *= 0.85
    skew = quality.get("skew_estimate_degrees")
    if isinstance(skew, int | float) and abs(float(skew)) >= 2.0:
        factor *= 0.8
    density = quality.get("foreground_density")
    if isinstance(density, int | float) and (float(density) < 0.005 or float(density) > 0.45):
        factor *= 0.85
    return round(factor, 4)


def _fragmented_segment_text(lines: list[str], segmentation_factor: float) -> bool:
    if segmentation_factor >= 0.8:
        return False
    meaningful = [line.strip() for line in lines if line.strip()]
    if len(meaningful) < 12:
        return False
    alphanumeric_counts = [sum(character.isalnum() for character in line) for line in meaningful]
    short_ratio = sum(count <= 2 for count in alphanumeric_counts) / len(alphanumeric_counts)
    average_alphanumeric = sum(alphanumeric_counts) / len(alphanumeric_counts)
    return short_ratio >= 0.12 or average_alphanumeric < 5.0


AMOUNT_PATTERN = re.compile(r"(?<!\d)\d{1,3}(?:[.,]\d{3})*[.,]\d{2}(?!\d)")
DATE_PATTERN = re.compile(r"(?<!\d)(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})(?!\d)")


def _should_use_character_line_prediction(
    crnn_text: str,
    crnn_confidence: float,
    character_prediction: object,
    minimum_confidence: float,
    *,
    allow_numeric_arbitration: bool = False,
) -> bool:
    if character_prediction is None:
        return False
    character_text = str(getattr(character_prediction, "text", "") or "").strip()
    character_confidence = getattr(character_prediction, "confidence", 0.0)
    if not isinstance(character_confidence, int | float):
        return False
    if float(character_confidence) < minimum_confidence:
        return False
    if sum(character.isalnum() for character in character_text) < 3:
        return False
    crnn_amounts = _amount_tokens(crnn_text)
    character_amounts = _amount_tokens(character_text)
    if (
        crnn_amounts
        and character_amounts
        and crnn_amounts != character_amounts
        and not (
            allow_numeric_arbitration
            and float(character_confidence) >= 0.9
            and len(character_amounts) == 1
        )
        and not _trusted_character_field_candidate(character_text, float(character_confidence))
    ):
        return False
    if crnn_amounts and not character_amounts and crnn_confidence >= 0.45:
        return False
    return True


def _trusted_character_field_candidate(text: str, confidence: float) -> bool:
    if confidence < 0.86 or len(_amount_tokens(text)) != 1:
        return False
    normalized = _ascii_fold(text)
    return (
        any(keyword in normalized for keyword in ("toplam", "total", "kdv", "vat", "tutar", "amount"))
        and _repeated_token_ratio(text) <= 0.25
    )


def _should_use_fourier_line_prediction(
    selected_text: str,
    selected_confidence: float,
    fourier_text: str,
    fourier_confidence: float,
) -> bool:
    selected_alnum = sum(character.isalnum() for character in selected_text)
    fourier_alnum = sum(character.isalnum() for character in fourier_text)
    if fourier_alnum < 2:
        return False
    selected_amounts = _amount_tokens(selected_text)
    fourier_amounts = _amount_tokens(fourier_text)
    if selected_amounts and selected_amounts != fourier_amounts:
        return False
    if selected_alnum < 2:
        return fourier_confidence >= 0.2
    return (
        fourier_confidence >= max(0.65, selected_confidence + 0.2)
        and fourier_alnum >= selected_alnum
        and _repeated_token_ratio(fourier_text) <= 0.4
    )


def _amount_tokens(text: str) -> set[str]:
    tokens: set[str] = set()
    for match in AMOUNT_PATTERN.findall(text):
        token = match.replace(" ", "").replace(".", "").replace(",", ".")
        tokens.add(token)
    return tokens


def _document_structure_factor(text: str) -> float:
    normalized = _ascii_fold(text)
    tokens = re.findall(r"[a-z0-9]+", normalized)
    if not tokens:
        return 0.25
    token_count = len(tokens)
    lexical_diversity = len(set(tokens)) / max(token_count, 1)
    has_amount = AMOUNT_PATTERN.search(normalized) is not None
    has_date = DATE_PATTERN.search(normalized) is not None
    has_total = "toplam" in normalized or "genel toplam" in normalized
    has_document_keyword = any(keyword in normalized for keyword in ("fis", "fatura", "kdv", "vkn", "tckn", "iban"))
    has_payment_or_currency = any(keyword in normalized for keyword in ("tl", "try", "kart", "nakit", "odeme"))
    has_merchant_signal = any(keyword in normalized for keyword in ("market", "ltd", "limited", "anonim", "sanayi", "ticaret"))

    score = 0.25
    if has_amount:
        score += 0.15
    if has_date:
        score += 0.25
    if has_total:
        score += 0.15
    if has_document_keyword:
        score += 0.10
    if has_payment_or_currency:
        score += 0.05
    if has_merchant_signal:
        score += 0.05
    if token_count >= 4 and lexical_diversity >= 0.35:
        score += 0.05
    if not has_date:
        score = min(score, 0.70)
    if not has_amount:
        score = min(score, 0.65)
    return round(max(0.25, min(score, 1.0)), 4)


def _ascii_fold(text: str) -> str:
    return (
        text.casefold()
        .replace("\u00e7", "c")
        .replace("\u011f", "g")
        .replace("\u0131", "i")
        .replace("\u0130", "i")
        .replace("\u00f6", "o")
        .replace("\u015f", "s")
        .replace("\u00fc", "u")
    )


def main() -> None:
    configure_utf8_stdout()
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, default=Path("artifacts/models/custom-crnn-local-full/model.pt"))
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--document", action="store_true")
    parser.add_argument("--decoder", choices=("greedy", "beam"), default="beam")
    parser.add_argument("--beam-width", type=int, default=8)
    parser.add_argument("--blank-penalty", type=float)
    parser.add_argument("--numeric-char-checkpoint", type=Path)
    parser.add_argument("--character-checkpoint", type=Path)
    parser.add_argument("--challenger-checkpoint", type=Path)
    parser.add_argument("--challenger-mode", choices=("off", "shadow", "validated"), default="shadow")
    args = parser.parse_args()
    if args.document:
        prediction = infer_document(
            args.checkpoint,
            args.image,
            decoder_method=args.decoder,
            beam_width=args.beam_width,
            blank_penalty=args.blank_penalty,
            numeric_char_checkpoint=args.numeric_char_checkpoint,
            character_checkpoint=args.character_checkpoint,
            challenger_checkpoint=args.challenger_checkpoint,
            challenger_mode=args.challenger_mode,
        )
        print(json.dumps(prediction.__dict__, ensure_ascii=False))
    else:
        prediction = infer_with_confidence(
            args.checkpoint,
            args.image,
            decoder_method=args.decoder,
            beam_width=args.beam_width,
            blank_penalty=args.blank_penalty,
            numeric_char_checkpoint=args.numeric_char_checkpoint,
            character_checkpoint=args.character_checkpoint,
            challenger_checkpoint=args.challenger_checkpoint,
            challenger_mode=args.challenger_mode,
        )
        print(json.dumps({"text": prediction.text, "confidence": prediction.confidence, "decoder": prediction.decoder}, ensure_ascii=False))


if __name__ == "__main__":
    main()
