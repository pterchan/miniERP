"""MinIO (S3-compatible) object storage client.

The product-image feature stores image bytes in MinIO and keeps only metadata
in PostgreSQL. MinIO stays internal (never exposed to browsers); the API is the
only caller, so no presigned URLs or CORS are needed.

Config via env:
  MINIO_ENDPOINT   host:port of the MinIO data endpoint (default minio:9000)
  MINIO_ACCESS_KEY access key (also MinIO_ROOT_USER on the server side)
  MINIO_SECRET_KEY secret key (also MinIO_ROOT_PASSWORD on the server side)
  MINIO_BUCKET     bucket name (default erp-product-images)
  MINIO_SECURE     "1" to use https (default 0, internal HTTP)
"""

from __future__ import annotations

import os

from minio import Minio


_client: Minio | None = None


def get_client() -> Minio:
    """Lazily build and cache the Minio client from environment variables.

    密钥缺失时直接抛错而不是回退公开已知的 minioadmin——后者等于把对象存储
    敞开给任何内网调用方。
    """
    global _client
    if _client is None:
        endpoint = os.environ.get("MINIO_ENDPOINT", "minio:9000")
        access_key = os.environ.get("MINIO_ACCESS_KEY")
        secret_key = os.environ.get("MINIO_SECRET_KEY")
        secure = os.environ.get("MINIO_SECURE", "0") == "1"
        if not access_key or not secret_key:
            raise RuntimeError("MINIO_ACCESS_KEY/MINIO_SECRET_KEY 未配置；拒绝使用默认凭据连接对象存储")
        _client = Minio(endpoint, access_key=access_key, secret_key=secret_key, secure=secure)
    return _client


def bucket_name() -> str:
    return os.environ.get("MINIO_BUCKET", "erp-product-images")


def ensure_bucket() -> None:
    """Create the bucket if it does not exist yet. Idempotent."""
    client = get_client()
    bucket = bucket_name()
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)
