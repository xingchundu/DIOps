# SQL 洞察（问题识别 + 异常波动检测）融合设计与冗余精简方案

> 依据：《SQL 问题识别与异常波动检测设计方案》（2026-11-06，PanWeiDB V3.0 适配版）
> 落点：Java 后端 `dbops-server` 新增 `com.dbops.sqlinsight` 模块，与现有 CMDB / 监控采集 / 告警中心 / 自动发布 / AI 优化联动。

---

## 1. 现状：SQL 相关代码的重复点

工程里与 SQL 质量相关的代码分散在 4 个 Node 路由、2 个 Node 服务、1 个 Python Agent 中，**同一件事普遍有 2～4 份实现**，而且口径不一致。

### 1.1 重复清单

| 能力 | 现有实现（重复） | 问题 |
|------|------------------|------|
| **SQL 静态审核规则** | ① `routes/sql.js` `/optimize`（8 条正则）<br>② `routes/automation.js` `sqlAuditCheckDynamic`（9 条内置正则 + `DDL_AUDIT_RULE`）<br>③ `routes/sqlReview.js` `runInternalAudit`（7 条内置正则 + `DDL_AUDIT_RULE`，注释写“复用 automation.js”，实际是**复制粘贴**）<br>④ Python `sql_rule_engine.py`（SQLGlot AST，511 行） | 同一条 SQL 在“SQL 优化 / SQL 审核 / 治理中心 / 发布预审 / AI 优化”五个入口得到**五种不同结论**；正则对注释、字符串、子查询、多语句全部误判（如 `(DELETE\|UPDATE)\s+\w+(?![\s\S]*WHERE)` 遇到子查询里的 WHERE 就漏报） |
| **评分 / 风险等级** | `calcSqlAuditScore`、`calcSqlAuditRisk` 在 automation.js 与 sqlReview.js 各一份 | 两份系数一致但独立维护 |
| **执行计划** | ① `sql.js /explain`（仅 Oracle）<br>② `sqlWorkbench.js /explain`（5 库）<br>③ `services/sqlGovernanceInstanceCheck.js`（5 库，540 行）<br>④ Python `explain_analyzer.py` + `db_service.run_explain` | 4 套连接、4 套方言分支、4 套全表扫描判断 |
| **危险语句识别** | `sql.js isDangerous` 与 `sqlWorkbench.js isDangerous`（同一段正则各一份） | `/* x */ DROP`、`WITH ... DELETE`（PG）、多语句等可绕过 |
| **慢 SQL 采集** | ① `sql.js /capture`（仅 Oracle、手动、写 `SQL_SLOW_SUMMARY`，且 MERGE 有绑定 bug）<br>② 监控 phase2 `topSql`（Oracle/磐维 Top5 写入 METRICS_JSON）<br>③ 实例详情实时 `exporter.topSql` | 只存“累计值快照”，无增量、无时间序列，无法做慢/波动判断 |
| **SQL 标识** | md5(去空白)（sqlReview）、sha256 前 32 位（automation）、Oracle SQL_ID（capture） | 三套 hash 互不相认，同一 SQL 在审核/基线/慢 SQL 里关联不上；字面量不同即视为不同 SQL |
| **“基线 / 退化”** | `SQL_BASELINE` + `SQL_REGRESSION`：只比较“重新审核的评分”，`CURRENT_COST` 实为正则得分 | 名为回归检测，实际不看任何运行数据 |
| **告警出口** | SQL 退化写 `FAULT_EXEC_LOG`；监控写 `ALERT_RECORD` | SQL 问题进不了告警中心，静默/抑制/聚合不生效 |
| **报表** | `reports.js /sql-quality` 从 `SQL_OPT_HISTORY` 查 `SQL_ID/EXECUTIONS/...` | 这些列不存在，异常被 `.catch` 吞掉，**Top SQL 永远为空** |
| **故障自愈 SLOW_QUERY** | 往 `SQL_AUDIT_RECORD` 插一条 `-- 慢查询自动收录` 占位文本 | 没有任何实际 SQL，审核结果是写死的 60 分 |

规模：上述重复/失效代码合计约 **2,100 行**（Node 约 1,550 行，Python 约 510 行）。

### 1.2 根因

没有“唯一的 SQL 解析与规则中心”，每个页面各写一套；也没有“按分钟的增量时间序列”，所以只能用正则和累计值做近似判断。附件方案恰好补的就是这两块。

---

## 2. 目标架构

```
                     ┌──────────────────────────────────────────────────────────────┐
                     │                Java dbops-server / sqlinsight                │
  被管库              │                                                              │
 Oracle/MySQL/PG ─┐  │  Collector（每分钟）            中心端（异步）                  │
 DM8/PanWei/MSSQL ├─▶│  ├ 能力探测 → DI_SQL_CAPABILITY  ├ SQL 资产/指纹 DI_SQL_ASSET  │
                 │  │  ├ 累计快照 → 增量/重置/断点     ├ 运行态规则 P-001~013         │
                 │  │  │  → DI_SQL_STATS_MIN(幂等)     ├ 静态规则  S-001~007(Druid AST)│
                 └─▶│  └ 活动会话采样(15s)             ├ 基线(中位数+MAD) 每小时       │
                     │                                 ├ 波动五项判定 / 三类波动       │
                     │                                 ├ 事件管理 DI_SQL_ANOMALY       │
                     │                                 └ 原因诊断 DI_SQL_ANOMALY_DIAG  │
                     │        │ CRITICAL 问题 / 持续升高波动                           │
                     │        ▼                                                     │
                     │   ALERT_RECORD（告警中心：静默/抑制/聚合/自动恢复复用）          │
                     └────────┬───────────────┬──────────────────┬──────────────────┘
                              │               │                  │
         SQL 审核/治理/发布预审 │  AI 优化 Agent │ 静态规则改为调用  │ 报表 / 实例详情
       （统一调用同一个审核引擎）│  （SQLGlot 只校验 AI 改写结果）    │ 读 DI_SQL_* 表
```

### 2.1 SQL 解析器选型：Java AST 组件（Alibaba Druid SQL Parser）

| 维度 | Druid（Java 进程内） | SQLGlot（独立 Python 服务） |
|------|---------------------|-----------------------------|
| 调用量 | 指纹在**每次采集的每条 SQL**上都要算：500 实例 × 200 SQL ≈ 10 万次/分钟，进程内微秒级 | 每次一个 HTTP 往返，1.7k QPS，多一个必须高可用的服务 |
| 方言 | `oracle / mysql / postgresql / sqlserver / dm / gaussdb / goldendb` 均有专用方言 | 无 DM、openGauss/磐维 方言，只能借用 oracle/postgres |
| 指纹/归一化 | 内置 `ParameterizedOutputVisitorUtils`：字面量→`?`、IN 列表合并，正是 P-013“未绑定变量”需要的 | 需自行实现 |
| 表/列/条件提取 | 内置 `SchemaStatVisitor` | 有 |
| 部署 | 一个 jar，信创/内网环境无额外运行时 | 多一个 Python 服务与依赖 |
| 已验证 | 已从源码编译并在本工程单测中跑通 6 种方言 | — |

**结论：** 采集链路（指纹、静态规则、表提取、危险语句识别）统一用 Druid；**SQLGlot 只留在 sql-optimizer-agent 内部，用于校验大模型改写后的 SQL 是否可解析**（`sql_validator.py`，这是 AI 侧的输出护栏，不在主链路）。Python 侧的 `sql_rule_engine.py` 删除，改为调用 Java 的统一审核接口。

---

## 3. 合并映射（谁替代谁）

| 旧 | 新（唯一实现） | 处理方式 |
|----|---------------|----------|
| sql.js `/optimize`、automation `sqlAuditCheckDynamic`、sqlReview `runInternalAudit`、Python `sql_rule_engine.py` | `SqlAuditService`（Druid AST 规则 S-001~S-007 + `DDL_AUDIT_RULE` 自定义正则策略） | 旧代码**删除**；Node 发布预审通过 `utils/sqlInsightClient.js` 调用 Java；Python 通过 HTTP 调用 |
| sql.js `/explain`、sqlGovernanceInstanceCheck.js（540 行） | `ExplainService`（5 库执行计划 + 表存在性检查 + 全表扫描识别） | 删除；sqlWorkbench 的 explain 改调 Java |
| 两份 `isDangerous` | `SqlAstService.classify()`（AST 识别语句类型，多语句逐条判断） | sql.js 删除；sqlWorkbench 改调 Java，Java 不可达时退回原正则（降级） |
| sql.js `/capture` + `SQL_SLOW_SUMMARY` | Collector + `DI_SQL_STATS_MIN` | 删除 /capture 逻辑；`/api/sql/slow`、`/api/sql/capture` 保留**同名接口**由 Java 实现（前端不改）；`SQL_SLOW_SUMMARY` 改为兼容视图 `V_SQL_SLOW_SUMMARY` |
| 三套 SQL hash | `DI_SQL_ASSET.FINGERPRINT`（方言 + Schema + 归一化 SQL 的 SHA-256） | 审核记录、工单、AI 优化记录写入时附带 `ASSET_ID` |
| `SQL_BASELINE`/`SQL_REGRESSION`（基于正则评分的“回归”） | `DI_SQL_BASELINE`（运行指标中位数+MAD）+ `DI_SQL_BASELINE_ANCHOR`（接受新基线）+ `DI_SQL_ANOMALY` | 治理中心原接口保留，`/regression` 改为触发真实波动检测，`/regressions` 读 `DI_SQL_ANOMALY`；发布成功写“基线锚点” |
| SQL 退化写 `FAULT_EXEC_LOG` | 写 `ALERT_RECORD`（规则名「SQL异常波动」「SQL问题」） | 复用告警中心静默/抑制/聚合/自动恢复 |
| 故障自愈 SLOW_QUERY 占位记录 | 触发该实例 SQL 洞察即时采集，把 Top 问题 SQL 写入审核队列 | 改为真实数据 |
| reports `/sql-quality` 读不存在的列 | 读 `DI_SQL_STATS_MIN` + `DI_SQL_PROBLEM` | 修复 |
| /api/sql-review、/api/automation/sql-governance 中的审核/实例检查 | Java `SqlAuditService` + `ExplainService`（经 `utils/sqlInsightClient.js` 调用） | **工单/评论/推送发布等流程代码不属于重复，保留在 Node**；只删除其中复制粘贴的审核规则与实例检查 |

保留不动（不属于重复）：SQL 工作台执行与元数据浏览（`sqlWorkbench.js` 主体）、AI 优化 Agent 的 LLM 对话与改写、`SQL_OPT_HISTORY`、发布工单流程本身。

---

## 4. 数据模型（Oracle 平台库）

| 表 | 作用 | 唯一约束 |
|----|------|----------|
| `DI_SQL_ASSET` | SQL 资产：指纹、归一化文本、方言、Schema、语句类型、静态分析状态与结果、核心标记、业务类型 | `(DB_TYPE, SCHEMA_NAME, FINGERPRINT)` |
| `DI_SQL_ASSET_SOURCE` | 资产在各实例上的原生标识（SQL_ID / DIGEST / queryid），用于 P-013 与回查 | `(ASSET_ID, INSTANCE_ID, NATIVE_ID)` |
| `DI_SQL_STATS_MIN` | 分钟增量：9 个窗口指标 + 原始增量 + DATA_QUALITY + 批次号 + 是否排除基线 + 本窗口异常标记 | `(INSTANCE_ID, ASSET_ID, PLAN_HASH, WINDOW_START)`，`PLAN_HASH` 无计划写 `NA` |
| `DI_SQL_CAPABILITY` | 能力矩阵：每实例每指标 SUPPORTED/UNSUPPORTED + 来源视图 + 探测时间 | `(INSTANCE_ID, METRIC)` |
| `DI_SQL_RULE` | 规则与阈值（运行态/静态），支持 SQL > 实例 > 业务类型 > 数据库类型 > 全局 覆盖 | `(RULE_CODE, SCOPE_TYPE, SCOPE_VALUE)` |
| `DI_SQL_PROBLEM` | 规则命中（问题）记录，含 SKIPPED 原因 | 未关闭问题 `EVENT_KEY = 规则|实例|资产` 唯一（函数索引） |
| `DI_SQL_BASELINE` | 基线：实例、资产、指标、日期类型、小时、中位数、MAD、样本数 | `(INSTANCE_ID, ASSET_ID, METRIC, DAY_TYPE, HOUR_OF_DAY)` |
| `DI_SQL_BASELINE_ANCHOR` | 基线起点（接受新基线 / 优化完成 / 发布） | — |
| `DI_SQL_ANOMALY` | 异常事件：事件键、波动类型、基线值、当前值、倍率、Z 分数、级别、状态 | 未恢复事件 `EVENT_KEY` 唯一（函数索引） |
| `DI_SQL_ANOMALY_DIAGNOSIS` | 诊断：候选原因、证据、快照、建议、AI 解释 | — |
| `DI_CHANGE_WINDOW` | 变更窗口：实例、类型、起止时间 | — |

“最近 5 个窗口的命中状态”直接记在 `DI_SQL_STATS_MIN.ANOMALY_FLAGS` 上，节点重启后从表里读回，不额外引入 Redis；多节点部署时按实例 ID 取模分片（`SQLINSIGHT_SHARD_INDEX/COUNT`）。分钟统计量大时可将 `SqlStatsStore` 换成 ClickHouse 实现，其余代码不变。

---

## 5. 与现有模块的联动点

1. **CMDB**：采集范围 = 已纳管、受支持类型、未停用的实例；新增 `CMDB_INSTANCE.SQL_BIZ_TYPE`（OLTP/BATCH/REPORT，空为 OLTP）作为规则覆盖的“业务类型”来源（`BIZ_LINE` 是“营销系统”这类业务线，不能表达负载类型），SQL 洞察页面可改；删除实例时级联清理 `DI_SQL_*`。
2. **监控调度**：SQL 采集挂在现有监控调度器旁（同一开关 `MONITOR_SCHEDULER_ENABLED`），复用 `TargetConnector`、实例互斥、连接超时配置。
3. **告警中心**：CRITICAL 问题与“持续升高”波动生成 `ALERT_RECORD`，事件恢复时同步自动恢复告警；告警详情可跳转到 SQL 洞察诊断。
4. **SQL 审核 / 治理中心 / 发布预审 / AI 优化**：统一调用 `SqlAuditService`，同一条 SQL 结论一致；审核记录挂接 `ASSET_ID`，可看到该 SQL 的运行时问题与波动史。
5. **自动发布**：发布成功写 `DI_SQL_BASELINE_ANCHOR`（基线从发布时间重算）；发布时间段自动登记为变更窗口，窗口内只记录不告警。
6. **故障自愈**：SLOW_QUERY 策略触发即时采集并把 Top 问题 SQL 推入审核队列。
7. **实例详情**：新增“SQL 洞察”页签（该实例的问题 SQL、异常事件、DB Time Top）。
8. **报表**：SQL 质量报表改读新表。

---

## 6. 分阶段上线（与附件第 10 节一致）

| 阶段 | 开关（SYS_CONFIG） | 默认 |
|------|-------------------|------|
| 1 修正数据 | `sqlinsight.collect.enabled` | 1 |
| 2 上线规则 | `sqlinsight.rules.enabled` | 1 |
| 3 积累基线、静默检测 | `sqlinsight.anomaly.enabled`=1、`sqlinsight.anomaly.notify`=0 | 检测开、通知关 |
| 4 校准后开放告警 | `sqlinsight.anomaly.notify`=1（可只对核心 SQL：`sqlinsight.anomaly.notify_core_only`） | 人工打开 |
| 5 诊断 | `sqlinsight.diagnosis.enabled` | 1 |

待目标环境实测：DM8 统计视图字段、PanWeiDB V3.0 `dbe_perf.statement` 字段与时间单位、`statement_history` 全量记录开关。未通过能力探测的指标记为 UNSUPPORTED，**不参与检测，界面显示“不支持”，不会按 0 处理**。

---

## 7. 实现落点（本次交付）

### 7.1 Java 模块 `com.dbops.sqlinsight`（约 6,000 行，单测 37 个用例）

| 包 | 类 | 职责 |
|----|----|------|
| `ast` | `SqlAstService` `SqlDialect` `StaticRuleEngine` `Finding` `TableMetadata` | Druid 解析、指纹、语句分类/危险识别、表提取；静态规则 S/D/H（手写 AST 遍历，避开 Druid 方言 Visitor 的无限递归） |
| `collect` | `StatsSource` `SessionSampler` `DeltaEngine` `WindowRow` `Counter` `Metric` `SqlCollectService` | 声明式取数（`SELECT * … WHERE 1=0` 探测实际列名，候选列吸收版本差异）、累计→增量与数据质量、9 个窗口指标、活动会话采样、分钟采集主流程 |
| `store` | `AssetService` `StatsRepo` `InstanceDirectory` `AlertBridge` `Json` | 资产/原生 ID、分钟统计幂等 MERGE、能力矩阵、变更窗口、告警中心出口、分片 |
| `rules` | `RuleConfigService` `RuntimeRuleEngine` `ProblemService` | 五级覆盖规则中心；P-001~P-013（不支持的指标 → SKIPPED）；问题去重/恢复/告警 |
| `baseline` | `RobustStats` `BaselineService` `Baseline` | 中位数+MAD（Oracle `MEDIAN` 聚合在库内算）、WD/WE×24 时段 + R24 回退、锚点、缓慢劣化 |
| `anomaly` | `AnomalyDetector` `AnomalyService` | 五项判定、5 中 3 持续性（状态即 `ANOMALY_FLAGS`）、突增/持续/劣化、恢复、实例级合并、变更窗口静默、告警 |
| `diagnosis` | `CauseClassifier` `DiagnosisService` | 按原设计方案 6.2 的 8 类原因（PLAN_REGRESSION / LOCK_WAIT / DATA_GROWTH_OR_SKEW / CACHE_OR_IO / RESOURCE_CONTENTION / TRAFFIC_SURGE / ERROR_SURGE / UNKNOWN，“升高”≥1.5、“稳定”<1.2）、证据快照（含实例 CPU、同时段变更）、6.3 格式报告 |
| `audit` | `SqlAuditService` `SqlOptimizeService` `ExplainService` `TargetMetadata` | 统一审核（AST + 规则中心 + `DDL_AUDIT_RULE` 自定义正则）、5 库执行计划与实例检查、目标库索引/字段类型元数据 |
| `optimize` | `PlanAnalyzer` `IndexAdvisor` `RewriteEngine` | 规则优化：执行计划解读、索引建议（等值→范围→排序、已有索引覆盖判断、行数）、等价改写 |
| `collect` | `SlowSqlSource` `SlowSqlService` | 立即采集慢 SQL → `SQL_SLOW_SUMMARY`（按采集时间 / 批次存放） |
| `web` | `SqlInsightController` `SqlInsightOpsController` `SqlCompatController` | `/api/sql-insight/*`（含 optimize / screen / plan-changes / tickets）；`/api/sql/*` 兼容原 sql.js |
| — | `SqlInsightScheduler` | 每分钟采集、15 秒会话采样、每小时基线/劣化/清理；共用 `MONITOR_SCHEDULER_ENABLED` |

### 7.2 删除 / 改写的冗余代码（Node + Python：+241 / −1,644 行）

| 文件 | 处理 |
|------|------|
| `backend/src/routes/sql.js` | **删除**（4 个接口由 Java `SqlCompatController` 同名实现，前端不改） |
| `backend/src/services/sqlGovernanceInstanceCheck.js`（540 行） | **删除**（Java `ExplainService`）；其中落库相关的 `toPlainJson / buildPublishReviewResult` 移到 `utils/sqlAuditRecord.js` |
| `backend/sql-optimizer-agent/sql_rule_engine.py`（511 行） | **删除**，换成 `sql_rule_client.py` 调 Java 审核（返回结构不变）；SQLGlot 仅留在 `sql_validator.py` 校验 AI 改写结果 |
| `routes/automation.js` | 删除死代码 `sqlAuditCheck`、`loadDdlRules / validateSqlInput / calcSqlAuditScore / calcSqlAuditRisk / sqlAuditCheckDynamic` 正则实现、`sqlHash / fetchLatestAuditId`；发布预审、即时审核、慢 SQL 导入、回归检测、故障 SLOW_QUERY、成本分析 Top SQL 改接 SQL 洞察 |
| `routes/sqlReview.js` | 删除 `runInternalAudit`（automation.js 正则的复制粘贴），自动审核改调 Java |
| `routes/sqlWorkbench.js` | `isDangerous` 改为 AST 判断（Java 不可达时退回加强版正则）；`/explain` 改调 Java |
| `routes/reports.js` | `/sql-quality` 删除（与 SQL 洞察概览重复，见第 8 节） |
| `DDL_AUDIT_RULE` 中 6 条内置正则 | 迁移脚本停用（已被 AST 规则覆盖）；用户自建规则继续作为“自定义策略”生效 |

### 7.3 调用关系与鉴权

- Node → Java：`backend/src/utils/sqlInsightClient.js`，地址 `JAVA_SERVER_URL`（默认 `http://127.0.0.1:3000`）。有用户请求时转发用户的 `Authorization`；后台任务（故障自愈）用 `JWT_SECRET` 签发 2 分钟有效、以启用的 ADMIN 账号身份的令牌。不新增密钥。
- Python → Java：`sql_rule_client.py`，同样转发浏览器经 Node 代理带来的 `Authorization`，地址 `JAVA_SERVER_URL`。
- 发布预审在审核服务不可用时**拦截提交**（503），不在没有审核结论时放行生产发布。
- `AuthFilter.OWNED_PREFIXES` 增加 `/api/sql-insight`、`/api/sql`；Node `app.js` 去掉 `/api/sql` 挂载。
- `AlertEvaluator` 跳过 `RULE_TYPE='SQL_INSIGHT'` 的两条占位规则（它们只用来挂接告警、控制开关）。

### 7.4 上线步骤

1. 执行 `backend/sql/migration_sql_insight.sql`（可重复执行）。
2. 启动：`start-java.sh` / `start-java.bat`，或 `start-all.sh` / `start-all.bat`（检测到 JDK 时同样以 Java 网关 :3000 + Node :3001 启动）。
   脚本会在源码比 jar 新时自动 `mvn -DskipTests package`（需要 JDK 17+、Maven 3.8+，`pom.xml` 已加 `com.alibaba:druid:1.2.24`）。
   **只启动 Node 时 SQL 洞察不可用**，界面会显示 503 和处理办法。Python Agent 单独部署时设置 `JAVA_SERVER_URL`。
3. 按第 6 节开关分阶段打开；阶段 3 静默观察约 2 周后再打开 `sqlinsight.anomaly.notify`。
4. 在 DM8 / PanWeiDB 目标环境确认能力矩阵（SQL洞察 → 能力矩阵）。字段名不符时只需在 `StatsSource.dameng()/panwei()` 的候选列里补一个名字，或调整 `sqlinsight.dameng.time_divisor / sqlinsight.panwei.time_divisor`。

### 7.5 已验证 / 未验证

- 已验证：Java 全量编译（Druid 1.2.24 源码本地编译的 jar + Spring 桩）；单测 72 个全部通过（其中 SQL 洞察 37 个，使用真实 Druid 解析 Oracle/MySQL/PG/达梦/磐维/SQLServer 方言）；Node 改动文件 `node --check`；Python `py_compile` 与结果映射冒烟；前端 `vite build` 通过，SQL 洞察页面在模拟接口下渲染正常、无控制台错误。
- 未验证：没有运行 `mvn package`（沙箱无法访问 Maven Central）；没有连接真实 Oracle 平台库与任何被管库，SQL（含 `MEDIAN` 分析函数、各库统计视图查询）未在真实数据库上执行；DM8 `V$SQL_STAT` 与磐维 `dbe_perf.statement` 的字段名、时间单位按设计文档要求“待目标环境实测”。


## 8. 第四轮：精简、慢 SQL 快照、SQL 洞察补全、规则优先的优化（2026-11-10）

### 8.1 去掉的功能

| 去掉 | 原因 / 去向 |
|------|-------------|
| Node 重复后端：`routes/auth, monitor, cmdb, alerts, users, rbac, systemConfig` 及 9 个 monitor/rbac 服务、`sshExec`、`clientIp` | 这些接口早已由 Java 实现，Node 版本只在“只启动 Node”时生效，两套逻辑长期不一致。现在 Java 是必需的，Node 只跑在 :3001 上处理剩余接口 |
| 只启动 Node 的模式 | `start.sh/.bat`、`start-all.sh/.bat` 统一先构建并启动 Java 网关；缺 JDK 直接报错，不再“半可用” |
| 自动化运维 → SQL 治理中心 | 与 SQL 评审重复。来源为故障自愈的慢 SQL 直接建 SQL 评审工单（`SOURCE=SLOW_QUERY`，同一 SQL 资产不重复建）；评审通过后可“推送到发布” |
| 自动化运维 → 成本分析 | CPU/IO/内存成本是随机数（演示数据）。Top SQL 资源消耗看 SQL 监控大屏 |
| 监控 → 性能对比、定时采集观测 | 演示性质页面，菜单和 `SYS_MENU` 一并删除；Java 去掉 `/collect-scheduler/status`、`/instances/{id}/topsql` |
| 实例详情“SQL 分析”页签、报表中心“SQL 质量” | 与 SQL 洞察重复，实例详情直接嵌入 SQL 洞察 |

### 8.2 立即采集慢 SQL（Oracle / 磐维 / 达梦，及 MySQL / PG / SQL Server）

- 入口：SQL 优化 → 慢 SQL 快照 → 立即采集慢 SQL；`POST /api/sql/capture/{instanceId}?minAvgMs=`。
- 原来的问题：只支持 Oracle，且采集的是 SQL 洞察的分钟增量（采完列表里没有“慢 SQL”）。
- 现在：直接读源库**累计**统计视图，取“单次平均耗时 ≥ 阈值”的前 N 条（条件写成 `总耗时 ≥ 阈值 × 执行次数`，无除零）：
  - Oracle：`V$SQLAREA_PLAN_HASH`（全文 `DBMS_LOB.SUBSTR(SQL_FULLTEXT,2000,1)`，全表扫描标记来自 `V$SQL_PLAN`）
  - 磐维：`dbe_perf.statement`（时间单位按 `sqlinsight.panwei.time_divisor`）
  - 达梦：优先 `V$LONG_EXEC_SQLS`（每行一次超时执行，按文本汇总），不可用时回退 `V$SQL_STAT`
  - 字段名仍走“探测实际列名 → 候选列”，缺失的字段写空值，不写 0。
- 存放：整批写入 `SQL_SLOW_SUMMARY`，同一批共用 `CAPTURE_TIME / CAPTURE_BATCH`，并记录 `CAPTURE_SOURCE(MANUAL/SCHEDULE)`、`STAT_SOURCE`、`ASSET_ID`、CPU/逻辑读/物理读/行数、`LAST_ACTIVE_TIME`。按时间范围、批次、关键字、阈值查询；同一条 SQL 可看历次快照的变化。
- 后台每 `sqlinsight.slow.capture_interval_min`（默认 30）分钟自动采集一次；保留 `sqlinsight.retention.slow_days`（默认 30）天。阈值 `sqlinsight.slow.min_avg_ms`（默认 1000），条数 `sqlinsight.slow.top_n`（默认 50）。

### 8.3 对照原设计文档补齐的部分

| 原设计 | 之前 | 现在 |
|--------|------|------|
| 6.2 原因分类表（8 类、优先级、1.5 / 1.2 阈值） | 自定义的 8 类（含“发布变更”作为原因），打分制 | 完全按表实现；发布 / 批处理 / 参数变更只作为证据；缺失指标按 NaN，不误判；计划标识不可用的库不判 PLAN_REGRESSION |
| 6.1 诊断快照含实例资源 | 无 | 实例 CPU（`MONITOR_METRIC_SAMPLE.METRIC_CPU`，近 15 分钟 / 过去 7 天同小时中位数） |
| 6.3 报告格式“异常 / 可能原因 / 证据 / 建议” | 自由文本 | 按格式生成；“交给 AI 解读”只让 AI 解释证据、补充步骤，不改原因结论 |
| 治理闭环：生成优化工单 | 无 | 问题 / 波动 → `POST /api/sql-insight/tickets` → SQL 评审工单（`SOURCE=SQL_INSIGHT`，同一 SQL 未结束的工单不重复建，附规则优化建议） |
| 执行计划变化 | 只在诊断里看 | 新页签“计划变化”：窗口内首次出现的计划与旧计划对比单次耗时（≥1.5 倍判退化）；MySQL/PG/磐维/达梦无计划标识，单独列出不参与 |
| 监控大屏 | 无 | `/sql-insight/screen`：KPI、每分钟执行与平均耗时、问题按规则、波动事件流、Top SQL（DB Time）、实例排行、慢 SQL 快照、每小时波动数、库类型；30 秒刷新、可全屏 |

### 8.4 SQL 优化：规则优先，AI 在后

SQL 优化页分三个页签：**规则优化**、**慢 SQL 快照**、**AI 深度优化**。

```
规则优化（POST /api/sql-insight/optimize，结果可复现）
  统一审核（静态规则 + 实例检查 + 执行计划）
  → 执行计划解读 X-001~X-007（全表扫描、笛卡尔积、索引全扫描、临时表空间、filesort、临时表、嵌套循环+全表扫描）+ 估算代价
  → 索引建议：每个表按“等值列 → 一个范围列 → 排序列”组合；已有索引前导列能覆盖则不建议；小表降低置信度；
     DDL 按方言用在线方式（Oracle ONLINE / PG·磐维 CONCURRENTLY / MySQL ALGORITHM=INPLACE）
  → 等价改写（自动生成新 SQL，重新解析校验）：
       RW-01 SELECT * 展开（需元数据） RW-02 NOT IN → NOT EXISTS（两侧列都确认 NOT NULL 才改，否则只给建议）
       RW-05 TRUNC/DATE/TO_CHAR(col)=值 → 范围条件  RW-06 字符列与数字比较 → 字符字面量
     只给建议：RW-03 跨列 OR、RW-07 前导 %、RW-08 深分页、RW-09 大 IN 列表、RW-10 UNION、RW-11 随机排序、
       RW-12 COUNT(*)、RW-13 标量子查询、RW-14 DISTINCT + JOIN
  → 改写后执行计划对比（代价变化）
  → 运行时证据（SQL 洞察的问题 / 波动 / 近 24 小时统计）
  → 按优先级排列的处理建议
AI 深度优化（Python Agent）
  sql_rule_client.py 改调 /optimize：规则结论、索引 DDL、改写后 SQL 一起放进提示词，要求 AI 在此基础上优化、不推翻规则结论；
  AI 输出仍由 sql_validator.py 校验。
```

Agent 页（`/sql-optimizer/index.html`）原来请求不带 `Authorization`，Node 鉴权返回 401，AI 优化实际不可用；现在同源请求自动带上主站登录令牌，401 时提示并通知主页面跳转登录。新增 `presetPrompt` 参数，用于把规则结论 / 诊断报告带给 AI。

### 8.5 已验证 / 未验证

- 已验证：Java 全量编译；单测 84 个全部通过（新增慢 SQL 查询构造 3 个、规则优化 5 个、原因分类 6 个）；Node `node --check`；Python `py_compile` 与映射冒烟；前端 `vite build`；监控大屏、规则优化、慢 SQL 快照、计划变化页面在模拟接口下渲染正常、无控制台错误。
- 未验证：未运行 `mvn package`、未连接真实数据库；新增 SQL（大屏聚合、计划变化、诊断 CPU 对比、各库慢 SQL 视图）未在真实库执行；达梦 `V$LONG_EXEC_SQLS` / 磐维 `dbe_perf.statement` 字段名和时间单位需在目标环境确认。
