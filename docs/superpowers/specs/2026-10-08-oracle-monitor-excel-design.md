# Oracle 监控项（Excel 129 项）在本工程的落地方案

**版本：** v0.2（设计稿）  
**日期：** 2026-10-08  
**统一设计（Oracle + 磐维）：** 见 [`2026-10-08-oracle-panwei-monitor-unified-design.md`](./2026-10-08-oracle-panwei-monitor-unified-design.md)  
**输入：** `Oracle数据库监控项.xlsx` → 结构化清单 `docs/_oracle_monitor_items.json`  
**环境确认：** **2** 单机可 SSH 主机 + **3** RAC / ASM  
**RAC 纳管方式（已确认）：** **B — 每个节点单独建 CMDB 实例**（非 SCAN 单连接）  

---

## 1. 目标

在 **DIOps 现有监控链路**（CMDB 纳管 → 定时采集 → `MONITOR_METRIC_SAMPLE` → 实例详情/健康分/告警中心）上，覆盖 Excel 中 129 项 Oracle 监控要求，**不替换** SQL 工作台、CMDB、巡检报告等既有模块。

---

## 2. 现状与缺口

| 能力 | 现状 | 与 Excel 差距 |
|------|------|----------------|
| 周期采集 | `monitorCollectPersist` ~90s，`oraclePerformance` 约 9 个 `V$SYSMETRIC` + 会话 | 缺 resource_limit、UNDO/TEMP/FRA、ASM、等待事件、DG 角色等 |
| 表空间 | `oracleTablespaces`（DBA 视图） | 阈值与 Excel 85%/95% 两档未统一 |
| 巡检 | `oracle_master_inspection.sql` 含锁、alert、段等 | 偏日检，未与实时告警绑定 |
| 告警 | `ALERT_RULE` 种子 4 条，无统一评估引擎 | 129 项未映射 `metric_key` |
| 主机 / RAC | 文档明确：**当前巡检仅 DB 内 SQL**，无 SSH 采集 | Excel 中 lsnrctl、crsctl、df、ps、私网等 **未实现** |

---

## 3. 总体架构（方案 B：目录 + 三通道）

```text
Excel 129 项
    │
    ▼
ORACLE_MONITOR_CATALOG（配置表，每行一项）
    │
    ├── REALTIME ──► monitorExporterCollect 扩展 ──► METRICS_JSON + 归一化指标
    ├── INSPECT  ──► 巡检 SQL 片段 / 定时 inspectTaskRun ──► 报告 + 可选告警
    └── HOST     ──► oracleHostCollect（新增）SSH 按节点执行 ──► METRICS_JSON(host.*)
                              │
                              ▼
                    alertEvaluator（新增/增强）──► ALERT_RECORD
```

### 3.1 RAC + ASM + SSH 拓扑（每节点一条 CMDB 实例）

本工程已有 **`CMDB_CLUSTER` + `CMDB_CLUSTER_MEMBER`**，与选项 B 对齐，无需「SCAN 单实例代表全集群」。

```text
CMDB_CLUSTER  (CLUSTER_TYPE=RAC, CLUSTER_NAME=PROD_RAC)
    │
    ├── CMDB_CLUSTER_MEMBER ──► CMDB_INSTANCE #1  (ORA19C-RAC1)
    │         NODE_ROLE=PRIMARY              HOST_IP=节点1 VIP
    │         └── HOST_ID ──► SSH（本节点 lsnrctl / crsctl / df / ps）
    │         └── Oracle 连接 ──► 本节点实例（SID/INSTANCE_NAME 或节点 TNS）
    │                              库内 SQL 以 V$* 为主（本实例视角）
    │
    ├── CMDB_CLUSTER_MEMBER ──► CMDB_INSTANCE #2  (ORA19C-RAC2)
    │         ...
    └── EXPECTED_MEMBER_COUNT = N（集群级配置，见下）

定时采集 collectAllInstances()：
  对每个 CMDB_INSTANCE 独立采集 → MONITOR_METRIC_SAMPLE（带 INSTANCE_ID）

集群级汇总（新增 clusterMetricRollup）：
  读同一 CLUSTER_ID 下各成员最新 sample
  → 计算 Excel #7「RAC 节点数」、集群健康、ASM 等「只告警一次」的项
```

**设计原则（选项 B）：**

| 指标类型 | 采集连接 | SQL 视角 | 告警归属 |
|----------|----------|----------|----------|
| 实例存活、本节点 sessions、本节点 sysmetric | **该节点 CMDB 实例** | `V$INSTANCE`、`V$SESSION`、`V$SYSMETRIC` | **INSTANCE_ID** |
| 监听器、CRS、df、本机 ora_* 进程 | **该节点 HOST_ID** SSH | shell | **INSTANCE_ID**（与节点 1:1） |
| ASM 磁盘组、FRA、库级 open_mode/role | **集群内指定 1 个成员**（见下） | `V$ASM_*`、`V$DATABASE` | **CLUSTER_ID**（去重，避免 N 份重复告警） |
| RAC 节点数、成员是否 OPEN | **汇总** 各成员 `oracle_instance_open` | 无单条 SQL | **CLUSTER_ID** |

**集群级指标由谁采：** 在 `CMDB_CLUSTER_MEMBER.NODE_ROLE` 增加约定值 **`METRIC_HUB`**（或 `PRIMARY` 兼用）：仅该成员执行 ASM/FRA/库级 role 采集；其它成员跳过库级重复项。若未指定 HUB，默认 **SORT_ORDER 最小** 的成员担任。

**连接串建议（每节点 CMDB 实例）：**

- `HOST_IP` = 节点 **VIP** 或 **公有 IP**（不用 SCAN 作为唯一入口也可，但 VIP 更贴「本节点」）
- `PORT` = 1521
- `SERVICE_NAME` = 业务服务名；或 `SID` = **本节点实例名**（如 `ora19c1` / `ora19c2`）
- 监控账号：各节点相同只读用户即可

**与选项 A（SCAN 单连接）的差异：** 不再依赖 `gv$*` 做默认路径；节点级问题（实例 DOWN、本节点 listener）定位更准；集群项通过 **rollup** 补全。

---

## 4. CMDB / 配置扩展（建议）

**已有可复用：**

| 已有 | 选项 B 用法 |
|------|-------------|
| `CMDB_INSTANCE` × N | 每个 RAC 节点一条 |
| `CMDB_INSTANCE.HOST_ID` | 1:1 绑定本节点主机 |
| `CMDB_INSTANCE.CLUSTER_NAME` | 与集群名一致（展示用） |
| `CMDB_CLUSTER` + `CMDB_CLUSTER_MEMBER` | 成员关系、NODE_ROLE |

**建议新增/扩展：**

| 字段 / 表 | 用途 |
|-----------|------|
| `CMDB_CLUSTER.EXPECTED_MEMBER_COUNT` | Excel #7 预期 RAC 节点数 |
| `CMDB_CLUSTER_MEMBER.NODE_ROLE` | `METRIC_HUB` / `MEMBER`（HUB 采 ASM/FRA/库级） |
| `CMDB_CLUSTER_MEMBER.ORACLE_INST_ID` | 可选，对应 `V$INSTANCE.INSTANCE_NUMBER` |
| `CMDB_INSTANCE.ENABLE_DIAG_PACK` | 0/1，ASH/AWR/filemetric |
| `CMDB_HOST.SSH_*` | HOST 通道（**新增**，当前无 SSH 字段） |
| `CMDB_CLUSTER_MEMBER.PRIV_IP` | 可选，私网心跳 ping 目标 |

**纳管示例（2 节点 RAC）：**

| INSTANCE_NAME | HOST_IP | SID/SERVICE | HOST_ID | CLUSTER |
|---------------|---------|-------------|---------|---------|
| ORA19C-RAC1 | 10.0.1.11 | ora19c1 | host-db1 | PROD_RAC |
| ORA19C-RAC2 | 10.0.1.12 | ora19c2 | host-db2 | PROD_RAC |

单机（环境 2）：仍 1 实例 + 1 `HOST_ID`；`CMDB_CLUSTER` 可不建或 `CLUSTER_TYPE=STANDALONE`。

---

## 5. 分阶段范围（按环境 2+3）

### 阶段 1 — 库内实时 + 告警（P0，约 2～3 周）

**目标：** 不依赖 SSH；**每个 CMDB 实例连本节点**，RAC 集群项由 **METRIC_HUB + clusterMetricRollup** 处理（不用 SCAN 单连接）。

| # | Excel 项（摘要） | metric_key | 默认阈值 | 级别 | 采集 |
|---|------------------|------------|----------|------|------|
| 1 | 实例 status OPEN | `oracle_instance_open` | status ≠ OPEN | 严重 | REALTIME |
| 2 | 启动时长 <6h 意外重启 | `oracle_uptime_hours` | < 6（且非维护窗口） | 严重 | REALTIME |
| 10 | 会话数 | `oracle_sessions_used_pct` | > 80% limit | 警告 | REALTIME |
| 11 | resource_limit | `oracle_processes_used_pct` | > 80% | 警告 | REALTIME |
| 14 | database_role | `oracle_db_role` | 偏离主库预期 | 严重 | REALTIME |
| 15 | open_mode | `oracle_open_mode` | ≠ READ WRITE（非备库策略） | 严重 | REALTIME |
| 13 | log_mode | `oracle_log_mode` | 生产非 ARCHIVELOG | 警告 | REALTIME |
| 36 | 表空间使用率 | `oracle_tablespace_used_pct` | > 85 警告 / > 95 严重 | 警告/严重 | REALTIME |
| 39 | UNDO | `oracle_undo_used_pct` | > 85% | 警告 | REALTIME |
| 40 | TEMP | `oracle_temp_used_pct` | > 80% | 警告 | REALTIME |
| 41 | FRA | `oracle_fra_used_pct` | > 80 / 100 | 警告/严重 | REALTIME |
| 44 | ASM 磁盘组 | `oracle_asm_dg_used_pct` | > 80 / 90 | 警告/严重 | REALTIME（**仅 METRIC_HUB 成员**） |
| 7 | RAC 节点数 | `oracle_rac_node_count` | ≠ `EXPECTED_MEMBER_COUNT` | 严重 | **CLUSTER rollup**（汇总各成员 OPEN 状态） |
| 17-19 | CPU / AAS 相关 sysmetric | `oracle_host_cpu_pct`, `oracle_active_sessions` | 见 Excel | 警告 | REALTIME |
| 59 | log file sync | `oracle_log_file_sync_ms` | > 10 / 20 ms | 警告/严重 | REALTIME |
| 73 | Buffer cache hit | `oracle_buffer_cache_hit_pct` | < 90% OLTP | 警告 | REALTIME（已有，对齐规则） |
| 31 | 阻塞 >60s | `oracle_blocking_session_max_sec` | > 60 | 严重 | REALTIME 或 INSPECT 15min |

**阶段 1 交付物：**

- 扩展 `monitorExporterCollect` + `METRICS_JSON`  schema 约定。
- `alertEvaluator`：读 `ALERT_RULE` + 最新 sample，写 `ALERT_RECORD`（挂到 `collectAllInstances` 之后）。
- `clusterMetricRollup`：RAC 集群维度规则（节点数、可选集群级严重度升级）。
- 从 Excel 导入阶段 1 规则到 `ALERT_RULE`（`DB_TYPE=ORACLE`）。
- 实例详情页：展示「Excel 覆盖度」摘要（可选 UI，阶段 1 可仅 API）。

### 阶段 2 — 深度 DB + 巡检联动（约 2 周）

- Top 等待 / Top SQL / 锁 / enqueue / latch：INSPECT 每小时 + 摘要指标进 `METRICS_JSON`。
- alert log ORA-00060 / ORA-4031 / checkpoint：解析 `V$DIAG_ALERT_EXT`（巡检模板已有片段）。
- DG、RMAN、归档：对齐 Excel 第 7 类，以 **INSPECT 日检 + 关键项 REALTIME** 为主。

### 阶段 3 — SSH 主机 + RAC 集群（环境 2+3 必做，约 2～3 周）

**新增服务：** `oracleHostCollect.js`（SSH 非交互，密钥登录，超时与 sudo 策略可配置）

| Excel 项 | 节点命令（示例） | metric_key |
|----------|------------------|------------|
| 监听器 | `lsnrctl status` 或 `systemctl status` | `host_listener_ready` |
| 后台进程 | `ps -ef \| grep ora_` + 与 `v$bgprocess` 交叉 | `host_oracle_proc_missing` |
| 文件系统 | `df -h` 挂载点 | `host_fs_used_pct` |
| RAC CRS | `crsctl stat res -t` | `host_crs_resource_offline` |
| 私网心跳 | `ping` 私网 IP / OS 网卡统计 | `host_interconnect_loss` |

- 调度：与监控周期同频或 5min；结果写入 `METRICS_JSON.host_checks[]`。
- **依赖：** CMDB SSH 凭据、防火墙、RAC 每节点 `HOST_ID` 绑定。

---

## 6. 129 项覆盖率（环境 2+3，三阶段后）

| 大类 | 项数 | 阶段 1 | 阶段 2 | 阶段 3 |
|------|------|--------|--------|--------|
| 1 可用性与实例 | 15 | 8 | 1 | 6 |
| 2 性能与等待 | 20 | 6 | 12 | 2 |
| 3 空间与存储 | 18 | 10 | 4 | 4 |
| 4 争用与资源 | 18 | 2 | 14 | 2 |
| 5 内存 SGA | 14 | 4 | 10 | 0 |
| 6 SQL 与计划 | 15 | 0 | 15 | 0 |
| 7 备份保护 | 11 | 1 | 10 | 0 |
| 8 作业与日志 | 8 | 0 | 8 | 0 |
| 9 安全合规 | 10 | 0 | 6 | 4 |
| **合计** | **129** | **~31** | **~80** | **~18** |

（部分项跨阶段重复计数以「首次可告警」为准；Diagnostics 许可项受 `ENABLE_DIAG_PACK` 控制。）

---

## 7. 权限与风险

- 监控账号：`SELECT_CATALOG_ROLE` + 对 `gv$`/`v$` 可读；ASM 需 `SYSASM` 或等价只读角色（建议单独只读账号）。
- Diagnostics Pack：ASH/AWR/`v$filemetric` 默认关闭，避免合规风险。
- SSH：最小权限用户，仅白名单命令；密钥不入库明文（与现有 `DB_PASSWORD` 加密方式一致）。

---

## 8. 非目标（本方案不做）

- 不引入独立 Prometheus 栈（方案 C）。
- 不修改 SQL 优化、CMDB 审批流等无关业务模块。
- 不在阶段 1 实现全部 129 项 UI 表单（先 API + 告警 + 详情页关键卡片）。

---

## 9. 下一步（实现前）

1. 评审本设计（CMDB 字段、阶段 1 指标表、SSH 安全模型）。
2. 使用 `writing-plans` 生成实现任务拆分（表结构 migration、`alertEvaluator`、采集扩展、`oracleHostCollect`）。
3. Excel → `ORACLE_MONITOR_CATALOG` 导入脚本（一次性）。

---

## 10. 参考文件

- 清单：`docs/_oracle_monitor_items.json`
- 采集：`backend/src/services/monitorExporterCollect.js`
- 持久化：`backend/src/services/monitorCollectPersist.js`
- 巡检 SQL：`backend/src/templates/inspect/oracle_master_inspection.sql`
- 文档：`docs/automation/checkv8-inspect.md`（主机 SSH 当前未在平台实现）
