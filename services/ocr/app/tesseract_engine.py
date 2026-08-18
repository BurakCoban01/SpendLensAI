from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shutil

import pytesseract
from pydantic import BaseModel
from pytesseract import Output


class TesseractToken(BaseModel):
    text: str
    confidence: float
    bbox: tuple[int, int, int, int]


@dataclass(frozen=True)
class TesseractResult:
    text: str
    confidence: float
    tokens: list[TesseractToken]
    warnings: list[str]


class TesseractEngineError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 503) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def check_tesseract_availability(lang: str = "tur+eng") -> dict[str, object]:
    binary_path = shutil.which("tesseract")
    if not binary_path:
        return {"available": False, "binary_path": None, "languages": [], "missing_languages": _requested_languages(lang)}

    try:
        languages = sorted(pytesseract.get_languages(config=""))
    except pytesseract.TesseractError:
        return {"available": False, "binary_path": binary_path, "languages": [], "missing_languages": _requested_languages(lang)}

    requested = _requested_languages(lang)
    missing = [language for language in requested if language not in languages]
    return {"available": len(missing) == 0, "binary_path": binary_path, "languages": languages, "missing_languages": missing}


def run_tesseract(
    image_path: Path,
    lang: str = "tur+eng",
    psm: int = 6,
    oem: int = 3,
    timeout_seconds: int | None = None,
) -> TesseractResult:
    availability = check_tesseract_availability(lang)
    if not availability["binary_path"]:
        raise TesseractEngineError("TESSERACT_BINARY_MISSING", "Tesseract binary is not installed or not on PATH.")
    if availability["missing_languages"]:
        raise TesseractEngineError(
            "TESSERACT_LANGUAGE_MISSING",
            f"Missing Tesseract languages: {', '.join(availability['missing_languages'])}",
            status_code=422,
        )

    config = f"--psm {psm} --oem {oem}"
    effective_timeout_seconds = timeout_seconds if timeout_seconds is not None else _default_timeout_seconds()
    try:
        text = pytesseract.image_to_string(str(image_path), lang=lang, config=config, timeout=effective_timeout_seconds)
        data = pytesseract.image_to_data(
            str(image_path),
            lang=lang,
            config=config,
            output_type=Output.DICT,
            timeout=effective_timeout_seconds,
        )
    except RuntimeError as error:
        raise TesseractEngineError("TESSERACT_TIMEOUT", str(error), status_code=504) from error
    except pytesseract.TesseractNotFoundError as error:
        raise TesseractEngineError("TESSERACT_BINARY_MISSING", str(error)) from error
    except pytesseract.TesseractError as error:
        raise TesseractEngineError("TESSERACT_RUNTIME_ERROR", str(error), status_code=422) from error

    tokens: list[TesseractToken] = []
    for index, raw_text in enumerate(data.get("text", [])):
        token_text = raw_text.strip()
        if not token_text:
            continue
        raw_conf = data["conf"][index]
        confidence = 0.0 if str(raw_conf) == "-1" else max(0.0, min(1.0, float(raw_conf) / 100.0))
        left = int(data["left"][index])
        top = int(data["top"][index])
        width = int(data["width"][index])
        height = int(data["height"][index])
        tokens.append(TesseractToken(text=token_text, confidence=confidence, bbox=(left, top, width, height)))

    if not text.strip() and not tokens:
        raise TesseractEngineError("TESSERACT_EMPTY_OUTPUT", "Tesseract produced no text.", status_code=422)

    average = sum(token.confidence for token in tokens) / len(tokens) if tokens else 0.0
    warnings = ["LOW_CONFIDENCE"] if average < 0.35 else []
    return TesseractResult(text=text, confidence=average, tokens=tokens, warnings=warnings)


def _requested_languages(lang: str) -> list[str]:
    return [part.strip() for part in lang.split("+") if part.strip()]


def _default_timeout_seconds() -> int:
    raw_value = os.getenv("TESSERACT_TIMEOUT_SECONDS", "90")
    try:
        timeout = int(raw_value)
    except ValueError:
        timeout = 90
    return max(5, min(timeout, 300))
