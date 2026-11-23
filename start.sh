#!/bin/bash
# 兼容入口：等同 start-all.sh（原“仅启动 Node 后端”已不适用——认证/CMDB/监控/告警/SQL 洞察在 Java 服务中）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/start-all.sh" "$@"
