#!/bin/bash
# 方案 A：Java :3000（主 API + 监控采集）+ Node :3001（兼容接口）+ Python 模块 + HTTPS 网关
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

if [ ! -f certs/server.crt ] || [ ! -x modules/sql-optimizer/venv/bin/python ]; then
  echo "[ERROR] 请先执行 ./bin/install.sh"
  exit 1
fi
if [ ! -f config/backend.env ]; then
  echo "[ERROR] 缺少 config/backend.env"
  exit 1
fi

cp -f config/backend.env backend/.env
for m in sql-optimizer ai-ops; do
  [ -d "modules/$m" ] && cp -f config/backend.env "modules/$m/.env"
done

set -a
# shellcheck disable=SC1091
source "$ROOT/config/backend.env"
set +a

export PATH="$ROOT/runtime/node/bin:$PATH"
JAVA_PORT="${JAVA_PORT:-3000}"
NODE_PORT="${NODE_PORT:-3001}"
export HTTPS_PORT="${HTTPS_PORT:-18443}"
export BIND_HOST="${BIND_HOST:-127.0.0.1}"
export SQL_OPT_HOST="${SQL_OPT_HOST:-127.0.0.1}"
export AI_OPS_HOST="${AI_OPS_HOST:-127.0.0.1}"
export SQL_AGENT_URL="${SQL_AGENT_URL:-http://127.0.0.1:8000}"
export AI_OPS_AGENT_URL="${AI_OPS_AGENT_URL:-http://127.0.0.1:8001}"
export BACKEND_URL="http://127.0.0.1:${JAVA_PORT}"
export NODE_ENV="${NODE_ENV:-production}"
export TZ="${DBOPS_TZ:-Asia/Shanghai}"

JAVA_BIN="$ROOT/runtime/jre/bin/java"
JAR="$ROOT/app/dbops-server.jar"
if [ ! -x "$JAVA_BIN" ] || [ ! -f "$JAR" ]; then
  echo "[ERROR] 缺少 runtime/jre 或 app/dbops-server.jar"
  exit 1
fi

urls=()
for ip in 127.0.0.1 $(hostname -I 2>/dev/null || true); do
  case "$ip" in
    *:*) continue ;;
  esac
  if [ "$HTTPS_PORT" = "443" ]; then
    urls+=("https://${ip}")
  fi
  urls+=("https://${ip}:${HTTPS_PORT}")
done
export FRONTEND_URL
FRONTEND_URL="$(IFS=,; echo "${urls[*]}")"

pidfile() { echo "$ROOT/logs/$1.pid"; }

running() {
  local f
  f="$(pidfile "$1")"
  [ -f "$f" ] || return 1
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null
}

start_bg() {
  local name="$1"
  shift
  if running "$name"; then
    echo "[OK] $name 已在运行 PID=$(cat "$(pidfile "$name")")"
    return 0
  fi
  setsid "$@" >>"$ROOT/logs/${name}.log" 2>&1 < /dev/null &
  echo $! >"$(pidfile "$name")"
  echo "[OK] $name PID=$(cat "$(pidfile "$name")")  日志 logs/${name}.log"
}

# Node 兼容层（关闭监控调度，避免与 Java 重复采集）
start_bg node-legacy bash -c "cd '$ROOT/backend' && PORT='$NODE_PORT' BIND_HOST=127.0.0.1 MONITOR_SCHEDULER_ENABLED=false TRUST_PROXY=1 \
  JAVA_SERVER_URL='http://127.0.0.1:${JAVA_PORT}' exec '$ROOT/runtime/node/bin/node' app.js"

# Java 主服务
start_bg dbops-java bash -c "DBOPS_ENV_FILE='$ROOT/backend/.env' PORT='$JAVA_PORT' LEGACY_NODE_URL='http://127.0.0.1:${NODE_PORT}' \
  exec '$JAVA_BIN' -Duser.timezone='$TZ' -Xms256m -Xmx1g -jar '$JAR'"

sleep 2
start_bg sql-optimizer bash -c "cd '$ROOT/modules/sql-optimizer' && exec ./venv/bin/python app.py"
start_bg ai-ops bash -c "cd '$ROOT/modules/ai-ops' && exec ./venv/bin/python app.py"
start_bg gateway "$ROOT/runtime/node/bin/node" "$ROOT/bin/gateway.js"

echo
echo "访问: https://本机IP:${HTTPS_PORT}/"
echo "API/健康: Java :${JAVA_PORT}（网关已反代 /api 与 /health）"
echo "版本: $(cat "$ROOT/VERSION" 2>/dev/null || echo 未知)"
echo "停止: ./bin/stop.sh"
