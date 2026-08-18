from __future__ import annotations

import base64
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from services.ocr.app.preprocessing import PreprocessingProfile, preprocess_document
from services.ocr.app.tesseract_engine import TesseractEngineError, check_tesseract_availability, run_tesseract


def run_custom_ocr_document(*args: object, **kwargs: object) -> object:
    """Load the CPU-heavy project model stack only when Custom OCR is requested."""
    from services.ocr.custom_model.infer import infer_document

    return infer_document(*args, **kwargs)


def train_custom_ocr_model(*args: object, **kwargs: object) -> dict[str, object]:
    """Keep training dependencies off the health-check and Tesseract startup path."""
    from services.ocr.custom_model.train import train_custom_ocr_model as train

    return train(*args, **kwargs)

app = FastAPI(title="SpendLens AI OCR Service", version="0.1.0")

SUPPORTED_OCR_DOCUMENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/tiff",
    "image/bmp",
    "image/x-ms-bmp",
    "image/gif",
    "application/pdf",
}


class CustomOcrSmokeTrainRequest(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=120)
    training_run_id: str = Field(min_length=1, max_length=120)
    seed: int = Field(ge=0, le=1_000_000)
    samples: int = Field(ge=8, le=64)
    epochs: int = Field(ge=1, le=3)


class CustomOcrFullTrainRequest(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=120)
    training_run_id: str = Field(min_length=1, max_length=120)
    seed: int = Field(ge=0, le=1_000_000)
    samples: int = Field(ge=65, le=50_000)
    epochs: int = Field(ge=2, le=20)


@app.get("/health/live")
def live() -> dict[str, str]:
    return {"status": "ok", "service": "ocr-service"}


@app.get("/health/ready")
def ready() -> dict[str, object]:
    availability = check_tesseract_availability()
    return {
        "status": "ok" if availability["available"] else "degraded",
        "checks": {"tesseract": availability},
    }


@app.post("/ocr/tesseract")
async def tesseract_ocr(file: UploadFile = File(...), lang: str = "tur+eng") -> JSONResponse:
    if file.content_type not in SUPPORTED_OCR_DOCUMENT_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported document type: {file.content_type}")

    suffix = Path(file.filename or "upload.png").suffix or ".png"
    with NamedTemporaryFile(suffix=suffix, delete=False) as temp:
        content = await file.read()
        temp.write(content)
        input_path = Path(temp.name)

    try:
        fallback = _run_tesseract_with_fallback(input_path, file.content_type or "", lang)
        page_results = fallback["pages"]
        all_text = [str(page["text"]) for page in page_results]
        all_tokens = [token for page in page_results for token in page["tokens"]]
        all_warnings = set(fallback["warnings"])
        confidences = [float(page["confidence"]) for page in page_results]
        average_confidence = sum(confidences) / len(confidences) if confidences else 0.0
        return JSONResponse(
            {
                "engine": "TESSERACT",
                "text": "\n\n".join(all_text),
                "confidence": average_confidence,
                "tokens": all_tokens,
                "warnings": sorted(all_warnings),
                "page_count": len(page_results),
                "pages": page_results,
                "preprocessing_manifest": fallback["preprocessing_manifest"],
                "preprocessing_manifests": fallback["preprocessing_manifests"],
                "attempts": fallback["attempts"],
                "selected_attempts": fallback["selected_attempts"],
            }
        )
    except TesseractEngineError as error:
        raise HTTPException(status_code=error.status_code, detail={"code": error.code, "message": str(error)}) from error
    finally:
        input_path.unlink(missing_ok=True)


def _run_tesseract_with_fallback(input_path: Path, source_mime_type: str, lang: str) -> dict[str, object]:
    profiles = _configured_tesseract_profiles()
    max_attempts = _configured_tesseract_max_attempts()
    psm_candidates = [6, 4, 11, 3]
    page_candidates: dict[int, dict[str, object]] = {}
    attempts: list[dict[str, object]] = []
    manifests: list[str] = []
    first_manifest: str | None = None
    last_error: TesseractEngineError | None = None

    for profile_index, profile in enumerate(profiles):
        low_pages = {page_number for page_number, candidate in page_candidates.items() if not _is_good_ocr_attempt(candidate)}
        if profile_index > 0 and page_candidates and not low_pages:
            break
        if profile_index > 0 and len(attempts) >= max_attempts:
            break
        processed = preprocess_document(input_path, profile=profile, source_mime_type=source_mime_type)
        manifest = str(processed.manifest_path)
        manifests.append(manifest)
        first_manifest = first_manifest or manifest
        for page in processed.pages:
            if profile_index > 0 and page.page_number not in low_pages:
                continue
            selected_for_page = page_candidates.get(page.page_number)
            for psm in psm_candidates:
                must_attempt_baseline = selected_for_page is None
                if not must_attempt_baseline and len(attempts) >= max_attempts:
                    break
                if not must_attempt_baseline and _is_good_ocr_attempt(selected_for_page) and psm != psm_candidates[0]:
                    break
                try:
                    result = run_tesseract(page.processed_image_path, lang=lang, psm=psm)
                    score = _score_tesseract_result(result.text, result.confidence)
                    tokens = [token.model_dump() | {"page_number": page.page_number} for token in result.tokens]
                    attempt = {
                        "page_number": page.page_number,
                        "profile": profile,
                        "psm": psm,
                        "oem": 3,
                        "confidence": result.confidence,
                        "text_length": len(result.text.strip()),
                        "score": score,
                        "status": "SUCCEEDED",
                        "warnings": result.warnings,
                    }
                    attempts.append(attempt)
                    candidate = {
                        "page_number": page.page_number,
                        "text": result.text,
                        "confidence": result.confidence,
                        "tokens": tokens,
                        "warnings": result.warnings,
                        "preprocessing": page.decisions,
                        "selected_profile": profile,
                        "selected_psm": psm,
                        "selection_score": score,
                    }
                    if selected_for_page is None or score > float(selected_for_page["selection_score"]):
                        page_candidates[page.page_number] = candidate
                        selected_for_page = candidate
                    if _is_good_ocr_attempt(selected_for_page):
                        break
                except TesseractEngineError as error:
                    last_error = error
                    attempts.append(
                        {
                            "page_number": page.page_number,
                            "profile": profile,
                            "psm": psm,
                            "oem": 3,
                            "confidence": 0.0,
                            "text_length": 0,
                            "score": 0.0,
                            "status": "FAILED",
                            "error_code": error.code,
                        }
                    )
                if len(attempts) >= max_attempts and selected_for_page is not None:
                    break

    if not page_candidates:
        if last_error:
            raise last_error
        raise TesseractEngineError("TESSERACT_EMPTY_OUTPUT", "Tesseract produced no usable text.", status_code=422)

    pages = [page_candidates[page_number] for page_number in sorted(page_candidates)]
    warnings: set[str] = {warning for page in pages for warning in page["warnings"]}
    if len(attempts) > len(pages):
        warnings.add("OCR_FALLBACK_ATTEMPTS_USED")
    for page in pages:
        if not _is_good_ocr_attempt(page):
            warnings.add(f"OCR_FALLBACK_LOW_SCORE_PAGE_{page['page_number']}")
    return {
        "pages": pages,
        "warnings": sorted(warnings),
        "preprocessing_manifest": first_manifest or "",
        "preprocessing_manifests": manifests,
        "attempts": attempts,
        "selected_attempts": [
            {
                "page_number": page["page_number"],
                "profile": page["selected_profile"],
                "psm": page["selected_psm"],
                "score": page["selection_score"],
                "confidence": page["confidence"],
            }
            for page in pages
        ],
    }


def _score_tesseract_result(text: str, confidence: float) -> float:
    normalized = text.casefold()
    text_score = min(len(text.strip()) / 500, 1.0) * 0.2
    keyword_score = 0.0
    for keyword in ["toplam", "fatura", "fis", "kdv", "tarih", "try", "tl", "ode", "urun", "tutar"]:
        if keyword in normalized:
            keyword_score += 0.04
    return min(1.0, max(0.0, confidence) * 0.7 + text_score + min(keyword_score, 0.2))


def _is_good_ocr_attempt(candidate: dict[str, object] | None) -> bool:
    if not candidate:
        return False
    return float(candidate["selection_score"]) >= 0.58 and len(str(candidate["text"]).strip()) >= 12


def _configured_tesseract_profiles() -> list[str]:
    raw = os.getenv("OCR_TESSERACT_FALLBACK_PROFILES", "TESSERACT_OPTIMIZED,LOW_LIGHT,THERMAL_RECEIPT,CRUMPLED_RECEIPT")
    profiles = [profile.strip() for profile in raw.split(",") if profile.strip()]
    return profiles or ["TESSERACT_OPTIMIZED"]


def _configured_tesseract_max_attempts() -> int:
    raw = os.getenv("OCR_TESSERACT_MAX_ATTEMPTS", "12")
    try:
        parsed = int(raw)
    except ValueError:
        parsed = 12
    return max(1, min(parsed, 32))


@app.post("/ocr/custom-crnn")
async def custom_crnn_ocr(
    file: UploadFile = File(...),
    checkpoint: str | None = None,
    numeric_char_checkpoint: str | None = None,
    character_checkpoint: str | None = None,
    challenger_checkpoint: str | None = None,
    challenger_mode: str | None = None,
    router_checkpoint: str | None = None,
) -> JSONResponse:
    if file.content_type not in SUPPORTED_OCR_DOCUMENT_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported document type: {file.content_type}")

    configured_checkpoint = checkpoint or os.getenv("CUSTOM_OCR_DEFAULT_CHECKPOINT") or "artifacts/models/custom-crnn-local-full/model.pt"
    checkpoint_path = _resolve_local_model_checkpoint(configured_checkpoint)
    if not checkpoint_path.exists() or not checkpoint_path.is_file():
        raise HTTPException(
            status_code=404,
            detail={"code": "CUSTOM_OCR_CHECKPOINT_NOT_FOUND", "message": f"Custom OCR checkpoint not found: {configured_checkpoint}"},
        )
    configured_numeric_checkpoint = numeric_char_checkpoint or os.getenv("CUSTOM_OCR_NUMERIC_CHAR_CHECKPOINT")
    numeric_checkpoint_path = (
        _resolve_local_model_checkpoint(configured_numeric_checkpoint) if configured_numeric_checkpoint else None
    )
    if numeric_checkpoint_path is not None and (
        not numeric_checkpoint_path.exists() or not numeric_checkpoint_path.is_file()
    ):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "CUSTOM_OCR_NUMERIC_CHECKPOINT_NOT_FOUND",
                "message": f"Numeric character checkpoint not found: {configured_numeric_checkpoint}",
            },
        )
    configured_character_checkpoint = character_checkpoint or os.getenv("CUSTOM_OCR_CHARACTER_CHECKPOINT")
    character_checkpoint_path = (
        _resolve_local_model_checkpoint(configured_character_checkpoint) if configured_character_checkpoint else None
    )
    if character_checkpoint_path is not None and (
        not character_checkpoint_path.exists() or not character_checkpoint_path.is_file()
    ):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "CUSTOM_OCR_CHARACTER_CHECKPOINT_NOT_FOUND",
                "message": f"Character checkpoint not found: {configured_character_checkpoint}",
            },
        )
    configured_challenger_checkpoint = challenger_checkpoint or os.getenv("CUSTOM_OCR_CRNN_CHALLENGER_CHECKPOINT")
    challenger_checkpoint_path = (
        _resolve_local_model_checkpoint(configured_challenger_checkpoint) if configured_challenger_checkpoint else None
    )
    if challenger_checkpoint_path is not None and (
        not challenger_checkpoint_path.exists() or not challenger_checkpoint_path.is_file()
    ):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "CUSTOM_OCR_CHALLENGER_CHECKPOINT_NOT_FOUND",
                "message": f"CRNN challenger checkpoint not found: {configured_challenger_checkpoint}",
            },
        )
    configured_challenger_mode = challenger_mode or os.getenv("CUSTOM_OCR_CRNN_CHALLENGER_MODE") or "shadow"
    if configured_challenger_mode not in {"off", "shadow", "validated"}:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "INVALID_CUSTOM_OCR_CHALLENGER_MODE",
                "message": "Challenger mode must be one of: off, shadow, validated.",
            },
        )
    configured_router_checkpoint = router_checkpoint or os.getenv("CUSTOM_OCR_ROUTER_CHECKPOINT")
    router_checkpoint_path = (
        _resolve_local_model_checkpoint(configured_router_checkpoint) if configured_router_checkpoint else None
    )
    if router_checkpoint_path is not None and (
        not router_checkpoint_path.exists() or not router_checkpoint_path.is_file()
    ):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "CUSTOM_OCR_ROUTER_CHECKPOINT_NOT_FOUND",
                "message": f"Pairwise router checkpoint not found: {configured_router_checkpoint}",
            },
        )

    suffix = Path(file.filename or "upload.png").suffix or ".png"
    with NamedTemporaryFile(suffix=suffix, delete=False) as temp:
        content = await file.read()
        temp.write(content)
        input_path = Path(temp.name)

    try:
        prediction = run_custom_ocr_document(
            checkpoint_path,
            input_path,
            file.content_type or "",
            numeric_char_checkpoint=numeric_checkpoint_path,
            character_checkpoint=character_checkpoint_path,
            challenger_checkpoint=challenger_checkpoint_path,
            challenger_mode=configured_challenger_mode,
            **({"router_checkpoint": router_checkpoint_path} if router_checkpoint_path is not None else {}),
        )
        return JSONResponse(
            {
                "engine": "CUSTOM_CRNN",
                "actual_engine_used": prediction.actual_engine_used,
                "text": prediction.text,
                "normalized_text": prediction.normalized_text,
                "confidence": prediction.confidence,
                "tokens": prediction.tokens,
                "warnings": prediction.warnings,
                "page_count": len(prediction.pages),
                "pages": prediction.pages,
                "quality": prediction.quality,
                "segmentation_manifest": prediction.segmentation_manifest,
                "model_version": prediction.model_version,
                "vocab_version": prediction.vocab_version,
                "checkpoint": str(checkpoint_path),
                "numeric_char_checkpoint": str(numeric_checkpoint_path) if numeric_checkpoint_path is not None else None,
                "character_checkpoint": str(character_checkpoint_path) if character_checkpoint_path is not None else None,
                "challenger_checkpoint": str(challenger_checkpoint_path) if challenger_checkpoint_path is not None else None,
                "challenger_mode": configured_challenger_mode,
                "router_checkpoint": str(router_checkpoint_path) if router_checkpoint_path is not None else None,
            }
        )
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={"code": "CUSTOM_OCR_CHECKPOINT_NOT_FOUND", "message": str(error)},
        ) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        input_path.unlink(missing_ok=True)


@app.post("/models/custom-ocr/smoke-train")
def custom_ocr_smoke_train(request: CustomOcrSmokeTrainRequest) -> JSONResponse:
    return _train_custom_ocr_for_api(
        tenant_id=request.tenant_id,
        training_run_id=request.training_run_id,
        seed=request.seed,
        samples=request.samples,
        epochs=request.epochs,
        profile="smoke",
        dataset_mode="lines",
    )


@app.post("/models/custom-ocr/full-train")
def custom_ocr_full_train(request: CustomOcrFullTrainRequest) -> JSONResponse:
    dataset_mode, combined_manifest_dir = _full_custom_ocr_dataset_config()
    return _train_custom_ocr_for_api(
        tenant_id=request.tenant_id,
        training_run_id=request.training_run_id,
        seed=request.seed,
        samples=request.samples,
        epochs=request.epochs,
        profile="local_full",
        dataset_mode=dataset_mode,
        combined_manifest_dir=combined_manifest_dir,
    )


def _train_custom_ocr_for_api(
    *,
    tenant_id: str,
    training_run_id: str,
    seed: int,
    samples: int,
    epochs: int,
    profile: str,
    dataset_mode: str,
    combined_manifest_dir: Path = Path("artifacts/datasets/custom-ocr"),
) -> JSONResponse:
    run_key = _safe_run_key(tenant_id, training_run_id)
    data_dir = Path("data") / "generated" / "custom-ocr-api" / run_key
    artifact_dir = Path("artifacts") / "models" / "custom-ocr-api" / run_key
    try:
        metrics = train_custom_ocr_model(
            data_dir=data_dir,
            artifact_dir=artifact_dir,
            samples=samples,
            epochs=epochs,
            seed=seed,
            profile=profile,
            dataset_mode=dataset_mode,
            batch_size=8 if profile == "local_full" else 4,
            early_stopping_patience=2 if profile == "local_full" else None,
            field_oversample_factor=3.0 if profile == "local_full" else 1.0,
            blank_regularization=0.05 if profile == "local_full" else 0.0,
            combined_manifest_dir=combined_manifest_dir,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    metrics = {
        **metrics,
        "model": "custom-crnn-ctc",
        "engine": "CUSTOM_CRNN",
        "seed": seed,
        "training_profile": profile,
    }
    report_key = f"{artifact_dir.as_posix()}/metrics.json"
    return JSONResponse(
        {
            "metrics": metrics,
            "artifactBucket": "local-artifacts",
            "artifactKey": artifact_dir.as_posix(),
            "reportKey": report_key,
            "checkpoint": f"{artifact_dir.as_posix()}/model.pt",
        }
    )


def _full_custom_ocr_dataset_config() -> tuple[str, Path]:
    combined_manifest_dir = Path("artifacts") / "datasets" / "custom-ocr"
    if (combined_manifest_dir / "line_train.jsonl").is_file() and (combined_manifest_dir / "line_validation.jsonl").is_file():
        return "combined_manifest", combined_manifest_dir
    return "document_lines", combined_manifest_dir


@app.post("/preprocess")
async def preprocess(file: UploadFile = File(...), profile: PreprocessingProfile = "TESSERACT_OPTIMIZED") -> JSONResponse:
    if file.content_type not in SUPPORTED_OCR_DOCUMENT_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported document type: {file.content_type}")

    suffix = Path(file.filename or "upload.png").suffix or ".png"
    with NamedTemporaryFile(suffix=suffix, delete=False) as temp:
        content = await file.read()
        temp.write(content)
        input_path = Path(temp.name)

    try:
        processed = preprocess_document(input_path, profile=profile, source_mime_type=file.content_type)
        return JSONResponse(
            {
                "profile": profile,
                "page_count": len(processed.pages),
                "preprocessing_manifest": str(processed.manifest_path),
                "pages": [
                    {
                        "page_number": page.page_number,
                        "mime_type": "image/png",
                        "processed_image_base64": base64.b64encode(page.processed_image_path.read_bytes()).decode("ascii"),
                        "output_width": page.decisions.get("output_width"),
                        "output_height": page.decisions.get("output_height"),
                        "quality_score": page.decisions.get("quality_score"),
                        "preprocessing": page.decisions,
                    }
                    for page in processed.pages
                ],
            }
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        input_path.unlink(missing_ok=True)


def _resolve_local_model_checkpoint(checkpoint: str) -> Path:
    candidate = Path(checkpoint)
    if candidate.is_absolute() or any(part == ".." for part in candidate.parts):
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_CUSTOM_OCR_CHECKPOINT_PATH", "message": "Checkpoint path must stay under artifacts/models."},
        )

    root = Path.cwd().resolve()
    resolved = (root / candidate).resolve()
    allowed_root = (root / "artifacts" / "models").resolve()
    try:
        resolved.relative_to(allowed_root)
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_CUSTOM_OCR_CHECKPOINT_PATH", "message": "Checkpoint path must stay under artifacts/models."},
        ) from error
    return resolved


def _safe_run_key(tenant_id: str, training_run_id: str) -> str:
    raw = f"{tenant_id}-{training_run_id}-{uuid4()}"
    return "".join(character if character.isalnum() or character in {"-", "_"} else "-" for character in raw)
