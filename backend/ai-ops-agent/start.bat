@echo off
chcp 65001 >nul
echo ==============================================
echo  DIOps AI 智能分析服务  PORT:8001
echo ==============================================
cd /d %~dp0

if not exist venv (
  echo [INFO] 创建虚拟环境...
  python -m venv venv
)

call venv\Scripts\activate.bat
echo [INFO] 安装依赖...
pip install -r requirements.txt -q

echo [INFO] 启动 AI Ops Agent ...
python app.py
pause
