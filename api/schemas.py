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
    lines: list[RequestLineIn] = Field(min_length=1)


class ProductIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=500)
    manufacturer: str | None = None
    specification: str | None = None
    source_uom_raw: str | None = "个"
    default_uom_id: int | None = None


class UserCreateIn(BaseModel):
    username: str = Field(min_length=3, max_length=100)
    display_name: str = Field(min_length=1, max_length=200)
    role: str
    password: str = Field(min_length=8, max_length=200)


class LocationIn(BaseModel):
    code: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    location_type: str = "warehouse"
    is_company_inventory: bool = True


class StockRequestPatch(BaseModel):
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
