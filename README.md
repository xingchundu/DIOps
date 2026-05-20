# 数据库智能平台 - 部署说明

---

## 版本更新记录


---

### v3.1.0 — 2025-05-20  SQL 治理 & 自动发布人工审核流程完善

> 针对「SQL 治理中心」和「自动发布」两个模块，补全人工审核/确认环节，形成完整的「自动审查 → 人工决策 → 执行发布」闭环。其余模块及功能保持不变。

#### 问题背景

| 模块 | 原有问题 |
|------|---------|
| 自动发布 | 审批弹窗仅为输入框，审核人看不到 SQL 内容、风险问题、评分，无法做出有效判断 |
| SQL 治理中心 | `SQL_AUDIT_RECORD` 无人工审核状态字段，审查记录只能"推送发布"，缺少确认 / 忽略决策环节 |

#### 数据库迁移

```bash
sqlplus monitor/oracle@host:1521/sid @backend/sql/migration_v3_closed_loop.sql
```

`migration_v3_closed_loop.sql` 末尾新增 **v3.1** 段落，对 `SQL_AUDIT_RECORD` 表追加 4 个字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `REVIEW_STATUS` | VARCHAR2(16) DEFAULT 'PENDING' | 人工审核状态：PENDING / CONFIRMED / IGNORED |
| `REVIEW_COMMENT` | VARCHAR2(1000) | 审核意见 |
| `REVIEWED_BY` | NUMBER | 审核人 USER_ID |
| `REVIEWED_AT` | TIMESTAMP | 审核时间 |

---

#### 自动发布 — 完整审核弹窗

**新增 UI：工单人工审核弹窗**（替换原有简单输入框）

点击发布工单列表中的「通过」或「拒绝」按钮，弹出完整审核页面，包含：

- 工单基本信息（工单号 / 环境 / 提交人 / 实例 / 标题）
- **SQL 评分环**（可视化评分 + 风险等级标签）
- **问题清单**（逐条展示自动审查发现的 CRITICAL / ERROR / WARNING 问题）
- **优化建议**（AI 生成的 hints）
- **SQL 全文**（带滚动区，审核人可完整阅读）
- 回滚 SQL 预览
- 历史审核流水（已有审批记录的时间线）
- **审批决定**：通过 / 拒绝二选一 + 意见输入
  - 拒绝时意见必填
  - HIGH 风险通过时展示警示提示
  - PROD 环境通过时展示高危提示

后端逻辑不变，`POST /publish/tickets/:id/review` 接口 PROD 环境限 DBA/ADMIN 审批。

---

#### SQL 治理中心 — 人工审核流程

**新增后端接口**

| 接口 | 说明 |
|------|------|
| `GET /sql-governance/audit/:auditId` | 获取单条审查记录完整详情（含 SQL 全文 + 审查结果 JSON） |
| `POST /sql-governance/audit/:auditId/review` | 人工审核：`action=CONFIRM`（确认有效）或 `action=IGNORE`（标记忽略） |

**审核历史列表改进**

- 新增「人工审核状态」列：⏳ 待审核（黄）/ ✅ 已确认（绿）/ 🚫 已忽略（灰）
- 新增「人工审核状态」筛选器（PENDING / CONFIRMED / IGNORED）
- 操作列：「查看/审核」按钮（所有记录可点）+ 「推送发布」按钮（仅 CONFIRMED + LOW/MEDIUM 风险显示）
- 列表顶部新增操作说明提示

**新增 UI：SQL 审查人工审核弹窗**

点击「查看/审核」弹出完整详情页面：

- 实例 / 来源 / 审查时间
- **SQL 评分环** + 风险等级
- **问题清单**（issues 逐条展示）+ 优化建议（hints）
- **SQL 全文**（完整文本，可滚动）
- 已审核时展示审核结论（时间 + 意见）
- 待审核时展示意见输入 + 三个决策按钮：
  - `✅ 确认有效`：标记 CONFIRMED，后续可推送发布
  - `🚫 标记忽略`：标记 IGNORED（误报 / 已知可接受风险）
  - `🚀 推送发布流程`：仅对 CONFIRMED + LOW/MEDIUM 风险记录展示，直接创建发布工单

**审核操作规则**
- 每条审查记录只能审核一次（PENDING → CONFIRMED 或 IGNORED，不可撤回）
- 只有 CONFIRMED 状态的记录才能推送发布，HIGH/CRITICAL 风险无法推送（需先优化 SQL）

---

### v3.0.0 — 2025-05-19  自动化运维四模块闭环重构

> 本次更新对「故障自动处理」「自动发布」「SQL 治理中心」「高可用与容灾」四个核心模块进行系统性重构，建立端到端的自动化闭环。

#### 数据库迁移

升级前请先执行增量迁移脚本：

```bash
sqlplus monitor/oracle@host:1521/sid @backend/sql/migration_v3_closed_loop.sql
```

迁移内容：`FAULT_EXEC_LOG` / `PUBLISH_TICKET` / `SQL_AUDIT_RECORD` / `SQL_BASELINE` / `DR_LINK` / `CMDB_INSTANCE` 六张表字段扩充，新增 `SQL_SCORE_CONFIG` 表及种子数据，新增三条示例故障策略。

---

#### § 故障自动处理

| 类型 | 内容 |
|------|------|
| 新增 API | `GET /automation/fault/dashboard` — 7 天故障统计（状态分布、高发类型、HA 触发次数、平均处置时长） |
| 新增 API | `POST /automation/fault/auto-process` — 告警系统接入入口，按优先级自动匹配并执行最优策略 |
| 增强 | `POST /fault/policies/:id/trigger` — 触发前读取真实监控指标与策略阈值比对；阈值未达时返回当前指标，支持 `force:true` 强制覆盖 |
| 新增功能 | 策略动作新增 **HA_FAILOVER** 类型，触发后自动联动高可用切换模块 |
| 新增功能 | 执行历史列增加 `HA_CORRELATION_ID`，可跨模块跳转至对应 HA 切换记录 |
| 前端 | 故障看板统计栏、触发对话框展示实时指标与强制模式切换开关 |

#### § 自动发布

| 类型 | 内容 |
|------|------|
| 增强 | 工单提交强制走 SQL 治理预审；CRITICAL 风险直接拦截，HIGH 风险关联 `GOVERNANCE_AUDIT_ID` 并提示 |
| 新增字段 | 工单新增 `ENV` 环境标签（DEV / STAGING / PROD），PROD 审批限 DBA/ADMIN 角色 |
| 新增 API | `GET /automation/publish/pipeline-overview` — 各阶段工单数量统计 |
| 增强 | 全量发布成功后低风险 SQL 自动固化入 `SQL_BASELINE`（CANDIDATE 状态）；回滚时同步置 REVOKED |
| 新增功能 | 灰度发布 → 全量发布两阶段流程，状态增加 `GRAY_TESTING` |
| 前端 | 环境徽章列（PROD 红 / STAGING 黄 / DEV 灰）、"全量发布"按钮、DDL 规则热加载说明 |

#### § SQL 治理中心

| 类型 | 内容 |
|------|------|
| 新增 API | `GET /automation/sql-governance/health-overview` — 各实例 SQL 平均健康评分、高风险数量、最近审查时间 |
| 新增 API | `POST /automation/sql-governance/import-slow-queries` — 从 `MONITOR_METRIC_SAMPLE` 一键导入慢查询并自动完成审查，来源标记 `SLOW_IMPORT` |
| 新增 API | `POST /automation/sql-governance/audit/:auditId/push-to-publish` — 低/中风险审查结果直接推送为发布工单 |
| 新增 API | `POST /automation/sql-governance/baselines/:id/activate` — DBA 确认激活 CANDIDATE 基线 |
| 增强 | 基线生命周期：`CANDIDATE → ACTIVE → REVOKED`，新增 `BASELINE_SCORE` 字段记录入库评分 |
| 增强 | 回归检测发现退化 SQL 自动写入 `FAULT_EXEC_LOG`，形成「SQL治理 → 故障处理」反向告警闭环 |
| 增强 | 动态 DDL 规则从 DB 实时加载，支持 30s TTL 缓存 + 创建/更新时主动失效 |
| 前端 | 健康评分栏、慢查询导入 Tab、审查记录来源筛选、"推送发布"按钮、CANDIDATE 基线确认激活 |

#### § 高可用与容灾

| 类型 | 内容 |
|------|------|
| 新增 API | `GET /automation/ha/dashboard` — 拓扑数量、30 天切换统计、容灾链路健康分布 |
| 新增 API | `GET /automation/ha/topologies/:id/health-check` — 逐节点健康检查（CMDB 状态 + 监控心跳双维度） |
| 增强 | `POST /ha/topologies/:id/switch` — 切换前检测目标节点健康；非演练切换成功后同步更新 `CMDB_INSTANCE.INSTANCE_ROLE` |
| 新增功能 | 切换类型增加 **DRILL**（演练），演练不变更生产主库，仅记录日志 |
| 新增 API | `POST /automation/ha/dr-links/:id/drill` — 容灾演练，记录 `LAST_DRILL_AT` |
| 增强 | 容灾链路延迟实时读取 `MONITOR_METRIC_SAMPLE`，前端"实时"标识区分监控数据与模拟数据 |
| 前端 | HA 看板统计栏、节点健康检查面板（内联展示）、容灾演练按钮、切换类型筛选 |

---

### v2.0.0  自动化运维专业版

详见 `backend/sql/migration_v2_automation_pro.sql`。

### v1.0.0  初始版本

详见 `backend/sql/init.sql`。



## 系统要求

- Node.js >= 18
- 可访问的 Oracle 平台库（示例：`192.168.137.102`，SID 或服务名按实际填写）
- **node-oracledb 默认使用 Thin 模式**：应用机**无需安装** Oracle Instant Client（Oracle DB 12.1+）。若需 Thick 模式，见下文「可选：Thick 模式」。

---

## 目录结构

```
DIOps/
├── backend/          后端 Node.js 服务
│   ├── app.js        服务入口
│   ├── .env          数据库配置（重要！）
│   ├── sql/init.sql                      Oracle 基础建表脚本
│   └── sql/migration_v2_automation_pro.sql  自动化运维专业版增量表（含 INSPECT_SCRIPT）
│   └── src/          业务代码
├── frontend/
│   ├── dist/         前端构建产物（直接部署）
│   └── src/          前端源码
├── start.bat         Windows：仅后端（日志见脚本说明）
├── start-all.bat     Windows：新窗口启动后端 + 前端
└── start.sh          Linux：启动脚本
```

---

## 第一步：初始化 Oracle 平台库

以平台库用户（示例 `monitor`）连接 Oracle，执行初始化脚本：

```bash
sqlplus moitor/oracle@192.168.137.102:1521/ora19c @backend/sql/init.sql
```

> 初始账号：admin / Admin@123456  
> 初始账号：dba / Dba@123456  

若库已建过、默认密码无法登录，请对照 `backend/sql/init.sql` 内注释中的 `UPDATE SYS_USER ...` 修正密码哈希。

### 自动化运维专业版表（自动巡检、上传巡检脚本等）

仅执行 `init.sql` **不会**创建 `INSPECT_SCRIPT` 等表。若需使用「自动化运维 → 自动巡检」中的**巡检脚本库 / 上传脚本**等功能，请在 **与 `.env` 中相同的平台库用户**下执行增量脚本：

```bash
sqlplus monitor/oracle@192.168.137.102:1521/ora19c @backend/sql/migration_v2_automation_pro.sql
```

> 未执行该脚本时，上传或访问脚本接口可能出现 **ORA-00942: table or view does not exist**（例如对象 `INSPECT_SCRIPT` 不存在）。  
> 若库中已手工创建过同名表，请勿重复执行整张脚本；仅补建缺失对象即可。

---

## 第二步：配置并启动后端

```bash
cd backend
npm install
node app.js
```

后端监听：`http://0.0.0.0:3000`（端口见 `PORT`）。

### 配置说明（backend/.env）

连接串三选一（与 `backend/src/config/db.js` 一致）：

1. **整串**：`DB_CONNECT_STRING=host:1521/ORCLPDB1`
2. **服务名**：`DB_HOST` + `DB_PORT` + `DB_SERVICE_NAME`
3. **SID**：`DB_HOST` + `DB_PORT` + `DB_SID`

示例：

```env
DB_HOST=192.168.137.102
DB_PORT=1521
DB_SID=ora19c
# 或使用服务名：DB_SERVICE_NAME=ORCLPDB1
DB_USER=moitor
DB_PASSWORD=oracle
JWT_SECRET=dbops_platform_secret_2026
PORT=3000
# 默认 Thin；仅当本机已装 Instant Client 且要用 Thick 时：
# NODE_ORACLEDB_DRIVER_MODE=thick
```

---

## 可选：Thick 模式（Instant Client）

仅在需要 **node-oracledb Thick** 时安装 Instant Client，并设置：

```env
NODE_ORACLEDB_DRIVER_MODE=thick
```

Linux 示例（版本号按下载包调整）：

```bash
# https://www.oracle.com/database/technologies/instant-client/linux-x86-64-downloads.html
rpm -ivh oracle-instantclient19.23-basic-19.23.0.0.0-1.x86_64.rpm
echo /usr/lib/oracle/19.23/client64/lib > /etc/ld.so.conf.d/oracle.conf
ldconfig
```

文档：<https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html>

---

## 第三步：部署前端

### 方案 A：Nginx 静态服务（推荐生产）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /opt/dbops/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
cp -r frontend/dist /opt/dbops/frontend/dist
nginx -s reload
```

### 方案 B：开发调试

```bash
cd backend && node app.js
cd frontend && npm install && npm run dev
# 访问 http://localhost:5173
```

Windows 可直接运行项目根目录的 `start-all.bat`（会各开窗口跑后端与前端，并写日志到 `logs/`）。

---

## API 健康检查

```bash
curl http://localhost:3000/health
```

---

## 默认账号

| 账号  | 密码         | 角色 |
|-------|--------------|------|
| admin | Admin@123456 | 超管 |
| dba   | Dba@123456   | DBA  |

> 首次登录后请立即修改密码！

---

## 监控采集配置（Prometheus）

平台后端已实现直连 Oracle 采集。如需集成 Prometheus，可参考：

```yaml
scrape_configs:
  - job_name: 'oracle'
    static_configs:
      - targets: ['192.168.137.102:9161']
```

oracle_exporter：<https://github.com/iamseth/oracledb_exporter>

---

## 常见问题

**Q: 后端连接 Oracle 失败**

- Thin 模式：确认 `DB_HOST` / `DB_PORT` / `DB_SERVICE_NAME` 或 `DB_SID`（或 `DB_CONNECT_STRING`）正确，网络可达数据库端口。
- Thick 模式：确认 Instant Client 已安装且 `LD_LIBRARY_PATH`（Linux）等环境变量正确。
- 验证连通：`telnet <DB_HOST> 1521` 或 `tnsping`。

**Q: 前端显示「网络错误」**

- 确认后端在 3000 端口运行；开发环境下前端代理是否指向该端口。
- Nginx 生产配置中 `/api/` 代理路径需与前端 `baseURL` 一致。

**Q: oracledb 安装失败**

- 参考官方安装文档：<https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html>

---

## SQL 优化 Agent

内嵌于平台的 SQL 优化工具，支持 Oracle / PostgreSQL / MySQL。基于 Ollama 本地 LLM + 确定性规则引擎 + 执行计划深度分析，提供可靠的 SQL 优化建议。

### 启动

SQL Optimizer Agent 随 `start-all.bat` 自动启动（需要 Python 3.10+ 和 Ollama）。独立启动：

```bash
cd backend/sql-optimizer-agent
python -m venv venv && venv\Scripts\activate   # 首次
pip install -r requirements.txt
python app.py                                   # 监听 http://localhost:8000
```

前端通过 `/sql-agent` 代理同源访问，无需单独打开 8000 端口。

### 架构

```
用户输入 SQL
    │
    ├─ ① 规则引擎（sql_rule_engine.py）    ← 确定性检查，不依赖 LLM
    ├─ ② EXPLAIN 深度分析（explain_analyzer.py）← 结构化解析执行计划
    ├─ ③ Schema 自动拉取 + RAG 知识检索
    │
    └─ ④ LLM 优化建议（Ollama + prompt_builder.py）
         │
         └─ ⑤ SQL 语法验证（sql_validator.py）← 后置校验
```

### 规则引擎（优先级 1）

对输入 SQL 做确定性规则检查，独立于 LLM，零幻觉。使用 sqlglot AST 解析 + 正则兜底。

| 规则 ID | 检查内容 | 严重度 |
|---------|---------|--------|
| `RULE_SELECT_STAR` | `SELECT *` 无 WHERE / 无行限制 | 高 |
| `RULE_SELECT_STAR_LIMIT` | `SELECT *` 有 LIMIT 但无 WHERE | 中 |
| `RULE_NOT_IN` | `NOT IN (子查询)` → 建议 `NOT EXISTS` | 中 |
| `RULE_CARTESIAN` | 缺少 JOIN 条件的多表 FROM | 高 |
| `RULE_OR_INDEX` | WHERE 中 OR 导致索引失效 | 中 |
| `RULE_SUBQUERY_TO_JOIN` | 可改写为 JOIN 的相关子查询 | 低 |
| `RULE_LARGE_OFFSET` | `OFFSET > 1000` → 建议 keyset 分页 | 中 |
| `RULE_INDEX_COL_ORDER` | 等值列应在范围列之前 | 低 |
| `RULE_MISSING_WHERE` | 大表 UPDATE/DELETE 无 WHERE | 高 |
| `RULE_LIKE_PREFIX` | `LIKE '%xxx'` 前缀通配符导致索引失效 | 中 |
| `RULE_FUNC_ON_INDEX` | WHERE 中对索引列使用函数 | 中 |
| `RULE_COUNT_STAR_INNODB` | MySQL `COUNT(*)` 无 WHERE 建议 `SHOW TABLE STATUS` | 低 |
| `RULE_IMPLICIT_CAST` | WHERE 列与值类型不匹配 | 中 |

规则引擎结果以可折叠卡片形式展示在 AI 回复下方，并自动注入 LLM prompt 作为优化上下文。

### EXPLAIN 深度分析（优先级 2）

结构化解析执行计划输出，识别高代价操作：

- **Oracle**：解析 `EXPLAIN PLAN` 树形结构，识别 `TABLE ACCESS FULL`、大排序、哈希连接
- **PostgreSQL**：解析 `EXPLAIN (FORMAT TEXT)` 输出，识别 `Seq Scan`、`Sort`、`Hash Join`
- **MySQL**：解析 `EXPLAIN` 表格 + JSON 格式，识别 `type=ALL`、`Using filesort`、`Using temporary`

### 功能增强（优先级 3）

- **MySQL 行数估算**：`SHOW TABLE STATUS` 替代 `SELECT COUNT(*)`，大表场景快 100x+
- **PG EXPLAIN 安全**：使用 `EXPLAIN (FORMAT TEXT)` 而非 `EXPLAIN ANALYZE`，避免实际执行 SQL
- **SQL 验证**：LLM 生成的 SQL 自动做方言解析、非法关键字、谓词一致性检查
- **前端展示**：规则引擎卡片、执行计划分析卡片、SQL 验证标签，均在对话流中内联展示

### LLM 大模型扩展

支持 Ollama 本地模型 + OpenAI 兼容远程 API 双 provider，可灵活切换 7b+ 大模型或远程推理服务。

**环境变量**（可选，有合理默认值）：

```env
LLM_PROVIDER=ollama                          # ollama | openai
OPENAI_BASE_URL=http://172.17.225.173:8103/v1  # OpenAI 兼容 API 地址
OPENAI_API_KEY=sk-xxx                          # 可为空
```

**配置示例：使用远程 qwen3-5-122b 大模型**

方式一：环境变量配置（全局生效）

在 `backend/sql-optimizer-agent/` 目录下创建 `.env` 文件或设置系统环境变量：

```env
LLM_PROVIDER=openai
OPENAI_BASE_URL=http://172.17.225.173:8103/v1
OPENAI_API_KEY=
```

方式二：前端页面配置（单用户生效，优先级高于环境变量）

1. 打开 SQL 优化页面，左侧切换到「数据库」tab
2. 在底部「LLM 配置」区域：
   - LLM 提供商 → 选择 **OpenAI 兼容（远程）**
   - API 地址 → 输入 `http://172.17.225.173:8103/v1`
   - API Key → 留空（该服务无需鉴权）或填入对应 key
3. 点击 **测试 LLM** 按钮，确认显示「连接成功」
4. 点击 **刷新模型** 按钮，从下拉列表中选择 `qwen3-5-122b`
5. 配置自动保存到浏览器，下次打开无需重复配置

> 前端配置优先于环境变量。两种方式均支持热切换，无需重启后端。

**前端配置**：「数据库」tab 底部提供 LLM 配置区域：
- LLM 提供商选择（Ollama / OpenAI 兼容）
- OpenAI API 地址与 Key 输入（选择 OpenAI 时显示）
- 测试 LLM 连接按钮
- 动态模型列表（根据 provider 自动加载）
- 配置持久化到浏览器 localStorage

**新增 API**：

| 端点 | 说明 |
|------|------|
| `GET /api/models?provider=ollama\|openai` | 获取可用模型列表 |
| `POST /api/llm/test` | 测试 LLM 连接是否可用 |

### 优化建议执行跟踪

记录每次优化建议的采纳/执行情况和效果评分，支持优化历史回顾。

**数据表**：`SQL_OPT_HISTORY`，状态流转 `PENDING → ADOPTED/REJECTED → EXECUTED`。

**功能**：
- **自动保存**：每次优化完成后自动将记录写入平台库（原始 SQL、优化后 SQL、规则引擎结果、执行计划）
- **操作栏**：AI 回复下方显示「已采纳」「已执行」「未采纳」按钮
- **效果评价**：1-5 星评分 + 备注输入
- **优化历史 tab**：左侧新增「历史」tab，展示优化记录列表（SQL 摘要、状态标签、评分、时间），点击查看详情弹窗

**API 端点**：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/sql-opt/save` | 保存优化记录（Agent 内部调用） |
| GET | `/api/sql-opt/list` | 查询优化历史（分页、筛选状态） |
| PUT | `/api/sql-opt/:id/status` | 更新状态 |
| PUT | `/api/sql-opt/:id/effect` | 更新效果评分和备注 |
| GET | `/api/sql-opt/:id` | 获取单条详情 |

### 依赖

- Python 3.10+
- sqlglot（SQL AST 解析，已在 requirements.txt 中）
- Ollama（本地 LLM，默认 deepseek-r1:1.5b，可切换模型）
- Oracle/PG/MySQL 客户端驱动（按需：oracledb / psycopg2 / pymysql）
