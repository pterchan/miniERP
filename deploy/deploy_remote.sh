#!/usr/bin/env bash
set -Eeuo pipefail

REMOTE_HOST="${DEPLOY_HOST:-}"
REMOTE_USER="${DEPLOY_USER:-}"
REMOTE_DIR="${DEPLOY_DIR:-}"
ENV_FILE=""
WORKBOOK=""
SEED=0

usage() {
  cat <<'EOF'
Usage: deploy/deploy_remote.sh [options]

  --host HOST             SSH host (required; set DEPLOY_HOST)
  --user USER             SSH user (required; set DEPLOY_USER)
  --remote-dir DIR        Remote checkout (required absolute path; set DEPLOY_DIR)
  --env-file FILE         Upload a protected dotenv file
  --seed-workbook FILE    Upload and import an encrypted workbook
  -h, --help              Show this help

For --seed-workbook, set IMPORT_WORKBOOK_PASSWORD or enter it at the prompt.
EOF
}

while (($#)); do
  case "$1" in
    --host) REMOTE_HOST="$2"; shift 2 ;;
    --user) REMOTE_USER="$2"; shift 2 ;;
    --remote-dir) REMOTE_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --seed-workbook) WORKBOOK="$2"; SEED=1; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${REMOTE_USER}@${REMOTE_HOST}"
[[ -f "$ROOT_DIR/docker-compose.yml" ]] || { echo "docker-compose.yml not found" >&2; exit 1; }
command -v ssh >/dev/null || { echo "ssh is required" >&2; exit 1; }
command -v scp >/dev/null || { echo "scp is required" >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required to build the web bundle" >&2; exit 1; }
if [[ -n "$ENV_FILE" && ! -f "$ENV_FILE" ]]; then
  echo "dotenv file not found: $ENV_FILE" >&2
  exit 1
fi
if ((SEED)) && [[ ! -f "$WORKBOOK" ]]; then
  echo "workbook not found: $WORKBOOK" >&2
  exit 1
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
    read -r -s -p "Workbook password: " SEED_PASSWORD
    printf '\n' >&2
  fi
  [[ -n "$SEED_PASSWORD" ]] || { echo "workbook password is empty" >&2; exit 1; }
  umask 077
  SEED_PASSWORD_FILE="$(mktemp "${TMPDIR:-/tmp}/import-password.XXXXXX")"
  printf '%s' "$SEED_PASSWORD" > "$SEED_PASSWORD_FILE"
  unset SEED_PASSWORD
fi

echo "Building web bundle locally..."
(cd "$ROOT_DIR/web" && npm ci --no-audit --no-fund && npm run build)

ssh -o BatchMode=yes "$TARGET" "mkdir -p '$REMOTE_DIR' && chmod 700 '$REMOTE_DIR'"
tar -czf - \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./web/node_modules' \
  --exclude='*/__pycache__' \
  --exclude='*.pyc' \
  -C "$ROOT_DIR" . | ssh -o BatchMode=yes "$TARGET" "tar -xzf - -C '$REMOTE_DIR'"

if [[ -n "$ENV_FILE" ]]; then
  scp -q "$ENV_FILE" "$TARGET:$REMOTE_DIR/.env"
fi
if ((SEED)); then
  scp -q "$WORKBOOK" "$TARGET:$REMOTE_DIR/.workbook.xlsx"
  scp -q "$SEED_PASSWORD_FILE" "$TARGET:$REMOTE_DIR/.import-password"
fi

ssh -o BatchMode=yes "$TARGET" "bash -s -- '$REMOTE_DIR' '$REMOTE_HOST' '$SEED'" <<'REMOTE_SCRIPT'
set -Eeuo pipefail
REMOTE_DIR="$1"
PUBLIC_HOST="$2"
DO_SEED="$3"
cd "$REMOTE_DIR"

gen_secret() { openssl rand -hex 32; }

if [[ ! -s .env ]]; then
  umask 077
  cat > .env <<EOF
POSTGRES_DB=inventory
POSTGRES_USER=inventory
POSTGRES_PASSWORD=$(gen_secret)
SESSION_SECRET=$(gen_secret)
BOOTSTRAP_WAREHOUSE_USERNAME=warehouse
BOOTSTRAP_WAREHOUSE_PASSWORD=$(gen_secret)
BOOTSTRAP_REQUESTER_USERNAME=requester
BOOTSTRAP_REQUESTER_PASSWORD=$(gen_secret)
OCR_INTERNAL_TOKEN=$(gen_secret)
OCR_PROXY_TIMEOUT_SECONDS=25
WEB_PORT=80
API_PORT=127.0.0.1:18001
POSTGRES_PORT=127.0.0.1:15432
CORS_ORIGINS=http://$PUBLIC_HOST
EOF
fi
chmod 600 .env
if ! grep -q '^WEB_DOCKERFILE=' .env; then
  printf '\nWEB_DOCKERFILE=Dockerfile.remote\n' >> .env
fi
if grep -Eq '^(POSTGRES_PASSWORD|SESSION_SECRET|BOOTSTRAP_WAREHOUSE_PASSWORD|BOOTSTRAP_REQUESTER_PASSWORD|OCR_INTERNAL_TOKEN)=(change-me|replace-with)' .env; then
  echo "dotenv contains placeholder secrets; provide --env-file with real values" >&2
  exit 1
fi

# The target host keeps a Python 3.12 base image under its configured mirror
# name. Retag that cached image locally so Docker builds do not need Docker Hub.
if ! docker image inspect python:3.12-slim >/dev/null 2>&1; then
  CACHED_PYTHON="$(docker image ls --format '{{.ID}}' python | head -n 1)"
  [[ -n "$CACHED_PYTHON" ]] || { echo "python:3.12-slim base image is unavailable" >&2; exit 1; }
  docker tag "$CACHED_PYTHON" python:3.12-slim
fi

docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build --remove-orphans
docker compose --env-file .env ps

if command -v curl >/dev/null 2>&1; then
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error "http://127.0.0.1/api/healthz" >/dev/null; then break; fi
    [[ "$attempt" -eq 30 ]] && { docker compose --env-file .env logs --tail=120 api postgres ocr; exit 1; }
    sleep 2
  done
else
  docker compose --env-file .env exec -T api python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/healthz", timeout=5).read()'
fi

if [[ "$DO_SEED" == "1" ]]; then
  [[ -s .workbook.xlsx && -s .import-password ]] || { echo "seed inputs are missing" >&2; exit 1; }
  chmod 600 .workbook.xlsx .import-password
  IMPORT_WORKBOOK_PASSWORD="$(cat .import-password)"
  docker compose --env-file .env run --rm --no-deps \
    -v "$PWD/.workbook.xlsx:/app/.workbook.xlsx:ro" \
    -e IMPORT_WORKBOOK_PASSWORD="$IMPORT_WORKBOOK_PASSWORD" \
    api python /app/scripts/seed_inventory.py \
      --input /app/.workbook.xlsx --password-env IMPORT_WORKBOOK_PASSWORD --apply
  unset IMPORT_WORKBOOK_PASSWORD
  rm -f .workbook.xlsx .import-password
fi

echo "Deployment complete: http://$PUBLIC_HOST"
echo "Remote dotenv: $REMOTE_DIR/.env (mode 600)"
REMOTE_SCRIPT
