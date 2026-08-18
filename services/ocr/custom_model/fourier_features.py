from __future__ import annotations

import cv2
import numpy as np

from services.ocr.custom_model.boundary import hole_count, trace_boundary


def fourier_descriptor(binary_crop: np.ndarray, coefficients: int = 12) -> np.ndarray:
    points = trace_boundary(binary_crop)
    if len(points) == 0:
        return np.zeros(coefficients * 2, dtype=np.float32)
    complex_points = points[:, 0] + 1j * points[:, 1]
    complex_points = complex_points - complex_points.mean()
    spectrum = np.fft.fft(complex_points)
    selected = spectrum[1 : coefficients + 1]
    if len(selected) < coefficients:
        selected = np.pad(selected, (0, coefficients - len(selected)), mode="constant")
    scale = np.abs(selected[0]) if len(selected) else 0
    if scale > 1e-6:
        selected = selected / scale
    return np.concatenate([selected.real, selected.imag]).astype(np.float32)


def handcrafted_features(binary_crop: np.ndarray) -> np.ndarray:
    if binary_crop.size == 0:
        return np.zeros(27, dtype=np.float32)
    crop = _foreground_crop(binary_crop)
    height, width = crop.shape[:2]
    resized = cv2.resize(crop, (16, 16), interpolation=cv2.INTER_AREA)
    zoning = resized.reshape(4, 4, 4, 4).mean(axis=(2, 3)) / 255.0
    horizontal = cv2.resize(crop.mean(axis=1, keepdims=True), (1, 4), interpolation=cv2.INTER_AREA).flatten() / 255.0
    vertical = cv2.resize(crop.mean(axis=0, keepdims=True), (4, 1), interpolation=cv2.INTER_AREA).flatten() / 255.0
    aspect = np.array([width / max(height, 1), height / max(width, 1), hole_count(crop)], dtype=np.float32)
    return np.concatenate([zoning.flatten(), horizontal, vertical, aspect]).astype(np.float32)


def embedding(binary_crop: np.ndarray) -> np.ndarray:
    vector = np.concatenate([fourier_descriptor(binary_crop), handcrafted_features(binary_crop)]).astype(np.float32)
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 1e-9 else vector


def cosine_similarity(left: np.ndarray, right: np.ndarray) -> float:
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denominator <= 1e-9:
        return 0.0
    return float(np.dot(left, right) / denominator)


def _foreground_crop(binary_crop: np.ndarray) -> np.ndarray:
    ys, xs = np.where(binary_crop > 0)
    if len(xs) == 0 or len(ys) == 0:
        return np.zeros((16, 16), dtype=np.uint8)
    return binary_crop[max(0, ys.min() - 1) : ys.max() + 2, max(0, xs.min() - 1) : xs.max() + 2]