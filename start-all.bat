@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DB Ops - Start All

set "ROOT=%~dp0"
set "LOGD=%ROOT%logs"
mkdir "%LOGD%" 2>nul

echo ============================================
echo   DB Ops Platform - Backend + Frontend + SQL Optimizer + AI Ops Agent
echo ============================================
echo.
echo [LOG] Backend  - console window + file:
echo       %LOGD%\backend.log
echo       %LOGD%\backend-install.log
echo [LOG] Frontend - console window + file:
echo       %LOGD%\frontend.log
echo       %LOGD%\frontend-install.log
echo [LOG] SQL Optimizer - console window + file:
echo       %LOGD%\sql-optimizer-backend.log
echo       %LOGD%\sql-optimizer-backend-install.log
echo [LOG] AI Ops Agent - console window + file:
echo       %LOGD%\ai-ops-agent.log
echo       %LOGD%\ai-ops-agent-install.log
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)

echo [OK] Node:
node --version
echo.

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if not exist "%ROOT%certs\server.crt" (
  echo [INFO] Generating HTTPS self-signed certificate...
  "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\gen-ssl-cert.ps1"
  if errorlevel 1 (
    echo [WARN] SSL cert generation failed. Frontend may fall back to HTTP.
  )
)
echo.

if not exist "%ROOT%backend\app.js" (
    echo [ERROR] Missing backend\app.js
    pause
    exit /b 1
)
if not exist "%ROOT%frontend\package.json" (
    echo [ERROR] Missing frontend\package.json
    pause
    exit /b 1
)

REM ---- Backend：固定为 Java 网关:3000 + Node:3001（Node 中与 Java 重复的后端已删除，不再支持仅 Node 模式）
REM      源码比 jar 新时自动重新构建（需要 JDK 17+、Maven 3.8+）
set "USE_JAVA=1"
set "NODE_ENV_PS=$env:PORT='3001'; $env:BIND_HOST='127.0.0.1'; $env:TRUST_PROXY='1'; $env:JAVA_SERVER_URL='http://127.0.0.1:3000';"
where java >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 未找到 java（需要 JDK 17+）。认证、CMDB、监控、告警、SQL 洞察都由 Java 服务提供，无法启动。
  pause
  exit /b 1
)
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\ensure-secrets.ps1"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\ensure-java-jar.ps1"
if errorlevel 1 (
  echo [ERROR] dbops-server.jar 不可用，已停止启动
  pause
  exit /b 1
)

set "BACKEND_SKIP=0"
"%PS%" -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 set "BACKEND_SKIP=1"

if "%BACKEND_SKIP%"=="1" (
  echo [OK] Backend already running on port 3000, skip start.
) else (
  start "DBOps-Backend" "%PS%" -NoExit -NoProfile -ExecutionPolicy Bypass -Command ^
    "%NODE_ENV_PS% Set-Location '%ROOT%backend'; Write-Host ('[{0}] [BACKEND] npm install' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan; $(npm install *>&1) | Tee-Object -FilePath '%LOGD%\backend-install.log' -Append; if ($LASTEXITCODE -ne 0) { pause; exit $LASTEXITCODE }; . '%ROOT%backend\sanitize-node-options.ps1'; Write-Host ('[{0}] [BACKEND] node app.js' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan; $(node app.js *>&1) | Tee-Object -FilePath '%LOGD%\backend.log' -Append"
)
if "%BACKEND_SKIP%"=="0" if "%USE_JAVA%"=="1" (
  start "DBOps-Java" "%PS%" -NoExit -NoProfile -ExecutionPolicy Bypass -Command ^
    "$env:DBOPS_ENV_FILE='%ROOT%backend\.env'; $env:PORT='3000'; $env:LEGACY_NODE_URL='http://127.0.0.1:3001'; Write-Host ('[{0}] [JAVA] dbops-server :3000' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Yellow; $(java -Duser.timezone=Asia/Shanghai -Dfile.encoding=UTF-8 -Xms256m -Xmx1g -jar '%ROOT%dbops-server\target\dbops-server.jar' *>&1) | Tee-Object -FilePath '%LOGD%\dbops-java.log' -Append"
)

timeout /t 2 /nobreak >nul

set "FRONTEND_SKIP=0"
"%PS%" -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'https://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 2 -SkipCertificateCheck; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 set "FRONTEND_SKIP=1"

if "%FRONTEND_SKIP%"=="1" (
  echo [OK] Frontend already running on port 5173, skip start.
) else (
  start "DBOps-Frontend" "%PS%" -NoExit -NoProfile -ExecutionPolicy Bypass -Command ^
    "Set-Location '%ROOT%frontend'; Write-Host ('[{0}] [FRONTEND] npm install' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Green; $(npm install *>&1) | Tee-Object -FilePath '%LOGD%\frontend-install.log' -Append; if ($LASTEXITCODE -ne 0) { pause; exit $LASTEXITCODE }; Write-Host ('[{0}] [FRONTEND] npm run dev' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Green; $(npm run dev *>&1) | Tee-Object -FilePath '%LOGD%\frontend.log' -Append"
)

timeout /t 2 /nobreak >nul

set "PYCMD="
py --version >nul 2>&1 && set "PYCMD=py"
if not defined PYCMD python --version >nul 2>&1 && set "PYCMD=python"

set "SQL_OPT=0"
if defined PYCMD (
  if exist "%ROOT%backend\sql-optimizer-agent\app.py" (
    if exist "%ROOT%backend\sql-optimizer-agent\requirements.txt" set "SQL_OPT=1"
  )
)
if "%SQL_OPT%"=="1" (
  start "DBOps-SQL-Optimizer" "%PS%" -NoExit -NoProfile -ExecutionPolicy Bypass -Command ^
    "$env:SQL_PY='%PYCMD%'; Set-Location '%ROOT%backend\sql-optimizer-agent'; if (-not (Test-Path 'venv')) { Write-Host ('[{0}] [SQL-OPTIMIZER] create venv' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan; & $env:SQL_PY -m venv venv; if ($LASTEXITCODE -ne 0) { pause; exit $LASTEXITCODE } }; . .\venv\Scripts\Activate.ps1; Write-Host ('[{0}] [SQL-OPTIMIZER] pip install' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan; $(python -m pip install -r requirements.txt -q *>&1) | Tee-Object -FilePath '%LOGD%\sql-optimizer-backend-install.log' -Append; if ($LASTEXITCODE -ne 0) { pause; exit $LASTEXITCODE }; Write-Host ('[{0}] [SQL-OPTIMIZER] python app.py' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan; $(python app.py *>&1) | Tee-Object -FilePath '%LOGD%\sql-optimizer-backend.log' -Append"
  echo [OK] SQL Optimizer window: DBOps-SQL-Optimizer  API http://localhost:8000
) else (
  echo [WARN] SQL Optimizer skipped ^(need Python/py launcher and backend\sql-optimizer-agent\app.py + requirements.txt^).
)

timeout /t 2 /nobreak >nul

set "AI_AGENT=0"
if defined PYCMD (
  if exist "%ROOT%backend\ai-ops-agent\app.py" (
    if exist "%ROOT%backend\ai-ops-agent\requirements.txt" set "AI_AGENT=1"
  )
)
if "%AI_AGENT%"=="1" (
  start "DBOps-AI-Ops-Agent" "%PS%" -NoExit -NoProfile -ExecutionPolicy Bypass -Command ^
    "$env:AI_PY='%PYCMD%'; Set-Location '%ROOT%backend\ai-ops-agent'; if (-not (Test-Path 'venv')) { Write-Host ('[{0}] [AI-OPS-AGENT] create venv' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Magenta; & $env:AI_PY -m venv venv; if ($LASTEXITCODE -ne 0) { pause; exit $LASTEXITCODE } }; . .\venv\Scripts\Activate.ps1; Write-Host ('[{0}] [AI-OPS-AGENT] pip install' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Magenta; $(python -m pip install -r requirements.txt -q *>&1) | Tee-Object -FilePath '%LOGD%\ai-ops-agent-install.log' -Append; if ($LASTEXITCODE -ne 0) { pause; exit $LASTEXITCODE }; Write-Host ('[{0}] [AI-OPS-AGENT] python app.py' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Magenta; $(python app.py *>&1) | Tee-Object -FilePath '%LOGD%\ai-ops-agent.log' -Append"
  echo [OK] AI Ops Agent window: DBOps-AI-Ops-Agent  API http://localhost:8001
) else (
  echo [WARN] AI Ops Agent skipped ^(need Python/py launcher and backend\ai-ops-agent\app.py + requirements.txt^).
)

echo [OK] Started windows: DBOps-Backend, DBOps-Frontend
if "%USE_JAVA%"=="1" echo            + DBOps-Java ^(Java 网关 :3000，Node :3001^)
if "%SQL_OPT%"=="1" echo            + DBOps-SQL-Optimizer
if "%AI_AGENT%"=="1" echo            + DBOps-AI-Ops-Agent
echo     Backend:  http://localhost:3000/health  (internal API, proxied via HTTPS frontend)
echo     Frontend: https://localhost:5173/login
if "%SQL_OPT%"=="1" echo     SQL Optimizer: http://localhost:8000/
if "%AI_AGENT%"=="1" echo     AI Ops Agent: http://localhost:8001/
echo.
echo Log directory: %LOGD%\
echo This window can be closed.
pause
