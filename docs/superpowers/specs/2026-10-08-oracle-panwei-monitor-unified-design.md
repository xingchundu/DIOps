# Oracle + 磐维（PanWeiDB）监控项统一落地方案

**版本：** v1.0（设计稿）  
**日期：** 2026-10-08  

| 输入清单 | 项数 | 结构化文件 |
|----------|------|------------|
| Oracle数据库监控项.xlsx | 129 | `docs/_oracle_monitor_items.json` |
| panwei数据库监控项清单.xlsx | 107 | `docs/_panwei_monitor_items.json` |
| **合计** | **236** | 导入同一监控目录 |

**环境（已确认）：**

- 主机可 **SSH**（Oracle / 磐维共用）
- Oracle **RAC / ASM**；磐维 **集群 / 主备**（openGauss 系工具 `gs_om` / `gs_ctl`）
- Oracle RAC：**每节点单独 CMDB 实例**（选项 B）
- 磐维集群：**同样每节点一条 CMDB 实例** + `CMDB_CLUSTER` 汇总（与 Oracle 模型一致）

**前置设计：** Oracle 细节见 `2026-10-08-oracle-monitor-excel-design.md` v0.2；本文在其上扩展为 **双引擎统一架构**。

---

## 1. 目标

一套监控子系统同时承载 Oracle 129 项与磐维 107 项，复用现有：

`CMDB` → `monitorCollectPersist` → `MONITOR_METRIC_SAMPLE` → 实例详情 / 健康分 / 告警中心 / 巡检 / 自定义指标  

**不改动** SQL 工作台、CMDB 审批、业务模块逻辑。

---

## 2. 清单特征对比

| 维度 | Oracle 129 项 | 磐维 107 项 |
|------|---------------|-------------|
| 大类数量 | 9 | 17 |
| 主机/OS 占比 | 中（listener/CRS/df/ps，阶段 3） | **高**（第 1 类 16 项几乎全 SSH：top/vmstat/iostat/df） |
| 库内 SQL | `V$` / `DBA_` / 少量 `GV$` | **`pg_*` + 磐维 `dbe_perf.*` + `gs_*` shell** |
| 集群 | RAC、CRS、ASM | `gs_om -t status`、主备复制、`pg_stat_replication` |
| 许可敏感 | Diagnostics（ASH/AWR） | 较少；注意 `dbe_perf` 视图权限 |
| 本工程现状 | 9 个 sysmetric + 表空间 + 巡检大 SQL | 与 **PostgreSQL 同采集器**（`pgPerformance`），无磐维专有项 |

**磐维采集方式粗分（107 项）：**

| 通道 | 约占比 | 说明 |
|------|--------|------|
| **SQL** | ~59 | `pg_stat_*`、`pg_settings`、`dbe_perf.statement` 等 |
| **HOST** | ~27 | top、vmstat、df、gs_om、gs_ctl |
| **MIXED** | ~21 | SQL + 主机命令组合，实现时拆成两步 |

---

## 3. 统一架构

```text
                    ┌─────────────────────────────────────┐
                    │   DB_MONITOR_CATALOG (236 rows)      │
                    │   DB_TYPE: ORACLE | PANWEI | BOTH    │
                    │   collect_mode: REALTIME|INSPECT|HOST│
                    │   metric_key, threshold, severity    │
                    └─────────────────────────────────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          ▼                             ▼                             ▼
   REALTIME (周期)                  INSPECT (巡检)                  HOST (SSH)
          │                             │                             │
   engineCollectAdapter              inspectTaskRun                 hostCollect
          │                             │                             │
   ┌──────┴──────┐                      │                      共用服务
   │ Oracle      │                      │                   hostCollect.js
   │ Panwei/PG   │                      │                   (原 oracleHostCollect
   └──────┬──────┘                      │                    泛化命名)
          ▼                             ▼                             ▼
              MONITOR_METRIC_SAMPLE.METRICS_JSON (+ labels)
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
      alertEvaluator (实例级)          clusterMetricRollup (集群级)
              │                               │
              └───────────────┬───────────────┘
                              ▼
                        ALERT_RECORD
```

### 3.1 引擎适配器（Realtime）

| 适配器 | 入口 | 扩展方向 |
|--------|------|----------|
| `oracleRealtimeBundle` | 现有 `oraclePerformance` + 表空间 + 新增 SQL 包 | `V$RESOURCE_LIMIT`、UNDO/TEMP/FRA、ASM（HUB 节点） |
| `panweiRealtimeBundle` | 现有 `pgPerformance` | 连接率、`pg_stat_bgwriter`、复制延迟、库容量；**磐维** `dbe_perf` 摘要（TOP SQL 计数） |

采集调度不变：`collectAllInstances()` **按 CMDB_INSTANCE 逐条执行**；`DB_TYPE` 选择适配器。

**磐维与 PostgreSQL：** 运行时仍可用 `connectPostgres`；`metricEngine` 在持久化层区分 `PANWEI` 与 `POSTGRESQL`（已有逻辑），指标 key 使用 `panwei_*` 前缀避免与纯 PG 实例混淆。

### 3.2 集群模型（Oracle RAC = 磐维分布式/主备集群）

共用 **`CMDB_CLUSTER` + `CMDB_CLUSTER_MEMBER`**：

| 引擎 | CLUSTER_TYPE | 每节点 CMDB | 集群级指标 | HUB 节点 |
|------|--------------|-------------|------------|----------|
| Oracle RAC | `RAC` | 1 实例 / 节点 VIP+SID | 节点数、ASM（HUB 采） | `NODE_ROLE=METRIC_HUB` |
| 磐维 | `PANWEI_CLUSTER` 或 `MPP` | 1 实例 / 节点 | `gs_om` 集群状态、复制汇总 | 同上 |

**`clusterMetricRollup`：** 对 `EXPECTED_MEMBER_COUNT`、集群 Normal/非 Normal、双主等 **只告警一次**（`CLUSTER_ID`）。

### 3.3 HOST 通道（两引擎共用）

Oracle 与磐维清单均大量依赖主机指标，**只实现一套** `hostCollect.js`：

- 白名单命令：`df`、`free`、`vmstat`、`iostat`、`uptime`、`ps`、…  
- Oracle 专有：`lsnrctl`、`crsctl`  
- 磐维专有：`gs_om -t status --detail`、`gs_ctl query`  

绑定关系：**每个 CMDB_INSTANCE.HOST_ID** → 该节点 SSH（与「每节点一条实例」一致）。

---

## 4. 监控目录表（统一元数据）

建议单表（实现时 migration）：

```text
DB_MONITOR_CATALOG
  CATALOG_ID, SOURCE_FILE, ITEM_NO
  DB_TYPE          -- ORACLE | PANWEI | ALL
  CATEGORY, SUBCATEGORY, ITEM_NAME
  COLLECT_MODE     -- REALTIME | INSPECT | HOST | CLUSTER_ROLLUP
  COLLECT_SPEC     -- SQL 或 shell 模板（可含占位符）
  METRIC_KEY       -- 全局唯一，如 oracle_tablespace_used_pct / panwei_conn_used_pct
  THRESHOLD_WARN, THRESHOLD_CRIT, SEVERITY
  REQUIRES_TAG     -- RAC, ASM, DIAG_PACK, DBA, SSH, PANWEI_DBE_PERF
  ENABLED
```

Excel 一次性导入 236 行；Oracle-only / Panwei-only 用 `DB_TYPE` 过滤。

---

## 5. 语义对照（统一告警与大盘）

便于运维「同一屏看两种库」——**语义层 metric 族** + **引擎具体 key**：

| 语义族 | Oracle metric_key（示例） | 磐维 metric_key（示例） | 共用阈值思路 |
|--------|---------------------------|---------------------------|--------------|
| 实例可用 | `oracle_instance_open` | `panwei_instance_up` | 非 OPEN / 不可连 → 严重 |
| 意外重启 | `oracle_uptime_hours` | `panwei_uptime_hours` | < 6h / 24h 内重启 |
| 连接使用率 | `oracle_sessions_used_pct` | `panwei_conn_used_pct` | > 80% / 90% |
| 缓冲命中率 | `oracle_buffer_cache_hit_pct` | `panwei_buffer_hit_pct` | OLTP < 90% |
| 空间 | `oracle_tablespace_used_pct` | `panwei_db_disk_used_pct` | 85% / 95% |
| WAL/Redo | `oracle_fra_used_pct`、redo | `panwei_wal_dir_used_pct` | 80% / 95% |
| 复制/备库 | `oracle_db_role`、DG | `panwei_replication_lag_bytes` | lag / 非 streaming |
| 阻塞 | `oracle_blocking_session_max_sec` | `panwei_lock_wait_max_sec` | > 60s |
| TOP SQL | `oracle_top_sql_dbtime_pct` | `panwei_top_sql_elapsed_pct` | > 20% |
| 主机 CPU | `host_cpu_used_pct` | `host_cpu_used_pct` | **共用** > 80% |
| 主机磁盘 | `host_fs_used_pct` | `host_fs_used_pct` | **共用** 85% / 95% |
| 集群健康 | `oracle_rac_node_count` | `panwei_cluster_status` | rollup |

前端「监控覆盖度」可按 **语义族** 展示 Oracle/磐维各覆盖多少项。

---

## 6. 分阶段实施（双引擎并行）

### 阶段 1 — P0 实时 + 告警（约 3 周）

**共用：** `alertEvaluator`、`METRICS_JSON` 约定、`DB_MONITOR_CATALOG` 导入、阶段 1 告警规则。

| 引擎 | 阶段 1 重点项（与 Excel 对齐） |
|------|--------------------------------|
| **Oracle** | 实例 OPEN、resource_limit 80%、表空间 85/95、UNDO/TEMP/FRA、Buffer hit、log file sync、RAC 节点 rollup |
| **磐维** | `pg_postmaster_start_time`、连接/max_connections 80/90%、`pg_buffer_cache_hit_ratio`、库/目录空间、复制 streaming & lag、idle in transaction |

**磐维阶段 1 暂不采：** 全部 16 项主机细粒度（留阶段 2/3 与 Oracle HOST 一并交付）。

**Oracle 阶段 1 暂不采：** SSH listener/CRS（阶段 3）。

### 阶段 2 — 深度 SQL + 巡检（约 2 周）

| 引擎 | 内容 |
|------|------|
| Oracle | Top 等待/Top SQL、锁链、alert ORA-、DG/RMAN（巡检 + 摘要） |
| 磐维 | `dbe_perf.statement` TOP N、锁/死锁、`pg_stat_user_tables` 膨胀、统计信息陈旧、checkpoint |

### 阶段 3 — HOST + 集群 shell（约 2～3 周）

**一次开发，两引擎复用：**

- 主机：CPU/load/iowait、内存/swap、iostat、df/inode（磐维清单第 1 类 + Oracle df/ps）
- Oracle：lsnrctl、crsctl、私网
- 磐维：`gs_om -t status`、`gs_ctl query`、WAL/归档目录 `du`

---

## 7. CMDB 纳管约定（Oracle + 磐维）

| 场景 | 做法 |
|------|------|
| Oracle RAC 节点 | N 条 `DB_TYPE=ORACLE`，入 `CMDB_CLUSTER(RAC)`，各绑 `HOST_ID` |
| 磐维 2 节点集群 | N 条 `DB_TYPE=PANWEI`，入 `CMDB_CLUSTER(PANWEI_CLUSTER)` |
| 单机 + SSH | 1 实例 + 1 `HOST_ID` |
| 连接串 | Oracle：节点 VIP + 实例 SID；磐维：节点 IP + 端口 + 库名（postgres 协议） |
| HUB | 每集群 1 个 `METRIC_HUB`：Oracle 采 ASM/FRA；磐维采 `gs_om` 集群态 + 全局复制视图 |

**待扩展字段（与 Oracle 设计一致）：** `CMDB_CLUSTER.EXPECTED_MEMBER_COUNT`、`CMDB_HOST.SSH_*`、`ENABLE_DIAG_PACK`（Oracle）、`PANWEI_ENABLE_DBE_PERF`（可选）。

---

## 8. 覆盖率目标（三阶段后）

| 清单 | 项数 | 目标可告警覆盖 |
|------|------|----------------|
| Oracle | 129 | ~90%（Diagnostics/RAC 极端项受标签控制） |
| 磐维 | 107 | ~85%（主机 16 项 + gs_om 依赖 SSH 与版本） |

---

## 9. 非目标

- 不合并 Oracle 与磐维为同一 SQL 方言；仅 **目录、HOST、告警、集群 rollup** 统一。
- 阶段 1 不做 236 项全部 UI 表单。

---

## 10. 下一步

1. 评审本统一设计 + Oracle v0.2 细节。  
2. 编写实现计划：`DB_MONITOR_CATALOG` migration、双 adapter、`hostCollect`、`clusterMetricRollup`、`alertEvaluator`。  
3. 导入脚本：`import_monitor_catalog.py` ← 两个 JSON。

---

## 11. 参考

- `docs/_oracle_monitor_items.json`
- `docs/_panwei_monitor_items.json`
- `docs/superpowers/specs/2026-10-08-oracle-monitor-excel-design.md`
- `backend/src/services/monitorExporterCollect.js`（`oraclePerformance` / `pgPerformance`）
- `backend/src/templates/inspect/oracle_master_inspection.sql`（磐维可增 `panwei_master_inspection.sql` 同级模板）
