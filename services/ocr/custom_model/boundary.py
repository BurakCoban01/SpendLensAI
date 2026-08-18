from __future__ import annotations

import cv2
import numpy as np


def trace_boundary(binary_crop: np.ndarray) -> np.ndarray:
    contours, _hierarchy = cv2.findContours(binary_crop, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return np.empty((0, 2), dtype=np.float32)
    contour = max(contours, key=cv2.contourArea).reshape(-1, 2).astype(np.float32)
    return contour


def hole_count(binary_crop: np.ndarray) -> int:
    contours, hierarchy = cv2.findContours(binary_crop, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return 0
    parents = hierarchy[0, :, 3]
    return int(np.count_nonzero(parents >= 0))