#!/bin/bash
# ============================================
# DB Ops Platform - Start / Stop All (Linux)
# 对齐 Windows start-all.bat：Backend + Frontend + SQL Optimizer + AI Ops Agent
# 缺依赖时自动 scripts/ensure-platform-deps.sh（install-deps 联网或 offline-bundle）
# ============================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/python39-home.sh
. "$ROOT/scripts/python39-home.sh"
LOGD="$ROOT/logs"
PIDD="$LOGD/pids"
mkdir -p "$LOGD" "$PIDD"

# 本地依赖（scripts/install-deps.sh 安装后可用，适用于离线/无全局 Node 环境）
if [ -x "$ROOT/deps/node/bin/node" ]; then
  export PATH="$ROOT/deps/node/bin:$PATH"
fi
if [ -d "$ROOT/deps/npm-cache" ]; then
  export NPM_CONFIG_CACHE="$ROOT/deps/npm-cache"
elif [ -d "$ROOT/offline-bundle/npm-cache" ]; then
  export NPM_CONFIG_CACHE="$ROOT/offline-bundle/npm-cache"
fi

# 启动前自动 install-deps（联网或 offline-bundle）
ensure_offline_deps() {
  bash "$ROOT/scripts/ensure-platform-deps.sh" || true
}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 去掉 NODE_OPTIONS 里无效的 --localstorage-file（与 start.sh 一致）
sanitize_node_options() {
  [ -z "${NODE_OPTIONS:-}" ] && return
  local -a arr out=()
  read -ra arr <<< "$NODE_OPTIONS"
  local i=0 n=${#arr[@]}
  while [ "$i" -lt "$n" ]; do
    local t="${arr[$i]}"
    if [ "$t" = "--localstorage-file" ]; then
      local nx="${arr[$((i+1))]:-}"
      if [ -n "$nx" ] && [[ "$nx" != -* ]]; then i=$((i+2)); else i=$((i+1)); fi
      continue
    fi
    case "$t" in
      --localstorage-file=*)
        local v="${t#*=}"
        [ -z "${v// }" ] && { i=$((i+1)); continue; }
        ;;
    esac
    out+=("$t")
    i=$((i+1))
  done
  if [ ${#out[@]} -eq 0 ]; then unset NODE_OPTIONS; else export NODE_OPTIONS="${out[*]}"; fi
}

port_up() {
  # $1=url  成功返回 0
  local url="$1"
  if [[ "$url" == https://* ]]; then
    curl -skf --connect-timeout 2 --max-time 3 "$url" >/dev/null 2>&1
  else
    curl -sf --connect-timeout 2 --max-time 3 "$url" >/dev/null 2>&1
  fi
}

pid_alive() {
  local f="$1"
  [ -f "$f" ] || return 1
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null
}

# 递归结束进程树（覆盖 npm → vite / python 子进程）
kill_tree() {
  local pid="$1" sig="${2:-TERM}"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" "$sig"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
}

# 新会话启动，便于按进程组停止
start_bg() {
  # $1=name $2=pidfile $3=logfile  其余为要执行的 shell 命令字符串
  local name="$1" pidfile="$2" logfile="$3"
  shift 3
  setsid bash -c "$*" </dev/null >>"$logfile" 2>&1 &
  echo $! >"$pidfile"
  echo -e "${GREEN}[OK]${NC} $name started PID=$(cat "$pidfile")  log=$logfile"
}

stop_one() {
  local name="$1" pidfile="$2"
  if ! [ -f "$pidfile" ]; then
    echo -e "${YELLOW}[INFO]${NC} $name: no pid file"
    return 0
  fi
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -z "${pid:-}" ]; then
    rm -f "$pidfile"
    echo -e "${YELLOW}[INFO]${NC} $name: empty pid file removed"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pidfile"
    echo -e "${YELLOW}[INFO]${NC} $name: not running (stale pid $pid)"
    return 0
  fi
  # 优先按进程组（setsid），再递归子进程
  kill -TERM -"$pid" 2>/dev/null || true
  kill_tree "$pid" TERM
  local i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
    sleep 0.25
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -"$pid" 2>/dev/null || true
    kill_tree "$pid" KILL
  fi
  rm -f "$pidfile"
  echo -e "${GREEN}[OK]${NC} $name stopped (was $pid)"
}

do_start() {
  echo "============================================"
  echo "  DB Ops Platform - Backend + Frontend + SQL Optimizer + AI Ops Agent"
  echo "============================================"
  echo
  echo "[LOG] Backend:       $LOGD/backend.log (+ backend-install.log)"
  echo "[LOG] Frontend:      $LOGD/frontend.log (+ frontend-install.log)"
  echo "[LOG] SQL Optimizer: $LOGD/sql-optimizer-backend.log (+ *-install.log)"
  echo "[LOG] AI Ops Agent:  $LOGD/ai-ops-agent.log (+ *-install.log)"
  echo "[PID]               $PIDD/"
  echo "============================================"
  echo

  ensure_offline_deps
  if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}[ERROR] Node.js not found（需要 Node.js 18+）${NC}"
    echo "  请先安装依赖:"
    echo "    bash scripts/install-deps.sh          # 有网"
    echo "    bash scripts/install-deps.sh --offline # 离线（需 offline-bundle/）"
    echo "  或将 offline-bundle/ 放到项目根目录后重新 ./start-all.sh start"
    exit 1
  fi
  echo -e "${GREEN}[OK]${NC} Node: $(node --version)"
  echo

  if [ ! -f "$ROOT/certs/server.crt" ] || [ ! -f "$ROOT/certs/server.key" ]; then
    echo "[INFO] Generating HTTPS self-signed certificate..."
    if [ -x "$ROOT/scripts/gen-ssl-cert.sh" ] || [ -f "$ROOT/scripts/gen-ssl-cert.sh" ]; then
      bash "$ROOT/scripts/gen-ssl-cert.sh" || echo -e "${YELLOW}[WARN] SSL cert generation failed. Frontend may fall back to HTTP.${NC}"
    else
      echo -e "${YELLOW}[WARN] scripts/gen-ssl-cert.sh missing.${NC}"
    fi
  fi
  echo

  if [ ! -f "$ROOT/backend/app.js" ]; then
    echo -e "${RED}[ERROR] Missing backend/app.js${NC}"
    exit 1
  fi
  if [ ! -f "$ROOT/frontend/package.json" ]; then
    echo -e "${RED}[ERROR] Missing frontend/package.json${NC}"
    exit 1
  fi

  # --- Backend ---
  # 固定架构：Java 网关 :3000（认证/CMDB/监控/告警/SQL 洞察）+ Node :3001（其余业务接口，由 Java 转发）
  # Node 中与 Java 重复的后端已删除，不再支持“仅 Node”模式。源码比 jar 新时自动重新构建。
  local USE_JAVA=1
  if ! command -v java >/dev/null 2>&1; then
    echo -e "${RED}[ERROR] 未找到 java（需要 JDK 17+）。认证、CMDB、监控、告警、SQL 洞察都由 Java 服务提供，无法启动。${NC}"
    return 1
  fi
  bash "$ROOT/scripts/ensure-secrets.sh" || { echo "[secrets] 生成密钥失败"; exit 1; }
  if ! bash "$ROOT/scripts/ensure-java-jar.sh"; then
    echo -e "${RED}[ERROR] dbops-server.jar 不可用（见上方原因），已停止启动${NC}"
    return 1
  fi
  if port_up "http://127.0.0.1:3000/health"; then
    echo -e "${GREEN}[OK]${NC} Backend already running on port 3000, skip start."
  elif pid_alive "$PIDD/backend.pid"; then
    echo -e "${GREEN}[OK]${NC} Backend pid alive ($(cat "$PIDD/backend.pid")), skip start."
  else
    sanitize_node_options
    # 导出清理后的 NODE_OPTIONS 给子进程
    export NODE_OPTIONS="${NODE_OPTIONS:-}"
    local NODE_ENVS=""
    if [ "$USE_JAVA" = "1" ]; then
      NODE_ENVS="PORT=3001 BIND_HOST=127.0.0.1 MONITOR_SCHEDULER_ENABLED=false TRUST_PROXY=1 JAVA_SERVER_URL=http://127.0.0.1:3000"
    fi
    start_bg "Backend(Node)" "$PIDD/backend.pid" "$LOGD/backend.log" \
      "cd '$ROOT/backend' && if [ ! -d node_modules ]; then echo '[$(ts)] [BACKEND] npm install' && npm install --no-audit --no-fund --offline >>'$LOGD/backend-install.log' 2>&1; fi && echo '[$(ts)] [BACKEND] node app.js' && exec env $NODE_ENVS node app.js"
    if [ "$USE_JAVA" = "1" ]; then
      start_bg "Backend(Java)" "$PIDD/java.pid" "$LOGD/dbops-java.log" \
        "cd '$ROOT' && exec env DBOPS_ENV_FILE='$ROOT/backend/.env' PORT=3000 LEGACY_NODE_URL=http://127.0.0.1:3001 java -Duser.timezone=\${DBOPS_TZ:-Asia/Shanghai} -Dfile.encoding=UTF-8 -Xms256m -Xmx1g -jar '$ROOT/dbops-server/target/dbops-server.jar'"
    fi
  fi

  sleep 2

  # --- Frontend ---
  if port_up "https://127.0.0.1:5173/" || port_up "http://127.0.0.1:5173/"; then
    echo -e "${GREEN}[OK]${NC} Frontend already running on port 5173, skip start."
  elif pid_alive "$PIDD/frontend.pid"; then
    echo -e "${GREEN}[OK]${NC} Frontend pid alive ($(cat "$PIDD/frontend.pid")), skip start."
  else
    start_bg "Frontend" "$PIDD/frontend.pid" "$LOGD/frontend.log" \
      "cd '$ROOT/frontend' && if [ ! -d node_modules ]; then echo '[$(ts)] [FRONTEND] npm install' && npm install --no-audit --no-fund --offline >>'$LOGD/frontend-install.log' 2>&1; fi && echo '[$(ts)] [FRONTEND] npm run dev' && exec npm run dev"
  fi

  sleep 2

  local SQL_OPT=0 AI_AGENT=0
  [ -f "$ROOT/backend/sql-optimizer-agent/app.py" ] && SQL_OPT=1
  [ -f "$ROOT/backend/ai-ops-agent/app.py" ] && AI_AGENT=1

  bash "$ROOT/scripts/start-sql-optimizer.sh" start
  sleep 1
  bash "$ROOT/scripts/start-ai-ops-agent.sh" start

  echo
  echo -e "${GREEN}[OK]${NC} Services:"
  echo "     Backend:  http://localhost:3000/health"
  echo "     Frontend: https://localhost:5173/login"
  [ "$SQL_OPT" = "1" ] && echo "     SQL Optimizer: http://localhost:8000/"
  [ "$AI_AGENT" = "1" ] && echo "     AI Ops Agent: http://localhost:8001/"
  echo
  echo "Log directory: $LOGD/"
  echo "PID directory: $PIDD/"
  echo "Stop all:      $0 stop"
}

do_stop() {
  echo "============================================"
  echo "  DB Ops Platform - Stop All"
  echo "============================================"
  stop_one "AI-Ops-Agent" "$PIDD/ai-ops-agent.pid"
  stop_one "SQL-Optimizer" "$PIDD/sql-optimizer.pid"
  stop_one "Frontend" "$PIDD/frontend.pid"
  stop_one "Backend(Java)" "$PIDD/java.pid"
  stop_one "Backend" "$PIDD/backend.pid"

  # 若 PID 已清但端口仍被占用（例如 npm 孤儿子进程），再按监听端口兜底
  local p still=0
  for p in 3000 3001 5173 8000 8001; do
    local busy=0
    case "$p" in
      3000) port_up "http://127.0.0.1:3000/health" && busy=1 ;;
      3001) port_up "http://127.0.0.1:3001/health" && busy=1 ;;
      5173)
        port_up "https://127.0.0.1:5173/" && busy=1
        [ "$busy" = "0" ] && port_up "http://127.0.0.1:5173/" && busy=1
        ;;
      8000) port_up "http://127.0.0.1:8000/api/health" && busy=1 ;;
      8001) port_up "http://127.0.0.1:8001/health" && busy=1 ;;
    esac
    [ "$busy" = "1" ] || continue
    still=1
    echo -e "${YELLOW}[WARN]${NC} port $p still in use, trying to free listener..."
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${p}/tcp" >/dev/null 2>&1 || true
    elif command -v lsof >/dev/null 2>&1; then
      local lp
      lp="$(lsof -t -iTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)"
      if [ -n "${lp:-}" ]; then
        # shellcheck disable=SC2086
        kill -TERM $lp 2>/dev/null || true
      fi
    fi
  done
  [ "$still" = "0" ] || sleep 0.5
  echo -e "${GREEN}[OK]${NC} Stop finished."
}

do_status() {
  echo "============================================"
  echo "  DB Ops Platform - Status"
  echo "============================================"
  local name pidfile url
  for item in \
    "Backend(Java)|$PIDD/java.pid|http://127.0.0.1:3000/health" \
    "Backend(Node)|$PIDD/backend.pid|http://127.0.0.1:3001/health" \
    "Frontend|$PIDD/frontend.pid|https://127.0.0.1:5173/" \
    "SQL-Optimizer|$PIDD/sql-optimizer.pid|http://127.0.0.1:8000/api/health" \
    "AI-Ops-Agent|$PIDD/ai-ops-agent.pid|http://127.0.0.1:8001/health"; do
    IFS='|' read -r name pidfile url <<<"$item"
    local state="DOWN" pid_info="-"
    if pid_alive "$pidfile"; then
      pid_info="$(cat "$pidfile")"
      state="PID_OK"
    fi
    if port_up "$url"; then
      state="UP"
    elif [ "$name" = "Frontend" ] && port_up "http://127.0.0.1:5173/"; then
      state="UP"
      url="http://127.0.0.1:5173/"
    fi
    printf "  %-14s  %-8s  pid=%-8s  %s\n" "$name" "$state" "$pid_info" "$url"
  done
}

do_restart() {
  do_stop
  sleep 1
  do_start
}

usage() {
  echo "用法: $0 {start|stop|restart|status}"
  echo
  echo "  start   - 启动 Backend + Frontend +（可选）SQL Optimizer / AI Ops Agent"
  echo "  stop    - 停止上述全部服务"
  echo "  restart - 先 stop 再 start"
  echo "  status  - 查看端口与 PID 状态"
  echo
  echo "日志: $LOGD/"
  echo "PID:  $PIDD/"
}

cmd="${1:-start}"
case "$cmd" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  -h|--help|help) usage ;;
  *)
    usage
    exit 1
    ;;
esac
