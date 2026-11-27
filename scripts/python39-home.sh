# 统一 Python 3.9 安装目录（默认 /opt/python39，可用 DIOPS_PYTHON_HOME 覆盖）
DIOPS_PYTHON_HOME="${DIOPS_PYTHON_HOME:-/opt/python39}"
if [ -x "$DIOPS_PYTHON_HOME/bin/python3.9" ]; then
  export PATH="$DIOPS_PYTHON_HOME/bin:$PATH"
fi