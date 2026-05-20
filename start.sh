#!/bin/bash
# ============================================
# 数据库智能平台 - 启动脚本
# ============================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
PID_FILE="$SCRIPT_DIR/backend.pid"
LOG_FILE="$SCRIPT_DIR/backend.log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

# 去掉 NODE_OPTIONS 里无效的 --localstorage-file，避免 Node 启动告警（不用 node 解析，纯 shell）
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
  if [ ${#out[@]} -eq 0 ]; then unset NODE_OPTIONS; else NODE_OPTIONS="${out[*]}"; export NODE_OPTIONS; fi
}

check_node() {
  if ! command -v node &>/dev/null; then
    echo -e "${RED}[ERROR] Node.js 未安装，请先安装 Node.js >= 18${NC}"
    exit 1
  fi
  local ver=$(node -e "console.log(process.versions.node.split('.')[0])")
  if [ "$ver" -lt 18 ]; then
    echo -e "${YELLOW}[WARN] Node.js 版本 $ver 较旧，建议使用 >= 18${NC}"
  fi
}

start() {
  check_node
  if [ -f "$PID_FILE" ] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
    echo -e "${YELLOW}[INFO] 后端服务已在运行 PID=$(cat $PID_FILE)${NC}"
    return
  fi
  echo -e "${GREEN}[INFO] 启动后端服务...${NC}"
  cd "$BACKEND_DIR"

  # 检查依赖
  if [ ! -d "node_modules" ]; then
    echo "[INFO] 安装依赖..."
    npm install
  fi

  sanitize_node_options
  nohup node app.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 2

  if kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
    local PORT=$(grep PORT .env 2>/dev/null | cut -d'=' -f2 || echo "3000")
    local IP=$(hostname -I | awk '{print $1}')
    echo -e "${GREEN}[OK] 后端服务启动成功${NC}"
    echo -e "     PID: $(cat $PID_FILE)"
    echo -e "     API: http://$IP:${PORT:-3000}"
    echo -e "     日志: $LOG_FILE"
    echo ""
    echo -e "${GREEN}前端访问：${NC}"
    echo -e "  - 如使用 Nginx：http://$IP"
    echo -e "  - 开发模式：cd frontend && npm run dev"
  else
    echo -e "${RED}[ERROR] 启动失败，查看日志: $LOG_FILE${NC}"
    tail -20 "$LOG_FILE"
    exit 1
  fi
}

stop() {
  if [ -f "$PID_FILE" ]; then
    local pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      rm -f "$PID_FILE"
      echo -e "${GREEN}[OK] 后端服务已停止${NC}"
    else
      echo -e "${YELLOW}[INFO] 服务未运行${NC}"
      rm -f "$PID_FILE"
    fi
  else
    echo -e "${YELLOW}[INFO] PID文件不存在，服务可能未运行${NC}"
  fi
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
    echo -e "${GREEN}[OK] 后端服务运行中 PID=$(cat $PID_FILE)${NC}"
    curl -s http://localhost:3000/health 2>/dev/null | python3 -m json.tool 2>/dev/null || true
  else
    echo -e "${RED}[STOP] 后端服务未运行${NC}"
  fi
}

restart() { stop; sleep 1; start; }

logs() { tail -f "$LOG_FILE"; }

case "$1" in
  start)   start   ;;
  stop)    stop    ;;
  restart) restart ;;
  status)  status  ;;
  logs)    logs    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs}"
    echo ""
    echo "  start   - 启动后端服务"
    echo "  stop    - 停止后端服务"
    echo "  restart - 重启后端服务"
    echo "  status  - 查看运行状态"
    echo "  logs    - 查看实时日志"
    exit 1
    ;;
esac
