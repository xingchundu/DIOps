# DIOps v5 修改说明

本次针对六类需求做了修复与增强。**所有改动都在 Node / Python / Vue / SQL 层**：Java（dbops-server）没有改动（本环境无法联网拉取 Maven 依赖，无法编译验证，因此宁可不动）。

> 先看“验证与限制”一节——哪些是真正跑通过的，哪些只是按接口写好、需要你在真实环境验证。

---

## 0. 一图看懂新增能力与模块联系

```
巡检脚本(手工配置) ──► 解析/只读执行 ──► 结论引擎(评分/问题清单) ──► Word(总结+详细)
                                              │                         └─► 批量 Excel(多实例汇总)
                                              ├─► INSPECT_ISSUE（Java 巡检对比读取，之前从未被写入）
                                              └─► 知识图谱 ◄───────────────┐
SQL 优化（预检→规则→可选 AI）──► SQL_OPT_HISTORY ──────────────────────────┤
Oracle SQL_ID 深度诊断（orasqlx）──► SQL_DIAG_JOB ─────────────────────────┤
根因分析 RCA（有模型：AI；无模型：规则）──────────────────────────────────┘
知识图谱 ──► ChatOps 问答上下文（历史问题/根因/处置建议）
```

---

## 1. 逻辑问题修复

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| 1 | `sql-optimizer/index.html` | **页面上选的大模型提供方 / 地址 / 模型从未随请求发给后端**（`llm_config` 没带），后端永远用默认配置，页面设置形同虚设 | 优化、追问请求都带上 `llm_config`（含模型名） |
| 2 | `sql_validator.py` | SQL 引号/注释未闭合会抛 `TokenError`，直接 500；国产库（达梦/GoldenDB/盘古）没有方言映射；非法写法表只覆盖 3 种库 | 捕获 `TokenError`；达梦→oracle、GoldenDB/TiDB→mysql、盘古/openGauss/人大金仓→postgres；补充 SQL Server 与各库常见跨方言写法（`IFNULL`、`NVL`、`TOP`、`(+)`、反引号、无括号 `SYSDATE` 等） |
| 3 | `rca_service.py` | `ROOT_CAUSE` 是 `VARCHAR2(1024)`（字节语义），按字符 `[:1000]` 截断，中文会触发 ORA-12899；模型不可用时整个 RCA 失败，什么都看不到 | 按字节截断；模型不可用自动走规则式 RCA（CPU/连接/锁/空间），`LLM_MODEL` 记为 `rule-engine`，置信度如实偏低 |
| 4 | `rag_service.py` | 无 `EMBED_MODEL` 时知识库完全不可用（添加/检索/问答全报错）；`reindex_document` 先删旧块再算向量，中途失败会丢掉原有索引；`KEYWORD_HASH` 按字符截断同样有字节问题 | 无向量模型：入库保留文本、检索降级为关键词命中率；reindex 改为“先算后删”；字节截断 |
| 5 | `cluster_service.py` | 告警降噪依赖向量模型，无模型整体失败 | 降级为本地哈希向量（统一维度，不混用） |
| 6 | 巡检（`INSPECT_ISSUE`） | Java `InspectCompareService` 读取该表，但 Node 巡检从不写入，“巡检对比”永远为空 | 巡检结果写入 `INSPECT_ISSUE`（键 `CATEGORY\|TITLE`） |
| 7 | 巡检脚本执行 | 手工脚本的分段、只读保护、失败处理不完整；脚本与实例类型不匹配时静默跑错 | 见第 3 节 |
| 8 | `sqlOptHistory.js` | `effectScore` 无范围校验；备注按字符截断；没有前后耗时无法衡量效果 | 校验 1–5；按字节截断；新增 `BASELINE_MS/AFTER_MS` |

## 2. 模块之间的联系（补齐的断点）

- **巡检 → 知识图谱**：每次巡检的严重/警告项、实例、处置建议自动入图。
- **SQL 优化 → 知识图谱**：保存优化记录时入图（SQL、实例、命中的规则）；记录里新增 `INSTANCE_ID / OPT_MODE / PRECHECK`。
- **RCA → 知识图谱**：根因与处置建议入图。
- **知识图谱 → ChatOps**：问答时按问题关键词取历史相关问题/根因/处置，拼进提示词。
- **慢 SQL 快照 → Oracle 深度诊断**：慢 SQL 详情里（Oracle 且有 SQL_ID）一键跳到诊断页并预填。
- **SQL 优化 AI 页 → 后端**：见上表第 1 项。
- 新增 Node 路由前缀 `/api/kg`、`/api/sql-diag`，均**不在** Java 网关 `OWNED_PREFIXES` 内，会被网关透传到 Node。

## 3. 数据库巡检：脚本驱动 + Word（总结 + 详细）+ 批量 Excel

### 3.1 流程

手工配置脚本 → 解析分段 → **只读**执行（逐段、有行数/超时上限）→ 结论引擎（评分、问题清单、采集失败不当作“正常”）→ 每实例一份 Word → 批量任务再出一份 Excel 汇总。

### 3.2 脚本怎么写

分段标记（按库不同，已兼容各客户端写法）：

| 库 | 标记写法 |
|----|----------|
| Oracle | `PROMPT >>SECTION: 3. [SPACE] 表空间使用率` |
| 达梦 | `PRINT '>>SECTION: …'` |
| PostgreSQL / 盘古 | `\echo '>>SECTION: …'` |
| MySQL / GoldenDB / SQL Server | `SELECT '>>SECTION: …';` |

- 标题里 `[TAG]` 决定分类：`HEALTH / RISK / PARAMETER / SPACE / HA`（另认 `PERF/BACKUP/STAT/ADG` 等别名）。
- 没有标记也能跑：按语句自动分段，分类用脚本默认分类。
- **阈值指令**（可选）：
  ```sql
  -- @rule col=LAG_SEC op=>= warn=300 crit=600 title=备库延迟 section=备库 advice=检查传输链路
  ```
  `op` 支持 `>= > <= < = != contains regex`；写错的指令会在报告里提示，而不是静默忽略。
- 保存前可点“校验脚本（不连库）”：看拆成几项、分类、`@rule` 是否合法、有没有非只读语句。
- **只读保护**：只放行 `SELECT/WITH/SHOW/EXPLAIN/DESC/VALUES/SET/USE/XA RECOVER`，DML/DDL 直接拒绝。

内置 6 套模板在 `backend/src/templates/inspect/`（Oracle/MySQL/PostgreSQL/达梦/GoldenDB/SQL Server）。

### 3.3 Word 报告结构

- 封面（实例、版本、巡检人、时间、总体评分/状态）
- **一、巡检总结**：1.1 结论 · 1.2 问题统计 · 1.3 重点问题（含建议）· 1.4 分类概览 · 1.5 采集失败项
- **二、详细结果**：每个检查项一节，数据表 + 命中问题标注（横向页面，宽表不挤）
- 附录：使用的脚本、阈值指令、说明

分类视图：每个分类（健康/风险/参数/空间/高可用）各存一行轻量报告，指向综合报告。

### 3.4 批量 Excel（任务含 2 个以上实例时生成）

工作表：`批量总览`（实例/评分/状态/严/警/提示/耗时/Word 文件）· `问题清单`（可筛选）· `分类矩阵`（实例×分类的问题数，按严重/警告着色）· `失败实例` · `说明`。

### 3.5 文件位置与接口

- 文件：`<报告目录>/inspect/<任务ID>/<时间戳>/…`（`INSPECT_PYTHON_REPORTS_DIR`，默认 `backend/reports`）；`latest.json` 记录最近一次清单。
- `GET /api/automation/inspect/tasks/:id/latest`、`GET …/excel`、`POST /api/automation/inspect/scripts/validate`。
- 前端：巡检任务行“最近结果”（汇总 + 下载 Excel）；巡检报告新增“综合报告”页签；脚本编辑框“校验脚本”。

## 4. SQL 洞察 / 规则优化增强

- 优化记录统计：`GET /api/sql-opt/stats`（总数、规则 vs AI、采纳率、已验证条数、平均提速）；页面顶部汇总条。
- 效果追踪：`PUT /api/sql-opt/:id/effect` 可记录 `baselineMs / afterMs`，自动计算提速。
- 导出：`GET /api/sql-opt/export`（CSV，带 BOM；单元格做了公式注入防护）。
- 与 Oracle 深度诊断打通（见第 7 节）。
- **没做**（需要改 Java 才合适，故未动）：规则白名单/豁免、规则命中率统计、规则阈值在线调整。建议在后续迭代里在 Java 的 `DI_SQL_RULE` 上做。

## 5. AI 知识图谱

- 表：`AI_KG_NODE`、`AI_KG_EDGE`（`migration_v5_kg_diag.sql`，已并入 `init.sql`）。
- 节点类型：实例 / SQL / 问题 / 巡检 / 根因分析 / 根因 / 处置建议 / SQL 优化 / SQL 诊断 / 知识文档 / 经验笔记…；重复出现只累加“权重”，反复出现的问题自然变热。
- 自动沉淀来源：巡检、SQL 优化、Oracle 诊断、RCA；也可手工“记一条经验”并关联到节点。
- 接口：`/api/kg/stats | overview | search | node/:id | note | context`（`DELETE /node/:id`）。
- 前端：AI 分析页新增“知识图谱”页签（力导向图，点击看详情，双击展开邻居，搜索、按类型筛选）。
- 写入始终“尽力而为”：失败只记日志，不影响巡检/优化主流程。

## 6. SQL 优化：先判断语句，再优化；无模型先规则

1. **预检**（`/api/precheck`，也是 `/api/optimize` 的第一步）：按所选数据库类型解析；识别 PL/SQL 块、多语句（只取第 1 条并提示）、DML/DDL（只做规则检查）、无 WHERE 的 UPDATE/DELETE；语法不对时尝试其它方言并提示“更像 xx 库写法”。**预检不通过不会进入优化**（可“仍然继续”）。
2. **优化方式** `mode`：`rule`（仅规则）/ `ai`（规则+AI，模型不可用则报错）/ `auto`（默认：模型可用用 AI，否则自动退回规则）。
3. **规则兜底链**：Java 统一规则引擎（索引建议、等价改写）→ 不可达时回退本地 `sql_rule_engine.py`（12 条规则，仅建议、不改写）。规则报告用 Markdown 输出，与 AI 回复同一渲染。
4. 规则页与 AI 页都已接入预检；AI 页增加“优化方式”下拉与“语句检查”按钮。

## 7. orasqlx（Oracle SQL_ID 深度诊断）的集成位置

**放在“SQL 优化”模块，作为独立页签“Oracle 深度诊断”**，以子进程方式调用，而不是嵌进 Java：

- 它的输入是 SQL_ID、输出是对单条 SQL 的诊断与优化建议，本质是 SQL 优化的“深度版”；与 SQL 洞察共用实例与慢 SQL 来源。
- Go 二进制独立、只读，用子进程隔离最稳；不增加 Java/Node 的依赖。

实现：`backend/tools/orasqlx/`（源码，已移除发证工具 `tools/licgen`）· `services/orasqlxRunner.js` · `routes/sqlDiag.js` · `SQL_DIAG_JOB` 表。

- 口令只通过环境变量 `ORASQLX_PWD` 传给子进程（不进命令行）；参数全部校验、`spawn(args[])` 不经 shell；总超时强制 kill；并发上限 `SQLDIAG_MAX_PARALLEL`（默认 2）。
- 流程：连库采集 → JSON 快照 → 用快照离线生成 Word（不重复连库）→ 结论入库、写知识图谱。
- 接口：`GET /api/sql-diag/status`（二进制是否可用）· `POST /run` · `GET /jobs[/:id[/docx|/json]]`。
- **已去掉 license**：orasqlx 源码中的授权校验、`--license/--machine-info/--license-info` 参数、公钥文件、README 授权章节与发证工具全部移除，平台不再有任何 orasqlx 授权检查。
- **连接取自所选实例**：页面只选 Oracle 实例，连接信息（主机/端口/服务名或 SID/账号/解密后的口令）全部来自 CMDB，不需要另填连接串；有 PDB 时才额外填 PDB 名。注意：orasqlx 是独立进程，会用该实例凭据自己建立一条只读会话（不复用 Node 已有的连接池连接）。

**部署**：
```bash
cd backend/tools/orasqlx && ./build.sh          # 需 Go>=1.21，首次联网拉取 go-ora 驱动；产物 dist/orasqlx-linux-{amd64,arm64}
# 非默认位置：ORASQLX_BIN=/path/orasqlx（不再需要 license）
```

## 8. 升级步骤

1. 备份后执行 `backend/sql/migration_v5_kg_diag.sql`（可重复执行；新库用已合并的 `init.sql`）。
2. 重启 Node 与两个 Python Agent；前端重新构建。
3. （可选）按第 7 节编译 orasqlx。
4. 无需改 Java。

## 9. 新增 / 相关环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `INSPECT_CONCURRENCY` | 2（1–8） | 批量巡检并发实例数 |
| `INSPECT_MAX_ROWS_PER_QUERY` | 5000 | 单条查询最多取回行数 |
| `INSPECT_STMT_TIMEOUT_MS` | 120000 | 单条语句超时 |
| `INSPECT_STORE_ROWS_PER_TABLE` | 300 | 入库的每表最多行数（完整数据只用于 Word） |
| `INSPECT_WORD_MAX_ROWS` | 200 | Word 每表最多行数 |
| `INSPECT_PYTHON_REPORTS_DIR` | `backend/reports` | 报告落盘根目录 |
| `ORASQLX_BIN` | 见上 | orasqlx 可执行文件路径 |
| `SQLDIAG_MAX_PARALLEL` | 2 | Oracle 诊断并发上限 |
| `EMBED_MODEL` | 空 | 为空时知识库降级为关键词检索 |

## 10. 验证与限制（请务必看）

**实际跑过的**
- 巡检脚本解析（6 套模板）、结论引擎、Word 生成（转 PDF 逐页看过版式）、批量 Excel 结构。
- Node 单测：`node --test test/inspect-report.test.js`（8 项通过）。知识图谱写入路径用“模拟数据库”校验了 SQL 绑定变量个数和写入流程。
- Python 单测：`sql-optimizer-agent/test_precheck.py`（10 项）、`ai-ops-agent/test_kg_rca.py`（4 项）通过；`/api/optimize` 的预检拦截 / 仅规则 / 自动回退 / 强制 AI 四种路径用 FastAPI TestClient 跑通。
- **第二轮（本次）**：SQL 校验/预检对未闭合引号、注释、反引号、`$$` 等畸形输入 × 14 种数据库名称（含 达梦/GoldenDB/PANWEIDB/盘古/磐维）全部返回“不通过”而不抛异常（12 项单测）；本地规则引擎的方言映射改为与校验共用一套。Java 侧代码审阅过：Druid 解析包了 `catch Throwable`，没有手写扫描器，未发现会因引号未闭合而 500 的位置；我没能复现 500，若你仍能复现，请把请求（URL、数据库类型、SQL）发我。
- 前端：所有改动的 Vue 组件通过 SFC 编译检查（模板与脚本）。
- orasqlx：去掉授权后 `go build -tags nodriver`、`go vet`、`go test` 通过；`--demo` 直接生成 JSON/Word，并用快照离线重新生成 Word 成功；Node 调用层用“假二进制”核对了命令行参数（口令只经环境变量、不进命令行）。

**没跑过的（环境限制）**
- **没有连接过真实的 Oracle / MySQL / 达梦 / PG 等数据库**：巡检执行、知识图谱 MERGE 语句、`SQL_DIAG_JOB`、迁移脚本都没在真实库上执行过。迁移与 MERGE 请先在测试库验证。
- **Java 没编译、没改动**。
- **orasqlx 带 Oracle 驱动的正式构建与真实采集**没跑过（本环境无法下载 go-ora）。
- **前端没做完整 `vite build` / 浏览器点击测试**（依赖包拉取受限），只做了 SFC 编译检查。
- 大模型相关路径只验证了“不可用/无模型”的降级逻辑，没有对真实模型做过效果评估。

**已知取舍**
- 规则兜底（本地 `sql_rule_engine`）只给建议、不生成改写 SQL；要等价改写需要 Java 统一规则引擎在线。
- 知识图谱当前是关键词检索，不是语义检索；配置 `EMBED_MODEL` 后知识库文档才有语义检索，图谱上下文仍按关键词。
- 巡检综合报告里“采集失败”的检查项会降低评分并标注“结果不可靠”，而不是当作正常——这是有意为之。
