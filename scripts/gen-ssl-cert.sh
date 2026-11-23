#!/bin/bash
# 生成本地/内网 HTTPS 自签名证书（Nginx + Vite 开发共用）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="$(cd "$SCRIPT_DIR/../certs" && pwd)"
KEY_FILE="$CERT_DIR/server.key"
CRT_FILE="$CERT_DIR/server.crt"

mkdir -p "$CERT_DIR"

if [ -f "$KEY_FILE" ] && [ -f "$CRT_FILE" ]; then
  echo "[OK] 证书已存在: $CRT_FILE"
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "[ERROR] 未找到 openssl，请先安装 OpenSSL"
  exit 1
fi

openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout "$KEY_FILE" \
  -out "$CRT_FILE" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:::1"

chmod 600 "$KEY_FILE"
echo "[OK] 已生成自签名证书:"
echo "     $CRT_FILE"
echo "     $KEY_FILE"
