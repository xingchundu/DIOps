#!/bin/bash
# 离线安装：证书、Python 模块 venv、同步 config -> backend/.env、可选自检
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs certs backend/data/backup backend/reports app

PY="$ROOT/runtime/python/bin/python3.9"
NODE="$ROOT/runtime/node/bin/node"
JAVA="$ROOT/runtime/jre/bin/java"
if [ ! -x "$PY" ] || [ ! -x "$NODE" ]; then
  echo "[ERROR] runtime/node 或 runtime/python 不完整"
  exit 1
fi
if [ ! -x "$JAVA" ]; then
  echo "[ERROR] 缺少 runtime/jre（JDK 17）"
  exit 1
fi
if [ ! -f "$ROOT/app/dbops-server.jar" ]; then
  echo "[ERROR] 缺少 app/dbops-server.jar"
  exit 1
fi
if [ ! -f config/backend.env ]; then
  echo "[ERROR] 请先编辑 config/backend.env（数据库地址、用户、密码）"
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "[ERROR] 系统未安装 openssl，无法生成本机证书"
  exit 1
fi

# 同步客户配置到 Node / Java / Python 模块
sync_customer_env() {
  cp -f config/backend.env backend/.env
  for m in sql-optimizer ai-ops; do
    [ -d "modules/$m" ] && cp -f config/backend.env "modules/$m/.env"
  done
}
sync_customer_env

set -a
# shellcheck disable=SC1091
source config/backend.env
set +a

if [ -z "${JWT_SECRET:-}" ] || [[ "$JWT_SECRET" == *请换* ]] || [ "${#JWT_SECRET}" -lt 16 ]; then
  JWT_SECRET="$(openssl rand -hex 24)"
  if grep -q '^JWT_SECRET=' config/backend.env; then
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" config/backend.env
  else
    echo "JWT_SECRET=${JWT_SECRET}" >> config/backend.env
  fi
  sync_customer_env
  echo "[OK] 已自动生成 JWT_SECRET 并写入 config/backend.env"
fi

if ! grep -q '^DIOPS_REQUIRE_GATEWAY=' config/backend.env 2>/dev/null; then
  echo "DIOPS_REQUIRE_GATEWAY=true" >> config/backend.env
  echo "[OK] 已写入 DIOPS_REQUIRE_GATEWAY=true"
fi

if [ ! -f certs/server.crt ] || [ ! -f certs/server.key ]; then
  sans="DNS:localhost,IP:127.0.0.1"
  for ip in $(hostname -I 2>/dev/null || true); do
    case "$ip" in
      *:*) ;;
      *) sans="${sans},IP:${ip}" ;;
    esac
  done
  echo "[INFO] 生成本机 HTTPS 证书 ..."
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout certs/server.key \
    -out certs/server.crt \
    -subj "/CN=diops" \
    -addext "subjectAltName=${sans}"
  chmod 600 certs/server.key
  echo "[OK] 证书: certs/server.crt"
else
  echo "[OK] 证书已存在，跳过"
fi

if [ -d "$ROOT/backend/node_modules/.bin" ]; then
  find "$ROOT/backend/node_modules/.bin" -type f -exec chmod a+x {} +
fi
find "$ROOT/backend/node_modules" -type f -name esbuild -exec chmod a+x {} + 2>/dev/null || true

install_module() {
  local name="$1"
  local dir="$ROOT/modules/$name"
  [ -f "$dir/requirements.txt" ] || return 0
  echo "[INFO] 安装模块 $name （离线 wheel）..."
  rm -rf "$dir/venv"
  "$PY" -m venv "$dir/venv"
  "$dir/venv/bin/python" -m pip install -q --no-index \
    --find-links="$ROOT/runtime/wheels" \
    -r "$dir/requirements.txt"
  echo "[OK] $name"
}

install_module sql-optimizer
install_module ai-ops

echo "[INFO] 检测平台库连接 ..."
if ! (cd "$ROOT/backend" && "$NODE" -e "
require('dotenv').config();
const oracledb = require('oracledb');
const cs = process.env.DB_CONNECT_STRING
  || (process.env.DB_HOST && (process.env.DB_SERVICE_NAME
    ? process.env.DB_HOST+':'+(process.env.DB_PORT||1521)+'/'+process.env.DB_SERVICE_NAME
    : process.env.DB_SID
      ? process.env.DB_HOST+':'+(process.env.DB_PORT||1521)+'/'+process.env.DB_SID
      : ''));
if (!cs || !process.env.DB_USER) { console.error('DB 配置不完整'); process.exit(1); }
(async()=>{
  const c = await oracledb.getConnection({ user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectString: cs });
  await c.execute('SELECT 1 AS OK FROM DUAL');
  await c.close();
  console.log('平台库连接成功 ->', cs);
})().catch(e=>{ console.error('平台库连接失败:', e.message); process.exit(1); });
"); then
  echo "[WARN] 平台库未连通。请确认 init.sql 已执行且 config/backend.env 正确，然后再 start"
fi

chmod +x "$ROOT/bin/"*.sh "$ROOT/runtime/node/bin/"* "$ROOT/runtime/python/bin/"* "$ROOT/runtime/jre/bin/"* 2>/dev/null || true
echo
echo "[OK] 安装完成。启动: ./bin/start.sh   状态: ./bin/status.sh   停止: ./bin/stop.sh"
