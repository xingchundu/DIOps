#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$ROOT/config/backend.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/config/backend.env"
  set +a
fi
JAVA_PORT="${JAVA_PORT:-3000}"
HTTPS_PORT="${HTTPS_PORT:-18443}"

pid() {
  local f="$ROOT/logs/$1.pid"
  if [ -f "$f" ] && kill -0 "$(cat "$f" 2>/dev/null)" 2>/dev/null; then
    echo "running (pid $(cat "$f"))"
  else
    echo "stopped"
  fi
}

echo "DIOps 版本: $(cat "$ROOT/VERSION" 2>/dev/null || echo 未知)"
echo "  gateway:       $(pid gateway)"
echo "  dbops-java:    $(pid dbops-java)"
echo "  node-legacy:   $(pid node-legacy)"
echo "  sql-optimizer: $(pid sql-optimizer)"
echo "  ai-ops:        $(pid ai-ops)"
echo
if command -v curl >/dev/null 2>&1; then
  curl -fsS -m 3 "http://127.0.0.1:${JAVA_PORT}/health" 2>/dev/null && echo || echo "[WARN] Java 健康检查未通过"
  curl -fsSk -m 3 "https://127.0.0.1:${HTTPS_PORT}/health" 2>/dev/null && echo || echo "[WARN] HTTPS 网关未通过"
fi
