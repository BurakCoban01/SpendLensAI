from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from tempfile import NamedTemporaryFile, mkdtemp
from typing import Literal
from uuid import uuid4

import cv2
import numpy as np
from PIL import Image, ImageOps

PreprocessingProfile = Literal[
    "DEFAULT",
    "TESSERACT_OPTIMIZED",
    "CUSTOM_MODEL_OPTIMIZED",
    "LOW_LIGHT",
    "THERMAL_RECEIPT",
    "CRUMPLED_RECEIPT",
]

PROFILE_SETTINGS: dict[str, dict[str, object]] = {
    "DEFAULT": {"denoise_h": 8, "adaptive_threshold": False, "shadow_reduction": False, "crop_boundary": False},
    "TESSERACT_OPTIMIZED": {"denoise_h": 10, "adaptive_threshold": True, "shadow_reduction": True, "crop_boundary": True},
    "CUSTOM_MODEL_OPTIMIZED": {"denoise_h": 6, "adaptive_threshold": False, "shadow_reduction": False, "crop_boundary": True},
    "LOW_LIGHT": {"denoise_h": 12, "adaptive_threshold": True, "shadow_reduction": True, "crop_boundary": True},
    "THERMAL_RECEIPT": {"denoise_h": 14, "adaptive_threshold": True, "shadow_reduction": True, "crop_boundary": True},
    "CRUMPLED_RECEIPT": {"denoise_h": 16, "adaptive_threshold": True, "shadow_reduction": True, "crop_boundary": True},
}


@dataclass(frozen=True)
class PreprocessingResult:
    image_path: Path
    decisions: dict[str, object]


@dataclass(frozen=True)
class PreprocessedDocumentPage:
    page_number: int
    source_image_path: Path
    processed_image_path: Path
    decisions: dict[str, object]


@dataclass(frozen=True)
class DocumentPreprocessingResult:
    pages: list[PreprocessedDocumentPage]
    manifest_path: Path


def preprocess_document(
    path: Path,
    profile: PreprocessingProfile = "DEFAULT",
    output_dir: Path | None = None,
    source_mime_type: str | None = None,
    dpi: int = 200,
) -> DocumentPreprocessingResult:
    artifact_dir = output_dir or Path(mkdtemp(prefix="spendlens-preprocessing-"))
    artifact_dir.mkdir(parents=True, exist_ok=True)

    source_images = (
        split_pdf_to_images(path, artifact_dir / "pages", dpi=dpi)
        if _is_pdf(path, source_mime_type)
        else [path]
    )
    if not source_images:
        raise ValueError("Document contains no renderable pages")

    pages: list[PreprocessedDocumentPage] = []
    for index, source_image in enumerate(source_images, start=1):
        processed_path = artifact_dir / f"page-{index:04d}-{profile.lower().replace('_', '-')}.png"
        result = preprocess_image(source_image, profile=profile, output_path=processed_path)
        decisions = {
            **result.decisions,
            "page_number": index,
            "source_artifact": str(source_image),
            "processed_artifact": str(result.image_path),
        }
        pages.append(
            PreprocessedDocumentPage(
                page_number=index,
                source_image_path=source_image,
                processed_image_path=result.image_path,
                decisions=decisions,
            )
        )

    manifest_path = artifact_dir / "preprocessing-manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "source": str(path),
                "source_mime_type": source_mime_type,
                "profile": profile,
                "page_count": len(pages),
                "pages": [
                    {
                        "page_number": page.page_number,
                        "source_image_path": str(page.source_image_path),
                        "processed_image_path": str(page.processed_image_path),
                        "decisions": page.decisions,
                    }
                    for page in pages
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return DocumentPreprocessingResult(pages=pages, manifest_path=manifest_path)


def preprocess_image(
    path: Path,
    profile: PreprocessingProfile = "DEFAULT",
    output_path: Path | None = None,
) -> PreprocessingResult:
    if profile not in PROFILE_SETTINGS:
        raise ValueError(f"Unsupported preprocessing profile: {profile}")

    settings = PROFILE_SETTINGS[profile]
    with Image.open(path) as source_image:
        frame_count = int(getattr(source_image, "n_frames", 1) or 1)
        if frame_count > 1:
            source_image.seek(0)
        image = ImageOps.exif_transpose(source_image).copy()
    decisions: dict[str, object] = {
        "profile": profile,
        "exif_transposed": True,
        "source_width": image.width,
        "source_height": image.height,
        "source_frame_count": frame_count,
    }
    if frame_count > 1:
        decisions["frame_handling"] = "first_frame_only"
        decisions["warnings"] = ["MULTIFRAME_FIRST_FRAME_ONLY"]

    array = np.array(image.convert("RGB"))
    gray = cv2.cvtColor(array, cv2.COLOR_RGB2GRAY)
    decisions["grayscale"] = True
    decisions["contrast_stddev"] = float(gray.std())

    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    decisions["blur_score"] = blur_score
    decisions["low_quality"] = blur_score < 35.0

    if bool(settings["shadow_reduction"]):
        gray = _reduce_shadows(gray)
        decisions["shadow_reduction"] = True
    else:
        decisions["shadow_reduction"] = False

    denoise_h = int(settings["denoise_h"])
    denoised = cv2.fastNlMeansDenoising(gray, None, h=denoise_h, templateWindowSize=7, searchWindowSize=21)
    decisions["denoise"] = {"enabled": True, "h": denoise_h}

    normalized = _normalize_contrast(denoised)
    decisions["contrast_normalization"] = "clahe"

    boundary = _detect_document_boundary(normalized)
    decisions["receipt_boundary"] = boundary
    if bool(settings["crop_boundary"]) and boundary["detected"]:
        x, y, width, height = boundary["bbox"]
        normalized = normalized[y : y + height, x : x + width]
        decisions["boundary_crop"] = True
    else:
        decisions["boundary_crop"] = False

    if bool(settings["adaptive_threshold"]):
        processed = cv2.adaptiveThreshold(
            normalized,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            31,
            11,
        )
        decisions["adaptive_threshold"] = True
    else:
        processed = normalized
        decisions["adaptive_threshold"] = False

    deskewed, angle = _deskew(processed)
    decisions["deskew_angle"] = angle
    decisions["output_width"] = int(deskewed.shape[1])
    decisions["output_height"] = int(deskewed.shape[0])
    decisions["quality_score"] = _quality_score(blur_score, float(gray.std()))

    if output_path is None:
        with NamedTemporaryFile(suffix=".png", delete=False) as output:
            target_path = Path(output.name)
    else:
        target_path = output_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(target_path), deskewed)
    return PreprocessingResult(image_path=target_path, decisions=decisions)


def split_pdf_to_images(path: Path, output_dir: Path, dpi: int = 200) -> list[Path]:
    try:
        import fitz  # type: ignore[import-not-found]
    except ImportError as error:
        raise RuntimeError("PDF preprocessing requires PyMuPDF. Install services/ocr requirements.") from error

    output_dir.mkdir(parents=True, exist_ok=True)
    rendered_pages: list[Path] = []
    with fitz.open(path) as document:
        if document.is_encrypted:
            raise ValueError("Encrypted PDFs are not supported for local OCR preprocessing")
        zoom = dpi / 72.0
        matrix = fitz.Matrix(zoom, zoom)
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            page_path = output_dir / f"page-{page_index + 1:04d}-{uuid4().hex[:8]}.png"
            pixmap.save(str(page_path))
            rendered_pages.append(page_path)
    return rendered_pages


def _is_pdf(path: Path, source_mime_type: str | None) -> bool:
    if source_mime_type == "application/pdf":
        return True
    if path.suffix.lower() == ".pdf":
        return True
    with path.open("rb") as file:
        return file.read(5) == b"%PDF-"


def _normalize_contrast(image: np.ndarray) -> np.ndarray:
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(image)


def _reduce_shadows(image: np.ndarray) -> np.ndarray:
    dilated = cv2.dilate(image, np.ones((7, 7), np.uint8))
    background = cv2.medianBlur(dilated, 21)
    diff = 255 - cv2.absdiff(image, background)
    return cv2.normalize(diff, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX)


def _detect_document_boundary(image: np.ndarray) -> dict[str, object]:
    blurred = cv2.GaussianBlur(image, (5, 5), 0)
    edged = cv2.Canny(blurred, 50, 150)
    contours, _ = cv2.findContours(edged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return {"detected": False, "bbox": [0, 0, int(image.shape[1]), int(image.shape[0])], "coverage": 1.0}

    height, width = image.shape[:2]
    largest = max(contours, key=cv2.contourArea)
    x, y, box_width, box_height = cv2.boundingRect(largest)
    coverage = float((box_width * box_height) / max(width * height, 1))
    detected = coverage >= 0.20 and box_width >= width * 0.35 and box_height >= height * 0.35
    if not detected:
        return {"detected": False, "bbox": [0, 0, int(width), int(height)], "coverage": coverage}
    return {"detected": True, "bbox": [int(x), int(y), int(box_width), int(box_height)], "coverage": coverage}


def _quality_score(blur_score: float, contrast_stddev: float) -> float:
    blur_component = min(blur_score / 250.0, 1.0)
    contrast_component = min(contrast_stddev / 64.0, 1.0)
    return round(max(0.0, min((blur_component * 0.65) + (contrast_component * 0.35), 1.0)), 4)


def _deskew(image: np.ndarray) -> tuple[np.ndarray, float]:
    coords = np.column_stack(np.where(image < 255))
    if len(coords) < 16:
        return image, 0.0
    angle = cv2.minAreaRect(coords)[-1]
    if angle < -45:
        angle = -(90 + angle)
    else:
        angle = -angle
    if abs(angle) > 15:
        return image, 0.0
    (height, width) = image.shape[:2]
    matrix = cv2.getRotationMatrix2D((width // 2, height // 2), angle, 1.0)
    rotated = cv2.warpAffine(image, matrix, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return rotated, float(angle)
