"""行为测试地基冒烟：登录、CSRF 双提交、healthz。

依赖一次性 Docker 测试库（docker-compose.test.yml）；库不可达时整类跳过。
这组测试同时是后续所有 R-F-V 行为测试的地基自验。
"""

from __future__ import annotations

import unittest

from tests.support.api_client import Api, make_client
from tests.support.testdb import DbTestCase


class HealthzSmokeTests(DbTestCase):
    def test_healthz_returns_ok(self) -> None:
        response = make_client().get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})


class LoginSmokeTests(DbTestCase):
    def test_login_success_sets_session_and_csrf_cookies(self) -> None:
        api = Api(make_client()).login("admin")
        self.assertIsNotNone(api.client.cookies.get("erp_session"))
        self.assertIsNotNone(api.csrf_token)
        me = api.get("/api/auth/me")
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["role"], "ADMIN")

    def test_login_wrong_password_rejected(self) -> None:
        client = make_client()
        response = client.post("/api/auth/login", json={"username": "admin", "password": "wrong-password-123"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"], "用户名或密码错误")

    def test_login_inactive_or_unknown_user_rejected(self) -> None:
        client = make_client()
        response = client.post("/api/auth/login", json={"username": "no-such-user", "password": "whatever-123"})
        self.assertEqual(response.status_code, 401)


class CsrfSmokeTests(DbTestCase):
    """CSRF 双提交契约：写请求必须带与 cookie 匹配的 X-CSRF-Token。"""

    def test_write_without_csrf_header_rejected(self) -> None:
        api = Api(make_client()).login("admin")
        response = api.client.post("/api/uoms", json={"code": "SMK", "display_name": "冒烟单位", "decimal_scale": 0})
        self.assertEqual(response.status_code, 403)

    def test_write_with_mismatched_csrf_header_rejected(self) -> None:
        api = Api(make_client()).login("admin")
        response = api.client.post(
            "/api/uoms",
            json={"code": "SMK", "display_name": "冒烟单位", "decimal_scale": 0},
            headers={"X-CSRF-Token": "forged-token-value"},
        )
        self.assertEqual(response.status_code, 403)

    def test_write_with_csrf_header_accepted(self) -> None:
        api = Api(make_client()).login("admin")
        response = api.post("/api/uoms", json={"code": "SMK", "display_name": "冒烟单位", "decimal_scale": 0})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["code"], "SMK")

    def test_get_does_not_require_csrf(self) -> None:
        api = Api(make_client()).login("colleague")
        response = api.get("/api/uoms")
        self.assertEqual(response.status_code, 200)


class RoleSmokeTests(DbTestCase):
    def test_colleague_cannot_create_uom(self) -> None:
        api = Api(make_client()).login("colleague")
        response = api.post("/api/uoms", json={"code": "SMK2", "display_name": "冒烟单位", "decimal_scale": 0})
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
