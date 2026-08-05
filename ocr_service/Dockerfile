FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    MKL_NUM_THREADS=2

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY ocr_service/requirements.txt /app/ocr_service/requirements.txt
RUN pip install --no-cache-dir -r /app/ocr_service/requirements.txt
COPY ocr_service /app/ocr_service

# The default RapidOCR wheel contains the PP-OCRv6 small models. Loading them
# while building the image makes a missing model fail before deployment.
RUN python -c "from ocr_service.engines.rapidocr import RapidOCRBackend; RapidOCRBackend()"

EXPOSE 8010
CMD ["uvicorn", "ocr_service.app:app", "--host", "0.0.0.0", "--port", "8010", "--workers", "1"]
