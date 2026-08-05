from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from typing import Iterable, Sequence


Point = tuple[float, float]
Polygon = list[Point]


@dataclass(frozen=True)
class LineGeometry:
    line_id: str
    polygon: Polygon
    angle_degrees: float
    height: float
    center: Point


def _distance(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def polygon_angle(polygon: Sequence[Sequence[float]]) -> float:
    if len(polygon) < 2:
        return 0.0
    dx = float(polygon[1][0]) - float(polygon[0][0])
    dy = float(polygon[1][1]) - float(polygon[0][1])
    return math.degrees(math.atan2(dy, dx))


def polygon_height(polygon: Sequence[Sequence[float]]) -> float:
    if len(polygon) < 4:
        return 0.0
    left = _distance((float(polygon[0][0]), float(polygon[0][1])), (float(polygon[3][0]), float(polygon[3][1])))
    right = _distance((float(polygon[1][0]), float(polygon[1][1])), (float(polygon[2][0]), float(polygon[2][1])))
    return (left + right) / 2.0


def polygon_center(polygon: Sequence[Sequence[float]]) -> Point:
    return (
        statistics.fmean(float(point[0]) for point in polygon),
        statistics.fmean(float(point[1]) for point in polygon),
    )


def normalize_polygon(polygon: Sequence[Sequence[float]], width: int, height: int) -> Polygon:
    return [
        (
            min(1.0, max(0.0, float(point[0]) / width)),
            min(1.0, max(0.0, float(point[1]) / height)),
        )
        for point in polygon
    ]


def denormalize_polygon(polygon: Sequence[Sequence[float]], width: int, height: int) -> Polygon:
    return [(float(point[0]) * width, float(point[1]) * height) for point in polygon]


def _angle_distance(a: float, b: float) -> float:
    # Text lines have a 180-degree symmetry.
    difference = abs((a - b) % 180.0)
    return min(difference, 180.0 - difference)


def _bbox(polygon: Sequence[Sequence[float]]) -> tuple[float, float, float, float]:
    xs = [float(point[0]) for point in polygon]
    ys = [float(point[1]) for point in polygon]
    return min(xs), min(ys), max(xs), max(ys)


def _vertical_gap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    if a[1] <= b[3] and b[1] <= a[3]:
        return 0.0
    return max(a[1] - b[3], b[1] - a[3])


def _horizontal_gap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    if a[0] <= b[2] and b[0] <= a[2]:
        return 0.0
    return max(a[0] - b[2], b[0] - a[2])


def line_geometries(lines: Iterable[dict]) -> list[LineGeometry]:
    result: list[LineGeometry] = []
    for line in lines:
        polygon = [(float(point[0]), float(point[1])) for point in line["polygon"]]
        result.append(
            LineGeometry(
                line_id=str(line["line_id"]),
                polygon=polygon,
                angle_degrees=polygon_angle(polygon),
                height=polygon_height(polygon),
                center=polygon_center(polygon),
            )
        )
    return result


def cluster_lines(lines: Iterable[dict], image_width: int, image_height: int) -> list[list[LineGeometry]]:
    """Cluster text lines into label candidates without assuming one label template."""

    items = line_geometries(lines)
    if not items:
        return []
    baseline_height = statistics.median(item.height for item in items if item.height > 0) or 20.0
    parent = list(range(len(items)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    for index, left in enumerate(items):
        left_box = _bbox(left.polygon)
        for other_index in range(index + 1, len(items)):
            right = items[other_index]
            right_box = _bbox(right.polygon)
            # Use the document's typical line height rather than a large logo
            # or a two-line address box, otherwise adjacent physical labels
            # can be bridged by one unusually tall detection polygon.
            scale = max(8.0, min(40.0, baseline_height))
            if _angle_distance(left.angle_degrees, right.angle_degrees) > 18.0:
                continue
            if _vertical_gap(left_box, right_box) > 2.5 * scale:
                continue
            if _horizontal_gap(left_box, right_box) > max(6.0 * scale, 0.25 * image_width):
                continue
            union(index, other_index)

    groups: dict[int, list[LineGeometry]] = {}
    for index, item in enumerate(items):
        groups.setdefault(find(index), []).append(item)
    return sorted(
        (sorted(group, key=lambda item: (item.center[1], item.center[0])) for group in groups.values()),
        key=lambda group: (min(item.center[1] for item in group), min(item.center[0] for item in group)),
    )


def region_polygon(group: Sequence[LineGeometry], image_width: int, image_height: int, margin: float = 0.05) -> Polygon:
    min_x = min(point[0] for item in group for point in item.polygon)
    min_y = min(point[1] for item in group for point in item.polygon)
    max_x = max(point[0] for item in group for point in item.polygon)
    max_y = max(point[1] for item in group for point in item.polygon)
    pad_x = max(8.0, (max_x - min_x) * margin)
    pad_y = max(8.0, (max_y - min_y) * margin)
    min_x, min_y = max(0.0, min_x - pad_x), max(0.0, min_y - pad_y)
    max_x, max_y = min(float(image_width), max_x + pad_x), min(float(image_height), max_y + pad_y)
    return [(min_x, min_y), (max_x, min_y), (max_x, max_y), (min_x, max_y)]


def group_angle(group: Sequence[LineGeometry]) -> float:
    if not group:
        return 0.0
    weights = [max(1.0, item.height) for item in group]
    # Circular mean for angles with 180-degree symmetry.
    x = sum(weight * math.cos(math.radians(2.0 * item.angle_degrees)) for item, weight in zip(group, weights))
    y = sum(weight * math.sin(math.radians(2.0 * item.angle_degrees)) for item, weight in zip(group, weights))
    return math.degrees(math.atan2(y, x)) / 2.0


def median_line_height(lines: Iterable[dict]) -> float | None:
    values = [polygon_height(line["polygon"]) for line in lines]
    return statistics.median(values) if values else None
