import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
TEST_COMPOSE = (ROOT / "docker-compose.test.yml").read_text(encoding="utf-8")
API_DOCKERFILE = (ROOT / "api/Dockerfile").read_text(encoding="utf-8")
ENV_EXAMPLE = (ROOT / ".env.example").read_text(encoding="utf-8")
DEV_UP = (ROOT / "scripts/dev_up.sh").read_text(encoding="utf-8")
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

    def test_postgres_and_api_default_to_loopback(self):
        """数据库与 API 缺省仅绑回环；对外暴露一律走网关，防止公网直连弱口令库。"""
        self.assertIn('"${POSTGRES_PORT:-127.0.0.1:5432}:5432"', COMPOSE)
        self.assertIn('"${API_PORT:-127.0.0.1:8000}:8000"', COMPOSE)

    def test_secure_cookies_switch_reaches_container(self):
        """文档宣称的 ERP_SECURE_COOKIES 开关必须能经 compose 透传进 api 容器。"""
        self.assertIn("ERP_SECURE_COOKIES: ${ERP_SECURE_COOKIES:-0}", COMPOSE)
        self.assertIn("ERP_SECURE_COOKIES", ENV_EXAMPLE)

    def test_static_servers_send_security_headers(self):
        """三套静态/代理层统一安全响应头，且不暴露服务器版本。"""
        for conf in (WEB_NGINX, GATEWAY, SERVE):
            self.assertIn("X-Content-Type-Options", conf)
            self.assertIn("X-Frame-Options", conf)
            self.assertIn("Referrer-Policy", conf)
            self.assertIn("Content-Security-Policy", conf)
        self.assertIn("server_tokens off;", WEB_NGINX)
        self.assertIn("server_tokens off;", GATEWAY)
        self.assertIn("_SECURITY_HEADERS", SERVE)

    def test_interactive_docs_disabled_in_compose(self):
        """生产（Compose）默认关闭 /docs 与 openapi.json，避免未认证暴露完整 API 面。"""
        self.assertIn("ERP_DISABLE_DOCS: ${ERP_DISABLE_DOCS:-1}", COMPOSE)
        self.assertIn('os.environ.get("ERP_DISABLE_DOCS", "0") == "1"', API)
        self.assertIn("docs_url=None if _disable_docs else \"/docs\"", API)

    def test_uvicorn_trusts_proxy_headers_for_audit_ip(self):
        """经 web 容器/网关代理时 uvicorn 必须解析 X-Forwarded-*，否则审计 IP 恒为代理地址。"""
        self.assertIn("--proxy-headers", API_DOCKERFILE)
        self.assertIn("--forwarded-allow-ips", API_DOCKERFILE)

    def test_dev_up_rejects_placeholder_password(self):
        """本地快速启动脚本必须拒绝 .env.example 的占位密码，避免弱口令库起在公网机器上。"""
        self.assertIn("change-me", DEV_UP)
        self.assertIn("docker compose up", DEV_UP)

    def test_gateway_owns_port_80_and_routes_erp(self):
        self.assertIn("listen 80 default_server;", GATEWAY)
        self.assertIn("location /erp/", GATEWAY)
        self.assertIn("proxy_pass http://127.0.0.1:18080/;", GATEWAY)
        self.assertIn('href="/erp/"', LANDING)

    def test_frontend_build_and_runtime_paths(self):
        self.assertIn("env.VITE_BASE_PATH || '/erp/'", VITE)
        # 开发代理也保留 Host，以通过登录的同源校验。
        self.assertIn("changeOrigin: false", VITE)
        self.assertIn("makePathHelpers", APP_PATH)
        self.assertIn("withBasePath(`/api${path}`)", API_JS)
        self.assertIn("withBasePath(to)", UI)
        self.assertIn("withBasePath(url)", TABLE)
        # 行链接必须走共享 Link（含基路径+点击拦截），禁止裸 <a href={link}>
        self.assertIn('<Link className="dt-cell-link" to={href}', TABLE)
        self.assertIn("returnTo", TABLE)

    def test_cookie_path_is_configurable_for_erp_mount(self):
        self.assertIn('COOKIE_PATH = os.environ.get("ERP_COOKIE_PATH", "/")', API)
        self.assertIn("path=COOKIE_PATH", API)
        self.assertIn("ERP_COOKIE_PATH=/erp", DEPLOY)
        self.assertIn("WEB_PORT=127.0.0.1:18080", DEPLOY)
        # 健康检查端口跟随 .env 的 WEB_PORT 解析（自定义端口不再部署失败）
        self.assertIn('HEALTH_PORT="${WEB_PORT_VALUE##*:}"', DEPLOY)
        self.assertIn('127.0.0.1:${HEALTH_PORT}/api/healthz', DEPLOY)

    def test_remote_deployment_requires_explicit_target_and_import_mapping(self):
        self.assertIn('REMOTE_HOST="${DEPLOY_HOST:-}"', DEPLOY)
        self.assertIn('REMOTE_USER="${DEPLOY_USER:-}"', DEPLOY)
        self.assertIn('REMOTE_DIR="${DEPLOY_DIR:-}"', DEPLOY)
        # REMOTE_HOST 嵌入远端 shell 串，必须有字符集白名单
        self.assertIn('[[ "$REMOTE_HOST" =~ ^[A-Za-z0-9._:-]+$ ]]', DEPLOY)
        # 迁移补跑按序 glob 全量幂等重放，新增迁移无需改清单
        self.assertIn("for f in /docker-entrypoint-initdb.d/*.sql", DEPLOY)
        self.assertIn("--host HOST --user USER --remote-dir ABSOLUTE_PATH", DEPLOY)
        self.assertIn('--mapping FILE', DEPLOY)
        self.assertIn('[[ -f "$MAPPING_FILE" ]] || { echo "--seed-workbook 需要同时提供 --mapping"', DEPLOY)
        self.assertNotRegex(DEPLOY, r"192\.168\.\d+\.\d+")


if __name__ == "__main__":
    unittest.main()
