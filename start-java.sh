#!/bin/bash
# ============================================================================
# Java 后端 + Node 旧服务 混合启动（渐进式迁移）
#
#   浏览器/前端 ──> Java dbops-server :3000 ──(未迁移接口)──> Node backend :3001
#
# Java 接管：/api/auth /api/users /api/rbac /api/system-config /api/cmdb /api/monitor /api/alerts
#           /api/sql-insight /api/sql（SQL 洞察）+ 监控定时采集 + SQL 采集
# Node 保留：自动化运维、SQL 工作台/审核/优化、报表、AI、标签、应用关系、部署、服务目录等
# SQL 深度优化另需 Python Agent :8000（本脚本会尝试启动，依赖 Python 3.9+）
#
# 用法：./start-java.sh start|stop|status|build
# 启动前自动 scripts/ensure-platform-deps.sh + scripts/start-sql-optimizer.sh
# 前端 / 网关无需改动：仍然访问 3000 端口（frontend/.env.development 的 VITE_DEV_PROXY_TARGET 保持默认即可）
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGD="$ROOT/logs"; PIDD="$LOGD/pids"; mkdir -p "$LOGD" "$PIDD"
JAR="$ROOT/dbops-server/target/dbops-server.jar"
ENV_FILE="${DBOPS_ENV_FILE:-$ROOT/backend/.env}"
JAVA_PORT="${JAVA_PORT:-3000}"
NODE_PORT="${NODE_PORT:-3001}"
TZ_OPT="${DBOPS_TZ:-Asia/Shanghai}"

build() {
  command -v mvn >/dev/null 2>&1 || { echo "[ERROR] 需要 Maven 3.8+ 与 JDK 17+"; exit 1; }
  (cd "$ROOT/dbops-server" && mvn -q -DskipTests package)
  echo "[OK] 构建完成: $JAR"
}

is_running() { [ -f "$PIDD/$1.pid" ] && kill -0 "$(cat "$PIDD/$1.pid")" 2>/dev/null; }

start() {
  # 源码比 jar 新时自动重新构建（升级代码后不会再跑旧 jar）
  bash "$ROOT/scripts/ensure-platform-deps.sh" || true
  bash "$ROOT/scripts/ensure-java-jar.sh" || exit 1
  if ! is_running node-legacy; then
    echo "[INFO] 启动 Node 旧服务 :$NODE_PORT（关闭其监控定时器，信任本机代理）"
    (cd "$ROOT/backend" && PORT="$NODE_PORT" BIND_HOST=127.0.0.1 MONITOR_SCHEDULER_ENABLED=false TRUST_PROXY=1 \
      JAVA_SERVER_URL="http://127.0.0.1:$JAVA_PORT" \
      nohup node app.js >"$LOGD/node-legacy.log" 2>&1 & echo $! >"$PIDD/node-legacy.pid")
  fi
  if ! is_running dbops-java; then
    echo "[INFO] 启动 Java dbops-server :$JAVA_PORT"
    DBOPS_ENV_FILE="$ENV_FILE" PORT="$JAVA_PORT" LEGACY_NODE_URL="http://127.0.0.1:$NODE_PORT" \
      nohup java -Duser.timezone="$TZ_OPT" -Xms256m -Xmx1g -jar "$JAR" >"$LOGD/dbops-java.log" 2>&1 &
    echo $! >"$PIDD/dbops-java.pid"
  fi
  bash "$ROOT/scripts/start-sql-optimizer.sh" start
  sleep 3; status
}

stop() {
  bash "$ROOT/scripts/start-sql-optimizer.sh" stop || true
  for n in dbops-java node-legacy; do
    if is_running "$n"; then kill "$(cat "$PIDD/$n.pid")" && echo "[OK] stopped $n"; fi
    rm -f "$PIDD/$n.pid"
  done
}

status() {
  for n in dbops-java node-legacy; do
    if is_running "$n"; then echo "  $n: running (pid $(cat "$PIDD/$n.pid"))"; else echo "  $n: stopped"; fi
  done
  bash "$ROOT/scripts/start-sql-optimizer.sh" status
  curl -fsS "http://127.0.0.1:$JAVA_PORT/health" 2>/dev/null && echo || true
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  build) build ;;
  *) echo "用法: $0 start|stop|restart|status|build"; exit 1 ;;
esac
