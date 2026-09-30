"""验证 Python 网关实际构造的请求，不启动 HTTP 服务或访问数据库。"""

from __future__ import annotations

import io
import unittest
from email.message import Message
from types import SimpleNamespace
from unittest.mock import Mock, patch

try:
    from fastapi import HTTPException
    from starlette.requests import Request
except ImportError:
    HTTPException = Request = None

if HTTPException is not None:
    from api.main import _require_same_origin
    from web import serve


@unittest.skipUnless(HTTPException is not None, "缺少 FastAPI/Starlette，请先安装后端依赖")
class GatewayProxyTests(unittest.TestCase):
    def proxy_request(self, path, host, origin):
        handler = object.__new__(serve.Handler)
        handler.path = path
        handler.command = "POST"
        handler.headers = Message()
        payload = b'{"username":"admin","password":"test"}'
        for key, value in {
            "Host": host, "Origin": origin, "Content-Type": "application/json",
            "Content-Length": str(len(payload)), "Connection": "keep-alive",
            "Cookie": "erp_csrf=test", "X-CSRF-Token": "test",
        }.items():
            handler.headers[key] = value
        handler.rfile = io.BytesIO(payload)
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        response_headers = Message()
        response_headers["Content-Type"] = "application/json"
        response_headers["Set-Cookie"] = "erp_session=one; HttpOnly"
        response_headers["Set-Cookie"] = "erp_csrf=two"
        response = SimpleNamespace(status=200, headers=response_headers, read=lambda: b'{"ok":true}')
        with patch.object(serve.urllib.request, "urlopen", return_value=response) as upstream:
            handler._proxy()
        return upstream.call_args.args[0], handler

    def api_request(self, proxied):
        return Request({
            "type": "http", "method": "POST", "path": "/api/auth/login",
            "headers": [(key.lower().encode(), value.encode()) for key, value in proxied.header_items()],
        })

    def test_public_host_and_port_survive_proxy_and_pass_origin_check(self):
        for path in ("/api/auth/login", "/erp/api/auth/login"):
            for host in ("erp.example.com", "erp.example.com:8443", "[::1]:18080"):
                with self.subTest(path=path, host=host):
                    proxied, _handler = self.proxy_request(path, host, f"https://{host}")
                    headers = {key.lower(): value for key, value in proxied.header_items()}
                    self.assertEqual(headers["host"], host)
                    self.assertEqual(proxied.full_url, f"{serve.API_ORIGIN}/api/auth/login")
                    self.assertEqual(headers["cookie"], "erp_csrf=test")
                    self.assertEqual(headers["x-csrf-token"], "test")
                    self.assertNotIn("connection", headers)
                    _require_same_origin(self.api_request(proxied))

    def test_cross_site_origin_still_returns_403(self):
        proxied, _handler = self.proxy_request("/api/auth/login", "erp.example.com:8443", "https://other.example.com:8443")
        with self.assertRaises(HTTPException) as rejected:
            _require_same_origin(self.api_request(proxied))
        self.assertEqual(rejected.exception.status_code, 403)

    def test_health_route_and_login_cookies_are_preserved(self):
        proxied, handler = self.proxy_request("/erp/api/healthz", "erp.example.com:8443", "https://erp.example.com:8443")
        self.assertEqual(proxied.full_url, f"{serve.API_ORIGIN}/healthz")
        cookies = [call.args[1] for call in handler.send_header.call_args_list if call.args[0].lower() == "set-cookie"]
        self.assertEqual(cookies, ["erp_session=one; HttpOnly", "erp_csrf=two"])
        for key, value in serve._SECURITY_HEADERS.items():
            handler.send_header.assert_any_call(key, value)


if __name__ == "__main__":
    unittest.main()
