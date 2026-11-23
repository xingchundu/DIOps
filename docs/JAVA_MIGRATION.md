# Java 化改造说明（dbops-server）

## 1. 改造策略：渐进式迁移

后端约 1.7 万行 Node.js、19 个路由模块。一次性全部重写风险过高，本次采用**绞杀者模式**：

```
浏览器 / Vite / 网关
        │  (仍然访问 :3000，前端零改动)
        ▼
┌──────────────────────────────┐
│ Java dbops-server  :3000      │  ← 本次新建（Spring Boot 3 + JDK 17 + JdbcTemplate）
│  /api/auth   /api/users       │
│  /api/rbac   /api/system-config│
│  /api/cmdb   /api/monitor     │
│  /api/alerts  /health         │
│  监控定时采集 + 告警评估/策略   │
│                               │
│  其余 /api/** ──透明转发──┐    │
└──────────────────────────┼────┘
                           ▼
              Node backend :3001（关闭其监控定时器）
              自动化运维 / SQL 工作台 / 报表 / AI / 标签 / 部署 ...
                           ▼
              Python Agent :8000 / :8001（不变）
```

- 两边共用同一个 Oracle 平台库、同一份 `backend/.env`、同一个 `JWT_SECRET`。Java 签发的 token 与 Node `jsonwebtoken` 互通（已用真实 jsonwebtoken 双向验证）。
- 接口路径、请求参数、返回结构（HTTP 200 + `{code,msg,data}`、Oracle 大写列名、分页 `{total,page,size,list}`、时间 ISO-8601）与 Node 版保持一致，前端无需修改。
- 后续模块按同样方式逐个迁到 Java，迁完一个就把前缀加入 `AuthFilter.OWNED_PREFIXES`，最后去掉 Node。

## 2. 目录结构

```
dbops-server/
├── pom.xml
└── src/main/java/com/dbops/
    ├── DbopsApplication.java          入口（加载 backend/.env）
    ├── config/                        数据源、CORS/过滤器、配置项
    ├── common/                        Db(JdbcTemplate 封装/分页)、R(响应体)、异常处理、取值工具
    ├── security/                      JWT(HS256)、认证/来源校验/限流过滤器、CurrentUser 注入
    ├── service/                       系统配置、RBAC、审计
    ├── controller/                    Auth / User / Rbac / SystemConfig / Cmdb / Monitor / Alert / Health
    ├── monitor/                       被管库连接、Exporter 采集、Oracle/磐维深度指标、SSH 主机采集、
    │                                  健康评分、计数器增量、采集服务与调度、集群汇总
    ├── alert/                         告警评估（持续时长/自动恢复）、静默/抑制/聚合、cron 窗口
    ├── cmdb/                          实例 Excel 导入模板（POI）
    └── legacy/LegacyProxyController   未迁移接口转发给 Node（支持上传、下载、SSE 流）
```

被管库驱动：ojdbc11、mysql-connector-j、postgresql、mssql-jdbc、达梦 DmJdbcDriver18；SSH 用 JSch（mwiede 分支）；Excel 用 Apache POI。

## 3. 构建与运行

要求：JDK 17+、Maven 3.8+（需能访问 Maven 中央仓库或内网镜像）。

```bash
# 1) 执行配套迁移（新增 alert.auto_resolve 配置、"数据库实例不可达"默认规则、索引）
sqlplus user/pwd@db @backend/sql/migration_java_server.sql

# 2) 构建
cd dbops-server && mvn -DskipTests package     # 产物 target/dbops-server.jar

# 3) 一键启动（Node 自动改到 3001 并关闭其定时采集；Java 监听 3000）
./start-java.sh start        # Windows: start-java.bat
./start-java.sh status
```

手动启动时注意三点：

| 进程 | 必须的环境变量 |
|------|----------------|
| Node | `PORT=3001`、`MONITOR_SCHEDULER_ENABLED=false`（否则与 Java 双份采集、重复告警）、`TRUST_PROXY=1`（否则所有用户共用一个限流桶） |
| Java | `DBOPS_ENV_FILE=backend/.env`（或直接设置 DB_* 环境变量）、`LEGACY_NODE_URL=http://127.0.0.1:3001` |
| 两者 | 同一个 `JWT_SECRET`；生产设置 `NODE_ENV=production`（弱密钥时拒绝启动） |

JVM 时区建议与平台库服务器一致（`-Duser.timezone=Asia/Shanghai`），与 Node 读取 TIMESTAMP 的行为一致。

## 4. 新增 / 变化的配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `LEGACY_NODE_ENABLED` | true | false 时不转发，未迁移接口返回 404 |
| `LEGACY_NODE_URL` | http://127.0.0.1:3001 | Node 旧服务地址 |
| `MONITOR_SCHEDULER_ENABLED` | true | Java 与 Node 都认这个变量；**只能有一方为 true** |
| `MONITOR_COLLECT_CONCURRENCY` | 5 | 并发采集实例数 |
| `MONITOR_TARGET_CONNECT_TIMEOUT_SEC` / `..._QUERY_TIMEOUT_SEC` | 20 / 30 | 被管库连接/查询超时 |
| `MONITOR_SSH_STRICT_HOST_KEY` / `MONITOR_SSH_KNOWN_HOSTS` | false / 空 | SSH 主机指纹校验 |
| SYS_CONFIG `alert.auto_resolve` | 1 | 指标恢复自动关闭告警 |
| SYS_CONFIG `alert.evaluation.default_duration_min` | 5 | 规则未填 DURATION 时使用（原先存在但未生效） |

## 5. 行为变化（请知悉）

1. **告警规则 DURATION 开始生效**：原有规则（种子数据 1~5 分钟）需要连续满足对应时长才会触发，不再“一次抖动就告警”。
2. **告警会自动恢复**：条件不再满足时置为 RESOLVED，`RESOLVE_BY=SYSTEM`。
3. **所有库类型都参与告警评估**，规则 METRIC 可直接写任何 exporter 指标名（如 `mysql_global_status_threads_connected`、`mssql_page_life_expectancy`），另提供通用别名 `db_reachable`、`health_score`、`db_active_sessions`、`db_buffer_hit_pct`。
4. **SSH_ENABLED=0 的主机不再做 SSH 采集**（原先只要有凭据就采）。如需采集请在主机管理中勾选“启用 SSH”。
5. 设置了实例级“自动采集间隔”的实例只按自己的间隔采集，不再同时进入全局轮次。
6. 不可达实例健康分为 0（原 40）。
7. MySQL 资源维度按“本周期新增慢查询”打分，历史累计慢查询不再拉低分数。
8. Top SQL 单位统一：`ELAPSED_TIME_TOTAL`/`CPU_TIME_TOTAL` 为秒，`AVG_ELAPSED_MS` 为毫秒。

## 6. 验证情况

- 本次构建环境无法访问 Maven 中央仓库，**未能执行 `mvn package`**。已用 JDK 21（`--release 17`）对全部源码做了编译检查（Jackson、SLF4J、JSch 使用真实 jar；Spring、Servlet、Hikari、POI 使用按真实签名编写的编译桩），并运行了 23 个单元测试（cron 窗口、健康评分、主机输出解析、计数器增量、告警比较与指标别名、JWT 互通、配置加载），全部通过。
- 未连接真实 Oracle/MySQL/PG/达梦/SQL Server 做联调。上线前请在测试环境执行 `mvn test`，并按“登录 → 实例列表 → 立即采集 → 实例详情各 Tab → 告警列表/规则/静默/抑制 → 自动化运维（经转发）”走一遍。

## 7. 下一步迁移建议

| 阶段 | 模块 | 说明 |
|------|------|------|
| 2 | reports、customMetrics、tagGroup、appRelation、serviceCatalog | 纯 CRUD + 查询，量小，可直接复用 `Db` / `R` |
| 3 | sqlWorkbench、sqlReview、sql、sqlOptHistory | 复用 `TargetConnector` 连接被管库 |
| 4 | automation（巡检/备份/部署/容量）、deploy | 量最大（~3000 行），涉及外部脚本与 Python 报告，建议单独排期；同时处理 `BUGFIX_REPORT.md` 三-2 的命令注入 |
| 5 | ai、sqlAgentLlm、sql-agent 代理 | 主要是转发 Python Agent，可在网关层（Spring Cloud Gateway / Nginx）完成 |
