#!/usr/bin/env bash
# 本地快速启动：先校验 .env 不含占位密码/令牌，再 docker compose up。
# 防止照抄 .env.example 的 change-me 值把弱口令数据库/账号起在有公网 IP 的机器上。
# 用法：scripts/dev_up.sh [docker compose up 参数...]（如 --build）
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "缺少 .env：请先 cp .env.example .env，并为所有密码和令牌设置随机值。" >&2
  exit 1
fi

placeholders=$(grep -n "change-me" .env || true)
if [[ -n "$placeholders" ]]; then
  echo "检测到 .env 仍含占位密码/令牌（change-me），拒绝启动：" >&2
  echo "$placeholders" >&2
  echo "请为这些变量设置随机值后重试。" >&2
  exit 1
fi

exec docker compose up "$@"
