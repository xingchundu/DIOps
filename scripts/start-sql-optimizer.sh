#!/bin/bash
# SQL 优化 Agent（Python FastAPI，默认 :8000）— 供 start-java.sh / start-all.sh 调用
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGD="${LOGD:-$ROOT/logs}"
PIDD="${PIDD:-$LOGD/pids}"
AGENT_DIR="$ROOT/backend/sql-optimizer-agent"
PID_FILE="$PIDD/sql-optimizer.pid"
LOG_FILE="$LOGD/sql-optimizer-backend.log"
INSTALL_LOG="$LOGD/sql-optimizer-backend-install.log"

mkdir -p "$LOGD" "$PIDD"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

port_up() {
  local url="$1"
  curl -sf --connect-timeout 2 --max-time 3 "$url" >/dev/null 2>&1
}

pid_alive() {
  local f="$1"
  [ -f "$f" ] || return 1
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null
}

resolve_python() {
  local c bin ver
  for c in "$ROOT/deps/python/bin/python3.9" "$ROOT/deps/python/bin/python3" python3.9 python3 python; do
    if [ -x "$c" ]; then bin="$c"
    elif command -v "$c" >/dev/null 2>&1; then bin="$(command -v "$c")"
    else continue
    fi
    ver="$("$bin" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
    case "$ver" in
      3.9|3.10|3.11|3.12) echo "$bin"; return 0 ;;
    esac
  done
  echo ""
}

sql_optimizer_start() {
  bash "$ROOT/scripts/ensure-platform-deps.sh" || true

  if [ ! -f "$AGENT_DIR/app.py" ] || [ ! -f "$AGENT_DIR/requirements.txt" ]; then
    echo "[WARN] 未找到 backend/sql-optimizer-agent，跳过 SQL Optimizer"
    return 0
  fi
  if port_up "http://127.0.0.1:8000/api/health"; then
    echo "[OK] SQL Optimizer 已在 8000 端口运行"
    return 0
  fi
  if pid_alive "$PID_FILE"; then
    echo "[OK] SQL Optimizer 进程存在 (pid $(cat "$PID_FILE"))"
    return 0
  fi
  local pycmd
  pycmd="$(resolve_python)"
  if [ -z "$pycmd" ]; then
    echo "[WARN] 需要 Python 3.9+ 才能启动 SQL Optimizer（已自动尝试 install-deps，请检查日志）"
    return 0
  fi
  echo "[INFO] 启动 SQL Optimizer (:8000)，Python=$pycmd"
  setsid bash -c "
    cd '$AGENT_DIR' &&
    if [ ! -f venv/bin/activate ]; then
      echo '[$(ts)] recreate venv' && rm -rf venv && '$pycmd' -m venv venv
    fi &&
    . venv/bin/activate &&
  if ls '$ROOT/offline-bundle/python/wheels'/*.whl >/dev/null 2>&1; then
      python -m pip install -q --no-index --find-links='$ROOT/offline-bundle/python/wheels' -r requirements.txt >>'$INSTALL_LOG' 2>&1
    else
      python -m pip install -r requirements.txt -q >>'$INSTALL_LOG' 2>&1
    fi &&
    echo '[$(ts)] python app.py' &&
    exec python app.py
  " </dev/null >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  local i=0
  while [ "$i" -lt 40 ]; do
    if port_up "http://127.0.0.1:8000/api/health"; then
      echo "[OK] SQL Optimizer API http://127.0.0.1:8000/api/health"
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done
  echo "[WARN] SQL Optimizer 启动超时，请查看 $LOG_FILE"
  return 0
}

sql_optimizer_stop() {
  if ! pid_alive "$PID_FILE"; then
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill -TERM "$pid" 2>/dev/null || true
  local i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
    sleep 0.25
    i=$((i + 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "[OK] SQL Optimizer stopped"
}

sql_optimizer_status() {
  if port_up "http://127.0.0.1:8000/api/health"; then
    echo "  sql-optimizer: running (http://127.0.0.1:8000/api/health)"
  elif pid_alive "$PID_FILE"; then
    echo "  sql-optimizer: pid $(cat "$PID_FILE") (health check failed)"
  else
    echo "  sql-optimizer: stopped"
  fi
}

case "${1:-start}" in
  start) sql_optimizer_start ;;
  stop) sql_optimizer_stop ;;
  status) sql_optimizer_status ;;
  *) echo "用法: $0 start|stop|status"; exit 1 ;;
esac
