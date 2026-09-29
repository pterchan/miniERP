from __future__ import annotations

import statistics
import time
from typing import Any

from .contracts import Diagnostics, ExtractResponse, ImageInfo, LabelResult, LineResult
from .field_extractor import extract_fields, normalize_text
from .geometry import (
    cluster_lines,
    group_angle,
    median_line_height,
    normalize_polygon,
    region_polygon,
)
from .preprocess import enhance_variant, crop_region, map_polygon_back, perspective_variant, resize_for_detection, rotate_variant


def _as_array(image: object) -> object:
    try:
        import numpy as np

        return np.asarray(image)
    except ImportError as exc:
        raise RuntimeError("OCR 服务缺少 NumPy") from exc


def _internal_line(line_id: str, text: str, confidence: float, polygon: list[list[float]], source_variant: str = "raw") -> dict[str, Any]:
    return {
        "line_id": line_id,
        "text": text,
        "normalized_text": normalize_text(text),
        "confidence": float(confidence),
        "polygon": polygon,
        "source_variant": source_variant,
    }


def _mean_confidence(lines: list[dict[str, Any]]) -> float:
    return statistics.fmean(float(line["confidence"]) for line in lines) if lines else 0.0


def _line_center_y(line: dict[str, Any]) -> float:
    return statistics.fmean(float(point[1]) for point in line["polygon"])


def _run_backend(backend: object, image: object, scale: float, prefix: str = "line", source_variant: str = "raw", map_back: Any = None, offset: tuple[float, float] = (0.0, 0.0)) -> list[dict[str, Any]]:
    raw = backend.recognize(_as_array(image))
    output: list[dict[str, Any]] = []
    for index, item in enumerate(raw.lines):
        polygon = [[float(point[0]) / scale, float(point[1]) / scale] for point in item.polygon]
        if map_back is not None:
            polygon = map_polygon_back(polygon, map_back, offset[0], offset[1])
        output.append(_internal_line(f"{prefix}-{index + 1}", item.text, item.confidence, polygon, source_variant))
    return output


def _assign_labels(lines: list[dict[str, Any]], width: int, height: int) -> list[list[Any]]:
    groups = cluster_lines(lines, width, height)
    membership: dict[str, str] = {}
    for index, group in enumerate(groups, start=1):
        label_id = f"label-{index}"
        for item in group:
            membership[item.line_id] = label_id
    for line in lines:
        line["label_id"] = membership.get(line["line_id"])
        line["height"] = median_line_height([line]) or 0.0
    return groups


def _replace_low_confidence_regions(lines: list[dict[str, Any]], groups: list[list[Any]], image: object, width: int, height: int, backend: object) -> None:
    """Try at most two local correction candidates; raw OCR remains default."""

    if _mean_confidence(lines) >= 0.75:
        return
    for group in groups[:2]:
        label_id = next((line.get("label_id") for line in lines if line["line_id"] == group[0].line_id), None)
        current = [line for line in lines if line.get("label_id") == label_id]
        if not current:
            continue
        polygon = region_polygon(group, width, height)
        crop, offset_x, offset_y = crop_region(image, polygon)
        local_polygon = [(float(x) - offset_x, float(y) - offset_y) for x, y in polygon]
        variants = [
            rotate_variant(crop, -group_angle(group)),
            perspective_variant(crop, local_polygon),
            enhance_variant(crop),
        ]
        candidates: list[tuple[float, list[dict[str, Any]], str]] = []
        for variant in [item for item in variants if item is not None][:2]:
            candidate = _run_backend(
                backend,
                variant.image,
                1.0,
                prefix=f"{label_id}-{variant.source_variant}",
                source_variant=variant.source_variant,
                map_back=variant,
                offset=(offset_x, offset_y),
            )
            if candidate:
                candidates.append((_mean_confidence(candidate), candidate, variant.source_variant))
        if not candidates:
            continue
        candidate_score, candidate, _ = max(candidates, key=lambda item: item[0])
        if candidate_score <= _mean_confidence(current) + 0.02:
            continue
        for item in candidate:
            item["label_id"] = label_id
        lines[:] = [line for line in lines if line.get("label_id") != label_id] + candidate
        lines.sort(key=lambda line: (_line_center_y(line), line["polygon"][0][0]))


def extract_from_image(image_info: Any, request_id: str, backend: object) -> ExtractResponse:
    started = time.perf_counter()
    image = image_info.image
    width, height = image_info.width, image_info.height
    working, scale = resize_for_detection(image)
    lines = _run_backend(backend, working, scale)
    groups = _assign_labels(lines, width, height)
    _replace_low_confidence_regions(lines, groups, image, width, height, backend)
    lines.sort(key=lambda line: (_line_center_y(line), line["polygon"][0][0]))
    groups = _assign_labels(lines, width, height)

    median_height = median_line_height(lines)
    mean_confidence = _mean_confidence(lines)
    warnings: list[str] = []
    if not lines:
        status = "reshoot_required"
        warnings.append("未检测到可靠文字，请重新取景并保持标签清晰")
    elif median_height is not None and median_height < 14.0:
        status = "reshoot_required"
        warnings.append("文字像素高度过低，请靠近标签重新拍摄")
    elif (median_height is not None and median_height < 18.0) or mean_confidence < 0.75:
        status = "partial"
        warnings.append("图片清晰度或文字尺寸偏低，结构化字段需要复核")
    else:
        status = "ok"

    fields_input: list[dict[str, Any]] = []
    for line in lines:
        fields_input.append({**line, "median_height": median_height or 0.0})
    extracted = extract_fields(fields_input)

    line_results = [
        LineResult(
            line_id=line["line_id"],
            text=line["text"],
            normalized_text=line["normalized_text"],
            confidence=line["confidence"],
            polygon=normalize_polygon(line["polygon"], width, height),
            label_id=line.get("label_id"),
            source_variant=line.get("source_variant", "raw"),
        )
        for line in lines
    ]
    label_results: list[LabelResult] = []
    for index, group in enumerate(groups, start=1):
        label_id = f"label-{index}"
        label_lines = [line for line in lines if line.get("label_id") == label_id]
        polygon = region_polygon(group, width, height)
        label_results.append(
            LabelResult(
                label_id=label_id,
                polygon=normalize_polygon(polygon, width, height),
                line_ids=[line["line_id"] for line in label_lines],
                rotation_degrees=group_angle(group),
                correction_applied=any(line.get("source_variant") != "raw" for line in label_lines),
            )
        )

    raw_text = "\n".join(line["text"] for line in lines)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return ExtractResponse(
        request_id=request_id,
        status=status,
        image=ImageInfo(media_type=image_info.media_type, width=width, height=height),
        raw_text=raw_text,
        lines=line_results,
        labels=label_results,
        fields=extracted.fields,
        key_values=extracted.key_values,
        search_terms=extracted.search_terms,
        warnings=warnings,
        diagnostics=Diagnostics(
            engine=backend.name,
            timings_ms={"total": round(elapsed_ms, 2)},
            median_text_height_px=median_height,
            mean_line_confidence=mean_confidence if lines else None,
        ),
    )
