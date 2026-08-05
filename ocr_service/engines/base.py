from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class OCRLine:
    text: str
    confidence: float
    polygon: list[list[float]]


@dataclass(frozen=True)
class OCRRawResult:
    lines: list[OCRLine]
    elapsed_seconds: float
    engine_name: str


class OCRBackend(Protocol):
    name: str

    def recognize(self, image: object) -> OCRRawResult:
        ...
