# SQL 洞察：能力对照与设计（对照「四大能力域 / 三个分析场景 / 数据处理链路」）

## 1. 数据处理链路（已具备）
数据库原生统计（V$SQLAREA / performance_schema digest / pg_stat_statements / 达梦 V$SQL_STAT / 盘古 dbe_perf）→ 只读采集适配（`StatsSource` 能力探测，列缺失自动降级）→ 资产与历史存储（`DI_SQL_ASSET` 指纹归一、`DI_SQL_ASSET_SOURCE` 原生 sql_id、`DI_SQL_STATS_MIN` 分钟窗口增量，保留 35 天）→ 基线对比（中位数 + MAD，工作日/周末/小时）→ 界面（SQL洞察 / 监控大屏）。

## 2. 四大能力域对照

| 能力域 | 能力点 | 现状 | 本次动作 |
|---|---|---|---|
| 01 SQL 资产管理 | 自动发现与指纹归一 | 已有（AST 指纹，跨实例同一资产） | — |
| | 业务 / 场景 / 版本关联 | 仅有业务类型、负责人 | **新增** 场景 `SCENE`、版本 `APP_VERSION`（资产抽屉可编辑） |
| | 质量标签与生命周期 | 无 | **新增** `QUALITY_TAG`、`LIFECYCLE`（人工：新增/活跃/待下线/已下线；未设置则按首次/最近出现自动判为 新增/活跃/休眠）；资产列表可按生命周期、质量标签筛选 |
| | 核心产出：SQL 资产台账 | 有列表无导出 | **新增** 「导出 SQL 台账」CSV（含 sql_id、业务、场景、版本、标签、生命周期、负责人） |
| 02 运行与质量画像 | 执行时段 / 频率 / 耗时基线 | 已有（趋势 + 基线） | — |
| | CPU / IO / 连接跨层画像 | 无单 SQL 视角 | **新增** `GET /assets/{id}/profile` + 抽屉「运行画像」：24 小时分布的执行次数、平均耗时、单次 CPU、单次物理读，叠加实例主机 CPU 与连接数 |
| | 绑定变量 / 计划 / 解析质量 | 仅有规则 P-013 | **新增** 画像内给出原生 SQL ID 个数→绑定变量质量（良好/一般/较差，阈值 10/100 与 P-013 对齐）、计划数、解析状态 |
| 03 变化感知与风险分析 | 频率 / 性能 / 计划变化 | 已有（异常波动、计划变化） | 计划变化增加「旧计划单次逻辑读」，可看变更前后读量 |
| | 新增 SQL、执行时段偏移 | 无 | **新增** `GET /changes`：新增 SQL（实例此前已有采集才算新增）；时段偏移（峰值小时移动 ≥3h，且当前≥10 次、前 7 天≥50 次） |
| | 资源增量与冲突风险预警 | 无 | **新增** 资源增量（DB Time 较前一同长窗口 +50% 且 ≥10s）；冲突风险（新增/偏移/增长的 SQL 峰值落在实例近 7 天 DB Time 最高 3 个小时内） |
| 04 上线与持续治理 | 上线申请、DBA 评审、变更审批留痕 | 已有（SQL 评审工单、评论、审核记录、变更窗口） | — |
| | 问题诊断 / 优化闭环 | 已有（异常诊断、规则优化、由问题/波动生成工单） | 新增「优化复测」页签与工单联动（见 §4） |

## 3. 三个分析场景对照

| 场景 | 现状 | 本次动作 |
|---|---|---|
| 01 执行计划变化（计划 Hash / 访问路径，变更前后耗时与读量） | 计划变化页：新旧计划、均耗时倍率 | 增加旧计划单次逻辑读；新增「访问路径」对比（见 §4） |
| 02 长时间执行 SQL（执行耗时 / P95，等待事件 / SQL 来源） | 慢 SQL 快照 + 运行中慢 SQL 规则，无 P95 | **新增** 「长时间执行」页 `GET /long-sql`：平均 / P95 / 窗口最大耗时、持续窗口数、单次 CPU/逻辑读/物理读、主要等待事件（全量活动会话采样累计）、采集来源 |
| 03 CPU 历史同期对比（今日 vs 昨日 vs 上月，主机 CPU / SQL CPU 时间） | 无 | **新增** 「CPU 同期对比」页 `GET /cpu-compare`：按小时对比三个周期，叠加主机 CPU；结论=当前 ÷ 参照 ≥1.5 偏离常态、≤0.67 低于常态，缺参照时明确提示；上月同期由小时汇总提供；附 CPU 增量 Top SQL |

## 4. 四项补强（原先标注为限制，现已实现）

1. **上月同期不再受分钟数据保留期限制**：新增 `DI_SQL_STATS_HOUR`（实例级小时汇总：SQL CPU、DB Time、执行次数、主机 CPU）。调度器每小时汇总最近 3 小时，首次启动用分钟数据保留期（默认 35 天）回填；汇总保留 `sqlinsight.retention.rollup_days`（默认 400 天）。CPU 同期对比按「整点小时」对齐，分钟数据缺失的小时由汇总补，页面显示每个周期的样本覆盖（含汇总补了几小时）；参照期覆盖不足一半时明确说「样本不足」，不下结论。系统首次上线后仍需自然积累满 30 天才有上月数据，这是数据本身决定的。
2. **等待事件覆盖所有 SQL**：活动会话每次采样（默认 15 秒）把所有带 SQL 的会话按（资产, 等待事件）累计到 `DI_SQL_WAIT_SAMPLE`，无等待事件记为 `ON CPU`，不再只在命中规则时才有。长时间执行页显示主要等待事件及「命中/总采样」，SQL 运行画像里有等待事件分布。各库等待事件来源：Oracle `V$SESSION.EVENT`、PG `wait_event`、SQL Server `wait_type`、MySQL `PROCESSLIST.STATE`；达梦会话视图无等待事件，只记 `ON CPU`。
3. **优化复测跟踪**：`DI_SQL_RETEST`。由 SQL 洞察生成的优化工单自动登记（PENDING）；工单状态变为 APPROVED 后（每小时及打开复测页时同步）自动以工单执行/审核时间为上线时刻开始观察（WATCHING）：优化前 = 上线前 24 小时，优化后 = 上线至今；平均耗时 ≤0.8 倍判改善、≥1.25 倍判退化，并给出 P95、单次 CPU/逻辑读/物理读变化；优化后执行 <5 次或 <3 个窗口时给「样本不足」，绝不据此下改善结论。可手动在资产详情「登记优化复测」，可随时「出结论」，观察满 `sqlinsight.retest.auto_finish_hours`（默认 72 小时）自动出结论；工单被拒绝/取消则复测自动取消。出结论时同时取优化后计划，与优化前计划对比访问路径。
4. **访问路径对比**：新增 `DI_SQL_PLAN_TEXT` 留存计划文本，`PlanDiff` 解析并比较访问路径与连接方式（Oracle/达梦 DBMS_XPLAN 表格、PostgreSQL/磐维 EXPLAIN、MySQL/GoldenDB EXPLAIN 表格）。计划变化页每行「访问路径」按钮：Oracle 用 sql_id + plan_hash 从共享池（`DISPLAY_CURSOR`）取旧/新计划，已被挤出时回退 AWR（`DISPLAY_AWR`，属 Diagnostics Pack，无许可或无权限时失败并如实提示，不会拿当前计划冒充历史计划）。无稳定 plan hash 的库（MySQL/PG 等）在复测的上线前后各取一次 EXPLAIN 对比。

## 5. 仍需知道的边界
- 取计划/EXPLAIN 只读，不带 ANALYZE，不会执行 SQL；DML 的 EXPLAIN 沿用原有安全校验（单语句）。
- 无稳定 plan hash 的库不会出现在「计划变化」列表里（原有行为），访问路径对比只能通过复测或资产的 EXPLAIN 查看。
- 复测的「优化前」快照取自上线时刻之前 24 小时的分钟统计；若工单很久后才被审核，且分钟数据已过期，会显示「优化前没有可用样本」。
- Java 部分在本环境无法联网拉取 Maven 依赖，未做编译与集成测试；`PlanDiff`、`RetestVerdict` 为纯 Java，已单独编译运行验证，并附 JUnit 用例（`src/test/java/.../plan/PlanDiffTest.java`）。

## 6. 改动清单
- 迁移：`backend/sql/migration_sql_insight.sql`、`init.sql` 追加 `DI_SQL_ASSET.SCENE / APP_VERSION / QUALITY_TAG / LIFECYCLE`，新表 `DI_SQL_STATS_HOUR / DI_SQL_WAIT_SAMPLE / DI_SQL_PLAN_TEXT / DI_SQL_RETEST`（幂等 `DI_EXEC_IGNORE`）。
- 后端：新增 `plan/{PlanDiff, RetestVerdict, PlanCaptureService, RetestService}`、`SqlInsightRetestController`（retests / plan-changes/compare）；`StatsRepo` 增加小时汇总与等待事件写入；`SqlCollectService` 采样时累计等待事件；`SqlInsightScheduler` 每小时汇总、同步工单、自动出结论；`SqlInsightOpsController` 生成优化工单时自动登记复测；新增 `SqlInsightAnalysisController`（long-sql / cpu-compare / changes / assets/{id}/profile）；`SqlInsightController` 资产列表与更新支持治理字段与筛选；`SqlInsightOpsController` 计划变化增加 `OLD_LR_PER_EXEC`。
- 前端：`SqlInsight.vue` 新增 3 个页签（变化感知 / 长时间执行 / CPU 同期对比）、资产治理表单、台账导出、抽屉「运行画像」；新组件 `ChangesPanel / LongSqlPanel / CpuComparePanel / ProfilePanel / RetestPanel / PlanDiffDialog`；新增「优化复测」页签与计划变化「访问路径」按钮。
