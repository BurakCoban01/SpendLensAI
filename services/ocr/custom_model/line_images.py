from __future__ import annotations

import numpy as np
import torch
import cv2
from PIL import Image


LINE_IMAGE_HEIGHT = 64
LINE_IMAGE_MIN_WIDTH = 128
LINE_IMAGE_MAX_WIDTH = 768
LINE_IMAGE_BACKGROUND = 245
LINE_IMAGE_DOCUMENT_MIN_WIDTH = 384
LINE_IMAGE_HORIZONTAL_MARGIN = 12
LINE_IMAGE_WINDOW_OVERLAP = 128
LINE_IMAGE_MAX_WINDOWS = 6


def deskew_line_image(
    image: Image.Image,
    *,
    max_angle_degrees: float = 14.0,
    background: int = LINE_IMAGE_BACKGROUND,
) -> Image.Image:
    gray = image.convert("L")
    angle = estimate_line_skew_degrees(gray)
    if abs(angle) < 2.0 or abs(angle) > max_angle_degrees:
        return gray
    return gray.rotate(angle, resample=_resampling_bicubic(), expand=True, fillcolor=background)


def estimate_line_skew_degrees(image: Image.Image) -> float:
    gray = np.array(image.convert("L"), dtype=np.uint8)
    if gray.size == 0:
        return 0.0
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    _threshold, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ys, xs = np.where(binary > 0)
    if len(xs) < 16:
        return 0.0
    points = np.column_stack((xs, ys)).astype(np.float32)
    rect = cv2.minAreaRect(points)
    angle = float(rect[-1])
    if angle < -45.0:
        correction = 90.0 + angle
    elif angle > 45.0:
        correction = angle - 90.0
    else:
        correction = angle
    if abs(correction) > 30.0:
        return 0.0
    return correction


def prepare_line_image(
    image: Image.Image,
    *,
    target_height: int = LINE_IMAGE_HEIGHT,
    min_width: int = LINE_IMAGE_MIN_WIDTH,
    max_width: int = LINE_IMAGE_MAX_WIDTH,
    background: int = LINE_IMAGE_BACKGROUND,
) -> Image.Image:
    gray = image.convert("L")
    width, height = gray.size
    if width <= 0 or height <= 0:
        raise ValueError("Line image must have positive dimensions.")
    scaled_width = max(1, round(width * (target_height / height)))
    resized_width = max(min_width, min(max_width, scaled_width))
    resized = gray.resize((resized_width, target_height), _resampling_bilinear())
    if resized_width >= min_width:
        return resized
    canvas = Image.new("L", (min_width, target_height), color=background)
    canvas.paste(resized, (0, 0))
    return canvas


def prepare_cropped_line_image(
    image: Image.Image,
    *,
    target_height: int = LINE_IMAGE_HEIGHT,
    min_width: int = LINE_IMAGE_DOCUMENT_MIN_WIDTH,
    max_width: int = LINE_IMAGE_MAX_WIDTH,
    background: int = LINE_IMAGE_BACKGROUND,
    horizontal_margin: int = LINE_IMAGE_HORIZONTAL_MARGIN,
    deskew: bool = False,
) -> Image.Image:
    gray = deskew_line_image(image, background=background) if deskew else image.convert("L")
    width, height = gray.size
    if width <= 0 or height <= 0:
        raise ValueError("Line image must have positive dimensions.")
    max_content_height = max(1, target_height - 8)
    if height > max_content_height or width + horizontal_margin * 2 > max_width:
        scale = min(max_content_height / height, max_width / max(width + horizontal_margin * 2, 1))
        resized_width = max(1, round(width * scale))
        resized_height = max(1, round(height * scale))
        gray = gray.resize((resized_width, resized_height), _resampling_bilinear())
        width, height = gray.size
    canvas_width = max(min_width, min(max_width, width + horizontal_margin * 2))
    canvas = Image.new("L", (canvas_width, target_height), color=background)
    canvas.paste(gray, (horizontal_margin, max(0, (target_height - height) // 2)))
    return canvas


def prepare_cropped_line_windows(
    image: Image.Image,
    *,
    target_height: int = LINE_IMAGE_HEIGHT,
    min_width: int = LINE_IMAGE_DOCUMENT_MIN_WIDTH,
    max_width: int = LINE_IMAGE_MAX_WIDTH,
    background: int = LINE_IMAGE_BACKGROUND,
    horizontal_margin: int = LINE_IMAGE_HORIZONTAL_MARGIN,
    overlap: int = LINE_IMAGE_WINDOW_OVERLAP,
    max_windows: int = LINE_IMAGE_MAX_WINDOWS,
    deskew: bool = False,
) -> list[Image.Image]:
    if overlap < 0 or overlap >= max_width:
        raise ValueError("Line window overlap must be non-negative and smaller than max_width.")
    if max_windows < 1:
        raise ValueError("max_windows must be positive.")
    gray = deskew_line_image(image, background=background) if deskew else image.convert("L")
    width, height = gray.size
    if width <= 0 or height <= 0:
        raise ValueError("Line image must have positive dimensions.")

    max_content_height = max(1, target_height - 8)
    scale = min(1.0, max_content_height / height)
    resized_width = max(1, round(width * scale))
    resized_height = max(1, round(height * scale))
    step = max_width - overlap
    maximum_covered_width = max_width + step * (max_windows - 1) - horizontal_margin * 2
    if resized_width > maximum_covered_width:
        bounded_scale = maximum_covered_width / width
        resized_width = max(1, round(width * bounded_scale))
        resized_height = max(1, round(height * bounded_scale))
    if (resized_width, resized_height) != gray.size:
        gray = gray.resize((resized_width, resized_height), _resampling_bilinear())

    content_width = gray.width + horizontal_margin * 2
    if content_width <= max_width:
        return [
            prepare_cropped_line_image(
                gray,
                target_height=target_height,
                min_width=min_width,
                max_width=max_width,
                background=background,
                horizontal_margin=horizontal_margin,
            )
        ]

    full_line = Image.new("L", (content_width, target_height), color=background)
    full_line.paste(gray, (horizontal_margin, max(0, (target_height - gray.height) // 2)))
    starts = list(range(0, max(1, content_width - max_width + 1), step))
    final_start = max(0, content_width - max_width)
    if not starts or starts[-1] != final_start:
        starts.append(final_start)
    starts = starts[:max_windows]
    return [full_line.crop((start, 0, start + max_width, target_height)) for start in starts]


def line_image_to_tensor(image: Image.Image, *, invert: bool = False) -> torch.Tensor:
    pixels = torch.from_numpy(np.array(image.convert("L"), dtype=np.float32) / 255.0).unsqueeze(0)
    return 1.0 - pixels if invert else pixels


def ctc_input_length_for_width(width: int, temporal_downsample: int = 4) -> int:
    if temporal_downsample not in {2, 4}:
        raise ValueError("temporal_downsample must be 2 or 4.")
    return max(1, width // temporal_downsample)


def _resampling_bilinear() -> int:
    resampling = getattr(Image, "Resampling", None)
    return int(resampling.BILINEAR if resampling is not None else Image.BILINEAR)


def _resampling_bicubic() -> int:
    resampling = getattr(Image, "Resampling", None)
    return int(resampling.BICUBIC if resampling is not None else Image.BICUBIC)
