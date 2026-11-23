#!/bin/bash
# ============================================================
# DIOps Linux 依赖安装（Node.js / npm / Python / 可选 Agent）
#
# 用法:
#   bash scripts/install-deps.sh              # 自动：有 offline-bundle 则离线，否则联网
#   bash scripts/install-deps.sh --online     # 强制联网安装
#   bash scripts/install-deps.sh --offline    # 强制使用 offline-bundle/
#
# 离线准备（在有网 Linux x64 上）:
#   bash scripts/prepare-offline-bundle.sh
#   将 offline-bundle/ 拷到目标机后 --offline 安装
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="$ROOT/deps"
BUNDLE="$ROOT/offline-bundle"
NODE_VERSION="${NODE_VERSION:-18.20.8}"
MODE="${1:-auto}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

has_network() {
  curl -fsS --connect-timeout 3 https://nodejs.org/dist/index.json >/dev/null 2>&1
}

node_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo linux-x64 ;;
    aarch64|arm64) echo linux-arm64 ;;
    *) echo "unsupported" ;;
  esac
}

ensure_path() {
  if [ -x "$DEPS/node/bin/node" ]; then
    export PATH="$DEPS/node/bin:$PATH"
  fi
  if [ -d "$DEPS/npm-cache" ]; then
    export NPM_CONFIG_CACHE="$DEPS/npm-cache"
  fi
}

install_node_from_tar() {
  local src="$1"
  mkdir -p "$DEPS"
  rm -rf "$DEPS/node"
  if [ -d "$src" ] && [ -x "$src/bin/node" ]; then
    mkdir -p "$DEPS/node"
    cp -a "$src/." "$DEPS/node/"
  elif [ -f "$src" ]; then
    if ! command -v tar >/dev/null 2>&1; then
      err "缺少 tar 命令，无法解压 Node 包"
      return 1
    fi
    echo "[INFO] 解压 Node 包: $src"
    if ! tar -xJf "$src" -C "$DEPS"; then
      err "解压失败（可能需要 xz：yum install xz / apt install xz-utils）"
      return 1
    fi
    local extracted
    extracted="$(find "$DEPS" -maxdepth 1 -type d -name 'node-v*' | head -1)"
    if [ -z "$extracted" ]; then
      err "解压后未找到 node-v* 目录"
      return 1
    fi
    mv "$extracted" "$DEPS/node"
  else
    err "无效的 Node 包: $src"
    return 1
  fi
  if [ ! -x "$DEPS/node/bin/node" ]; then
    err "Node 安装失败（未找到 $DEPS/node/bin/node，请确认 offline-bundle 与服务器架构一致，如 linux-x64）"
    return 1
  fi
  log "Node.js -> $DEPS/node ($( "$DEPS/node/bin/node" --version ))"
}

install_node_online() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [ "$major" -ge 18 ]; then
      log "系统已有 Node $(node --version)，跳过安装"
      return 0
    fi
    warn "系统 Node $(node --version) 版本 < 18，将安装独立 Node 到 deps/node"
  fi

  local arch tar url
  arch="$(node_arch)"
  [ "$arch" != "unsupported" ] || { err "不支持的 CPU 架构"; exit 1; }

  tar="node-v${NODE_VERSION}-${arch}.tar.xz"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${tar}"
  mkdir -p "$DEPS"
  echo "[INFO] 下载 $url ..."
  curl -fsSL "$url" -o "$DEPS/$tar"
  install_node_from_tar "$DEPS/$tar"
  rm -f "$DEPS/$tar"
}

install_node_offline() {
  if [ -x "$DEPS/node/bin/node" ] && [ -x "$DEPS/node/bin/npm" ]; then
    log "deps/node 已存在: $( "$DEPS/node/bin/node" --version )"
    return 0
  fi
  local f
  f="$(find "$BUNDLE" -maxdepth 1 -name 'node-v*.tar.xz' 2>/dev/null | head -1)"
  if [ -n "$f" ]; then
    install_node_from_tar "$f"
    return
  fi
  if [ -x "$BUNDLE/node/bin/node" ]; then
    install_node_from_tar "$BUNDLE/node"
    return
  fi
  err "离线包中未找到 Node。请先运行 scripts/prepare-offline-bundle.sh"
  exit 1
}

install_system_packages_online() {
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y curl tar xz python3 python3-pip openssl 2>/dev/null || \
      warn "dnf 安装部分系统包失败，请手动安装 python3/openssl/curl"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl tar xz python3 python3-pip openssl 2>/dev/null || \
      warn "yum 安装部分系统包失败，请手动安装 python3/openssl/curl"
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y curl tar xz-utils python3 python3-pip python3-venv openssl ca-certificates
  else
    warn "未识别包管理器，请确保已安装: curl tar python3 openssl"
  fi
}

restore_npm_modules() {
  local name="$1" dir="$2" archive="$3"
  if [ -f "$archive" ]; then
    echo "[INFO] 解压 $name node_modules ..."
    rm -rf "$dir/node_modules"
    tar -xzf "$archive" -C "$dir"
    # Windows 打出来的包常把 .bin 存成 0666，Linux 上会 Permission denied
    if [ -d "$dir/node_modules/.bin" ]; then
      find "$dir/node_modules/.bin" -type f -exec chmod a+x {} +
    fi
    find "$dir/node_modules" -type f -name esbuild -exec chmod a+x {} +
    log "$name node_modules 已从离线包恢复"
    return 0
  fi
  return 1
}

install_npm_project() {
  local name="$1" dir="$2"
  local offline_tgz="$BUNDLE/archives/${name}-node_modules.tgz"
  [ -d "$DEPS/npm-cache" ] && export NPM_CONFIG_CACHE="$DEPS/npm-cache"
  [ -d "$BUNDLE/npm-cache" ] && export NPM_CONFIG_CACHE="$BUNDLE/npm-cache"

  if [ "$MODE" = "offline" ] || { [ "$MODE" = "auto" ] && [ -d "$BUNDLE" ]; }; then
    if restore_npm_modules "$name" "$dir" "$offline_tgz"; then
      return 0
    fi
  fi

  echo "[INFO] npm install ($name) ..."
  local flags=(--no-audit --no-fund)
  [ -d "${NPM_CONFIG_CACHE:-}" ] && flags+=(--prefer-offline)
  (cd "$dir" && npm install "${flags[@]}")
  log "$name npm 依赖已安装"
}

# 离线二进制 wheel 是 cp39，只能用 CPython 3.9。优先项目内 deps/python。
try_install_system_python39() {
  if [ "${DIOPS_SKIP_PY39_INSTALL:-}" = "1" ]; then return 1; fi
  echo "[INFO] 尝试安装 Python 3.9（系统包）..."
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y python39 python39-pip 2>/dev/null || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python39 python39-pip 2>/dev/null || true
  elif command -v apt-get >/dev/null 2>&1; then
  apt-get install -y python3.9 python3.9-venv python3.9-dev 2>/dev/null || true
  fi
}

python39_bin() {
  local c bin ver
  for c in "$DEPS/python/bin/python3.9" "$DEPS/python/bin/python3" python3.9; do
    if [ -x "$c" ]; then
      bin="$c"
    elif command -v "$c" >/dev/null 2>&1; then
      bin="$(command -v "$c")"
    else
      continue
    fi
    ver="$("$bin" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
    if [ "$ver" = "3.9" ]; then
      echo "$bin"
      return 0
    fi
  done
  return 1
}

install_python_agent() {
  local agent_dir="$1" label="$2" py="$3"
  [ -f "$agent_dir/requirements.txt" ] || return 0
  [ -f "$agent_dir/app.py" ] || return 0

  echo "[INFO] 配置 $label ..."
  (
    cd "$agent_dir"
    # Windows 拷来的 venv 只有 Scripts/activate，没有 bin/activate
    if [ ! -f venv/bin/activate ] || [ ! -x venv/bin/python ]; then
      if [ -d venv ]; then
        echo "[WARN] $label 的 venv 不是 Linux 虚拟环境，删除后用 $py 重建"
        rm -rf venv
      fi
      "$py" -m venv venv
    fi
    # shellcheck disable=SC1091
    source venv/bin/activate
    if [ -d "$BUNDLE/python/wheels" ] && ls "$BUNDLE/python/wheels"/*.whl >/dev/null 2>&1; then
      pip install -q --no-index --find-links="$BUNDLE/python/wheels" -r requirements.txt
    else
      pip install -q -r requirements.txt
    fi
  )
  log "$label Python 依赖已安装"
}

resolve_mode() {
  case "$MODE" in
    --online|online) echo online ;;
    --offline|offline) echo offline ;;
    auto|"")
      if [ -d "$BUNDLE" ] && { [ -x "$BUNDLE/node/bin/node" ] || [ -n "$(find "$BUNDLE" -maxdepth 1 -name 'node-v*.tar.xz' 2>/dev/null | head -1)" ]; }; then
        echo offline
      elif has_network; then
        echo online
      elif [ -d "$BUNDLE" ]; then
        echo offline
      else
        err "无法访问外网且未找到 offline-bundle/，请先准备离线包或配置网络"
        exit 1
      fi
      ;;
    -h|--help|help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      err "未知参数: $MODE"
      echo "用法: bash scripts/install-deps.sh [--online|--offline|auto]"
      exit 1
      ;;
  esac
}

main() {
  MODE="$(resolve_mode)"
  echo "============================================"
  echo "  DIOps 依赖安装  模式: $MODE"
  echo "============================================"
  echo

  if [ "$MODE" = "online" ]; then
    install_system_packages_online
    install_node_online
  else
    install_node_offline
    mkdir -p "$DEPS/npm-cache"
    [ -d "$BUNDLE/npm-cache" ] && cp -a "$BUNDLE/npm-cache/." "$DEPS/npm-cache/" 2>/dev/null || true
  fi

  ensure_path
  command -v node >/dev/null 2>&1 || { err "Node 仍不可用"; exit 1; }
  command -v npm >/dev/null 2>&1 || { err "npm 不可用"; exit 1; }

  log "Node $(node --version)  npm $(npm --version)"

  install_npm_project backend "$ROOT/backend"
  install_npm_project frontend "$ROOT/frontend"

  local py39=""
  if ! py39="$(python39_bin 2>/dev/null)"; then
    if [ "$MODE" = "online" ]; then
      try_install_system_python39
      py39="$(python39_bin 2>/dev/null || true)"
    fi
  fi

  if [ -n "$py39" ]; then
    log "Python Agent 解释器: $py39 ($("$py39" --version 2>&1))"
    install_python_agent "$ROOT/backend/sql-optimizer-agent" "SQL Optimizer" "$py39"
    install_python_agent "$ROOT/backend/ai-ops-agent" "AI Ops Agent" "$py39"
  elif [ "$MODE" = "offline" ] || [ -d "$BUNDLE/python/wheels" ]; then
    err "SQL Optimizer / AI Ops Agent 需要 CPython 3.9（离线 wheel 为 cp39）。"
    err "当前系统: $(python3 --version 2>/dev/null || echo 未安装 python3)"
    err "请安装 python3.9，或将解释器放到 deps/python/bin/python3.9 后重试。"
    exit 1
  else
    warn "未找到 Python 3.9，SQL/AI Agent 将在下次 start 时再次尝试安装（可手动: dnf install python39）"
  fi

  echo
  log "依赖安装完成。启动平台:"
  echo "  ./start-all.sh start"
  echo
  echo "Node 路径: $(command -v node)"
  if [ -x "$DEPS/node/bin/node" ]; then
    echo "（使用项目 deps/node，已写入 deps/ 目录）"
  fi
}

main
