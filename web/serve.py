"""Small dependency-free static server and same-origin API reverse proxy."""

from __future__ import annotations

import http.server
import os
import urllib.error
import urllib.request
from pathlib import Path


API_ORIGIN = os.getenv("WEB_API_ORIGIN", "http://api:8000")
DIST = Path(os.getenv("WEB_DIST", "/app/dist")).resolve()
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "InventoryERPWeb/0.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def _is_api(self) -> bool:
        return self.path == "/api" or self.path.startswith("/api/")

    def _proxy(self) -> None:
        body = None
        length = self.headers.get("Content-Length")
        if length:
            body = self.rfile.read(int(length))
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in {"host", "content-length", *HOP_BY_HOP}
        }
        upstream_path = "/healthz" if self.path == "/api/healthz" else self.path
        request = urllib.request.Request(
            f"{API_ORIGIN}{upstream_path}", data=body, headers=headers, method=self.command
        )
        try:
            response = urllib.request.urlopen(request, timeout=30)
            status, response_headers, payload = response.status, response.headers, response.read()
        except urllib.error.HTTPError as exc:
            status, response_headers, payload = exc.code, exc.headers, exc.read()
        except Exception as exc:  # pragma: no cover - only on network failure
            self.send_error(502, f"API proxy unavailable: {exc}")
            return

        self.send_response(status)
        for key, value in response_headers.items():
            if key.lower() not in HOP_BY_HOP:
                self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _serve_static(self) -> None:
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
    port = int(os.getenv("WEB_PORT_INTERNAL", "80"))
    http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
