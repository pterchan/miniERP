from __future__ import annotations

from decimal import Decimal
from pydantic import BaseModel, Field, field_validator


class LoginIn(BaseModel):
    username: str
    password: str


class RequestLineIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    uom_id: int | None = None
    uom_code: str | None = None
    condition_id: int | None = None
    source_uom_raw: str | None = "个"
    source_location_id: int | None = None
    destination_location_id: int | None = None
    notes: str | None = None


class StockRequestIn(BaseModel):
    request_type: str
    source_location_id: int | None = None
    destination_location_id: int | None = None
    reason: str | None = None
    # Drafts may be created before the requester has selected a product.
    # Submission performs the at-least-one-valid-line check server-side.
    lines: list[RequestLineIn] = Field(default_factory=list)


class ProductIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=500)
    manufacturer: str | None = None
    specification: str | None = None
    source_uom_raw: str | None = "个"
    default_uom_id: int | None = None
    primary_identifier: str | None = None


class ProductCreateIn(ProductIn):
    """Payload for creating a product and (optionally) its primary identifier."""


class ProductUpdateIn(BaseModel):
    """All fields are optional so omitted values never silently reset units."""

    display_name: str | None = Field(default=None, min_length=1, max_length=500)
    manufacturer: str | None = None
    specification: str | None = None
    source_uom_raw: str | None = None
    default_uom_id: int | None = None
    primary_identifier: str | None = None


class UserCreateIn(BaseModel):
    username: str = Field(min_length=3, max_length=100)
    display_name: str = Field(min_length=1, max_length=200)
    role: str
    password: str = Field(min_length=8, max_length=200)


class UserUpdateIn(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    role: str | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=200)


class LocationIn(BaseModel):
    code: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    location_type: str = "warehouse"
    is_company_inventory: bool = True


class LocationUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    location_type: str | None = None
    is_company_inventory: bool | None = None
    is_active: bool | None = None


class StockRequestPatch(BaseModel):
    version: int = Field(gt=0)
    source_location_id: int | None = None
    destination_location_id: int | None = None
    reason: str | None = None
    lines: list[RequestLineIn] | None = None


class RejectIn(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


class ConflictResolveIn(BaseModel):
    resolution_notes: str = Field(min_length=1, max_length=2000)


class OCRExtractIn(BaseModel):
    # The OCR service owns MIME validation so unsupported values map to 415.
    media_type: str = Field(min_length=1, max_length=100)
    image_base64: str = Field(min_length=16)

    @field_validator("image_base64")
    @classmethod
    def validate_raw_base64(cls, value: str) -> str:
        if value.startswith("data:") or any(char.isspace() for char in value):
            raise ValueError("image_base64 必须是无空白的原始 Base64")
        return value
