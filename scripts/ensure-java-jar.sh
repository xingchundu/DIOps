#!/bin/bash
# 确保 dbops-server/target/dbops-server.jar 存在且不比源码旧；需要时用 Maven 重新构建。
# 退出码：0 = jar 可用（最新）；1 = 不可用（无 jar 且无法构建，或构建失败）
# [fix] 原 start-java 只在 jar 不存在时才构建：升级代码后仍运行旧 jar，新接口（如 /api/sql-insight）全部“接口不存在”
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRV="$ROOT/dbops-server"
JAR="$SRV/target/dbops-server.jar"

stale=0
if [ ! -f "$JAR" ]; then
  stale=1
elif [ -n "$(find "$SRV/src/main" "$SRV/pom.xml" -type f -newer "$JAR" -print -quit 2>/dev/null)" ]; then
  stale=1
fi
[ "$stale" = "0" ] && exit 0

if ! command -v mvn >/dev/null 2>&1; then
  if [ -f "$JAR" ]; then
    echo "[ERROR] dbops-server.jar 比源码旧，且未找到 Maven（mvn），无法重新构建。请安装 Maven 3.8+ 后执行：cd dbops-server && mvn -DskipTests package" >&2
  else
    echo "[ERROR] 未找到 $JAR，且未找到 Maven（mvn）。需要 JDK 17+ 与 Maven 3.8+" >&2
  fi
  exit 1
fi
echo "[INFO] 源码有更新，重新构建 dbops-server（mvn -DskipTests package）..."
if (cd "$SRV" && mvn -q -DskipTests package); then
  echo "[OK] 构建完成: $JAR"
  exit 0
fi
echo "[ERROR] dbops-server 构建失败，请查看上方 Maven 输出" >&2
exit 1
