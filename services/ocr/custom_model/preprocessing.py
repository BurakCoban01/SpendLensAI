from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import cv2
from PIL import Image

from services.ocr.custom_model.image_ops import (
    adaptive_binary,
    blur_score,
    contrast_score,
    estimate_skew,
    foreground_density,
    load_pages,
    rotate_bound,
    to_grayscale_array,
)


@dataclass(frozen=True)
class CustomPreprocessedPage:
    page_number: int
    gray: np.ndarray
    binary: np.ndarray
    quality: dict[str, float | str]


def preprocess_custom_document(path: Path, source_mime_type: str = "") -> list[CustomPreprocessedPage]:
    pages: list[CustomPreprocessedPage] = []
    for loaded in load_pages(path, source_mime_type):
        source_rgb = np.array(loaded.image.convert("RGB"), dtype=np.uint8)
        gray = to_grayscale_array(loaded.image)
        first_binary = adaptive_binary(gray)
        skew = estimate_skew(first_binary)
        corrected = rotate_bound(gray, skew)
        corrected_rgb = _rotate_color_array(source_rgb, skew)
        binary = adaptive_binary(corrected)
        document_mask, document_surface_detected, document_surface_coverage = _document_surface_mask(corrected, corrected_rgb)
        if document_surface_detected:
            binary = np.where(document_mask > 0, binary, 0).astype(np.uint8)
        quality = {
            "blur_score": round(blur_score(corrected), 4),
            "contrast_score": round(contrast_score(corrected), 4),
            "skew_estimate_degrees": skew,
            "foreground_density": round(foreground_density(binary), 6),
            "document_surface_detected": document_surface_detected,
            "document_surface_coverage": round(document_surface_coverage, 4),
            "status": "ok",
        }
        if quality["blur_score"] < 20:
            quality["status"] = "low_blur"
        if quality["contrast_score"] < 18:
            quality["status"] = "low_contrast"
        pages.append(CustomPreprocessedPage(page_number=loaded.page_number, gray=corrected, binary=binary, quality=quality))
    return pages


def _document_surface_mask(gray: np.ndarray, rgb: np.ndarray | None = None) -> tuple[np.ndarray, bool, float]:
    height, width = gray.shape[:2]
    if height < 96 or width < 96:
        return np.full_like(gray, 255), False, 1.0

    sigma = max(3.0, min(height, width) / 80.0)
    smoothed = cv2.GaussianBlur(gray, (0, 0), sigmaX=sigma, sigmaY=sigma)
    _threshold, candidate = cv2.threshold(smoothed, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if rgb is not None and rgb.shape[:2] == gray.shape:
        hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
        low_saturation_bright = np.where((hsv[:, :, 1] <= 45) & (hsv[:, :, 2] >= 105), 255, 0).astype(np.uint8)
        candidate = cv2.bitwise_and(candidate, low_saturation_bright)
    kernel_size = max(15, min(51, int(round(min(height, width) * 0.035))))
    if kernel_size % 2 == 0:
        kernel_size += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, kernel)

    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(candidate, connectivity=8)
    mask = np.zeros_like(candidate)
    image_area = height * width
    for index in range(1, count):
        x, y, box_width, box_height, area = (int(value) for value in stats[index])
        if area < image_area * 0.06:
            continue
        if box_width < width * 0.2 or box_height < height * 0.2:
            continue
        covers_frame = (
            x <= width * 0.02
            and y <= height * 0.02
            and x + box_width >= width * 0.98
            and y + box_height >= height * 0.98
        )
        if covers_frame:
            return np.full_like(gray, 255), False, 1.0
        mask[labels == index] = 255

    coverage = float(np.count_nonzero(mask) / max(image_area, 1))
    if coverage < 0.15 or coverage > 0.88:
        return np.full_like(gray, 255), False, 1.0
    inside = gray[mask > 0]
    outside = gray[mask == 0]
    if inside.size == 0 or outside.size == 0 or float(inside.mean() - outside.mean()) < 10.0:
        return np.full_like(gray, 255), False, 1.0

    margin = max(3, min(15, int(round(min(height, width) * 0.008))))
    expanded = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (margin * 2 + 1, margin * 2 + 1)))
    return expanded, True, float(np.count_nonzero(expanded) / max(image_area, 1))


def _rotate_color_array(rgb: np.ndarray, angle: float) -> np.ndarray:
    if abs(angle) < 0.2:
        return rgb
    height, width = rgb.shape[:2]
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
    return cv2.warpAffine(rgb, matrix, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def crop_gray(gray: np.ndarray, bbox: tuple[int, int, int, int], padding: int = 2) -> Image.Image:
    x, y, w, h = bbox
    left = max(0, x - padding)
    top = max(0, y - padding)
    right = min(gray.shape[1], x + w + padding)
    bottom = min(gray.shape[0], y + h + padding)
    return Image.fromarray(gray[top:bottom, left:right]).convert("L")
