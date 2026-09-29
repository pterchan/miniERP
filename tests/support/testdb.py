"""一次性行为测试数据库基建。

- 连接串：环境变量 ``TEST_DATABASE_URL``，默认指向 docker-compose.test.yml
  启动的 postgres（127.0.0.1:15433）。
- 库不可达时测试类整类跳过，保证无 Docker 环境下静态/纯函数测试可独立运行。
- 清库方式用 DROP SCHEMA 而非 TRUNCATE：audit_event 有不可变触发器，
  且重放迁移本身就是对幂等性的持续回归验证。
"""

from __future__ import annotations

import os
import unittest
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = ROOT / "db" / "migrations"
DEFAULT_TEST_DATABASE_URL = "postgresql://erp_test:erp_test@127.0.0.1:15433/erp_test"
START_HINT = (
    "docker compose -f docker-compose.test.yml up -d --wait "
    "&& TEST_DATABASE_URL=" + DEFAULT_TEST_DATABASE_URL
)

TEST_PASSWORD = "test-pass-123456"
TEST_USERS: dict[str, tuple[str, str]] = {
    "admin": ("ADMIN", "测试管理员"),
    "warehouse": ("WAREHOUSE", "测试仓管"),
    "sales": ("SALES", "测试销售"),
    "finance": ("FINANCE", "测试财务"),
    "colleague": ("COLLEAGUE", "测试同事"),
}


def test_database_url() -> str:
    return os.environ.get("TEST_DATABASE_URL") or DEFAULT_TEST_DATABASE_URL


def probe() -> bool:
    try:
        conn = psycopg2.connect(test_database_url(), connect_timeout=2)
        conn.close()
        return True
    except Exception as exc:
        if os.environ.get("TEST_DATABASE_URL"):
            # 显式指定却不可达：这是配置/启动故障，静默跳过会掩盖问题
            raise RuntimeError(f"TEST_DATABASE_URL 已设置但不可达：{exc}") from exc
        return False


def apply_migrations() -> list[str]:
    """按文件名序整文件执行迁移；每个文件自带 BEGIN/COMMIT，须在 autocommit 连接上执行。"""
    applied: list[str] = []
    conn = psycopg2.connect(test_database_url())
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
                cur.execute(path.read_text(encoding="utf-8"))
                applied.append(path.name)
    finally:
        conn.close()
    return applied


def reset_database() -> None:
    conn = psycopg2.connect(test_database_url())
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("DROP SCHEMA public CASCADE")
            cur.execute("CREATE SCHEMA public")
    finally:
        conn.close()
    apply_migrations()


def reset_app_pool() -> None:
    """把 api.db 的连接池切到测试库（应用通过 DATABASE_URL 取库）。"""
    import api.db as db

    os.environ["DATABASE_URL"] = test_database_url()
    if db._pool is not None:
        try:
            db._pool.closeall()
        except Exception:
            pass
    db._pool = None


def create_test_users() -> None:
    from api.db import audit, connection
    from api.security import hash_password

    with connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM app_user")
            if cur.fetchone()[0]:
                return
        for username, (role, label) in TEST_USERS.items():
            audit(conn, None, "TEST_SETUP", "app_user", after={"username": username, "role": role})
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO app_user(username,display_name,role,password_hash) VALUES (%s,%s,%s,%s)",
                    (username, label, role, hash_password(TEST_PASSWORD)),
                )


def setup_test_env() -> None:
    reset_app_pool()
    reset_database()
    create_test_users()


class DbTestCase(unittest.TestCase):
    """需要一次性测试库的行为测试基类。

    每个测试类重建一次库（DROP SCHEMA + 重放迁移），类内测试共享数据。
    需要完全干净数据的测试类应放在独立类中。
    """

    @classmethod
    def setUpClass(cls) -> None:
        if not probe():
            raise unittest.SkipTest("测试数据库不可达；启动方式：" + START_HINT)
        try:
            import fastapi  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("缺少 fastapi 等后端依赖；安装方式：pip install -r api/requirements.txt")
        setup_test_env()
