# Offline product-label OCR service

This service is intentionally independent from the ERP database. It accepts a
strict JSON Base64 image request and returns line-level OCR evidence, detected
label regions, generic key/value pairs, canonical product fields, and ranked
search terms.

The default backend is RapidOCR 3.9.2 with PP-OCRv6 small and ONNX Runtime.
Models are loaded at startup and the container is expected to run without
network access after the image is built.

Endpoints:

- `GET /healthz`: process liveness.
- `GET /readyz`: model readiness.
- `POST /v1/extract`: OCR extraction. `OCR_INTERNAL_TOKEN` is required and the
  caller must send the matching `X-Internal-Token` header.

The service never writes source images or OCR text to disk. See
`ocr_service/contracts.py` for the versioned response contract.

Design notes
------------

- The detector clusters independent text regions, so the parser does not
  assume the sample vendor sample layout.  Alias definitions live in
  `field_aliases.json`; unknown colon key/value pairs and every OCR line are
  retained as evidence.
- Numbers stay strings (including leading zeroes).  Dates are normalized only
  when an unambiguous date pattern is present.  Conflicting candidates are
  returned with `ambiguous` status rather than guessed substitutions.
- Low-confidence regions may be retried with local deskew, perspective, and
  grayscale/contrast candidates.  The raw result wins unless a candidate
  improves confidence, and no more than two candidates are retried per label.
- `GET /readyz` is false until all wheel-bundled models are present.  The
  image build and `MODEL_MANIFEST.txt` provide the pinned model checksums;
  runtime does not download anything.

The initial engine is intentionally CPU-only RapidOCR.  Full PaddleOCR with
UVDoc is a possible later replacement, but is not a runtime dependency of this
POC.  Tesseract's page layout handling was not sufficient for the photographed
labels, while EasyOCR, docTR, and MMOCR would add a heavier training/runtime
stack without a demonstrated POC gain.  The ERP endpoint is only an
authenticated/CSRF-protected thin proxy and does not perform product matching
or write scan history.
