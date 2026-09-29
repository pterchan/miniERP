from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator, model_validator

ROLE_VALUES = ("ADMIN", "WAREHOUSE", "SALES", "FINANCE", "COLLEAGUE")


def _validate_role(value: str) -> str:
    if value not in ROLE_VALUES:
        raise ValueError("角色无效")
    return value


def _qty_scale(value: Decimal) -> Decimal:
    if abs(value) >= Decimal("10") ** 15:
        raise ValueError("数量过大")
    if value.quantize(Decimal("0.001")) != value:
        raise ValueError("数量最多支持 3 位小数")
    return value


def _money_scale(value: Decimal) -> Decimal:
    if value < 0:
        raise ValueError("金额不能为负")
    if abs(value) >= Decimal("10") ** 15:
        raise ValueError("金额过大")
    if value.quantize(Decimal("0.01")) != value:
        raise ValueError("金额最多支持 2 位小数")
    return value


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

    _q = field_validator("quantity")(_qty_scale)


class StockRequestIn(BaseModel):
    request_type: str
    source_location_id: int | None = None
    destination_location_id: int | None = None
    reason: str | None = None
    # Drafts may be created before the requester has selected a product.
    # Submission performs the at-least-one-valid-line check server-side.
    lines: list[RequestLineIn] = Field(default_factory=list, max_length=2000)


class ProductIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=500)
    manufacturer: str | None = None
    specification: str | None = None
    source_uom_raw: str | None = "个"
    default_uom_id: int | None = None
    primary_identifier: str | None = None
    category_id: int | None = None
    purchase_cost_price: Decimal | None = None
    sales_price: Decimal | None = None
    serialized: bool | None = None

    @field_validator("purchase_cost_price", "sales_price")
    @classmethod
    def _product_price(cls, value: Decimal | None) -> Decimal | None:
        if value is None:
            return None
        return _money_scale(value)


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
    category_id: int | None = None
    purchase_cost_price: Decimal | None = None
    sales_price: Decimal | None = None
    serialized: bool | None = None

    @field_validator("purchase_cost_price", "sales_price")
    @classmethod
    def _product_price(cls, value: Decimal | None) -> Decimal | None:
        if value is None:
            return None
        return _money_scale(value)


class UserCreateIn(BaseModel):
    username: str = Field(min_length=3, max_length=100)
    display_name: str = Field(min_length=1, max_length=200)
    role: str
    password: str = Field(min_length=8, max_length=200)

    @field_validator("role")
    @classmethod
    def _role(cls, value: str) -> str:
        return _validate_role(value)


class UserUpdateIn(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    role: str | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=200)

    @field_validator("role")
    @classmethod
    def _role(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _validate_role(value)


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
    outcome: str = "resolved"

    @field_validator("outcome")
    @classmethod
    def validate_outcome(cls, value: str) -> str:
        if value not in {"resolved", "duplicate", "ignored"}:
            raise ValueError("outcome 必须是 resolved/duplicate/ignored")
        return value


class ConflictLinkIn(BaseModel):
    product_id: int
    resolution_notes: str = Field(min_length=1, max_length=2000)


class ConflictCreateProductIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=500)
    manufacturer: str | None = None
    specification: str | None = None
    source_uom_raw: str | None = None
    default_uom_id: int | None = None
    primary_identifier: str | None = None
    resolution_notes: str = Field(min_length=1, max_length=2000)


class ConflictEditProductIn(BaseModel):
    """Optional product master-data fields; resolution_notes resolves the case."""
    display_name: str | None = Field(default=None, min_length=1, max_length=500)
    manufacturer: str | None = None
    specification: str | None = None
    source_uom_raw: str | None = None
    default_uom_id: int | None = None
    primary_identifier: str | None = None
    resolution_notes: str = Field(min_length=1, max_length=2000)


class InventoryAdjustIn(BaseModel):
    """Override a product's on-hand balance at one location with an ADJUSTMENT."""
    product_id: int
    location_id: int
    condition_id: int | None = None
    uom_id: int
    counted_quantity: Decimal = Field(description="may be negative")
    change_default_unit: bool = False
    source_uom_raw: str | None = None
    notes: str | None = None
    serial_numbers: list[str] | None = Field(default=None, max_length=2000)  # 可选 SN 清单；启用 SN 的货品填了则按件校验

    @field_validator("counted_quantity")
    @classmethod
    def _limit_scale(cls, value: Decimal) -> Decimal:
        if abs(value) >= Decimal("10") ** 15:
            raise ValueError("数量过大")
        if value.quantize(Decimal("0.001")) != value:
            raise ValueError("数量最多支持 3 位小数")
        return value


class UomIn(BaseModel):
    code: str = Field(min_length=1, max_length=40)
    display_name: str = Field(min_length=1, max_length=200)
    decimal_scale: int = Field(default=0, ge=0, le=6)
    is_active: bool = True


class OCRExtractIn(BaseModel):
    # The OCR service owns MIME validation so unsupported values map to 415.
    media_type: str = Field(min_length=1, max_length=100)
    image_base64: str = Field(min_length=16, max_length=20_000_000)  # ~15MB 原图的 base64 长度上限

    @field_validator("image_base64")
    @classmethod
    def validate_raw_base64(cls, value: str) -> str:
        if value.startswith("data:") or any(char.isspace() for char in value):
            raise ValueError("image_base64 必须是无空白的原始 Base64")
        return value


class DocLineIn(BaseModel):
    product_id: int
    quantity: Decimal = Field(gt=0)
    uom_id: int | None = None
    uom_code: str | None = None
    condition_id: int | None = None
    source_location_id: int | None = None
    destination_location_id: int | None = None
    price: Decimal | None = Field(default=None, ge=0)
    counted_quantity: Decimal | None = None  # STOCK_COUNT only
    notes: str | None = None
    serial_numbers: list[str] | None = Field(default=None, max_length=2000)  # 可选 SN 登记；过账时按 (product, SN) 写资产事件

    _q = field_validator("quantity")(_qty_scale)
    _cq = field_validator("counted_quantity")(_qty_scale)

    @field_validator("counted_quantity")
    @classmethod
    def _counted_non_negative(cls, value: Decimal | None) -> Decimal | None:
        if value is not None and value < 0:
            raise ValueError("盘点实盘数不能为负")
        return value
    _p = field_validator("price")(_money_scale)


class DocCreateIn(BaseModel):
    doc_type: str
    party_id: int | None = None
    doc_date: date | None = None
    source_location_id: int | None = None
    destination_location_id: int | None = None
    deposit_amount: Decimal | None = Field(default=None, ge=0)
    notes: str | None = None
    lines: list[DocLineIn] = Field(default_factory=list, max_length=2000)

    _d = field_validator("deposit_amount")(_money_scale)


class DocUpdateIn(BaseModel):
    """All fields are optional + optimistic-lock version, like StockRequestPatch."""
    version: int = Field(gt=0)
    party_id: int | None = None
    doc_date: date | None = None
    source_location_id: int | None = None
    destination_location_id: int | None = None
    deposit_amount: Decimal | None = None
    notes: str | None = None
    lines: list[DocLineIn] | None = None

    _d = field_validator("deposit_amount")(_money_scale)

    @model_validator(mode="after")
    def _reject_explicit_nulls(self) -> "DocUpdateIn":
        # 显式传 null 会击穿 NOT NULL/CHECK 约束变成 500；未传（缺省）不受影响
        for field in ("party_id", "doc_date", "deposit_amount"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} 不允许显式置空；如需修改请提供有效值")
        return self


class DocSubmitIn(BaseModel):
    override_review: bool = False


class SerialParseIn(BaseModel):
    """解析一段 SN 文本并标注登记状态，供出库前预检。纯读取不写库。"""
    product_id: int
    text: str = Field(min_length=1, max_length=20000)


class ImageReorderIn(BaseModel):
    """按目标顺序提交货品全部图片的 image_id 列表，服务端一次性原子重排。"""
    order: list[int] = Field(min_length=1, max_length=500)


class AttachmentIn(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=200)
    size: int = Field(gt=0, le=10 * 1024 * 1024)
    data_base64: str = Field(min_length=16, max_length=14_000_000)  # 10MB 原始数据的 base64 长度上限

    @field_validator("data_base64")
    @classmethod
    def validate_raw_base64(cls, value: str) -> str:
        if value.startswith("data:") or any(char.isspace() for char in value):
            raise ValueError("data_base64 必须是无空白的原始 Base64")
        return value


class ChangePasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    parent_category_id: int | None = None
    sort_order: int = 0
    is_active: bool = True


class CustomerIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    contact_person: str | None = None
    phone: str | None = None
    address: str | None = None
    settlement_method: str = "现结"
    level: str | None = None
    credit_limit: Decimal = Decimal(0)
    notes: str | None = None
    is_active: bool = True

    @field_validator("settlement_method")
    @classmethod
    def _settlement(cls, value: str) -> str:
        if value not in {"现结", "月结"}:
            raise ValueError("结算方式必须是 现结/月结")
        return value

    @field_validator("credit_limit")
    @classmethod
    def _credit(cls, value: Decimal) -> Decimal:
        return _money_scale(value)


class SupplierIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    contact_person: str | None = None
    phone: str | None = None
    address: str | None = None
    settlement_days: int = Field(default=0, ge=0)
    notes: str | None = None
    is_active: bool = True


class PriceTierIn(BaseModel):
    tier_name: str = Field(min_length=1, max_length=100)
    min_quantity: Decimal = Decimal(0)
    price: Decimal

    @field_validator("min_quantity")
    @classmethod
    def _min_qty(cls, value: Decimal) -> Decimal:
        return _qty_scale(value)

    @field_validator("price")
    @classmethod
    def _price(cls, value: Decimal) -> Decimal:
        return _money_scale(value)


class DepartmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    sort_order: int = 0
    is_active: bool = True


class ImageUpdateIn(BaseModel):
    """Update metadata of a product image (sort order / filename)."""
    sort_order: int | None = Field(default=None, ge=0)
    filename: str | None = Field(default=None, min_length=1, max_length=255)
