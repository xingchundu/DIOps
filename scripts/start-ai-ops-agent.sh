#!/bin/bash
# AI Ops Agent（Python FastAPI，默认 :8001）— 供 start-all.sh 调用
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=python39-home.sh
. "$ROOT/scripts/python39-home.sh"
LOGD="${LOGD:-$ROOT/logs}"
PIDD="${PIDD:-$LOGD/pids}"
AGENT_DIR="$ROOT/backend/ai-ops-agent"
PID_FILE="$PIDD/ai-ops-agent.pid"
LOG_FILE="$LOGD/ai-ops-agent.log"
INSTALL_LOG="$LOGD/ai-ops-agent-install.log"

mkdir -p "$LOGD" "$PIDD"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

port_up() {
  curl -sf --connect-timeout 2 --max-time 3 "$1" >/dev/null 2>&1
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
  for c in "$DIOPS_PYTHON_HOME/bin/python3.9" "$ROOT/deps/python/bin/python3.9" "$ROOT/deps/python/bin/python3" python3.9 python3; do
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

ai_agent_start() {
  bash "$ROOT/scripts/ensure-platform-deps.sh" || true

  if [ ! -f "$AGENT_DIR/app.py" ] || [ ! -f "$AGENT_DIR/requirements.txt" ]; then
    return 0
  fi
  if port_up "http://127.0.0.1:8001/health"; then
    echo "[OK] AI Ops Agent 已在 8001 端口运行"
    return 0
  fi
  if pid_alive "$PID_FILE"; then
    echo "[OK] AI Ops Agent 进程存在 (pid $(cat "$PID_FILE"))"
    return 0
  fi
  local pycmd
  pycmd="$(resolve_python)"
  if [ -z "$pycmd" ]; then
    echo "[WARN] 需要 Python 3.9+ 才能启动 AI Ops Agent（已尝试 ensure-platform-deps）"
    return 0
  fi
  echo "[INFO] 启动 AI Ops Agent (:8001)，Python=$pycmd"
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
    if port_up "http://127.0.0.1:8001/health"; then
      echo "[OK] AI Ops Agent http://127.0.0.1:8001/health"
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done
  echo "[WARN] AI Ops Agent 启动超时，请查看 $LOG_FILE"
}

ai_agent_stop() {
  if ! pid_alive "$PID_FILE"; then
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill -TERM "$pid" 2>/dev/null || true
  sleep 1
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "[OK] AI Ops Agent stopped"
}

case "${1:-start}" in
  start) ai_agent_start ;;
  stop) ai_agent_stop ;;
  *) echo "用法: $0 start|stop"; exit 1 ;;
esac
