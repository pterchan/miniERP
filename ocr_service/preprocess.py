from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class ImageVariant:
    image: object
    source_variant: str
    inverse_transform: object | None = None
    offset_x: float = 0.0
    offset_y: float = 0.0


def enhance_variant(image: object) -> ImageVariant | None:
    """Create a conservative grayscale/contrast candidate for faint labels."""

    try:
        from PIL import ImageEnhance, ImageOps

        gray = ImageOps.autocontrast(image.convert("L"))
        enhanced = ImageEnhance.Contrast(gray).enhance(1.15).convert("RGB")
        return ImageVariant(enhanced, "enhanced")
    except (AttributeError, ImportError, OSError):
        return None


def perspective_variant(image: object, polygon: list[tuple[float, float]]) -> ImageVariant | None:
    """Rectify a four-corner label crop and retain an inverse mapping."""

    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    if len(polygon) != 4:
        return None
    points = np.asarray(polygon, dtype="float32")
    sums, differences = points.sum(axis=1), points[:, 1] - points[:, 0]
    ordered = np.asarray(
        [points[np.argmin(sums)], points[np.argmin(differences)], points[np.argmax(sums)], points[np.argmax(differences)]],
        dtype="float32",
    )
    width = max(2, int(max(np.linalg.norm(ordered[1] - ordered[0]), np.linalg.norm(ordered[2] - ordered[3]))))
    height = max(2, int(max(np.linalg.norm(ordered[3] - ordered[0]), np.linalg.norm(ordered[2] - ordered[1]))))
    target = np.asarray([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype="float32")
    matrix = cv2.getPerspectiveTransform(ordered, target)
    warped = cv2.warpPerspective(np.asarray(image.convert("RGB")), matrix, (width, height), borderValue=(255, 255, 255))
    return ImageVariant(warped, "perspective", cv2.getPerspectiveTransform(target, ordered))


def resize_for_detection(image: object, max_side: int = 2500) -> tuple[object, float]:
    width, height = image.size
    longest = max(width, height)
    if longest <= max_side:
        return image, 1.0
    scale = max_side / float(longest)
    resized = image.resize((max(1, round(width * scale)), max(1, round(height * scale))))
    return resized, scale


def crop_region(image: object, polygon: list[tuple[float, float]], margin: float = 0.08) -> tuple[object, float, float]:
    min_x = min(point[0] for point in polygon)
    min_y = min(point[1] for point in polygon)
    max_x = max(point[0] for point in polygon)
    max_y = max(point[1] for point in polygon)
    pad_x = max(8.0, (max_x - min_x) * margin)
    pad_y = max(8.0, (max_y - min_y) * margin)
    left = max(0, int(min_x - pad_x))
    top = max(0, int(min_y - pad_y))
    right = min(image.width, int(max_x + pad_x + 1))
    bottom = min(image.height, int(max_y + pad_y + 1))
    return image.crop((left, top, right, bottom)), float(left), float(top)


def rotate_variant(image: object, angle_degrees: float) -> ImageVariant | None:
    """Return an expanded OpenCV rotation and the inverse affine matrix.

    OpenCV is an optional dependency for the pure contract tests. RapidOCR
    installs it in production, so rotation retries simply remain disabled if
    a lightweight development environment omits it.
    """

    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    source = np.asarray(image.convert("RGB"))
    height, width = source.shape[:2]
    center = (width / 2.0, height / 2.0)
    matrix = cv2.getRotationMatrix2D(center, angle_degrees, 1.0)
    radians = abs(angle_degrees) * math.pi / 180.0
    cos, sin = abs(math.cos(radians)), abs(math.sin(radians))
    new_width = int(height * sin + width * cos)
    new_height = int(height * cos + width * sin)
    matrix[0, 2] += new_width / 2.0 - center[0]
    matrix[1, 2] += new_height / 2.0 - center[1]
    rotated = cv2.warpAffine(source, matrix, (new_width, new_height), borderValue=(255, 255, 255))
    inverse = cv2.invertAffineTransform(matrix)
    return ImageVariant(rotated, "deskew", inverse)


def map_polygon_back(polygon: list[list[float]], variant: ImageVariant, offset_x: float, offset_y: float) -> list[list[float]]:
    if variant.inverse_transform is None:
        return [[float(x) + offset_x, float(y) + offset_y] for x, y in polygon]
    import numpy as np

    points = np.asarray(polygon, dtype="float32")
    mapped = []
    for x, y in points:
        transformed = variant.inverse_transform.dot([float(x), float(y), 1.0])
        if len(transformed) == 3 and abs(float(transformed[2])) > 1e-8:
            original_x, original_y = transformed[0] / transformed[2], transformed[1] / transformed[2]
        else:
            original_x, original_y = transformed[0], transformed[1]
        mapped.append([float(original_x) + offset_x, float(original_y) + offset_y])
    return mapped
