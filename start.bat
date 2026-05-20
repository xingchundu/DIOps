@echo off
REM UTF-8 console; save as UTF-8 with BOM for Chinese Windows cmd.
chcp 65001 >nul
title DB Ops Platform - Backend

set "ROOT=%~dp0"
set "LOGD=%ROOT%logs"
mkdir "%LOGD%" 2>nul

echo ============================================
echo   DB Ops Platform - Start Backend
echo ============================================
echo.
echo [LOG] Console + file:
echo       %LOGD%\backend.log
echo       %LOGD%\backend-install.log
echo ============================================
echo.

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)

echo [OK] Node.js:
node --version

cd /d "%ROOT%backend"
if %errorlevel% neq 0 (
    echo [ERROR] backend folder not found
    pause
    exit /b 1
)

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
echo [INFO] npm install ^(see %LOGD%\backend-install.log^)...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "npm install *>&1 | Tee-Object -FilePath '%LOGD%\backend-install.log' -Append; exit $LASTEXITCODE"
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
)
echo [OK] Dependencies ready.
echo.

echo [INFO] Starting backend ^(logs also in %LOGD%\backend.log^)...
echo ============================================

"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "Set-Location '%ROOT%backend'; . '%ROOT%backend\sanitize-node-options.ps1'; node app.js *>&1 | Tee-Object -FilePath '%LOGD%\backend.log' -Append"

pause
