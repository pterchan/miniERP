"""认证加固行为测试（复现 P1：改密不撤会话、登录无防爆破、无 Origin 校验）。"""

from __future__ import annotations

import unittest

from tests.support.api_client import Api, api_for, make_client
from tests.support.testdb import DbTestCase, TEST_PASSWORD


class SessionRevocationTests(DbTestCase):
    def test_change_password_revokes_other_sessions(self) -> None:
        current = api_for("colleague")
        other = api_for("colleague")
        response = current.post("/api/auth/change-password",
                                json={"current_password": TEST_PASSWORD, "new_password": "new-pass-123456"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(current.get("/api/auth/me").status_code, 200, "当前会话应保留")
        self.assertEqual(other.get("/api/auth/me").status_code, 401, "其它会话应在改密后失效")

    def test_login_with_new_password_after_change(self) -> None:
        current = api_for("finance")
        response = current.post("/api/auth/change-password",
                                json={"current_password": TEST_PASSWORD, "new_password": "new-pass-123456"})
        self.assertEqual(response.status_code, 200)
        fresh = Api(make_client()).login("finance", "new-pass-123456")
        self.assertEqual(fresh.get("/api/auth/me").status_code, 200)

    def test_admin_reset_revokes_target_sessions(self) -> None:
        target = api_for("sales")
        admin = api_for("admin")
        response = admin.post(f"/api/admin/users/{target.user['user_id']}/password",
                              json={"password": "reset-pass-123"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(target.get("/api/auth/me").status_code, 401, "被重置用户的会话应失效")


class LoginOriginTests(DbTestCase):
    def test_cross_origin_login_rejected(self) -> None:
        client = make_client()
        response = client.post("/api/auth/login",
                               json={"username": "admin", "password": TEST_PASSWORD},
                               headers={"Origin": "http://evil.example"})
        self.assertEqual(response.status_code, 403, "跨站 Origin 的登录应被拒绝（login CSRF）")

    def test_same_origin_login_ok(self) -> None:
        client = make_client()
        response = client.post("/api/auth/login",
                               json={"username": "admin", "password": TEST_PASSWORD},
                               headers={"Origin": "http://testserver"})
        self.assertEqual(response.status_code, 200)


class LoginThrottleTests(DbTestCase):
    """独立类：失败计数不外溢到其它行为测试。"""

    WRONG = "wrong-password-000"

    def _fail_login(self, username: str = "admin"):
        return make_client().post("/api/auth/login", json={"username": username, "password": self.WRONG})

    def test_five_failures_lock_the_account(self) -> None:
        for _ in range(5):
            self.assertEqual(self._fail_login().status_code, 401)
        locked = make_client().post("/api/auth/login", json={"username": "admin", "password": TEST_PASSWORD})
        self.assertEqual(locked.status_code, 429, "连续失败后即使密码正确也应被锁定")
        self.assertIn("尝试次数过多", locked.json()["detail"])

    def test_failed_attempt_is_audited(self) -> None:
        # 用独立用户名，避免与锁定用例的失败计数叠加
        self.assertEqual(self._fail_login(username="sales").status_code, 401)
        from api.db import connection, fetch_all
        with connection() as conn:
            rows = fetch_all(conn, "SELECT action FROM audit_event WHERE action='LOGIN_FAIL' ORDER BY audit_event_id DESC LIMIT 1")
        self.assertTrue(rows, "登录失败必须落审计（LOGIN_FAIL），否则爆破不可见")

    def test_unknown_user_attempt_recorded(self) -> None:
        response = self._fail_login(username="no-such-user-xyz")
        self.assertEqual(response.status_code, 401)
        from api.db import connection, fetch_one
        with connection() as conn:
            row = fetch_one(conn, "SELECT username_hash, succeeded FROM login_attempt WHERE username_hash IS NOT NULL ORDER BY id DESC")
        self.assertIsNotNone(row, "未知用户的失败尝试也应计数（防用户名枚举式爆破）")
        self.assertFalse(row["succeeded"])


if __name__ == "__main__":
    unittest.main()
