from __future__ import annotations

import json
import os
import threading
from datetime import date, datetime
from decimal import Decimal
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg2
from psycopg2 import pool as _pg_pool
from psycopg2.extras import RealDictCursor, Json


def _json_safe(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def database_url() -> str:
    value = os.environ.get("DATABASE_URL")
    if not value:
        raise RuntimeError("DATABASE_URL 未配置")
    return value


_pool: Any = None
_pool_lock = threading.Lock()


class PoolExhaustedError(RuntimeError):
    """连接池耗尽：映射为 503 让客户端退避重试，而不是 500/挂死。"""


def _get_pool() -> Any:
    """惰性创建连接池：minconn=0 避免启动即连库。

    connect_timeout 限制建连等待；statement_timeout 兜底慢查询（30s），
    防止个别慢语句长期占用池内连接。
    """
    global _pool
    if _pool is None:
        # 多线程首请求并发建池会创建两个池（其一泄漏、连接上限翻倍）
        with _pool_lock:
            if _pool is None:
                _pool = _pg_pool.ThreadedConnectionPool(
                    0, 30, database_url(), connect_timeout=5, options="-c statement_timeout=30000",
                )
    return _pool


@contextmanager
def connection() -> Iterator[Any]:
    pool = _get_pool()
    try:
        conn = pool.getconn()
    except _pg_pool.PoolError as exc:
        raise PoolExhaustedError("数据库连接池已耗尽，请稍后重试") from exc
    conn.autocommit = False
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


def fetch_one(conn: Any, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
        return dict(row) if row else None


def fetch_all(conn: Any, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, params)
        return [dict(row) for row in cur.fetchall()]


def set_audit_context(conn: Any, user_id: int | None, action: str) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('app.actor_id', %s, true), set_config('app.audit_action', %s, true)", (str(user_id) if user_id else "SYSTEM", action))


def audit(
    conn: Any,
    user: dict[str, Any] | None,
    action: str,
    target_table: str,
    target_id: int | None = None,
    before: Any = None,
    after: Any = None,
    field_diff: Any = None,
    request_id: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> None:
    set_audit_context(conn, user.get("user_id") if user else None, action)
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO audit_event
               (actor_user_id, actor_role, action, target_table, target_id,
                request_id, ip_address, user_agent, before_data, after_data, field_diff)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                user.get("user_id") if user else None,
                user.get("role") if user else "SYSTEM",
                action,
                target_table,
                target_id,
                request_id,
                ip_address,
                user_agent,
                Json(_json_safe(before)) if before is not None else None,
                Json(_json_safe(after)) if after is not None else None,
                Json(_json_safe(field_diff)) if field_diff is not None else None,
            ),
        )


def ensure_bootstrap_users() -> None:
    # Accept both the explicit ERP_* names and the compose-friendly
    # BOOTSTRAP_* names so deployment files can rotate credentials without
    # changing application code. Creates an ADMIN (管理员) and a COLLEAGUE (同事).
    admin_password = (
        os.environ.get("BOOTSTRAP_ADMIN_PASSWORD")
        or os.environ.get("ERP_ADMIN_PASSWORD")
        or os.environ.get("BOOTSTRAP_WAREHOUSE_PASSWORD")
    )
    colleague_password = os.environ.get("BOOTSTRAP_REQUESTER_PASSWORD") or os.environ.get("ERP_REQUESTER_PASSWORD")
    if not admin_password or not colleague_password:
        return
    from .security import hash_password

    with connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM app_user")
            if cur.fetchone()[0]:
                return
        admin_name = os.environ.get("BOOTSTRAP_ADMIN_USERNAME") or os.environ.get("ERP_ADMIN_USERNAME") or os.environ.get("BOOTSTRAP_WAREHOUSE_USERNAME", "admin")
        colleague_name = os.environ.get("BOOTSTRAP_REQUESTER_USERNAME") or os.environ.get("ERP_REQUESTER_USERNAME", "colleague")
        audit(conn, None, "BOOTSTRAP_CREATE", "app_user", after={"usernames": [admin_name, colleague_name]})
        with conn.cursor() as cur:
            cur.execute("INSERT INTO app_user(username,display_name,role,password_hash) VALUES (%s,%s,'ADMIN',%s),(%s,%s,'COLLEAGUE',%s)",
                        (admin_name, "系统管理员", hash_password(admin_password), colleague_name, "同事", hash_password(colleague_password)))
