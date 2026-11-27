# 数据库巡检中心设计（Oracle / 达梦 / MySQL / PostgreSQL）

与「操作系统巡检」同一套结构：**检查项 → 巡检模板 → 巡检计划 → 巡检记录 → 问题项 → 巡检报告**。
原则不变：**采集只取数，判定由规则引擎完成**；连不上的实例记「巡检失败」单独统计；复检正常的问题项自动置「已整改」。

入口：菜单「数据库巡检」（`/db-inspect`）；接口前缀 `/api/db-inspect`（Node，经 Java 网关转发）。

## 1. 与 OS 巡检的对应关系

| OS 巡检 | 数据库巡检 | 说明 |
|---|---|---|
| 按 OS 类型区分采集脚本 | 按**方言族**区分采集 SQL：ORACLE / MYSQL / POSTGRESQL / DAMENG | GoldenDB→MYSQL，PanWei→POSTGRESQL；一个检查项 = 一份规则 + 每个方言族一份采集 SQL |
| 阈值 | 阈值（预警/严重），可按 **数据库类型 / 环境 / 业务线 / 实例** 覆盖 | 优先级：实例 > 业务线 > 环境 > 数据库类型 > 默认；可对某范围「关闭该项」 |
| 专项模板 + 告警联动 | 同：模板类型 `SPECIAL`，配置告警关键字，告警触发后自动对该实例跑专项巡检（冷却 30 分钟） | `DBINSPECT_ALERT_COOLDOWN_MIN` |
| 执行窗口（支持跨午夜） | 同：`22:00-06:00` 视为跨午夜，不在窗口内到点跳过 | |
| 巡检失败单独统计 | 同：连接失败/整体异常 → `FAIL_INST`；单个检查项采集失败（权限/视图不存在）→ 「采集失败」，**都不计入数据库异常**，也不会误把旧问题判为已整改 | |
| 复检自动整改 | 同：本次成功采集且结果完整、不再出现的问题项自动 `FIXED`；结果被截断时不自动整改 | |
| Word / Excel 报告 | 同，并新增 **SQL 洞察（按 Oracle / PostgreSQL / MySQL / 达梦分节）** | 见第 4 节 |

## 2. 数据模型（`backend/sql/migration_db_inspect.sql`，幂等，已加入 `init-merge.list`）

`DBI_CHECK_ITEM`（检查项：规则 JSON、默认阈值、整改建议、是否含 SQL ID）· `DBI_CHECK_IMPL`（每方言族的采集 SQL / 备用 SQL / 列映射 / 单位 / 阈值，`IS_CUSTOM=1` 表示用户改过，升级不覆盖）· `DBI_THRESHOLD`（范围覆盖）· `DBI_TEMPLATE(+_ITEM)` · `DBI_PLAN` · `DBI_RUN`（一次触发一条）· `DBI_RUN_INSTANCE`（按实例拆子任务）· `DBI_RUN_RESULT`（每实例每检查项一条，含证据 JSON）· `DBI_ISSUE`（问题项，唯一键：实例+检查项+对象，函数索引保证「当前问题」唯一）· `DBI_SQL_SNAPSHOT`（SQL 洞察快照，含 SQL_ID）· `DBI_REPORT`。

升级：重启即自动同步内置检查项（`store.ensureSeeded`）；用户改过的名称/阈值/建议/启停/自定义采集 SQL 不会被覆盖；模板仅在不存在时创建。

## 3. 检查项目录（36 项，6 个内置模板）

分类：可用性 / 资源 / 存储 / 性能 / SQL 洞察 / 高可用 / 备份 / 配置 / 安全 / 日志。
模板：`db-daily-health`（23 项日常）· `db-sql-insight`（15 项，绑定告警关键字：慢SQL/锁等待/长事务/CPU…）· `db-space-special`（空间专项）· `db-ha-backup`（主备与备份专项）· `db-baseline`（配置与安全基线）· `db-full`（全量 36 项）。

规则类型：`THRESHOLD`（越高/越低越差，可设空值等级）· `ROWS`（有返回即异常）· `STATUS`（状态值判定）· `TOPN`（Top N，按阈值标注严重度，也可仅记录）· `INFO`（仅记录）。

采集 SQL 的**结果列约定**：`OBJ`（对象）、`VAL`（判定值）、`TXT`（文本）；SQL 类另需 `SQL_ID / SQL_TEXT`，可选 `SQL_ID_KIND / PLAN_HASH / SCHEMA_NAME / EXECS / TOTAL_MS / AVG_MS / CPU_MS / LOGICAL_READS / PHYSICAL_READS / ROWS_PROC / ROWS_EXAMINED`，其余列自动作为证据。占位符：`{{TOPN}} {{DAYS}} {{MINEXECS}}`（仅整数）。所有内置 SQL 在测试中经只读校验（`readOnlyViolation`），自定义 SQL 保存时同样校验。

## 4. SQL 洞察与 sql_id

所有 SQL 类检查项（Top 耗时/CPU/IO/执行次数、平均耗时过高、读/扫描过大、全表扫描、执行计划变化、未绑变量、长时间运行，以及**锁等待、长事务**中涉及的 SQL）都返回 SQL ID，并写入问题项与 `DBI_SQL_SNAPSHOT`：

| 数据库 | SQL ID 来源 | ID 类型 | 数据源 |
|---|---|---|---|
| Oracle | `V$SQL.SQL_ID`（计划哈希 `PLAN_HASH_VALUE`） | SQL_ID | `V$SQL` / `V$SESSION` / `V$LOCK` |
| PostgreSQL / PanWei | `pg_stat_statements.queryid`（回退 `dbe_perf.statement.unique_sql_id`） | queryid | `pg_stat_statements`（总耗时列自动在 `total_exec_time`/`total_time` 间回退） |
| MySQL / GoldenDB | `events_statements_summary_by_digest.DIGEST` | digest | `performance_schema` |
| 达梦 | `V$SQL_STAT.SQL_ID` | SQL_ID | `V$SQL_STAT`，**按实际列自适应生成**（各版本列名不同） |
| 任意库缺失原生 ID | SQL 归一化后的 sha1 指纹 `FP:xxxx`（字面量/空白/大小写不敏感） | 指纹 | — |

报告（Word/Excel）「三、SQL 洞察」按数据库类型分节 → 实例 → 维度，列出排名、SQL ID（含类型）、计划哈希、执行次数、总耗时/平均耗时、逻辑读（MySQL 为扫描行）、判定、SQL 文本。问题项里的 SQL 类问题以 `sql_id` 作为对象键，因此同一条 SQL 跨次巡检可追踪、复检可自动整改。

## 5. 运行与调度

- `runner.startRun`：创建 `DBI_RUN` 后异步执行，多实例并发（`DBINSPECT_CONCURRENCY`，默认 3），每实例单连接顺序跑检查项；前端轮询进度。
- 同一计划同时只允许一个 RUNNING（本进程内存 + 库内 2 小时内 RUNNING 记录双重保护）；服务重启时把超过 2 小时的 RUNNING 收尾为失败。
- `scheduler`：node-cron，每 90 秒对账计划（增删改后自动生效）；告警联动每 60 秒轮询 `ALERT_RECORD`。随 Node 启动（`platform/bootstrap.js`），`DBINSPECT_SCHEDULER=0` 可关闭。
- 采集保护：只读校验、单语句超时（`DBINSPECT_STMT_TIMEOUT_MS`）、结果行数上限（`DBINSPECT_MAX_ROWS`）、连接中断后其余项标记「未执行」而不是逐个超时。

## 6. 目标库所需权限（只读）

- Oracle：`SELECT_CATALOG_ROLE`（V$SQL、V$SESSION、V$LOCK、DBA_* 视图）。
- PostgreSQL：`pg_monitor` 角色 + `CREATE EXTENSION pg_stat_statements`（并在 `shared_preload_libraries` 中加载）；未启用时 SQL 洞察显示「采集失败」并给出提示。
- MySQL：`PROCESS`、`REPLICATION CLIENT`、对 `performance_schema` 的 `SELECT`（需开启 `performance_schema`）。
- 达梦：能查询 `V$SQL_STAT`、`V$SESSIONS`、`V$LOCK`、`DBA_*` 的账号。

## 7. 已知边界（需要在真实实例上验证）

- 达梦不同版本的视图/列差异大：SQL 洞察用列探测自适应，其余检查项（表空间、会话、主备、备份）的 SQL 未能在真实达梦实例上验证；任何一项失败只会显示「采集失败」+ 原因，可在「检查项 → 采集实现」里直接改 SQL，不影响其他项。时间列单位默认毫秒，微秒版本设 `DBINSPECT_DM_TIME_DIVISOR=1000`。
- 本次交付在无真实数据库的环境中完成：判定引擎、方言、SQL 只读校验、报告生成、调度窗口、前端构建均已自动化验证（`backend/test/dbinspect.test.js`，`npm test`）；各库采集 SQL 的实际执行需在你的环境首次巡检后确认。
- 「AI 分析」未接入本模块。

## 8. 环境变量

`DBINSPECT_SCHEDULER`(1) · `DBINSPECT_ALERT_LINK`(1) · `DBINSPECT_ALERT_POLL_SEC`(60) · `DBINSPECT_ALERT_COOLDOWN_MIN`(30) · `DBINSPECT_CONCURRENCY`(3) · `DBINSPECT_TOPN`(10) · `DBINSPECT_SQL_DAYS`(1) · `DBINSPECT_MAX_ROWS` · `DBINSPECT_STMT_TIMEOUT_MS` · `DBINSPECT_DM_TIME_DIVISOR`(1)。

## 补充（v2）

- **巡检项目录**：`catalog/oracleCollect.js` 按 `collect_db.sql` 分节生成 111 个 `ora.*` 巡检项（含 DIAG/TUNE/HEAVY 标签），模板：ora-collect-standard / nopack / full / ora-rac-special。自定义巡检项仍通过「新增巡检项 + 保存实现 SQL」添加，可指定 sqlBearing 与规则类型。
- **巡检报告**：`wordReport.js` 按样例 Word（Oracle 巡检报告）版式生成，所有数据库类型共用：封面、1 巡检结论、2 问题清单与建议（H/M/L）、3 环境概况、分类检查表、高消耗 SQL（按库类型，带 SQL_ID）、实施计划、附录。
- **SQL 洞察 sql_id**：问题SQL、SQL资产、异常波动、计划变化、概览 Top SQL / 慢 SQL 接口新增 `NATIVE_SQL_ID`（取自 `DI_SQL_ASSET_SOURCE.NATIVE_ID`，无需迁移）；前端列 `SQL_ID`（MySQL 取 digest，PG 取 queryid）；SQL 资产搜索支持按 sql_id。慢 SQL 原已存 `SQL_SLOW_SUMMARY.NATIVE_SQL_ID`。
