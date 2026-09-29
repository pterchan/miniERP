"""FastAPI TestClient 封装：登录、会话 cookie 与 CSRF 双提交头。

不进入 TestClient 上下文管理器，从而不触发 startup 事件
（bootstrap 用户由 testdb 直接创建，MinIO 探测也不应拖慢测试）。
"""

from __future__ import annotations

from typing import Any

from .testdb import TEST_PASSWORD


def make_client() -> Any:
    # 惰性导入：无 fastapi 的最小环境下模块仍可导入，测试类由 DbTestCase 跳过。
    from fastapi.testclient import TestClient

    from api.main import app

    return TestClient(app)


class Api:
    """单一身份的 API 客户端；login() 后自动携带会话 cookie 与 CSRF 头。"""

    def __init__(self, client: Any):
        self.client = client
        self.csrf_token: str | None = None
        self.user: dict[str, Any] | None = None

    def login(self, username: str, password: str = TEST_PASSWORD) -> "Api":
        response = self.client.post("/api/auth/login", json={"username": username, "password": password})
        if response.status_code != 200:
            raise AssertionError(f"测试用户登录失败: {username} HTTP {response.status_code} {response.text}")
        self.csrf_token = self.client.cookies.get("erp_csrf")
        self.user = response.json()
        return self

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", None) or {})
        if method.upper() not in ("GET", "HEAD", "OPTIONS") and self.csrf_token:
            headers.setdefault("X-CSRF-Token", self.csrf_token)
        return self.client.request(method, path, headers=headers, **kwargs)

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.request("GET", path, **kwargs)

    def post(self, path: str, **kwargs: Any) -> Any:
        return self.request("POST", path, **kwargs)

    def put(self, path: str, **kwargs: Any) -> Any:
        return self.request("PUT", path, **kwargs)

    def delete(self, path: str, **kwargs: Any) -> Any:
        return self.request("DELETE", path, **kwargs)


def api_for(username: str, password: str = TEST_PASSWORD) -> Api:
    """创建独立 cookie 会话并登录指定测试用户。"""
    return Api(make_client()).login(username, password)
