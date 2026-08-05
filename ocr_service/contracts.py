from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


MediaType = Literal["image/jpeg", "image/png", "image/webp"]
ExtractionStatus = Literal["ok", "partial", "reshoot_required"]
FieldStatus = Literal["confirmed", "candidate", "ambiguous"]


class ExtractRequest(BaseModel):
    """Transport contract shared by the public proxy and OCR service."""

    # Keep this as a string at the transport boundary so the service can map
    # an unsupported MIME to HTTP 415 instead of Pydantic's generic 422.
    media_type: str = Field(min_length=1, max_length=100)
    image_base64: str = Field(min_length=16)

    @field_validator("image_base64")
    @classmethod
    def reject_data_uri_and_whitespace(cls, value: str) -> str:
        if value.startswith("data:"):
            raise ValueError("image_base64 must not contain a data URI prefix")
        if any(ch.isspace() for ch in value):
            raise ValueError("image_base64 must be RFC 4648 base64 without whitespace")
        return value


class ImageInfo(BaseModel):
    media_type: MediaType
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class LineResult(BaseModel):
    line_id: str
    text: str
    normalized_text: str
    confidence: float = Field(ge=0.0, le=1.0)
    polygon: list[list[float]] = Field(min_length=4, max_length=4)
    label_id: str | None = None
    source_variant: Literal["raw", "deskew", "perspective", "enhanced"] = "raw"


class Evidence(BaseModel):
    label_ids: list[str] = Field(default_factory=list)
    line_ids: list[str] = Field(default_factory=list)


class FieldCandidate(BaseModel):
    value_raw: str
    value_normalized: str
    language: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    status: FieldStatus
    # Kept at the candidate level so ERP clients do not need to unpack the
    # evidence object.  ``evidence`` remains for backwards-compatible detail.
    label_ids: list[str] = Field(default_factory=list)
    line_ids: list[str] = Field(default_factory=list)
    evidence: Evidence = Field(default_factory=Evidence)


class LabelResult(BaseModel):
    label_id: str
    polygon: list[list[float]] = Field(min_length=4, max_length=4)
    line_ids: list[str] = Field(default_factory=list)
    rotation_degrees: float
    correction_applied: bool = False


class GenericKeyValue(BaseModel):
    key_raw: str
    key_normalized: str
    value_raw: str
    value_normalized: str
    confidence: float = Field(ge=0.0, le=1.0)
    evidence: Evidence = Field(default_factory=Evidence)


class SearchTerm(BaseModel):
    value: str
    normalized: str
    kind: Literal["reference", "model", "specification", "product_name", "brand", "manufacturer", "registration"]
    priority: int = Field(ge=1, le=100)
    confidence: float = Field(ge=0.0, le=1.0)


class Diagnostics(BaseModel):
    engine: str
    timings_ms: dict[str, float] = Field(default_factory=dict)
    median_text_height_px: float | None = None
    mean_line_confidence: float | None = None


class ExtractResponse(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    request_id: str
    status: ExtractionStatus
    image: ImageInfo
    raw_text: str
    lines: list[LineResult] = Field(default_factory=list)
    labels: list[LabelResult] = Field(default_factory=list)
    fields: dict[str, list[FieldCandidate]] = Field(default_factory=dict)
    key_values: list[GenericKeyValue] = Field(default_factory=list)
    search_terms: list[SearchTerm] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    diagnostics: Diagnostics
