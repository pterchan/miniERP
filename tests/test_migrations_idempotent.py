"""迁移幂等性回归门（AGENTS.md 约定：迁移必须幂等）。

对已应用 001-006 的库原样重放全部迁移文件：
- 现状（长红灯）：001-004 的 DDL 无 IF NOT EXISTS、002 的幂等 INSERT 被自身
  审计触发器拦截，重放必然报错；
- 目标（批次 4 修复后转绿）：全部迁移可安全重放，且种子数据行数不变。
"""

from __future__ import annotations

import unittest

import psycopg2

from tests.support.testdb import MIGRATIONS_DIR, DbTestCase, test_database_url

# 仅迁移文件播种的字典表（不含测试自建数据的表）
_SEED_TABLES = ("record_status", "movement_type", "inventory_condition", "uom")


def _seed_counts(conn) -> dict[str, int]:
    counts: dict[str, int] = {}
    with conn.cursor() as cur:
        for table in _SEED_TABLES:
            cur.execute(f"SELECT count(*) FROM {table}")  # 表名来自代码内白名单
            counts[table] = int(cur.fetchone()[0])
    return counts


class MigrationIdempotencyTests(DbTestCase):
    def test_rerunning_all_migrations_succeeds_and_keeps_seed_counts(self) -> None:
        conn = psycopg2.connect(test_database_url())
        conn.autocommit = True
        try:
            before = _seed_counts(conn)
            replayed = 0
            for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
                with conn.cursor() as cur:
                    cur.execute(path.read_text(encoding="utf-8"))
                replayed += 1
            self.assertGreaterEqual(replayed, 6)
            self.assertEqual(_seed_counts(conn), before, "重放迁移后种子数据行数发生变化")
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
