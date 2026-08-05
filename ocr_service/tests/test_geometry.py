from __future__ import annotations

import unittest

from ocr_service.geometry import cluster_lines, group_angle, median_line_height, normalize_polygon, polygon_angle


def line(line_id: str, x: float, y: float, angle: float = 0.0, width: float = 100.0, height: float = 20.0) -> dict:
    import math

    dx, dy = width * math.cos(math.radians(angle)), width * math.sin(math.radians(angle))
    return {
        "line_id": line_id,
        "polygon": [[x, y], [x + dx, y + dy], [x + dx, y + dy + height], [x, y + height]],
    }


class GeometryTests(unittest.TestCase):
    def test_angle_and_normalization(self) -> None:
        item = line("a", 10, 20, -9)
        self.assertAlmostEqual(polygon_angle(item["polygon"]), -9.0, places=3)
        normalized = normalize_polygon(item["polygon"], 1000, 1000)
        self.assertGreaterEqual(min(point[0] for point in normalized), 0.0)
        self.assertLessEqual(max(point[0] for point in normalized), 1.0)

    def test_two_spatially_separated_labels_remain_separate(self) -> None:
        lines = [line("a", 100, 100), line("b", 100, 130), line("c", 100, 700, -9), line("d", 100, 730, -9)]
        groups = cluster_lines(lines, 1000, 1000)
        self.assertEqual(len(groups), 2)
        self.assertAlmostEqual(group_angle(groups[1]), -9.0, places=1)
        self.assertEqual(median_line_height(lines), 20.0)


if __name__ == "__main__":
    unittest.main()
