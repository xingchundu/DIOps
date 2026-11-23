# 被管库账号权限（监控 / SQL 洞察 / 巡检）

平台 **CMDB 实例上的「数据库用户」** 连接的是**被管库**，与 **`.env` 里 `DB_USER`（平台库 Oracle 用户）** 不是同一套账号。

若监控只能看到「本 schema / 本库」、表空间为空、健康分大量「未采集」，多半是**被管库账号权限不足**，不是平台登录角色（ADMIN/DBA/VIEWER）限制。

## 平台侧角色（应用 RBAC）

| 角色 | 作用 |
|------|------|
| ADMIN / DBA | 纳管实例、改配置、Kill 会话、巡检等 |
| OPS / VIEWER | 看监控与告警（可见范围由菜单权限决定，**不**改变被管库 SQL 能看到的数据） |

## 采集逻辑与「只能看本 schema」的常见原因

| 库类型 | 表现 | 原因 |
|--------|------|------|
| **MySQL / GoldenDB** | 表空间 Tab 只有 1 个 schema | `information_schema.tables` **只包含当前账号有权限的库**；按 `table_schema` 汇总 ≈ 按可见库汇总 |
| **Oracle** | 表空间为空或健康分缺容量项 | **12c+** 优先 `DBA_TABLESPACE_USAGE_METRICS` + `DBA_TABLESPACES`；更低版本或视图不可用则回退 `DBA_DATA_FILES` / `DBA_FREE_SPACE`（再尝试 `ALL_*`） |
| **PostgreSQL / 磐维** | 只显示当前连接库 | `pg_database_size` 对无 CONNECT 权限的库可能不可用；列表以可连接库为主 |
| **达梦** | 部分项缺失 | 依赖 `V$*` / 字典视图，需按文档授权 |
| **SQL Server** | 仅当前库文件 | 采集 SQL 针对 **当前连接库** 的 `sys.database_files` |

深度指标（Oracle/磐维 `V$SESSION`、`V$SYSMETRIC`、SQL 洞察 `V$SQL` 等）需要 **字典/动态性能视图的只读权限**（见下节），不能用「仅有业务 schema 查询」的账号替代。

## Oracle：目录权限（部署必看）

DIOps 对被管 Oracle 的采集 SQL 会访问（包括但不限于）：

| 类型 | 示例对象 | 能力 |
|------|----------|------|
| 动态性能视图 | `V$SESSION`、`V$SQL`、`V$SQLSTATS`、`V$SYSMETRIC`、`V$SYSTEM_EVENT`、`V$LOCK` | 会话、SQL 统计、等待、锁 |
| 数据字典视图 | 12c+：`DBA_TABLESPACE_USAGE_METRICS`、`DBA_TABLESPACES`；否则 `DBA_DATA_FILES`、`DBA_FREE_SPACE`（失败时回退 `ALL_*`） | 表空间容量 |
| 可选 AWR | `DBA_HIST_*`、`DBMS_WORKLOAD_REPOSITORY` | 报告/AWR（需 Diagnostics Pack + 额外授权） |

### `SELECT ANY DICTIONARY`（**推荐，与默认采集一致**）

- **系统权限**：可对数据字典对象执行 `SELECT`（含上述多数 `V$` / `DBA_` / `GV$` 视图）。
- **适用**：希望一次授权即可跑通监控、健康分、SQL 洞察、表空间（在有无 `DBA_*` 时仍有 `ALL_*` 回退）。
- **安全口径**：只读字典，**不等于** `SELECT ANY TABLE`；不授权业务表 DML。仍应使用**专用纳管账号**，勿用业务应用用户。

```sql
GRANT SELECT ANY DICTIONARY TO diops_monitor;
```

### `SELECT_CATALOG_ROLE`（**备选，须 DBA 评估是否够用**）

- **角色**：对数据字典**视图**的 `SELECT`（Oracle 预置目录角色）。
- **与 ANY DICTIONARY 的区别**：二者**不能等同**。部分环境仅授 `SELECT_CATALOG_ROLE` 时，仍可能出现 `DBA_DATA_FILES` / 部分 `V$` 访问失败，表现为表空间为空、健康分「未采集」、SQL 洞察无统计。
- **适用**：企业规范**禁止**授予 `SELECT ANY DICTIONARY`，只允许角色制时，可先授：

```sql
GRANT SELECT_CATALOG_ROLE TO diops_monitor;
```

授后必须用下文 **自检 SQL** 验证；不通过则改为 `SELECT ANY DICTIONARY`，或由 DBA 按失败对象逐条 `GRANT SELECT ON ...`（维护成本高，不推荐除非合规强制）。

### 部署建议（二选一 + 固定基础权限）

| 策略 | 授权 |
|------|------|
| **A（推荐）** | `CREATE SESSION` + `SELECT ANY DICTIONARY` + `SELECT ANY TRANSACTION` +（按需）`LOGMINING` |
| **B（合规收紧）** | `CREATE SESSION` + `SELECT_CATALOG_ROLE` + `SELECT ANY TRANSACTION` + 自检不通过再补权或改 A |

无论 A/B，均需 **`CREATE SESSION`**、建议 **`SELECT ANY TRANSACTION`**（避免只能看到本 schema 相关事务视图）。**平台库** `config/backend.env` 中的 `DB_USER` **不要**用来连被管库。

## 推荐：专用只读监控账号

在被管库上创建 **只用于 DIOps 纳管** 的用户，不要使用业务 schema 应用账号。

### Oracle（被管库 · 监控用户）

在被管 Oracle 上创建**专用纳管账号**（勿用业务 schema 用户、勿与平台库 `.env` 的 `DB_USER` 混用）：

```sql
CREATE USER diops_monitor IDENTIFIED BY "替换为强口令"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp;

GRANT CREATE SESSION TO diops_monitor;
GRANT CREATE TABLE TO diops_monitor;      -- 纯只读监控可按规范省略
GRANT CREATE SEQUENCE TO diops_monitor;   -- 同上，可选
GRANT LOGMINING TO diops_monitor;         -- SQL 洞察 / LogMiner 相关，按版本与许可
GRANT SELECT ANY DICTIONARY TO diops_monitor;   -- 推荐；若不允许则见上节「SELECT_CATALOG_ROLE」
GRANT SELECT ANY TRANSACTION TO diops_monitor;
```

| 权限 / 角色 | 用途（DIOps） |
|-------------|----------------|
| `CREATE SESSION` | 连接被管库（必选） |
| `SELECT ANY DICTIONARY` | 查询 `V$` / `DBA_` / `GV$` 等：会话、表空间、等待事件、SQL 统计、健康分与告警（**推荐**） |
| `SELECT_CATALOG_ROLE` | 仅当不允许 ANY DICTIONARY 时的备选；**授后必须跑自检 SQL** |
| `SELECT ANY TRANSACTION` | 跨 schema 读取事务/一致性读相关视图，避免只能看到本用户 schema |
| `LOGMINING` | LogMiner 相关能力（部分 SQL 洞察 / 审计类能力，按库版本与许可） |
| `CREATE TABLE` / `CREATE SEQUENCE` | 若需在**被管库本用户 schema** 下放临时表/序列（部分巡检或工具链）；**纯只读监控可不授**，按贵司规范二选一 |

可选（按需追加，非上表必选）：

```sql
-- AWR HTML 报告：需 Diagnostics Pack + 执行包权限
-- GRANT EXECUTE ON DBMS_WORKLOAD_REPOSITORY TO diops_monitor;
-- GRANT SELECT ON DBA_HIST_* ... （按版本与 DBA 要求细化）
```

授权后自检（用 `diops_monitor` 登录；**部署交付前建议 DBA 执行并留存结果**）：

```sql
-- 1) 动态性能视图（需 SELECT ANY DICTIONARY 或等效）
SELECT COUNT(*) FROM v$session;
SELECT sql_id FROM v$sql WHERE ROWNUM = 1;

-- 2) 表空间（优先 DBA_*；无权限时平台回退 ALL_*，结果可能不全）
SELECT COUNT(*) FROM dba_data_files;

-- 3) 任一项 ORA-01031 / ORA-00942 即需补权或改用 SELECT ANY DICTIONARY
```

若仍只能看到本 schema，请确认 CMDB 中填写的正是上述用户，且未使用权限受限的应用账号。

### MySQL 8.x / GoldenDB

```sql
CREATE USER 'diops_monitor'@'%' IDENTIFIED BY '替换为强口令';
GRANT SELECT, PROCESS, REPLICATION CLIENT ON *.* TO 'diops_monitor'@'%';
GRANT SELECT ON performance_schema.* TO 'diops_monitor'@'%';
```

无 `SELECT ON *.*` 时，监控通常只能看到**授权过的那个 schema**。

### PostgreSQL / 磐维（PanWei）

```sql
CREATE USER diops_monitor WITH PASSWORD '替换为强口令';
GRANT pg_read_all_stats TO diops_monitor;  -- 10+ 若无此角色，用超级用户或按库 CONNECT
-- 对各业务库：GRANT CONNECT ON DATABASE dbname TO diops_monitor;
```

### 达梦

```sql
-- 参考 docs/automation/checkv8-inspect.md：至少可查 V$；监控与表空间需字典/动态视图只读
GRANT SELECT ON V$DATAFILE TO diops_monitor;  -- 具体以达梦版本手册为准
```

## Oracle 版本与连接方式（离线包）

| 场景 | 驱动 | 说明 |
|------|------|------|
| **平台库**（`DB_USER`） | Node/Java **Thin** | 建议 Oracle **12.1+**；无需 Instant Client |
| **被管库** 监控采集 | **Java JDBC** | 11g/12c/RAC 均可；等待事件等 SQL 已兼容 11g |
| **被管库** WebSQL（Node） | node-oracledb **Thin** | **11g 会 NJS-118**；需安装 Instant Client 并设 `ORACLE_CLIENT_LIB_DIR` + `NODE_ORACLEDB_DRIVER_MODE=thick` |

## 如何自查

1. **CMDB** 确认纳管用户是**被管库**专用账号，不是平台库 `monitor` 用户误填。
2. 实例详情 → **立即采集** → 看「离线/未采集」说明；表空间 Tab 点刷新，若报错含 `DBA_DATA_FILES` 即权限问题。
3. 用同一账号在客户端执行采集 SQL（如 Oracle 的 `SELECT COUNT(*) FROM v$session`）。
4. SQL 洞察仅统计**非系统 schema** 的 SQL，不包含 SYS 等；若业务 SQL 也看不到，仍是 `V$SQL` / 性能视图权限不足。

## 相关代码

- 表空间：`dbops-server/.../monitor/ExporterCollector.java`（Oracle 先 `DBA_*`，再 `ALL_*`）
- 健康分未采集项：`HealthScorer.java`（无数据不扣分，界面显示「未采集」）
- 安装纳管说明：`docs/INSTALL.md` §3.5
