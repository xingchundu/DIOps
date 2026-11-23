#!/usr/bin/env bash
# 首次启动时为 backend/.env 生成强随机密钥（已存在且足够长时不改动）：
#   JWT_SECRET          登录令牌签名（Java / Node 共用）
#   DBOPS_SECRET_KEY    被管库密码、SSH 凭据的 AES-GCM 加密密钥 —— 生成后请备份，丢失将无法解密已保存的密码
#   AI_INTERNAL_TOKEN   平台调用 Python AI 服务的内部令牌
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/backend/.env"
touch "$ENV_FILE"
gen() { head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | head -c 48; }
weak() { case "$1" in ''|dbops_secret|dbops_platform_secret_2026|请换成*) return 0;; esac; [ "${#1}" -lt 16 ]; }
for k in JWT_SECRET DBOPS_SECRET_KEY AI_INTERNAL_TOKEN; do
  cur="$(grep -E "^${k}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r' || true)"
  if weak "$cur"; then
    sed -i.bak "/^${k}=/d" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    echo "${k}=$(gen)" >> "$ENV_FILE"
    echo "[secrets] 已生成 ${k}（保存在 backend/.env）"
    [ "$k" = "DBOPS_SECRET_KEY" ] && echo "[secrets] 请备份 DBOPS_SECRET_KEY：丢失后已保存的被管库密码无法解密"
  fi
done
chmod 600 "$ENV_FILE" 2>/dev/null || true
