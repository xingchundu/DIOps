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

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

start "DBOps-Backend" "%PS%" -NoExit -NoProfile -ExecutionPolicy Bypass -Command ^
  "Set-Location '%ROOT%backend'; Write-Host ('[{0}] [BACKEND] npm install' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan; $(npm install *>&1) | Tee-Object -FilePath '%LOGD%\backend-install.log' -Append; if ($LASTEXITCODE -ne 0) { pause; exit $LASTEXITCODE }; . '%ROOT%backend\sanitize-node-options.ps1'; Write-Host ('[{0}] [BACKEND] node app.js' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan; $(node app.js *>&1) | Tee-Object -FilePath '%LOGD%\backend.log' -Append"

timeout /t 2 /nobreak >nul

start "DBOps-Frontend" "%PS%" -NoExit -NoProfile -ExecutionPolicy Bypass -Command ^
  "Set-Location '%ROOT%frontend'; Write-Host ('[{0}] [FRONTEND] npm install' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Green; $(npm install *>&1) | Tee-Object -FilePath '%LOGD%\frontend-install.log' -Append; if ($LASTEXITCODE -ne 0) { pause; exit $LASTEXITCODE }; Write-Host ('[{0}] [FRONTEND] npm run dev' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Green; $(npm run dev *>&1) | Tee-Object -FilePath '%LOGD%\frontend.log' -Append"

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
if "%SQL_OPT%"=="1" echo            + DBOps-SQL-Optimizer
if "%AI_AGENT%"=="1" echo            + DBOps-AI-Ops-Agent
echo     Backend:  http://localhost:3000/health
echo     Frontend: http://localhost:5173/login
if "%SQL_OPT%"=="1" echo     SQL Optimizer: http://localhost:8000/
if "%AI_AGENT%"=="1" echo     AI Ops Agent: http://localhost:8001/
echo.
echo Log directory: %LOGD%\
echo This window can be closed.
pause
