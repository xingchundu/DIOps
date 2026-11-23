#!/bin/bash
# 将 CPython 3.9 安装到 deps/python（供 pack-offline.sh 打入客户包；离线 wheel 为 cp39）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="$ROOT/deps"
PY="$DEPS/python/bin/python3.9"

if [ -x "$PY" ]; then
  echo "[OK] 已存在 $PY ($("$PY" --version 2>&1))"
  exit 0
fi

# 若系统有 python3.9 且可导入 venv，可把 prefix 拷入 deps/python（少见，优先用独立包）
if command -v python3.9 >/dev/null 2>&1; then
  ver="$(python3.9 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
  if [ "$ver" = "3.9" ]; then
    echo "[INFO] 检测到系统 python3.9；客户包仍需独立 prefix，将下载 install_only 到 deps/python"
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "[ERROR] 需要 curl 以下载 Python 3.9"
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "[ERROR] 需要 tar"
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="x86_64-unknown-linux-gnu" ;;
  aarch64|arm64) ARCH="aarch64-unknown-linux-gnu" ;;
  *)
    echo "[ERROR] 不支持的 CPU 架构: $(uname -m)"
    exit 1
    ;;
esac

PY_VERSION="3.9.20"
PY_TAG="20241016"
TAR="cpython-${PY_VERSION}+${PY_TAG}-${ARCH}-install_only.tar.gz"
URL="https://github.com/indygreg/python-build-standalone/releases/download/${PY_TAG}/${TAR}"
DEST="$DEPS/$TAR"

mkdir -p "$DEPS"
echo "[INFO] 下载 Python ${PY_VERSION} -> deps/python"
echo "       $URL"
if ! curl -fsSL --connect-timeout 30 --retry 3 --retry-delay 5 -o "$DEST" "$URL"; then
  echo "[ERROR] 下载失败。可手工下载解压到 deps/python，保证存在 deps/python/bin/python3.9"
  exit 1
fi

rm -rf "$DEPS/python"
tar -xzf "$DEST" -C "$DEPS"
rm -f "$DEST"

if [ ! -d "$DEPS/python" ]; then
  found="$(find "$DEPS" -maxdepth 2 -type d -name 'python' | head -1)"
  if [ -n "$found" ] && [ "$found" != "$DEPS/python" ]; then
    mv "$found" "$DEPS/python"
  fi
fi

if [ ! -x "$PY" ]; then
  echo "[ERROR] 解压后未找到 $PY"
  exit 1
fi

chmod +x "$DEPS/python/bin/"* 2>/dev/null || true
echo "[OK] $PY ($("$PY" --version 2>&1))"
