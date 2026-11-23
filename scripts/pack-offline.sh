#!/bin/bash
# 生成客户离线安装包（方案 A：Java 主服务 + Node 兼容层 + HTTPS 网关）
#
# 用法：
#   bash scripts/pack-offline.sh              # 默认版本 1.0.0 -> release/diops-offline-1.0.0.tar.gz
#   bash scripts/pack-offline.sh 4.0.1        # 指定版本号
#
# 每次执行本脚本都会用当前工程源码重新打包（勿依赖 release/diops 里旧产物）：
#   - mvn package           -> app/dbops-server.jar（Java 后端）
#   - npm run build         -> frontend/dist（前端静态资源）
#   - merge-init-sql.sh     -> sql/init.sql
#   - rsync backend/        -> 最新 Node 兼容层源码与 node_modules
#   - 打包前删除 release/diops-offline-*.tar.gz 及 release/diops 旧目录
#
# 打包机准备（有网 Linux x64）：
#   bash scripts/prepare-offline-bundle.sh    # offline-bundle、wheels（需本机 python3 用于 pip download）
#   bash scripts/install-deps.sh --online     # deps/node、npm
#   bash scripts/ensure-deps-python39.sh      # deps/python（Python 3.9，与 wheel cp39 一致）
#   准备 deps/jre：JDK 17 解压到 deps/jre（或设置 JAVA_HOME，脚本会尝试拷贝）
#   cd dbops-server && mvn -DskipTests package # 或由本脚本自动构建
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-1.0.0}"
# 版本号仅允许常见 semver 字符，避免 tar 文件名异常
if [[ ! "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]]; then
  echo "[ERROR] 非法版本号: $VERSION"
  exit 1
fi

TPL="$ROOT/scripts/offline-package"
STAGE="$ROOT/release/diops"
ARCHIVE="$ROOT/release/diops-offline-${VERSION}.tar.gz"
JAR_SRC="$ROOT/dbops-server/target/dbops-server.jar"

mkdir -p "$ROOT/release"

clean_old_offline_artifacts() {
  local removed=0
  shopt -s nullglob
  for f in "$ROOT/release"/diops-offline-*.tar.gz; do
    echo "      删除: $(basename "$f")"
    rm -f "$f" "${f}.sha256"
    removed=$((removed + 1))
  done
  shopt -u nullglob
  if [ -d "$STAGE" ]; then
    echo "      删除: release/diops/"
    rm -rf "$STAGE"
  fi
  if [ "$removed" -eq 0 ]; then
    echo "      （无历史 diops-offline-*.tar.gz）"
  fi
}

if [ ! -d "$TPL/bin" ]; then
  echo "[ERROR] 缺少模板目录 scripts/offline-package/"
  exit 1
fi

if [ -x "$ROOT/deps/node/bin/node" ]; then
  export PATH="$ROOT/deps/node/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] 未找到 node/npm。请先执行 bash scripts/install-deps.sh --online"
  exit 1
fi
if [ ! -x "$ROOT/deps/python/bin/python3.9" ]; then
  if [ -f "$ROOT/scripts/ensure-deps-python39.sh" ]; then
    echo "[INFO] 缺少 deps/python/bin/python3.9，尝试自动下载 ..."
    bash "$ROOT/scripts/ensure-deps-python39.sh" || true
  fi
fi
if [ ! -x "$ROOT/deps/python/bin/python3.9" ]; then
  echo "[ERROR] 缺少 deps/python/bin/python3.9（客户包 SQL/AI 模块需要 CPython 3.9，离线 wheel 为 cp39）"
  echo "        修复: bash scripts/ensure-deps-python39.sh"
  echo "        或把 Python 3.9 独立发行版解压到 deps/python，确保可执行 deps/python/bin/python3.9"
  exit 1
fi
wheels_ready() {
  [ -d "$ROOT/offline-bundle/python/wheels" ] && ls "$ROOT/offline-bundle/python/wheels"/*.whl >/dev/null 2>&1
}
if ! wheels_ready; then
  if [ -f "$ROOT/scripts/prepare-offline-bundle.sh" ] && [ -x "$ROOT/deps/python/bin/python3.9" ]; then
    echo "[INFO] 缺少 offline-bundle/python/wheels，自动下载（--wheels-only）..."
    bash "$ROOT/scripts/prepare-offline-bundle.sh" --wheels-only || true
  fi
fi
if ! wheels_ready; then
  echo "[ERROR] 缺少 offline-bundle/python/wheels（目录为空或无 .whl）"
  echo "        修复: bash scripts/prepare-offline-bundle.sh --wheels-only"
  exit 1
fi
if [ ! -d "$ROOT/backend/node_modules/ssh2" ]; then
  echo "[ERROR] backend/node_modules 不完整。请先装好 backend/frontend 依赖"
  exit 1
fi

ensure_jre() {
  if [ -x "$ROOT/deps/jre/bin/java" ]; then
    return 0
  fi
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
    echo "[INFO] 从 JAVA_HOME 拷贝 JRE 到 deps/jre ..."
    rm -rf "$ROOT/deps/jre"
    mkdir -p "$ROOT/deps/jre"
    rsync -a \
      --exclude man --exclude include --exclude jmods \
      "$JAVA_HOME/" "$ROOT/deps/jre/"
    return 0
  fi
  echo "[ERROR] 需要 JDK 17：解压到 deps/jre/ 或设置 JAVA_HOME 后重试"
  exit 1
}

echo "=============================================="
echo " DIOps 离线包 $VERSION — 从当前源码全量重建"
echo "  Java: mvn package | 前端: npm run build | Node: backend 同步"
echo "=============================================="

echo "[0/8] 清理旧离线产物（release/diops-offline-*.tar.gz、release/diops）..."
clean_old_offline_artifacts

echo "[1/8] 构建 Java dbops-server ..."
if command -v mvn >/dev/null 2>&1; then
  (cd "$ROOT/dbops-server" && mvn -q -DskipTests clean package)
else
  bash "$ROOT/scripts/ensure-java-jar.sh" || {
    echo "[ERROR] 未找到 mvn 且 jar 不可用"
    exit 1
  }
fi
if [ ! -f "$JAR_SRC" ]; then
  echo "[ERROR] 未生成 $JAR_SRC"
  exit 1
fi

ensure_jre
"$ROOT/deps/jre/bin/java" -version

echo "[2/8] 构建前端（npm run build，写入 frontend/dist）..."
cd "$ROOT/frontend"
npm run build
if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "[ERROR] 前端构建失败：缺少 frontend/dist/index.html"
  exit 1
fi

echo "[3/8] 准备目录 release/diops ..."
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/config" "$STAGE/certs" "$STAGE/logs" \
  "$STAGE/frontend" "$STAGE/app" "$STAGE/sql" \
  "$STAGE/backend/data/backup" "$STAGE/backend/reports" \
  "$STAGE/modules/sql-optimizer" "$STAGE/modules/ai-ops" "$STAGE/runtime"

echo "$VERSION" >"$STAGE/VERSION"
cp -a "$TPL/bin/." "$STAGE/bin/"
cp -a "$TPL/backend.env" "$STAGE/config/backend.env"
if [ -f "$TPL/安装说明.md" ]; then
  cp -a "$TPL/安装说明.md" "$STAGE/安装说明.md"
else
  cp -a "$TPL/#U5b89#U88c5#U8bf4#U660e.md" "$STAGE/安装说明.md" 2>/dev/null || true
fi
: > "$STAGE/logs/.gitkeep"
: > "$STAGE/certs/.gitkeep"
sed -i 's/\r$//' "$STAGE/bin/"* "$STAGE/config/backend.env" 2>/dev/null || true
[ -f "$STAGE/安装说明.md" ] && sed -i "s/{{VERSION}}/$VERSION/g" "$STAGE/安装说明.md" || true
chmod +x "$STAGE/bin/"*.sh

echo "[4/8] 前端与 SQL 脚本 ..."
cp -a "$ROOT/frontend/dist/." "$STAGE/frontend/"
find "$STAGE/frontend" -name '*.map' -delete
test -f "$STAGE/frontend/index.html"
echo "      合并 migration -> 单一 sql/init.sql（客户包不打包零散 migration）..."
bash "$ROOT/scripts/merge-init-sql.sh"
rm -rf "$STAGE/sql"
mkdir -p "$STAGE/sql"
cp -a "$ROOT/backend/sql/init.sql" "$STAGE/sql/init.sql"
# 已装库但未含授权表时可单独执行（文件名非 migration_*，避免与「仅 init.sql」校验冲突）
if [ -f "$ROOT/backend/sql/migration_license.sql" ]; then
  cp -a "$ROOT/backend/sql/migration_license.sql" "$STAGE/sql/license_tables.sql"
fi
if [ -f "$TPL/sql/README.md" ]; then
  cp -a "$TPL/sql/README.md" "$STAGE/sql/README.md"
fi
mkdir -p "$STAGE/docs"
cp -a "$ROOT/docs/monitor-target-db-privileges.md" "$STAGE/docs/" 2>/dev/null || true

echo "[5/8] Java 包 ..."
/bin/cp -f "$JAR_SRC" "$STAGE/app/dbops-server.jar"
rm -rf "$STAGE/runtime/jre"
cp -a "$ROOT/deps/jre" "$STAGE/runtime/jre"

echo "[6/8] Node 兼容层（同步当前 backend/ 源码）、Python 模块、运行时 ..."
rsync -a \
  --exclude 'ai-ops-agent' \
  --exclude 'sql-optimizer-agent' \
  --exclude 'sql/' \
  --exclude '.env' \
  --exclude '*.ps1' \
  --exclude 'data' \
  --exclude 'reports' \
  --exclude 'node_modules/.cache' \
  "$ROOT/backend/" "$STAGE/backend/"
mkdir -p "$STAGE/backend/data/backup" "$STAGE/backend/reports"

STAGE_SECURITY="$STAGE/backend/src/middleware/security.js" python3 - <<'PY'
import os
from pathlib import Path
p = Path(os.environ["STAGE_SECURITY"])
if not p.is_file():
    raise SystemExit(0)
text = p.read_text(encoding="utf-8")
old = """function hostOrigins(host) {
  const origins = [];
  for (const scheme of ['https', 'http']) {
    origins.push(`${scheme}://${host}`);
    for (const port of [5173, 4173, 80, 443]) {
      origins.push(`${scheme}://${host}:${port}`);
    }
  }
  return origins;
}"""
new = """function hostOrigins(host) {
  const origins = [];
  const httpsPort = parseInt(process.env.HTTPS_PORT || '18443', 10);
  const ports = [5173, 4173, 80, 443];
  if (Number.isFinite(httpsPort)) ports.push(httpsPort);
  for (const scheme of ['https', 'http']) {
    origins.push(`${scheme}://${host}`);
    for (const port of ports) {
      origins.push(`${scheme}://${host}:${port}`);
    }
  }
  return origins;
}"""
if "process.env.HTTPS_PORT" not in text and old in text:
    p.write_text(text.replace(old, new, 1), encoding="utf-8")
PY

cp -a "$ROOT/backend/sql-optimizer-agent/"*.py "$ROOT/backend/sql-optimizer-agent/requirements.txt" "$STAGE/modules/sql-optimizer/"
cp -a "$ROOT/backend/ai-ops-agent/"*.py "$ROOT/backend/ai-ops-agent/requirements.txt" "$STAGE/modules/ai-ops/"
rm -rf "$STAGE/runtime/node" "$STAGE/runtime/python" "$STAGE/runtime/wheels"
cp -a "$ROOT/deps/node" "$STAGE/runtime/node"
cp -a "$ROOT/deps/python" "$STAGE/runtime/python"
cp -a "$ROOT/offline-bundle/python/wheels" "$STAGE/runtime/wheels"
find "$STAGE/backend/node_modules/.bin" -type f -exec chmod a+x {} +
find "$STAGE" -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true

if find "$STAGE" \( -name '.env' -o -name '*.vue' -o -name '*.map' \) | grep -q .; then
  echo "[ERROR] 客户包里出现了不应交付的文件："
  find "$STAGE" \( -name '.env' -o -name '*.vue' -o -name '*.map' \)
  exit 1
fi
if [ -d "$STAGE/backend/sql" ] || find "$STAGE" -name 'migration_*.sql' | grep -q .; then
  echo "[ERROR] 客户包不应包含 backend/sql 或 migration_*.sql（新库仅 sql/init.sql）"
  find "$STAGE" \( -path '*/backend/sql' -o -name 'migration_*.sql' \) 2>/dev/null | head -20
  exit 1
fi
if [ ! -f "$STAGE/sql/init.sql" ]; then
  echo "[ERROR] 缺少 STAGE/sql/init.sql"
  exit 1
fi

echo "[7/8] 检查脚本与运行时 ..."
bash -n "$STAGE/bin/install.sh"
bash -n "$STAGE/bin/start.sh"
bash -n "$STAGE/bin/stop.sh"
bash -n "$STAGE/bin/status.sh"
"$STAGE/runtime/node/bin/node" --check "$STAGE/bin/gateway.js"
"$STAGE/runtime/node/bin/node" -v
"$STAGE/runtime/python/bin/python3.9" -V
"$STAGE/runtime/jre/bin/java" -version

echo "[8/8] 压缩 release/diops-offline-${VERSION}.tar.gz ..."
rm -f "$ARCHIVE"
tar -czf "$ARCHIVE" -C "$ROOT/release" diops
sha256sum "$ARCHIVE" >"${ARCHIVE}.sha256" 2>/dev/null || true
ls -lh "$ARCHIVE"
echo
echo "[OK] 客户包: $ARCHIVE"
echo "     版本:   $VERSION"
echo "     目录:   $STAGE"
echo "客户: 解压 -> 编辑 config/backend.env -> sqlplus @sql/init.sql（仅此一个建库脚本）-> ./bin/install.sh -> ./bin/start.sh"
