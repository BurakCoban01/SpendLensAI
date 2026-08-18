from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class SegmentBox:
    x: int
    y: int
    w: int
    h: int
    level: str
    confidence: float = 1.0
    recognition_bbox: tuple[int, int, int, int] | None = None

    @property
    def bbox(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.w, self.h)


def detect_text_regions(binary: np.ndarray) -> list[SegmentBox]:
    binary = _remove_rule_lines(binary)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 5))
    grouped = cv2.dilate(binary, kernel, iterations=1)
    return _components(grouped, "region", min_area=50, max_height_ratio=0.95)


def segment_lines(binary: np.ndarray) -> list[SegmentBox]:
    binary = _remove_rule_lines(binary)
    projection = np.count_nonzero(binary, axis=1)
    active = projection > max(1, int(binary.shape[1] * 0.015))
    runs = _runs(active)
    boxes: list[SegmentBox] = []
    for top, bottom in runs:
        if bottom - top < 8:
            continue
        row = binary[top:bottom, :]
        column_threshold = 2 if row.shape[0] >= 8 else 1
        columns = np.where(np.count_nonzero(row, axis=0) >= column_threshold)[0]
        if len(columns) == 0:
            continue
        left = int(columns.min())
        right = int(columns.max()) + 1
        line_crop = row[:, left:right]
        line_density = np.count_nonzero(line_crop) / max(line_crop.size, 1)
        if line_density < 0.04:
            continue
        boxes.append(SegmentBox(left, int(top), int(right - left), int(bottom - top), "line"))
    if len(boxes) >= 16:
        boxes = [segment for box in boxes for segment in _split_distant_line_columns(binary, box)]
    if boxes and not _line_projection_is_suspicious(binary, boxes):
        return _finalize_line_segments(binary, boxes)
    component_lines = _component_text_segments(binary)
    if component_lines:
        return _finalize_line_segments(binary, component_lines)
    if boxes:
        return _finalize_line_segments(binary, boxes)
    return _finalize_line_segments(binary, _components(binary, "line", min_area=20, max_height_ratio=0.3))


def _finalize_line_segments(binary: np.ndarray, boxes: list[SegmentBox]) -> list[SegmentBox]:
    height, width = binary.shape[:2]
    padded: list[SegmentBox] = []
    for box in boxes:
        horizontal_padding = max(2, round(box.h * 0.3))
        vertical_padding = max(2, round(box.h * 0.4))
        left = max(0, box.x - horizontal_padding)
        top = max(0, box.y - vertical_padding)
        right = min(width, box.x + box.w + horizontal_padding)
        bottom = min(height, box.y + box.h + vertical_padding)
        padded.append(
            SegmentBox(
                left,
                top,
                right - left,
                bottom - top,
                box.level,
                confidence=box.confidence,
                recognition_bbox=box.recognition_bbox or box.bbox,
            )
        )
    return _sort_reading_order(padded)


def _split_distant_line_columns(binary: np.ndarray, line: SegmentBox) -> list[SegmentBox]:
    crop = binary[line.y : line.y + line.h, line.x : line.x + line.w]
    runs = _runs(np.count_nonzero(crop, axis=0) > 0)
    if len(runs) < 2:
        return [line]
    column_gap_threshold = max(12, int(line.h * 2.0))
    groups: list[tuple[int, int]] = []
    start, end = runs[0]
    for next_start, next_end in runs[1:]:
        if next_start - end > column_gap_threshold:
            groups.append((start, end))
            start = next_start
        end = next_end
    groups.append((start, end))
    if len(groups) == 1:
        return [line]
    return [
        SegmentBox(line.x + left, line.y, right - left, line.h, "line", confidence=line.confidence)
        for left, right in groups
        if right > left
    ]


def _line_projection_is_suspicious(binary: np.ndarray, boxes: list[SegmentBox]) -> bool:
    if not boxes:
        return True
    height, width = binary.shape[:2]
    if height <= 128 and len(boxes) == 1:
        return False
    if any(box.h > height * 0.12 for box in boxes):
        return True
    if len(boxes) > 1:
        return False
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)
    plausible_components = 0
    for index in range(1, count):
        _x, _y, component_width, component_height, area = (int(value) for value in stats[index])
        density = area / max(component_width * component_height, 1)
        if (
            area >= 8
            and component_height >= max(5, int(height * 0.003))
            and component_height <= height * 0.1
            and component_width <= width * 0.18
            and density >= 0.08
        ):
            plausible_components += 1
    return plausible_components >= 12


def _component_text_segments(binary: np.ndarray) -> list[SegmentBox]:
    cleaned = _remove_rule_lines(binary)
    height, width = cleaned.shape[:2]
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(cleaned, connectivity=8)
    filtered = np.zeros_like(cleaned)
    minimum_height = max(5, int(height * 0.006))
    maximum_height = max(24, int(height * 0.1))
    for index in range(1, count):
        _x, _y, component_width, component_height, area = (int(value) for value in stats[index])
        density = area / max(component_width * component_height, 1)
        if area < 8 or component_height < minimum_height or component_height > maximum_height:
            continue
        if component_width > width * 0.18 or density < 0.08:
            continue
        filtered[labels == index] = 255
    if np.count_nonzero(filtered) == 0:
        return []

    kernel_width = max(9, min(31, width // 50))
    grouped = cv2.dilate(filtered, cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_width, 3)), iterations=1)
    grouped_count, _grouped_labels, grouped_stats, _grouped_centroids = cv2.connectedComponentsWithStats(grouped, connectivity=8)
    segments: list[SegmentBox] = []
    for index in range(1, grouped_count):
        x, y, box_width, box_height, area = (int(value) for value in grouped_stats[index])
        if area < 30 or box_width < max(12, minimum_height, int(box_height * 1.1)):
            continue
        if box_height < minimum_height or box_height > max(96, int(height * 0.1)):
            continue
        original_ink = int(np.count_nonzero(filtered[y : y + box_height, x : x + box_width]))
        if original_ink < 12:
            continue
        segments.append(SegmentBox(x, y, box_width, box_height, "line", confidence=0.65))
    return _sort_reading_order(segments[:160])


def segment_words(binary: np.ndarray, line: SegmentBox) -> list[SegmentBox]:
    if line.recognition_bbox is not None:
        line = SegmentBox(*line.recognition_bbox, line.level, confidence=line.confidence)
    crop = binary[line.y : line.y + line.h, line.x : line.x + line.w]
    projection = np.count_nonzero(crop, axis=0)
    active = projection > 0
    runs = _runs(active)
    if not runs:
        return []
    gaps = [runs[index + 1][0] - runs[index][1] for index in range(len(runs) - 1)]
    threshold = max(4, line.h // 3, int(np.median(gaps) * 1.8)) if gaps else max(8, line.h // 3)
    words: list[tuple[int, int]] = []
    start, end = runs[0]
    for next_start, next_end in runs[1:]:
        if next_start - end > threshold:
            words.append((start, end))
            start = next_start
        end = next_end
    words.append((start, end))
    return [SegmentBox(line.x + int(left), line.y, int(right - left), line.h, "word") for left, right in words if right > left]


def segment_characters(binary: np.ndarray, word: SegmentBox) -> list[SegmentBox]:
    crop = binary[word.y : word.y + word.h, word.x : word.x + word.w]
    components = _components(crop, "char", min_area=2, max_height_ratio=1.0)
    components = _split_touching_components(crop, components)
    components = _filter_character_rule_artifacts(crop, components)
    components = [SegmentBox(word.x + c.x, word.y + c.y, c.w, c.h, "char") for c in components if c.w <= max(word.w, 1)]
    return _merge_turkish_diacritics(_sort_character_order(components))


def _filter_character_rule_artifacts(binary_crop: np.ndarray, boxes: list[SegmentBox]) -> list[SegmentBox]:
    if not boxes:
        return []
    crop_height = max(1, int(binary_crop.shape[0]))
    filtered: list[SegmentBox] = []
    for box in boxes:
        lower_edge = box.y + box.h
        is_bottom_rule_fragment = box.h <= 3 and lower_edge >= int(crop_height * 0.92) and box.w >= 6
        if is_bottom_rule_fragment:
            continue
        filtered.append(box)
    return filtered


def _split_touching_components(binary_crop: np.ndarray, boxes: list[SegmentBox]) -> list[SegmentBox]:
    if not boxes:
        return []
    median_height = float(np.median([box.h for box in boxes]))
    expected_width = max(3.0, median_height * 0.72)
    normal_widths = [
        box.w
        for box in boxes
        if expected_width * 0.45 <= box.w <= expected_width * 1.6 and box.h >= median_height * 0.55
    ]
    if normal_widths:
        expected_width = max(3.0, float(np.median(normal_widths)))

    split_boxes: list[SegmentBox] = []
    for box in boxes:
        if box.w < expected_width * 1.9 or box.h < median_height * 0.55:
            split_boxes.append(box)
            continue
        estimated_count = max(2, min(12, int(round(box.w / expected_width))))
        projection = np.count_nonzero(binary_crop[box.y : box.y + box.h, box.x : box.x + box.w], axis=0)
        minimum_part_width = max(2, int(expected_width * 0.45))
        radius = max(1, int(expected_width * 0.35))
        cuts = [0]
        for part_index in range(1, estimated_count):
            ideal = int(round(box.w * part_index / estimated_count))
            lower = max(cuts[-1] + minimum_part_width, ideal - radius)
            remaining_parts = estimated_count - part_index
            upper = min(box.w - remaining_parts * minimum_part_width, ideal + radius)
            if lower > upper:
                continue
            cut = min(range(lower, upper + 1), key=lambda column: (int(projection[column]), abs(column - ideal)))
            cuts.append(cut)
        cuts.append(box.w)
        if len(cuts) != estimated_count + 1:
            split_boxes.append(box)
            continue
        for left, right in zip(cuts, cuts[1:]):
            part = binary_crop[box.y : box.y + box.h, box.x + left : box.x + right]
            rows, columns = np.where(part > 0)
            if len(columns) == 0:
                continue
            part_left = int(columns.min())
            part_right = int(columns.max()) + 1
            part_top = int(rows.min())
            part_bottom = int(rows.max()) + 1
            split_boxes.append(
                SegmentBox(
                    box.x + left + part_left,
                    box.y + part_top,
                    part_right - part_left,
                    part_bottom - part_top,
                    "char",
                )
            )
    return _sort_character_order(split_boxes)


def _components(binary: np.ndarray, level: str, min_area: int, max_height_ratio: float) -> list[SegmentBox]:
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)
    boxes: list[SegmentBox] = []
    max_height = max(1, int(binary.shape[0] * max_height_ratio))
    for index in range(1, count):
        x, y, w, h, area = (int(value) for value in stats[index])
        if area < min_area or w <= 0 or h <= 0 or h > max_height:
            continue
        boxes.append(SegmentBox(x, y, w, h, level, confidence=min(1.0, area / max(w * h, 1))))
    return _sort_reading_order(boxes)


def _remove_rule_lines(binary: np.ndarray) -> np.ndarray:
    cleaned = binary.copy()
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(cleaned, connectivity=8)
    image_height, image_width = cleaned.shape[:2]
    for index in range(1, count):
        x, y, w, h, area = (int(value) for value in stats[index])
        if area <= 0:
            continue
        fills_box_sparsely = area / max(w * h, 1) < 0.12
        page_frame = w > image_width * 0.7 and h > image_height * 0.7 and fills_box_sparsely
        long_horizontal_rule = w > image_width * 0.45 and h <= max(3, image_height * 0.02)
        long_vertical_rule = h > image_height * 0.45 and w <= max(3, image_width * 0.02)
        if page_frame or long_horizontal_rule or long_vertical_rule:
            cleaned[labels == index] = 0
    return cleaned


def _merge_turkish_diacritics(boxes: list[SegmentBox]) -> list[SegmentBox]:
    merged: list[SegmentBox] = []
    consumed: set[int] = set()
    median_height = np.median([box.h for box in boxes]) if boxes else 0
    for index, box in enumerate(boxes):
        if index in consumed:
            continue
        current = box
        for accent_index, accent in enumerate(boxes):
            if accent_index == index or accent_index in consumed:
                continue
            small = accent.h <= max(3, median_height * 0.45) and accent.w <= max(3, current.w * 1.2)
            above_or_below = accent.y + accent.h <= current.y + max(2, current.h * 0.25) or accent.y >= current.y + current.h * 0.65
            horizontal_overlap = accent.x < current.x + current.w and accent.x + accent.w > current.x
            if small and above_or_below and horizontal_overlap:
                left = min(current.x, accent.x)
                top = min(current.y, accent.y)
                right = max(current.x + current.w, accent.x + accent.w)
                bottom = max(current.y + current.h, accent.y + accent.h)
                current = SegmentBox(left, top, right - left, bottom - top, "char")
                consumed.add(accent_index)
        merged.append(current)
    return _sort_character_order(merged)


def _runs(active: np.ndarray) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, value in enumerate(active.tolist()):
        if value and start is None:
            start = index
        elif not value and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(active)))
    return runs


def _sort_reading_order(boxes: list[SegmentBox]) -> list[SegmentBox]:
    return sorted(boxes, key=lambda box: (box.y + box.h // 2, box.x))


def _sort_character_order(boxes: list[SegmentBox]) -> list[SegmentBox]:
    return sorted(boxes, key=lambda box: (box.x, box.y))
