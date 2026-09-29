import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
TEST_COMPOSE = (ROOT / "docker-compose.test.yml").read_text(encoding="utf-8")
API = (ROOT / "api/main.py").read_text(encoding="utf-8")
VITE = (ROOT / "web/vite.config.js").read_text(encoding="utf-8")
APP_PATH = (ROOT / "web/src/app-path.js").read_text(encoding="utf-8")
API_JS = (ROOT / "web/src/api.js").read_text(encoding="utf-8")
UI = (ROOT / "web/src/ui.jsx").read_text(encoding="utf-8")
TABLE = (ROOT / "web/src/data-table.jsx").read_text(encoding="utf-8")
WEB_NGINX = (ROOT / "web/nginx.conf").read_text(encoding="utf-8")
SERVE = (ROOT / "web/serve.py").read_text(encoding="utf-8")
GATEWAY = (ROOT / "deploy/gateway/nginx.conf").read_text(encoding="utf-8")
LANDING = (ROOT / "deploy/gateway/index.html").read_text(encoding="utf-8")
DEPLOY = (ROOT / "deploy/deploy_remote.sh").read_text(encoding="utf-8")


class GatewayContractTests(unittest.TestCase):
    def test_web_is_private_high_port_service(self):
        self.assertIn('"${WEB_PORT:-127.0.0.1:18080}:8080"', COMPOSE)
        self.assertIn("ERP_COOKIE_PATH: ${ERP_COOKIE_PATH:-/}", COMPOSE)
        self.assertIn("listen 8080;", WEB_NGINX)
        self.assertNotIn("listen 80;", WEB_NGINX)
        self.assertIn("location = /api/healthz", WEB_NGINX)
        self.assertIn("location = /erp/api/healthz", WEB_NGINX)
        self.assertIn("proxy_pass http://api:8000/healthz;", WEB_NGINX)
        self.assertIn('EXPOSE 8080', (ROOT / "web/Dockerfile").read_text(encoding="utf-8"))
        self.assertIn('EXPOSE 8080', (ROOT / "web/Dockerfile.remote").read_text(encoding="utf-8"))
        self.assertIn('os.getenv("WEB_PORT_INTERNAL", "8080")', SERVE)

    def test_behavior_test_db_is_isolated_ephemeral_and_loopback(self):
        """一次性行为测试库：数据在 tmpfs、端口仅绑回环，与主栈隔离。"""
        self.assertIn('"127.0.0.1:15433:5432"', TEST_COMPOSE)
        self.assertIn("- /var/lib/postgresql/data", TEST_COMPOSE)
        self.assertNotIn("${POSTGRES_PORT", TEST_COMPOSE)
        self.assertIn("TEST_DATABASE_URL", (ROOT / "tests/support/testdb.py").read_text(encoding="utf-8"))

    def test_gateway_owns_port_80_and_routes_erp(self):
        self.assertIn("listen 80 default_server;", GATEWAY)
        self.assertIn("location /erp/", GATEWAY)
        self.assertIn("proxy_pass http://127.0.0.1:18080/;", GATEWAY)
        self.assertIn('href="/erp/"', LANDING)

    def test_frontend_build_and_runtime_paths(self):
        self.assertIn("env.VITE_BASE_PATH || '/erp/'", VITE)
        self.assertIn("makePathHelpers", APP_PATH)
        self.assertIn("withBasePath(`/api${path}`)", API_JS)
        self.assertIn("withBasePath(to)", UI)
        self.assertIn("withBasePath(url)", TABLE)

    def test_cookie_path_is_configurable_for_erp_mount(self):
        self.assertIn('COOKIE_PATH = os.environ.get("ERP_COOKIE_PATH", "/")', API)
        self.assertIn("path=COOKIE_PATH", API)
        self.assertIn("ERP_COOKIE_PATH=/erp", DEPLOY)
        self.assertIn("WEB_PORT=127.0.0.1:18080", DEPLOY)
        self.assertIn("127.0.0.1:18080/api/healthz", DEPLOY)

    def test_remote_deployment_requires_explicit_target_and_import_mapping(self):
        self.assertIn('REMOTE_HOST="${DEPLOY_HOST:-}"', DEPLOY)
        self.assertIn('REMOTE_USER="${DEPLOY_USER:-}"', DEPLOY)
        self.assertIn('REMOTE_DIR="${DEPLOY_DIR:-}"', DEPLOY)
        self.assertIn("--host HOST --user USER --remote-dir ABSOLUTE_PATH", DEPLOY)
        self.assertIn('--mapping FILE', DEPLOY)
        self.assertIn('[[ -f "$MAPPING_FILE" ]] || { echo "--seed-workbook 需要同时提供 --mapping"', DEPLOY)
        self.assertNotRegex(DEPLOY, r"192\.168\.\d+\.\d+")


if __name__ == "__main__":
    unittest.main()
