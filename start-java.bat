@echo off
REM ============================================================================
REM Java 后端 + Node 旧服务 混合启动（Windows）
REM   前端 -> Java dbops-server :3000 -> (未迁移接口) -> Node backend :3001
REM 首次运行或代码更新后会自动构建（需要 JDK 17+、Maven 3.8+）
REM ============================================================================
setlocal
set ROOT=%~dp0
if "%JAVA_PORT%"=="" set JAVA_PORT=3000
if "%NODE_PORT%"=="" set NODE_PORT=3001
set JAR=%ROOT%dbops-server\target\dbops-server.jar

REM 源码比 jar 新时自动重新构建（原来只在 jar 不存在时构建，升级代码后仍跑旧 jar → 新接口“接口不存在”）
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\ensure-java-jar.ps1"
if errorlevel 1 (
  echo [ERROR] dbops-server.jar 不可用，已停止启动
  pause
  exit /b 1
)

echo [INFO] 启动 Node 旧服务 :%NODE_PORT%
start "dbops-node-legacy" cmd /c "cd /d %ROOT%backend && set PORT=%NODE_PORT%&& set BIND_HOST=127.0.0.1&& set MONITOR_SCHEDULER_ENABLED=false&& set TRUST_PROXY=1&& set JAVA_SERVER_URL=http://127.0.0.1:%JAVA_PORT%&& node app.js"

echo [INFO] 启动 Java dbops-server :%JAVA_PORT%
start "dbops-java" cmd /c "set DBOPS_ENV_FILE=%ROOT%backend\.env&& set PORT=%JAVA_PORT%&& set LEGACY_NODE_URL=http://127.0.0.1:%NODE_PORT%&& java -Duser.timezone=Asia/Shanghai -Dfile.encoding=UTF-8 -jar "%JAR%""
endlocal
