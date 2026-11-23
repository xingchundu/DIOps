#!/bin/bash
# DIOps AI Ops Agent 启动脚本
# 端口: 8001  |  Python FastAPI  |  依赖: Ollama (deepseek-r1:1.5b)

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=============================================="
echo " DIOps AI 智能分析服务 启动"
echo " PORT: 8001"
echo " LLM:  deepseek-r1:1.5b (Ollama)"
echo " DB:   Oracle 192.168.137.102:1521/ora19c"
echo "=============================================="

# 检查 Python
if ! command -v python3 &>/dev/null; then
  echo "[ERROR] Python3 未安装"
  exit 1
fi

# 虚拟环境
if [ ! -d "venv" ]; then
  echo "[INFO] 创建虚拟环境..."
  python3 -m venv venv
fi

source venv/bin/activate

# 安装依赖
echo "[INFO] 检查 Python 依赖..."
pip install -r requirements.txt -q --break-system-packages 2>/dev/null || \
  pip install -r requirements.txt -q

# 检查 Ollama
if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
  echo "[WARN] Ollama 未启动，LLM功能将降级（向量使用哈希，问答不可用）"
else
  echo "[INFO] Ollama 已就绪"
  # 检查模型
  if curl -s http://localhost:11434/api/tags | grep -q "deepseek-r1:1.5b"; then
    echo "[INFO] deepseek-r1:1.5b 模型已就绪"
  else
    echo "[INFO] 正在拉取 deepseek-r1:1.5b 模型..."
    ollama pull deepseek-r1:1.5b
  fi
fi

echo "[INFO] 启动 AI Ops Agent ..."
python3 app.py
