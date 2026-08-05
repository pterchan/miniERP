from __future__ import annotations

import json
import os
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .contracts import Evidence, FieldCandidate, GenericKeyValue, SearchTerm


CORE_ALIASES: dict[str, tuple[str, ...]] = {
    "product_name": ("产品名称", "商品名称", "品名", "product name", "product description", "device name"),
    "brand": ("品牌", "brand"),
    "manufacturer": ("制造商", "生产商", "生产企业", "厂家", "manufacturer", "manufactured by"),
    "reference_number": (
        "ref no",
        "reference no",
        "reference number",
        "catalog no",
        "catalog number",
        "catalogue no",
        "part no",
        "part number",
        "item no",
        "item number",
        "p/n",
        "ref",
        "货号",
        "货品编号",
        "参考号",
        "产品编号",
    ),
    "model": ("规格型号", "型号规格", "型号", "model no", "model number", "model", "型号/规格"),
    "specification": ("规格", "specification", "size"),
    "revision": ("revision", "rev", "版本", "修订"),
    "lot_number": ("lot no", "lot number", "lot", "batch no", "batch number", "batch", "批号", "批次"),
    "serial_number": ("serial no", "serial number", "serial", "s/n", "sn", "序列号"),
    "manufacture_date": (
        "生产日期",
        "制造日期",
        "manufacture date",
        "manufactured date",
        "date of mfg",
        "mfg date",
        "mfd",
        "mfg",
        "dom",
    ),
    "expiry_date": ("有效期至", "失效日期", "expiry date", "expiration date", "expiry", "exp", "use by"),
    "shelf_life": ("使用期限", "保质期", "shelf life"),
    "registration_number": (
        "注册证编号",
        "注册证号",
        "registration number",
        "registration no",
        "certificate number",
        "certificate no",
    ),
    "udi": ("udi", "unique device identifier"),
}


def _load_aliases() -> dict[str, tuple[str, ...]]:
    """Load aliases from a small JSON registry, with a safe code fallback."""

    configured = os.environ.get("OCR_FIELD_ALIASES_PATH")
    path = Path(configured) if configured else Path(__file__).with_name("field_aliases.json")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("alias registry must be an object")
        loaded: dict[str, tuple[str, ...]] = {}
        for field, values in payload.items():
            if isinstance(field, str) and isinstance(values, list) and all(isinstance(value, str) for value in values):
                loaded[field] = tuple(value.strip() for value in values if value.strip())
        return loaded or CORE_ALIASES
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return CORE_ALIASES


CORE_ALIASES = _load_aliases()

_ALIASES: list[tuple[str, str]] = sorted(
    ((alias, field) for field, aliases in CORE_ALIASES.items() for alias in aliases),
    key=lambda item: len(item[0]),
    reverse=True,
)
_DATE_RE = re.compile(r"\b(19\d{2}|20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b")
_CN_DATE_RE = re.compile(r"(19\d{2}|20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日?")
_REV_RE = re.compile(r"\b(?:rev(?:ision)?)[.\s:]*([A-Za-z0-9][A-Za-z0-9._-]*)\b", re.IGNORECASE)
_URL_RE = re.compile(r"^https?://|^www\.", re.IGNORECASE)
_NON_PRODUCT_TITLE_TERMS = (
    "incorporated",
    "limited",
    " ltd",
    "business park",
    "canada",
    "ireland",
    "dba ",
    "made in",
    "说明书",
    "其他内容",
    "address",
)


@dataclass(frozen=True)
class ExtractedFields:
    fields: dict[str, list[FieldCandidate]]
    key_values: list[GenericKeyValue]
    search_terms: list[SearchTerm]


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    return " ".join(value.replace("\u00a0", " ").split()).strip()


def normalize_value(value: str, field: str | None = None) -> str:
    value = normalize_text(value).strip(" ：:;,，")
    if field in {"manufacture_date", "expiry_date"}:
        match = _DATE_RE.search(value) or _CN_DATE_RE.search(value)
        if match:
            year, month, day = (int(part) for part in match.groups())
            return f"{year:04d}-{month:02d}-{day:02d}"
    return value


def _language(value: str) -> str | None:
    if any("\u4e00" <= char <= "\u9fff" for char in value):
        return "zh"
    if any(char.isalpha() for char in value):
        return "en"
    return None


def _alias_match(text: str) -> tuple[str | None, str]:
    raw = normalize_text(text).strip(" :：")
    normalized = raw.lower()
    for alias, field in _ALIASES:
        alias_normalized = alias.lower()
        if normalized == alias_normalized:
            return field, ""
        if normalized.startswith(alias_normalized + ":") or normalized.startswith(alias_normalized + "："):
            return field, raw[len(alias_normalized) + 1 :].lstrip(" ：:")
        if normalized.startswith(alias_normalized + " "):
            return field, raw[len(alias_normalized) :].strip()
    return None, ""


def _split_key_value(text: str) -> tuple[str, str] | None:
    for delimiter in ("：", ":", "；", ";"):
        if delimiter in text:
            key, value = text.split(delimiter, 1)
            if normalize_text(key) and normalize_text(value):
                return key.strip(), value.strip()
    return None


def _candidate(field: str, value: str, confidence: float, line: dict, status: str = "confirmed") -> FieldCandidate | None:
    raw = normalize_text(value)
    normalized = normalize_value(raw, field)
    if not normalized:
        return None
    if field in {"manufacture_date", "expiry_date"} and not (_DATE_RE.search(raw) or _CN_DATE_RE.search(raw)):
        return None
    return FieldCandidate(
        value_raw=raw,
        value_normalized=normalized,
        language=_language(raw),
        confidence=max(0.0, min(1.0, confidence)),
        status=status,  # type: ignore[arg-type]
        label_ids=[line["label_id"]] if line.get("label_id") else [],
        line_ids=[line["line_id"]],
        evidence=Evidence(label_ids=[line["label_id"]] if line.get("label_id") else [], line_ids=[line["line_id"]]),
    )


def _append(fields: dict[str, list[FieldCandidate]], field: str, value: str, confidence: float, line: dict, status: str = "confirmed") -> None:
    candidate = _candidate(field, value, confidence, line, status)
    if candidate:
        fields[field].append(candidate)


def _merge_candidates(fields: dict[str, list[FieldCandidate]]) -> None:
    for field, candidates in fields.items():
        deduped: dict[tuple[str, str | None], FieldCandidate] = {}
        for candidate in candidates:
            key = (candidate.value_normalized, candidate.language)
            existing = deduped.get(key)
            if existing is None or candidate.confidence > existing.confidence:
                deduped[key] = candidate
            elif existing:
                existing.evidence.label_ids = sorted(set(existing.evidence.label_ids + candidate.evidence.label_ids))
                existing.evidence.line_ids = sorted(set(existing.evidence.line_ids + candidate.evidence.line_ids))
                existing.label_ids = sorted(set(existing.label_ids + candidate.label_ids))
                existing.line_ids = sorted(set(existing.line_ids + candidate.line_ids))
        values = sorted(deduped.values(), key=lambda item: item.confidence, reverse=True)
        normalized_values = {item.value_normalized for item in values}
        if len(normalized_values) > 1:
            # A bilingual product name is expected to have one Chinese and one
            # English candidate.  More than one candidate in either language,
            # or any conflict in other fields, is genuinely ambiguous.
            if field == "product_name":
                by_language: dict[str | None, list[FieldCandidate]] = defaultdict(list)
                for value in values:
                    by_language[value.language].append(value)
                for language_values in by_language.values():
                    if language_values[0].language not in {"zh", "en"}:
                        for value in language_values:
                            value.status = "ambiguous"  # type: ignore[assignment]
                    elif len(language_values) > 1:
                        # Keep the strongest reading usable for search while
                        # retaining weaker/conflicting readings as evidence.
                        for value in language_values[1:]:
                            value.status = "ambiguous"  # type: ignore[assignment]
            else:
                for value in values:
                    value.status = "ambiguous"  # type: ignore[assignment]
        fields[field] = values


def _generic_key_value(key: str, value: str, line: dict) -> GenericKeyValue:
    return GenericKeyValue(
        key_raw=key.strip(),
        key_normalized=normalize_text(key).lower(),
        value_raw=normalize_text(value),
        value_normalized=normalize_value(value),
        confidence=float(line["confidence"]),
        evidence=Evidence(label_ids=[line["label_id"]] if line.get("label_id") else [], line_ids=[line["line_id"]]),
    )


def _line_sort_key(line: dict) -> tuple[float, float]:
    polygon = line["polygon"]
    return (sum(float(point[1]) for point in polygon) / len(polygon), sum(float(point[0]) for point in polygon) / len(polygon))


def _line_center(line: dict) -> tuple[float, float]:
    polygon = line["polygon"]
    return (
        sum(float(point[0]) for point in polygon) / len(polygon),
        sum(float(point[1]) for point in polygon) / len(polygon),
    )


def _is_continuation_line(line: dict) -> bool:
    text = normalize_text(line["text"])
    return bool(text) and _alias_match(text)[0] is None and _split_key_value(text) is None


def _standalone_dates(lines: list[dict], fields: dict[str, list[FieldCandidate]]) -> None:
    for line in lines:
        text = normalize_text(line["text"])
        if _DATE_RE.search(text) or _CN_DATE_RE.search(text):
            if any(line["line_id"] in item.evidence.line_ids for item in fields.get("manufacture_date", [])):
                continue
            # A naked date is a candidate, not a confirmed manufacture date.
            _append(fields, "manufacture_date", text, float(line["confidence"]) * 0.8, line, "candidate")


def _fallback_identifiers(lines: list[dict], fields: dict[str, list[FieldCandidate]]) -> None:
    """Recover codes when a 90/270-degree photo loses REF or LOT glyphs."""

    line_by_id = {line["line_id"]: line for line in lines}
    reference_values = fields.get("reference_number", [])
    model_values = fields.get("model", [])
    if not reference_values or (model_values and not any(item.value_normalized in {model.value_normalized for model in model_values} for item in reference_values)):
        if model_values:
            fields["reference_number"] = [item for item in reference_values if not (item.value_normalized.isdigit() and len(item.value_normalized) < 4)]
    if not fields.get("reference_number"):
        for model in fields.get("model", []):
            source = next((line_by_id[line_id] for line_id in model.evidence.line_ids if line_id in line_by_id), None)
            if source and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ./_-]{3,}", model.value_raw):
                _append(fields, "reference_number", model.value_raw, model.confidence * 0.9, source, "candidate")
                break

    if not fields.get("revision"):
        revision_lines: list[tuple[float, dict, re.Match[str]]] = []
        known_codes = {
            item.value_normalized
            for field_name in ("reference_number", "model")
            for item in fields.get(field_name, [])
        }
        for line in lines:
            text = normalize_text(line["text"])
            revision = _REV_RE.search(text)
            if not revision:
                continue
            score = float(line["confidence"])
            if any(code and code in text for code in known_codes):
                score += 0.25
            revision_lines.append((score, line, revision))
        if revision_lines:
            _, line, revision = max(revision_lines, key=lambda item: item[0])
            _append(fields, "revision", revision.group(1), float(line["confidence"]) * 0.85, line, "candidate")

    lot_values = fields.get("lot_number", [])
    valid_lot_values = [item for item in lot_values if not (item.value_normalized.isdigit() and len(item.value_normalized) < 4)]
    fields["lot_number"] = valid_lot_values
    if not fields.get("lot_number"):
        known_codes = {
            item.value_normalized
            for field_name in ("reference_number", "model", "specification")
            for item in fields.get(field_name, [])
        }
        numeric_lines = [
            line
            for line in lines
            if re.fullmatch(r"\d{5,8}", normalize_text(line["text"]))
            and normalize_text(line["text"]) not in known_codes
        ]
        if numeric_lines:
            best = max(numeric_lines, key=lambda line: float(line["confidence"]))
            _append(fields, "lot_number", best["text"], float(best["confidence"]) * 0.75, best, "candidate")


def extract_fields(lines: Iterable[dict]) -> ExtractedFields:
    ordered = sorted((dict(line) for line in lines), key=_line_sort_key)
    fields: dict[str, list[FieldCandidate]] = defaultdict(list)
    key_values: list[GenericKeyValue] = []
    pending: list[tuple[str, str, dict]] = []

    for index, line in enumerate(ordered):
        text = normalize_text(line["text"])
        if not text:
            continue
        split = _split_key_value(text)
        if split:
            key, value = split
            field, _ = _alias_match(key)
            if field:
                _append(fields, field, value, float(line["confidence"]), line)
                revision = _REV_RE.search(value)
                if revision:
                    _append(fields, "revision", revision.group(1), float(line["confidence"]) * 0.95, line)
            else:
                key_values.append(_generic_key_value(key, value, line))
            continue

        field, inline_value = _alias_match(text)
        if field and inline_value:
            revision = _REV_RE.search(inline_value)
            value = inline_value[: revision.start()].strip() if revision else inline_value
            _append(fields, field, value, float(line["confidence"]), line)
            if revision:
                _append(fields, "revision", revision.group(1), float(line["confidence"]) * 0.95, line)
            continue
        if field:
            pending.append((field, text, line))
            continue

        # Labels such as REF 011518 and LOT 54711 often have no delimiter.
        for alias, alias_field in _ALIASES:
            match = re.match(rf"^{re.escape(alias)}\b[\s.:-]*(.+)$", text, re.IGNORECASE)
            if match:
                _append(fields, alias_field, match.group(1), float(line["confidence"]), line)
                revision = _REV_RE.search(match.group(1))
                if revision:
                    _append(fields, "revision", revision.group(1), float(line["confidence"]) * 0.95, line)
                break
        else:
            # Unknown colon-free text is retained as OCR evidence. A large
            # title-like line is a low-risk product-name candidate.
            letter_count = sum(char.isalpha() or "\u4e00" <= char <= "\u9fff" for char in text)
            digit_count = sum(char.isdigit() for char in text)
            lower_text = text.lower()
            if not _URL_RE.search(text) and not any(term in lower_text for term in _NON_PRODUCT_TITLE_TERMS) and len(text) >= 4 and letter_count >= 4 and digit_count <= max(6, letter_count * 2) and not text[0].isdigit() and not _DATE_RE.search(text) and not _CN_DATE_RE.search(text) and float(line.get("height", 0.0)) >= float(line.get("median_height", 0.0)) * 1.2:
                if len(text.split()) == 1 and text.isascii() and text.isalpha() and float(line.get("height", 0.0)) >= float(line.get("median_height", 0.0)) * 2.0:
                    _append(fields, "brand", text, float(line["confidence"]) * 0.78, line, "candidate")
                else:
                    _append(fields, "product_name", text, float(line["confidence"]) * 0.82, line, "candidate")

    used_value_line_ids: set[str] = set()
    for field, _, marker in pending:
        marker_center_x = sum(float(point[0]) for point in marker["polygon"]) / len(marker["polygon"])
        marker_center_y = sum(float(point[1]) for point in marker["polygon"]) / len(marker["polygon"])
        marker_height = float(marker.get("height", 20.0))
        candidates: list[tuple[float, dict]] = []
        for candidate_line in ordered:
            if marker.get("label_id") and candidate_line.get("label_id") != marker.get("label_id"):
                continue
            if candidate_line is marker or candidate_line["line_id"] == marker["line_id"] or candidate_line["line_id"] in used_value_line_ids:
                continue
            value = normalize_text(candidate_line["text"])
            if not value or _alias_match(value)[0] is not None:
                continue
            center_x = sum(float(point[0]) for point in candidate_line["polygon"]) / len(candidate_line["polygon"])
            center_y = sum(float(point[1]) for point in candidate_line["polygon"]) / len(candidate_line["polygon"])
            distance_y = abs(center_y - marker_center_y)
            if distance_y > max(4.0 * marker_height, 100.0):
                continue
            direction_penalty = 0.0 if center_y <= marker_center_y + marker_height * 0.5 else 18.0
            candidates.append((distance_y + 0.25 * abs(center_x - marker_center_x) + direction_penalty, candidate_line))
        if candidates:
            _, candidate_line = min(candidates, key=lambda item: item[0])
            value_lines = [candidate_line]
            used_value_line_ids.add(candidate_line["line_id"])
            first_x, first_y = _line_center(candidate_line)
            first_height = float(candidate_line.get("height", marker_height))
            # A key-only line may be followed by a wrapped value.  Consume
            # only tightly adjacent, same-label, non-key lines so an
            # arbitrary label layout does not turn into a template rule.
            if field in {"product_name", "manufacturer", "model", "specification"}:
                for continuation in ordered:
                    if continuation["line_id"] in used_value_line_ids or continuation is marker:
                        continue
                    if marker.get("label_id") and continuation.get("label_id") != marker.get("label_id"):
                        continue
                    if not _is_continuation_line(continuation):
                        continue
                    next_x, next_y = _line_center(continuation)
                    vertical_gap = next_y - first_y
                    if vertical_gap < -0.4 * first_height or vertical_gap > 1.8 * max(first_height, float(continuation.get("height", first_height))):
                        continue
                    if abs(next_x - first_x) > 12.0 * max(first_height, 8.0):
                        continue
                    value_lines.append(continuation)
                    used_value_line_ids.add(continuation["line_id"])
                    first_x, first_y = next_x, next_y
                    first_height = float(continuation.get("height", first_height))
            value = " ".join(normalize_text(item["text"]) for item in value_lines)
            revision = _REV_RE.search(value)
            clean_value = value[: revision.start()].strip() if revision else value
            _append(fields, field, clean_value, float(marker["confidence"]) * float(candidate_line["confidence"]), candidate_line)
            if revision:
                _append(fields, "revision", revision.group(1), float(marker["confidence"]) * 0.95, candidate_line)

    _standalone_dates(ordered, fields)
    _fallback_identifiers(ordered, fields)
    _merge_candidates(fields)
    search_terms = build_search_terms(fields)
    return ExtractedFields(dict(fields), key_values, search_terms)


def build_search_terms(fields: dict[str, list[FieldCandidate]]) -> list[SearchTerm]:
    priorities = {
        "reference_number": 1,
        "model": 2,
        "specification": 3,
        "product_name": 4,
        "brand": 5,
        "manufacturer": 6,
        "registration_number": 7,
    }
    terms: list[SearchTerm] = []
    seen: set[str] = set()
    for field, priority in priorities.items():
        for candidate in fields.get(field, []):
            if candidate.status == "ambiguous" or candidate.confidence < 0.45:
                continue
            normalized = candidate.value_normalized
            if not normalized or normalized.lower() in seen:
                continue
            seen.add(normalized.lower())
            kind = "reference" if field == "reference_number" else ("registration" if field == "registration_number" else field)
            terms.append(
                SearchTerm(
                    value=candidate.value_raw,
                    normalized=normalized,
                    kind=kind,  # type: ignore[arg-type]
                    priority=priority,
                    confidence=candidate.confidence,
                )
            )
    return terms
