# Oracle + 磐维监控目录与阶段 1 采集/告警 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地统一监控目录（236 项元数据）、Oracle/磐维阶段 1 引擎指标采集，并在定时采集后自动评估告警与 RAC/集群节点数 rollup。

**Architecture:** `DB_MONITOR_CATALOG` 存 Excel 元数据；`monitorEngineMetrics.js` 在现有 `getPerformanceBundle` 之外补充 `engineMetrics[]`；`monitorAlertEvaluator.js` 对照 `ALERT_RULE` 写 `ALERT_RECORD`；`monitorClusterRollup.js` 汇总 `CMDB_CLUSTER` 成员可达性。不引入 SSH（阶段 3）。

**Tech Stack:** Node.js backend、oracledb、pg、Oracle 平台库 SQL migration。

## Global Constraints

- 不修改 SQL 工作台、CMDB 业务流、前端业务页面（阶段 1 可无 UI，仅 API/脚本）。
- Oracle RAC：**每节点一条 CMDB 实例**；集群规则用 `CMDB_CLUSTER.EXPECTED_MEMBER_COUNT`。
- 磐维：`DB_TYPE=PANWEI`，连接复用 `connectPostgres`；指标 key 前缀 `panwei_*` / `oracle_*`。
- 新表通过 `backend/sql/migration_*.sql` 交付；可选合并进 `init.sql` 由维护者决定。

---

### Task 1: 数据库 migration

**Files:**
- Create: `backend/sql/migration_monitor_catalog.sql`

- [x] 创建 `DB_MONITOR_CATALOG` 表
- [x] `ALTER CMDB_CLUSTER ADD EXPECTED_MEMBER_COUNT`
- [x] 插入阶段 1 `ALERT_RULE`（Oracle + 磐维 metric_key）

**Test:** 在平台库执行 migration 无 ORA 错误。

---

### Task 2: 目录导入脚本

**Files:**
- Create: `backend/scripts/importMonitorCatalog.js`

**Interfaces:**
- Consumes: `docs/_oracle_monitor_items.json`, `docs/_panwei_monitor_items.json`
- Produces: `DB_MONITOR_CATALOG` rows

- [x] 启发式 `COLLECT_MODE`（SQL/HOST/INSPECT）
- [ ] 平台库 migration 后: `cd backend && node scripts/importMonitorCatalog.js`

---

### Task 3: 引擎扩展采集

**Files:**
- Create: `backend/src/services/monitorEngineMetrics.js`
- Modify: `backend/src/services/monitorCollectPersist.js`

**Produces:** `collectEngineMetrics(inst, dbType) -> [{ key, value, unit, labels? }]`

- [x] Oracle：实例 OPEN、uptime_hours、sessions/processes%、表空间最大使用率、FRA（可选）
- [x] 磐维：连接使用率、postmaster 运行小时、复制 lag（字节，有备库时）
- [x] 写入 `METRICS_JSON.engineMetrics`

---

### Task 4: 告警评估

**Files:**
- Create: `backend/src/services/monitorAlertEvaluator.js`

- [x] 读取 ENABLED `ALERT_RULE`，匹配 `DB_TYPE` / `INSTANCE_ID`
- [x] 从 `engineMetrics` + 归一化 `metrics` 取值，比较 gt/lt/gte/lte
- [x] OPEN 告警去重（恢复逻辑阶段 2）

---

### Task 5: 集群 rollup

**Files:**
- Create: `backend/src/services/monitorClusterRollup.js`

- [x] 按 `CMDB_CLUSTER_MEMBER` 统计最近 sample `REACHABLE=1` 成员数
- [x] 与 `EXPECTED_MEMBER_COUNT` 比较，写集群告警

---

### Task 6: 挂接调度与 initDb

**Files:**
- Modify: `backend/src/services/monitorCollectPersist.js`（collectAllInstances 末尾）
- Modify: `backend/src/utils/initDb.js`（REQUIRED_TABLES）
- [x] `GET /api/monitor/catalog`（monitor.js）

- [x] `collectAllInstances` → `evaluateAlertsForInstance` → `runClusterRollup`

---

### Task 7: 文档

- Modify: `docs/superpowers/specs/2026-10-08-oracle-panwei-monitor-unified-design.md`（实现状态）

---

## Phase 2（已完成代码，待 migration）

- [x] `monitorEngineMetricsPhase2.js` Oracle/磐维深度指标 + `enginePhase2Summary`
- [x] `migration_monitor_catalog_phase2.sql` 告警规则
- [x] `GET /api/monitor/instances/:id/engine-phase2`
- [ ] 平台库执行 `@migration_monitor_catalog_phase2.sql` 后重启 backend

## Phase 3+（未做）

HOST/SSH（`gs_om`、iostat、lsnrctl）、236 项 UI 覆盖度。
