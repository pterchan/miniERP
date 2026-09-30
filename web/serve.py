"""Small dependency-free static server and same-origin API reverse proxy."""

from __future__ import annotations

import gzip
import http.server
import io
import os
import urllib.error
import urllib.request
from pathlib import Path


API_ORIGIN = os.getenv("WEB_API_ORIGIN", "http://api:8000")
DIST = Path(os.getenv("WEB_DIST", "/app/dist")).resolve()
MAX_PROXY_BODY = 25 * 1024 * 1024
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}
_GZIP_TYPES = {
    "text/css", "text/javascript", "application/javascript", "application/json",
    "image/svg+xml", "text/html", "text/plain",
}
_ASSET_CACHE = "public, max-age=31536000, immutable"
# 统一安全响应头：与两份 nginx 配置保持一致（网关契约）
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
}
_PROXY_TIMEOUT = int(os.getenv("WEB_PROXY_TIMEOUT_SECONDS", "60"))


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "InventoryERPWeb/0.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def _app_path(self) -> str:
        """Strip the public /erp prefix for direct high-port inspection.

        The host Nginx normally strips this prefix before the request reaches
        the container, but keeping the fallback here makes the published
        18080 endpoint self-contained and easier to diagnose.
        """
        clean = self.path.split("?", 1)[0]
        suffix = self.path[len(clean):]
        if clean == "/erp":
            return "/" + suffix
        if clean.startswith("/erp/"):
            return clean[4:] + suffix
        return self.path

    def _is_api(self) -> bool:
        path = self._app_path()
        return path == "/api" or path.startswith("/api/")

    def _proxy(self) -> None:
        body = None
        length = self.headers.get("Content-Length")
        if length:
            if int(length) > MAX_PROXY_BODY:
                self.send_error(413, "request body too large")
                return
            body = self.rfile.read(int(length))
        # 保留浏览器的 Host（包括公开端口），使 API 的同源校验与 Nginx 一致。
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in {"content-length", *HOP_BY_HOP}
        }
        app_path = self._app_path()
        upstream_path = "/healthz" if app_path == "/api/healthz" else app_path
        request = urllib.request.Request(
            f"{API_ORIGIN}{upstream_path}", data=body, headers=headers, method=self.command
        )
        try:
            response = urllib.request.urlopen(request, timeout=_PROXY_TIMEOUT)
            status, response_headers, payload = response.status, response.headers, response.read()
        except urllib.error.HTTPError as exc:
            status, response_headers, payload = exc.code, exc.headers, exc.read()
        except Exception as exc:  # pragma: no cover - only on network failure
            self.send_error(502, f"API proxy unavailable: {exc}")
            return

        self.send_response(status)
        ct = response_headers.get("Content-Type", "")
        want_gzip = (
            self.command != "HEAD"
            and "gzip" in (self.headers.get("Accept-Encoding") or "")
            and not response_headers.get("Content-Encoding")
            and (ct.startswith("text/") or "json" in ct)
            and len(payload) >= 1024
        )
        if want_gzip:
            payload = gzip.compress(payload, 9)
        for key, value in response_headers.items():
            if key.lower() in HOP_BY_HOP:
                continue
            if key.lower() == "content-length" and want_gzip:
                continue  # 压缩后由下方重发
            self.send_header(key, value)
        if want_gzip:
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Cache-Control", "no-cache")
        for key, value in _SECURITY_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_head(self):
        """静态响应：/assets/* 哈希资源打 immutable 长缓存；文本资源按
        Accept-Encoding gzip（HEAD 同样带正确头部，body 不写出）。
        非文件路径（含目录）不落入父类的目录列表，按 SPA 回退 index.html；
        index.html 自身缺失则交父类返回 404，避免无限递归。"""
        clean = self.path.split("?", 1)[0]
        path = self.translate_path(clean)
        if not os.path.isfile(path):
            if clean == "/index.html":
                return super().send_head()
            self.path = "/index.html"
            return self.send_head()
        ctype = self.guess_type(path)
        with open(path, "rb") as fh:
            data = fh.read()
        cache = _ASSET_CACHE if clean.startswith("/assets/") else "no-cache"
        accept_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
        compressible = accept_gzip and ctype in _GZIP_TYPES and len(data) >= 1024
        if compressible:
            data = gzip.compress(data, 9)
        self.send_response(200)
        self.send_header("Content-type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        for key, value in _SECURITY_HEADERS.items():
            self.send_header(key, value)
        if compressible:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        return io.BytesIO(data)

    def _serve_static(self) -> None:
        self.path = self._app_path()
        candidate = DIST / self.path.split("?", 1)[0].lstrip("/")
        if not candidate.is_file():
            self.path = "/index.html"
        super().do_GET() if self.command == "GET" else super().do_HEAD()

    def do_GET(self) -> None:  # noqa: N802
        self._proxy() if self._is_api() else self._serve_static()

    def do_HEAD(self) -> None:  # noqa: N802
        self._proxy() if self._is_api() else self._serve_static()

    def do_POST(self) -> None:  # noqa: N802
        self._proxy() if self._is_api() else self.send_error(405)

    def do_PUT(self) -> None:  # noqa: N802
        self._proxy() if self._is_api() else self.send_error(405)

    def do_PATCH(self) -> None:  # noqa: N802
        self._proxy() if self._is_api() else self.send_error(405)

    def do_DELETE(self) -> None:  # noqa: N802
        self._proxy() if self._is_api() else self.send_error(405)


if __name__ == "__main__":
    port = int(os.getenv("WEB_PORT_INTERNAL", "8080"))
    http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
