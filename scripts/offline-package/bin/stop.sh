#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

stop_one() {
  local name="$1"
  local f="$ROOT/logs/${name}.pid"
  if [ ! -f "$f" ]; then
    echo "[INFO] $name 无 pid 文件"
    return 0
  fi
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 0.5
    kill -9 "$pid" 2>/dev/null || true
    echo "[OK] $name 已停止 (PID $pid)"
  else
    echo "[INFO] $name 未在运行"
  fi
  rm -f "$f"
}

stop_one gateway
stop_one ai-ops
stop_one sql-optimizer
stop_one dbops-java
stop_one node-legacy
echo "[OK] 已停止"
