#!/bin/bash
# ============================================================
# 在有网络的 Linux 机器上运行，生成 offline-bundle/ 目录
#
# 用法:
#   bash scripts/prepare-offline-bundle.sh              # 全量（Node 包 + npm 归档 + wheels）
#   bash scripts/prepare-offline-bundle.sh --wheels-only  # 仅 Python wheels（pack-offline 常用）
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/offline-bundle"
MODE="${1:-full}"
NODE_MAJOR="${NODE_MAJOR:-18}"
NODE_VERSION="${NODE_VERSION:-18.20.8}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NODE_ARCH=linux-x64 ;;
  aarch64|arm64) NODE_ARCH=linux-arm64 ;;
  *)
    echo "[ERROR] 不支持的架构: $ARCH（仅 linux-x64 / linux-arm64）"
    exit 1
    ;;
esac

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "[ERROR] 缺少命令: $1"; exit 1; }
}

resolve_pip_python() {
  if [ -x "$ROOT/deps/python/bin/python3.9" ]; then
    echo "$ROOT/deps/python/bin/python3.9"
    return 0
  fi
  if command -v python3.9 >/dev/null 2>&1; then
    command -v python3.9
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    local ver
    ver="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
    if [ "$ver" = "3.9" ]; then
      command -v python3
      return 0
    fi
  fi
  echo "[ERROR] 需要 Python 3.9 用于下载 cp39 wheel。请先: bash scripts/ensure-deps-python39.sh"
  exit 1
}

download_wheels() {
  local py
  py="$(resolve_pip_python)"
  echo "[INFO] 使用 $($py --version 2>&1) 下载 wheels -> $OUT/python/wheels"
  mkdir -p "$OUT/python/wheels"
  "$py" -m pip install -q --upgrade pip 2>/dev/null || true

  local ok=0
  for req in \
    "$ROOT/backend/sql-optimizer-agent/requirements.txt" \
    "$ROOT/backend/ai-ops-agent/requirements.txt"; do
    [ -f "$req" ] || continue
    echo "[INFO] pip download -r $req"
    if "$py" -m pip download -r "$req" -d "$OUT/python/wheels" \
        --platform manylinux2014_x86_64 --python-version 39 --only-binary=:all: 2>/dev/null; then
      ok=1
    elif "$py" -m pip download -r "$req" -d "$OUT/python/wheels" \
        --platform manylinux2014_x86_64 --python-version 39; then
      ok=1
    else
      echo "[WARN] 部分包无 manylinux wheel，尝试通用 download ..."
      "$py" -m pip download -r "$req" -d "$OUT/python/wheels" && ok=1 || true
    fi
  done

  if ! ls "$OUT/python/wheels"/*.whl >/dev/null 2>&1; then
    echo "[ERROR] $OUT/python/wheels 下没有 .whl 文件，pip 下载失败"
    exit 1
  fi
  local n
  n="$(find "$OUT/python/wheels" -name '*.whl' | wc -l)"
  echo "[OK] wheels 数量: $n"
}

download_node() {
  local tar="node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz"
  local dest="$OUT/$tar"
  local urls=(
    "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${tar}"
    "https://nodejs.org/dist/v${NODE_VERSION}/${tar}"
  )
  for url in "${urls[@]}"; do
    echo "  GET $url"
    if curl -fsSL --connect-timeout 20 --max-time 600 "$url" -o "$dest"; then
      [ -s "$dest" ] && return 0
    fi
    rm -f "$dest"
  done
  echo "[ERROR] 无法下载 Node.js"
  exit 1
}

pack_npm_project() {
  local name="$1" src="$2"
  local tmp="$OUT/staging/$name"
  echo "[INFO] 打包 $name npm 依赖..."
  rm -rf "$tmp"
  mkdir -p "$tmp"
  cp "$src/package.json" "$tmp/"
  [ -f "$src/package-lock.json" ] && cp "$src/package-lock.json" "$tmp/"
  (
    cd "$tmp"
    npm install --no-audit --no-fund
    tar -czf "$OUT/archives/${name}-node_modules.tgz" node_modules
  )
}

if [ "$MODE" = "--wheels-only" ] || [ "$MODE" = "wheels-only" ]; then
  echo "============================================"
  echo "  仅下载 Python wheels -> $OUT/python/wheels"
  echo "============================================"
  need_cmd curl
  download_wheels
  exit 0
fi

if [ -x "$ROOT/deps/node/bin/node" ]; then
  export PATH="$ROOT/deps/node/bin:$PATH"
fi

need_cmd curl
need_cmd tar
need_cmd node
need_cmd npm

NODE_VER="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ "$NODE_VER" -lt "$NODE_MAJOR" ]; then
  echo "[WARN] 当前 Node $(node -v) 较旧，建议 Node >= ${NODE_MAJOR}"
fi

echo "============================================"
echo "  准备离线依赖包 -> $OUT"
echo "  架构: $NODE_ARCH"
echo "============================================"

rm -rf "$OUT"
mkdir -p "$OUT/archives" "$OUT/npm-cache" "$OUT/python/wheels" "$OUT/staging"

echo "[1/5] 下载 Node.js ${NODE_VERSION} (${NODE_ARCH})..."
download_node

echo "[2/5] 打包 backend npm 依赖..."
export NPM_CONFIG_CACHE="$OUT/npm-cache"
pack_npm_project backend "$ROOT/backend"

echo "[3/5] 打包 frontend npm 依赖..."
pack_npm_project frontend "$ROOT/frontend"

echo "[4/5] 下载 Python wheels..."
download_wheels

rm -rf "$OUT/staging"

cat > "$OUT/MANIFEST.txt" <<EOF
DIOps offline-bundle
Node: v${NODE_VERSION} ${NODE_ARCH}
Created: $(date -Iseconds)
Host: $(uname -a)

目录说明:
  node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz   Node.js 二进制包
  npm-cache/                     npm 缓存
  archives/backend-node_modules.tgz
  archives/frontend-node_modules.tgz
  python/wheels/                 pip 离线包（cp39）

离线服务器启动:
  ./start-all.sh start
EOF

echo "[5/5] 完成."
echo ""
echo "打包拷贝示例:"
echo "  tar -czf diops-offline-bundle.tgz -C $(dirname "$OUT") $(basename "$OUT")"
du -sh "$OUT" 2>/dev/null || true
