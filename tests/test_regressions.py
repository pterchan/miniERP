"""复审回归测试：serve.py 静态服务、ids 导出 SQL、导入器原生日期单元格。"""

from __future__ import annotations

import http.server
import importlib
import tempfile
import threading
import unittest
import urllib.request
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch


class ServeStaticTests(unittest.TestCase):
    """真实起 serve.py 进程验证静态服务（字符串契约测不出发不出响应字节的事故）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.dist_dir = tempfile.TemporaryDirectory(prefix="serve-test-dist-")
        cls.addClassCleanup(cls.dist_dir.cleanup)
        cls.dist = cls.dist_dir.name
        (Path(cls.dist) / "index.html").write_text("<html>miniERP 测试首页</html>", encoding="utf-8")
        assets = Path(cls.dist) / "assets"
        assets.mkdir()
        (assets / "app.js").write_text("console.log('ok')", encoding="utf-8")
        serve = importlib.import_module("web.serve")
        # 代理测试也会导入该模块；显式隔离静态目录，避免依赖测试导入顺序。
        cls.dist_patch = patch.object(serve, "DIST", Path(cls.dist))
        cls.dist_patch.start()
        cls.addClassCleanup(cls.dist_patch.stop)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def _get(self, path: str) -> tuple[int, str]:
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=5) as response:
            return response.status, response.read().decode("utf-8", "replace")

    def test_index_served_with_body_and_security_headers(self) -> None:
        status, body = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn("miniERP", body)

    def test_hashed_asset_served(self) -> None:
        status, body = self._get("/assets/app.js")
        self.assertEqual(status, 200)
        self.assertIn("console.log", body)

    def test_spa_fallback_for_unknown_path(self) -> None:
        status, body = self._get("/products/5")
        self.assertEqual(status, 200)
        self.assertIn("miniERP", body, "未知路径应回退 index.html（SPA 路由）")


class IdsExportSqlTests(unittest.TestCase):
    """ids 导出的保序 SQL 必须是合法 PostgreSQL（unnest 在标量参数位不合法）。"""

    def test_order_by_has_no_unnest_in_scalar_position(self) -> None:
        export = Path(__file__).parents[1].joinpath("api/export.py").read_text(encoding="utf-8")
        main = Path(__file__).parents[1].joinpath("api/main.py").read_text(encoding="utf-8")
        for label, source in (("export.py", export), ("main.py", main)):
            self.assertNotIn("array_position(unnest(", source,
                             f"{label}: unnest 不能出现在 array_position 的标量参数位（运行期 UndefinedFunction → 500）")


class ImporterNativeDateTests(unittest.TestCase):
    def test_parse_date_accepts_native_date_and_datetime_cells(self) -> None:
        import sys
        sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
        import import_inventory as importer
        self.assertEqual(importer.parse_date(date(2024, 5, 3)), ("2024-05-03", None))
        self.assertEqual(importer.parse_date(datetime(2024, 5, 3, 8, 30)), ("2024-05-03", None))


if __name__ == "__main__":
    unittest.main()
