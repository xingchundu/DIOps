#!/bin/bash
# 启动前依赖自检：Node/npm 项目依赖、Python 3.9+（SQL/AI Agent）
# 缺则自动执行 scripts/install-deps.sh（有 offline-bundle 则离线，否则联网）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="$ROOT/deps"
BUNDLE="$ROOT/offline-bundle"

if [ -x "$DEPS/node/bin/node" ]; then
  export PATH="$DEPS/node/bin:$PATH"
fi
if [ -d "$DEPS/npm-cache" ]; then
  export NPM_CONFIG_CACHE="$DEPS/npm-cache"
elif [ -d "$BUNDLE/npm-cache" ]; then
  export NPM_CONFIG_CACHE="$BUNDLE/npm-cache"
fi

_agent_python_ok() {
  local c bin ver
  for c in "$DEPS/python/bin/python3.9" "$DEPS/python/bin/python3" python3.9 python3; do
    if [ -x "$c" ]; then bin="$c"
    elif command -v "$c" >/dev/null 2>&1; then bin="$(command -v "$c")"
    else continue
    fi
    ver="$("$bin" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
    case "$ver" in
      3.9|3.10|3.11|3.12) return 0 ;;
    esac
  done
  return 1
}

_needs_agents() {
  [ -f "$ROOT/backend/sql-optimizer-agent/app.py" ] || [ -f "$ROOT/backend/ai-ops-agent/app.py" ]
}

need_node=0
need_install=0

if ! command -v node >/dev/null 2>&1; then
  need_node=1
  need_install=1
fi
if [ ! -d "$ROOT/backend/node_modules" ] || [ ! -d "$ROOT/frontend/node_modules" ]; then
  need_install=1
fi
if _needs_agents && ! _agent_python_ok; then
  need_install=1
fi

if [ "$need_install" = "0" ]; then
  return 0 2>/dev/null || exit 0
fi

if [ ! -f "$ROOT/scripts/install-deps.sh" ]; then
  echo "[WARN] 缺少 scripts/install-deps.sh，跳过自动安装依赖"
  exit 0
fi

echo "[INFO] 检测到依赖不完整，自动执行 scripts/install-deps.sh ..."
set +e
if [ -d "$BUNDLE" ] && { [ -x "$BUNDLE/node/bin/node" ] || [ -n "$(find "$BUNDLE" -maxdepth 1 -name 'node-v*.tar.xz' 2>/dev/null | head -1)" ]; }; then
  bash "$ROOT/scripts/install-deps.sh" --offline
  ec=$?
  [ "$ec" -ne 0 ] && bash "$ROOT/scripts/install-deps.sh" auto
else
  bash "$ROOT/scripts/install-deps.sh" auto
fi
set -e

if [ -x "$DEPS/node/bin/node" ]; then
  export PATH="$DEPS/node/bin:$PATH"
fi

if [ "$need_node" = "1" ] && ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] 自动安装后仍无 Node.js，请查看 install-deps 输出"
  exit 1
fi

if _needs_agents && ! _agent_python_ok; then
  echo "[WARN] 仍未找到 Python 3.9+（SQL 深度优化 / AI Agent 可能不可用）"
  echo "       有网: 安装 python39 或将解释器放到 deps/python/bin/python3.9"
  echo "       离线: 准备 offline-bundle/ 后 bash scripts/install-deps.sh --offline"
fi
