"""使用实际 psycopg2 池和假连接验证复用与故障边界，不连接数据库。"""

from __future__ import annotations

import os
import importlib.util
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import psycopg2
from psycopg2.extensions import TRANSACTION_STATUS_IDLE

from api import db


class FakeConnection:
    def __init__(self):
        self.closed = False
        self.broken = False
        self.autocommit = False
        self.info = SimpleNamespace(transaction_status=TRANSACTION_STATUS_IDLE)

    def cursor(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, _sql):
        if self.broken:
            raise psycopg2.OperationalError("测试连接已中断")

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        self.closed = True


class ConnectionPoolTests(unittest.TestCase):
    def setUp(self):
        self.previous_pool = db._pool
        db._pool = None
        self.environment = patch.dict(os.environ, {"DATABASE_URL": "postgresql://unused"}, clear=True)
        self.environment.start()
        self.created = []

        def connect(*_args, **_kwargs):
            conn = FakeConnection()
            self.created.append(conn)
            return conn

        self.connect_patch = patch.object(psycopg2, "connect", side_effect=connect)
        self.connect_mock = self.connect_patch.start()

    def tearDown(self):
        if db._pool is not None:
            db._pool.closeall()
        db._pool = self.previous_pool
        self.connect_patch.stop()
        self.environment.stop()

    def test_default_pool_reuses_returned_connection(self):
        with db.connection() as first:
            pass
        with db.connection() as second:
            pass
        self.assertIs(first, second)
        self.assertEqual(len(self.created), 1)
        self.assertFalse(first.closed)
        self.assertEqual((db._pool.minconn, db._pool.maxconn), (1, 30))

    def test_explicit_zero_closes_returned_connections(self):
        os.environ["ERP_DB_POOL_MIN"] = "0"
        with db.connection() as first:
            pass
        with db.connection() as second:
            pass
        self.assertIsNot(first, second)
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)
        self.assertEqual(len(self.created), 2)

    def test_settings_accept_zero_and_reject_invalid_limits(self):
        self.assertEqual(db.validate_pool_settings(), (1, 30))
        with patch.dict(os.environ, {"ERP_DB_POOL_MIN": "0", "ERP_DB_POOL_MAX": "1"}):
            self.assertEqual(db.validate_pool_settings(), (0, 1))
        for minimum, maximum in (("-1", "30"), ("1", "0"), ("31", "30"), ("a", "30"), ("1", "a")):
            with self.subTest(minimum=minimum, maximum=maximum):
                with patch.dict(os.environ, {"ERP_DB_POOL_MIN": minimum, "ERP_DB_POOL_MAX": maximum}):
                    with self.assertRaises(RuntimeError):
                        db.validate_pool_settings()
        self.connect_mock.assert_not_called()

    def test_initial_connection_failure_leaves_pool_retryable(self):
        with patch.object(db._pg_pool, "ThreadedConnectionPool", side_effect=psycopg2.OperationalError("测试建连失败")):
            with self.assertRaises(db.PoolExhaustedError):
                db._get_pool()
        self.assertIsNone(db._pool)
        self.assertIsNotNone(db._get_pool())

    @unittest.skipUnless(importlib.util.find_spec("fastapi"), "缺少 FastAPI，请先安装后端依赖")
    def test_initial_connection_failure_returns_503(self):
        from fastapi.testclient import TestClient
        from api.main import app

        client = TestClient(app)
        try:
            with patch.object(db._pg_pool, "ThreadedConnectionPool", side_effect=psycopg2.OperationalError("测试建连失败")):
                response = client.get("/healthz")
        finally:
            client.close()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["Retry-After"], "5")
        self.assertIsNone(db._pool)

    @unittest.skipUnless(importlib.util.find_spec("fastapi"), "缺少 FastAPI，请先安装后端依赖")
    def test_invalid_settings_abort_startup_even_without_strict_bootstrap(self):
        from fastapi.testclient import TestClient
        from api.main import app

        with patch.dict(os.environ, {"ERP_DB_POOL_MIN": "invalid", "ERP_BOOTSTRAP_STRICT": "0"}):
            with patch("api.main.ensure_bootstrap_users") as bootstrap:
                with self.assertRaisesRegex(RuntimeError, "必须为整数"):
                    with TestClient(app):
                        self.fail("非法连接池配置不得完成启动")
        bootstrap.assert_not_called()
        self.connect_mock.assert_not_called()

    def test_configured_limits_reach_pool_constructor(self):
        with patch.dict(os.environ, {"ERP_DB_POOL_MIN": "2", "ERP_DB_POOL_MAX": "4"}):
            pool = db._get_pool()
        self.assertEqual((pool.minconn, pool.maxconn), (2, 4))
        self.assertEqual(len(self.created), 2)

    def test_default_maximum_remains_30_connections(self):
        pool = db._get_pool()
        borrowed = [pool.getconn() for _ in range(30)]
        try:
            with self.assertRaises(db.PoolExhaustedError):
                db._checkout(pool)
            self.assertEqual(len(self.created), 30)
        finally:
            for conn in borrowed:
                pool.putconn(conn)

    def test_broken_idle_connection_is_replaced(self):
        with db.connection() as first:
            pass
        first.broken = True
        with patch.object(db.time, "sleep"):
            with db.connection() as second:
                pass
        self.assertIsNot(first, second)
        self.assertTrue(first.closed)
        self.assertFalse(second.closed)


if __name__ == "__main__":
    unittest.main()
