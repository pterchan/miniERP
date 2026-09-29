# Third-party notices

miniERP uses third-party packages whose licenses are declared by their package
metadata and dependency manifests（requirements.txt / api/requirements.txt /
ocr_service/requirements.txt / web/package.json）. Refer to each upstream
project for its full license text and notices.

## 编排与基础镜像（docker-compose.yml）

| 组件 | 许可证 | 来源 |
|---|---|---|
| PostgreSQL（postgres:16 镜像） | PostgreSQL Licence | https://www.postgresql.org |
| MinIO（minio/minio 镜像） | **GNU AGPLv3** | https://github.com/minio/minio |
| Docker 官方 python/nginx/node 基础镜像 | 各自上游许可 | https://hub.docker.com |

> MinIO 以 AGPLv3 提供。若仅按 docker-compose.yml 原样自托管使用，一般无需额外义务；
> 修改或再分发 MinIO 本身、或将其作为服务提供给第三方时，须遵守 AGPLv3 条款。
> 生产部署建议通过 `MINIO_IMAGE` 固定具体版本，避免 `latest` 漂移。

## Python 依赖（api/requirements.txt、requirements.txt）

| 组件 | 许可证 |
|---|---|
| FastAPI / Starlette | MIT / BSD-3-Clause |
| Pydantic | MIT |
| Uvicorn | BSD-3-Clause |
| psycopg2 | LGPL-3.0 |
| argon2-cffi | MIT |
| cryptography | Apache-2.0 / OpenSSL 双许可（含 OpenSSL 与 NSS 随附许可） |
| openpyxl | MIT |
| httpx | BSD-3-Clause |
| MinIO Python SDK | Apache-2.0 |
| python-multipart | Apache-2.0 |
| Pillow | HPND（Historical Permission Notice and Disclaimer） |

## OCR 容器（ocr_service/requirements.txt 与内置模型）

- RapidOCR 3.9.2: Apache License 2.0. Source: https://github.com/RapidAI/RapidOCR
- PP-OCRv6 models distributed with RapidOCR: Apache License 2.0. Source: https://github.com/PaddlePaddle/PaddleOCR
- ONNX Runtime 1.28.0: MIT License. Source: https://github.com/microsoft/onnxruntime
- OpenCV（opencv-python-headless，经 RapidOCR 传递引入）: Apache License 2.0. Source: https://github.com/opencv/opencv

The model names and checksums used by the OCR image are documented in
ocr_service/MODEL_MANIFEST.txt.

## 前端（web/package.json）

| 组件 | 许可证 |
|---|---|
| React | MIT |
| Vite | MIT |
| @vitejs/plugin-react | MIT |
| Vitest | MIT |
| @testing-library/react、@testing-library/jest-dom | MIT |
| jsdom | MIT |
| heic2any | MIT |
