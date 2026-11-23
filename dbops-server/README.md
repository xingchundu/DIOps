# dbops-server（Java 后端）

Spring Boot 3.3 / JDK 17 / JdbcTemplate。接管核心监控链路：认证、用户、RBAC、系统配置、CMDB、监控采集与告警；其余接口转发给 Node 旧服务。

```bash
mvn -DskipTests package
DBOPS_ENV_FILE=../backend/.env LEGACY_NODE_URL=http://127.0.0.1:3001 \
  java -Duser.timezone=Asia/Shanghai -jar target/dbops-server.jar
```

Node 侧需以 `PORT=3001 MONITOR_SCHEDULER_ENABLED=false TRUST_PROXY=1` 启动，或直接使用仓库根目录的 `start-java.sh`。

详细说明见 [`../docs/JAVA_MIGRATION.md`](../docs/JAVA_MIGRATION.md)，缺陷修复清单见 [`../BUGFIX_REPORT.md`](../BUGFIX_REPORT.md)。

## SQL 洞察（com.dbops.sqlinsight）

SQL 问题识别 + 异常波动检测 + 原因诊断 + 统一 SQL 审核/执行计划，设计与上线步骤见 `docs/SQL_INSIGHT_DESIGN.md`。

- 依赖：`com.alibaba:druid`（仅用其 SQL Parser，不使用 Druid 连接池）
- 数据表：先执行 `backend/sql/migration_sql_insight.sql`
- 调度：与监控共用 `MONITOR_SCHEDULER_ENABLED`；各阶段开关在“系统配置 → SQL洞察”
- 多节点：`SQLINSIGHT_SHARD_COUNT` / `SQLINSIGHT_SHARD_INDEX` 按实例 ID 取模分片
- Node / Python 调用地址：环境变量 `JAVA_SERVER_URL`（默认 `http://127.0.0.1:3000`）
