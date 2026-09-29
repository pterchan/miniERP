#!/usr/bin/env bash
set -Eeuo pipefail

REMOTE_HOST="${DEPLOY_HOST:-}"
REMOTE_USER="${DEPLOY_USER:-}"
REMOTE_DIR="${DEPLOY_DIR:-}"
ENV_FILE=""
WORKBOOK=""
MAPPING_FILE=""
SEED=0

usage() {
  cat <<'USAGE'
Usage: deploy/deploy_remote.sh --host HOST --user USER --remote-dir ABSOLUTE_PATH [options]

Required values may also be set with DEPLOY_HOST, DEPLOY_USER, and DEPLOY_DIR.

  --host HOST             SSH host
  --user USER             SSH user
  --remote-dir DIR        Absolute remote checkout directory
  --env-file FILE         Upload a dotenv file
  --seed-workbook FILE    Upload and import a workbook
  --mapping FILE          JSON column mapping; required with --seed-workbook
  -h, --help              Show this help

For workbook import, set IMPORT_WORKBOOK_PASSWORD or enter it at the prompt.
USAGE
}

while (($#)); do
  case "$1" in
    --host) REMOTE_HOST="$2"; shift 2 ;;
    --user) REMOTE_USER="$2"; shift 2 ;;
    --remote-dir) REMOTE_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --seed-workbook) WORKBOOK="$2"; SEED=1; shift 2 ;;
    --mapping) MAPPING_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知选项：$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$REMOTE_HOST" && -n "$REMOTE_USER" && -n "$REMOTE_DIR" ]] || {
  echo "请通过参数或 DEPLOY_HOST、DEPLOY_USER、DEPLOY_DIR 设置远程目标" >&2
  usage >&2
  exit 2
}
[[ "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ && "$REMOTE_DIR" != *"/../"* && "$REMOTE_DIR" != */.. ]] || {
  echo "远程目录必须是只含字母、数字、点、下划线、连字符和斜杠的绝对路径" >&2
  exit 2
}
# REMOTE_HOST 会嵌入远端 shell 单引号串，仅放行安全字符集，防止命令注入
[[ "$REMOTE_HOST" =~ ^[A-Za-z0-9._:-]+$ ]] || {
  echo "远程主机只能包含字母、数字、点、下划线、连字符和冒号（非法值：$REMOTE_HOST）" >&2
  exit 2
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${REMOTE_USER}@${REMOTE_HOST}"
[[ -f "$ROOT_DIR/docker-compose.yml" ]] || { echo "找不到 docker-compose.yml" >&2; exit 1; }
command -v ssh >/dev/null || { echo "需要 ssh" >&2; exit 1; }
command -v scp >/dev/null || { echo "需要 scp" >&2; exit 1; }
command -v tar >/dev/null || { echo "需要 tar" >&2; exit 1; }
command -v npm >/dev/null || { echo "需要 npm 构建前端" >&2; exit 1; }
if [[ -n "$ENV_FILE" && ! -f "$ENV_FILE" ]]; then
  echo "找不到 dotenv 文件：$ENV_FILE" >&2
  exit 1
fi
if ((SEED)); then
  [[ -f "$WORKBOOK" ]] || { echo "找不到工作簿：$WORKBOOK" >&2; exit 1; }
  [[ -f "$MAPPING_FILE" ]] || { echo "--seed-workbook 需要同时提供 --mapping" >&2; exit 1; }
elif [[ -n "$MAPPING_FILE" ]]; then
  echo "--mapping 只能与 --seed-workbook 一起使用" >&2
  exit 2
fi

SEED_PASSWORD_FILE=""
cleanup() {
  if [[ -n "$SEED_PASSWORD_FILE" && -f "$SEED_PASSWORD_FILE" ]]; then
    rm -f "$SEED_PASSWORD_FILE"
  fi
}
trap cleanup EXIT

if ((SEED)); then
  SEED_PASSWORD="${IMPORT_WORKBOOK_PASSWORD:-}"
  if [[ -z "$SEED_PASSWORD" ]]; then
    read -r -s -p "工作簿密码：" SEED_PASSWORD
    printf '\n' >&2
  fi
  [[ -n "$SEED_PASSWORD" ]] || { echo "工作簿密码不能为空" >&2; exit 1; }
  umask 077
  SEED_PASSWORD_FILE="$(mktemp "${TMPDIR:-/tmp}/mini-erp-import-password.XXXXXX")"
  printf '%s' "$SEED_PASSWORD" > "$SEED_PASSWORD_FILE"
  unset SEED_PASSWORD
fi

echo "正在本地构建前端..."
(cd "$ROOT_DIR/web" && npm ci --no-audit --no-fund && VITE_BASE_PATH="${VITE_BASE_PATH:-/erp/}" npm run build)

ssh -o BatchMode=yes "$TARGET" "mkdir -p '$REMOTE_DIR' && chmod 700 '$REMOTE_DIR'"
tar -czf - \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./.DS_Store' \
  --exclude='./.zcode' \
  --exclude='./web/node_modules' \
  --exclude='*/__pycache__' \
  --exclude='*.pyc' \
  --exclude='*.xlsx' \
  --exclude='*.xls' \
  -C "$ROOT_DIR" . | ssh -o BatchMode=yes "$TARGET" "tar -xzf - -C '$REMOTE_DIR'"

if [[ -n "$ENV_FILE" ]]; then
  scp -q "$ENV_FILE" "$TARGET:$REMOTE_DIR/.env"
fi
if ((SEED)); then
  scp -q "$WORKBOOK" "$TARGET:$REMOTE_DIR/.mini-erp-seed.xlsx"
  scp -q "$MAPPING_FILE" "$TARGET:$REMOTE_DIR/.mini-erp-import-map.json"
  scp -q "$SEED_PASSWORD_FILE" "$TARGET:$REMOTE_DIR/.mini-erp-import-password"
fi

ssh -o BatchMode=yes "$TARGET" "bash -s -- '$REMOTE_DIR' '$REMOTE_HOST' '$SEED'" <<'REMOTE_SCRIPT'
set -Eeuo pipefail
REMOTE_DIR="$1"
PUBLIC_HOST="$2"
DO_SEED="$3"
cd "$REMOTE_DIR"

cleanup_seed() {
  if [[ "$DO_SEED" == "1" ]]; then
    rm -f .mini-erp-seed.xlsx .mini-erp-import-map.json .mini-erp-import-password
  fi
}
trap cleanup_seed EXIT

gen_secret() { openssl rand -hex 32; }

if [[ ! -s .env ]]; then
  umask 077
  cat > .env <<EOF_ENV
POSTGRES_DB=inventory
POSTGRES_USER=inventory
POSTGRES_PASSWORD=$(gen_secret)
SESSION_SECRET=$(gen_secret)
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=$(gen_secret)
BOOTSTRAP_REQUESTER_USERNAME=colleague
BOOTSTRAP_REQUESTER_PASSWORD=$(gen_secret)
OCR_INTERNAL_TOKEN=$(gen_secret)
OCR_PROXY_TIMEOUT_SECONDS=25
MINIO_ACCESS_KEY=$(openssl rand -hex 8)
MINIO_SECRET_KEY=$(openssl rand -hex 16)
MINIO_BUCKET=erp-product-images
WEB_PORT=127.0.0.1:18080
ERP_COOKIE_PATH=/erp
# TLS 终止代理就绪后改为 1，启用会话/CSRF Cookie 的 Secure 标志
ERP_SECURE_COOKIES=0
API_PORT=127.0.0.1:18001
POSTGRES_PORT=127.0.0.1:15432
CORS_ORIGINS=https://$PUBLIC_HOST
WEB_DOCKERFILE=Dockerfile.remote
EOF_ENV
fi
chmod 600 .env
if grep -Eq '^(POSTGRES_PASSWORD|SESSION_SECRET|BOOTSTRAP_ADMIN_PASSWORD|BOOTSTRAP_REQUESTER_PASSWORD|OCR_INTERNAL_TOKEN|MINIO_ACCESS_KEY|MINIO_SECRET_KEY)=(change-me|replace-with)' .env; then
  echo "dotenv 含占位密码或令牌，请先配置随机值" >&2
  exit 1
fi

docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build --remove-orphans
docker compose --env-file .env ps

# 健康检查端口跟随 .env 的 WEB_PORT（形如 127.0.0.1:18080 或 18080）
WEB_PORT_VALUE="$(grep -E '^WEB_PORT=' .env | cut -d= -f2- || true)"
HEALTH_PORT="${WEB_PORT_VALUE##*:}"
[[ "$HEALTH_PORT" =~ ^[0-9]+$ ]] || HEALTH_PORT=18080
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error "http://127.0.0.1:${HEALTH_PORT}/api/healthz" >/dev/null; then break; fi
  [[ "$attempt" -eq 30 ]] && { docker compose --env-file .env logs --tail=120 api postgres ocr; exit 1; }
  sleep 2
done

DB_USER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)"
DB_NAME="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)"
for migration in 005_search_indexes.sql 006_serial_tracking.sql 007_login_throttle.sql 008_hardening.sql; do
  docker compose --env-file .env exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
    -f "/docker-entrypoint-initdb.d/$migration"
done

if [[ "$DO_SEED" == "1" ]]; then
  [[ -s .mini-erp-seed.xlsx && -s .mini-erp-import-map.json && -s .mini-erp-import-password ]] || {
    echo "导入文件不完整" >&2
    exit 1
  }
  chmod 600 .mini-erp-seed.xlsx .mini-erp-import-map.json .mini-erp-import-password
  IMPORT_WORKBOOK_PASSWORD="$(cat .mini-erp-import-password)"
  docker compose --env-file .env run --rm --no-deps \
    -v "$PWD/.mini-erp-seed.xlsx:/app/.mini-erp-seed.xlsx:ro" \
    -v "$PWD/.mini-erp-import-map.json:/app/.mini-erp-import-map.json:ro" \
    -e IMPORT_WORKBOOK_PASSWORD="$IMPORT_WORKBOOK_PASSWORD" \
    api python /app/scripts/seed_inventory.py \
      --input /app/.mini-erp-seed.xlsx \
      --mapping /app/.mini-erp-import-map.json \
      --password-env IMPORT_WORKBOOK_PASSWORD --apply
  unset IMPORT_WORKBOOK_PASSWORD
fi

echo "部署完成：远程目录 $REMOTE_DIR"
echo "dotenv 权限为 600，请通过 HTTPS 网关公开 Web 服务。"
REMOTE_SCRIPT
