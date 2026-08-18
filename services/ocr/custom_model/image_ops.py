from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import fitz
import numpy as np
from PIL import Image, ImageOps


@dataclass(frozen=True)
class LoadedPage:
    page_number: int
    image: Image.Image


def load_pages(path: Path, source_mime_type: str = "") -> list[LoadedPage]:
    if source_mime_type == "application/pdf" or path.suffix.lower() == ".pdf":
        document = fitz.open(path)
        pages: list[LoadedPage] = []
        try:
            for index, page in enumerate(document):
                pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                image = Image.frombytes("RGB", [pixmap.width, pixmap.height], pixmap.samples)
                pages.append(LoadedPage(page_number=index + 1, image=image))
        finally:
            document.close()
        return pages
    return [LoadedPage(page_number=1, image=ImageOps.exif_transpose(Image.open(path)).convert("RGB"))]


def to_grayscale_array(image: Image.Image) -> np.ndarray:
    return np.array(image.convert("L"), dtype=np.uint8)


def adaptive_binary(gray: np.ndarray) -> np.ndarray:
    denoised = cv2.fastNlMeansDenoising(gray, h=7)
    normalized = cv2.equalizeHist(denoised)
    return cv2.adaptiveThreshold(
        normalized,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        12,
    )


def estimate_skew(binary: np.ndarray) -> float:
    points = cv2.findNonZero(binary)
    if points is None or len(points) < 20:
        return 0.0
    rect = cv2.minAreaRect(points)
    angle = float(rect[-1])
    if angle < -45:
        angle += 90
    if angle > 45:
        angle -= 90
    return round(angle, 3)


def rotate_bound(gray: np.ndarray, angle: float) -> np.ndarray:
    if abs(angle) < 0.2:
        return gray
    height, width = gray.shape[:2]
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
    return cv2.warpAffine(gray, matrix, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def blur_score(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def contrast_score(gray: np.ndarray) -> float:
    return float(gray.std())


def foreground_density(binary: np.ndarray) -> float:
    return float(np.count_nonzero(binary) / max(binary.size, 1))
