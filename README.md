# 数据库智能平台 - 部署说明

---

## 版本更新记录


---

### v3.22.0 — 2026-05-28  自动安装部署-部署模板与任务管理（F-45）

> 部署模板管理 + 部署任务执行引擎，支持 Oracle/MySQL/PostgreSQL/达梦 安装部署全流程。

#### 功能增强：自动安装部署（F-45）

**需求来源：** SRS F-45 自动安装部署，需要部署模板和任务管理

`DEPLOY_TEMPLATE` 和 `DEPLOY_JOB` 表在 init.sql 中已有基础定义，但无后端路由和前端页面。本次增强为完整的部署模板管理和部署任务执行系统，集成到自动化运维中心。

**核心变更：**

1. **数据库迁移**（`backend/sql/migration_deploy.sql`）：
   - DEPLOY_TEMPLATE 增强：新增 DEPLOY_TYPE（安装/升级/配置/迁移）、DB_TYPE（数据库类型）、STEPS_JSON（步骤定义）、SORT_ORDER
   - DEPLOY_JOB 增强：新增 HOST_ID、TARGET_IP、STEPS_LOG（步骤日志）、UPDATED_AT、CANCELLED_BY、CANCELLED_AT
   - 种子数据：4 个部署模板（Oracle/MySQL/PostgreSQL/达梦单机安装）

2. **部署步骤类型**：

   | 类型 | 说明 | 示例 |
   |------|------|------|
   | `CHECK` | 前置条件检查 | 连通性验证、环境检查 |
   | `SHELL` | 本地 Shell 命令 | 安装软件、配置内核参数 |
   | `SQL` | 目标实例 SQL 执行 | 创建数据库、初始化表 |

3. **后端 API**（`backend/src/routes/deploy.js`）：

   模板管理：

   | 方法 | 路径 | 说明 |
   |------|------|------|
   | GET | `/api/deploy/templates` | 模板列表 |
   | GET | `/api/deploy/templates/:id` | 模板详情 |
   | POST | `/api/deploy/templates` | 新增模板（ADMIN/DBA） |
   | PUT | `/api/deploy/templates/:id` | 编辑模板（ADMIN/DBA） |

   部署任务：

   | 方法 | 路径 | 说明 |
   |------|------|------|
   | GET | `/api/deploy/jobs` | 任务列表（分页+筛选） |
   | GET | `/api/deploy/jobs/:id` | 任务详情（含步骤日志） |
   | POST | `/api/deploy/jobs` | 创建部署任务 |
   | POST | `/api/deploy/jobs/:id/execute` | 执行/重试任务 |
   | POST | `/api/deploy/jobs/:id/cancel` | 取消任务 |
   | GET | `/api/deploy/jobs/:id/log` | 实时日志 |
   | GET | `/api/deploy/stats` | 统计 |

4. **部署执行引擎**（`backend/src/services/deployRunner.js`）：
   - 解析模板 STEPS_JSON 中的步骤定义，按顺序执行
   - 每步骤记录：状态、开始时间、耗时、输出、错误
   - 支持任务取消（RUNNING 状态下设置取消标记，步骤间检查）
   - 状态流转：PENDING → RUNNING → SUCCESS/FAILED/CANCELLED

5. **前端集成**（`frontend/src/views/automation/AutomationCenter.vue`）：
   - 自动化中心新增「安装部署」tab
   - 部署模板：卡片网格展示，支持新建/编辑/发起部署
   - 部署任务：表格列表，支持筛选/执行/重试/取消/查看详情
   - 任务详情抽屉：步骤进度条 + 每步骤日志 + 操作按钮

**部署模板步骤示例（Oracle 单机安装）：**

```
环境检查(CHECK) → 创建用户(SHELL) → 配置内核参数(SHELL) → 安装软件(SHELL) → 创建实例(SQL) → 验证(CHECK)
```

---

### v3.21.0 — 2026-05-28  系统配置-可视化参数管理（F-69）

> 全局系统参数（采集频率、告警延迟、保留策略、连接池）可视化配置，修改即时生效无需重启。

#### 功能增强：系统配置-可视化参数管理（F-69）

**需求来源：** SRS F-69 系统配置，采集频率/告警延迟/保留策略可视化配置

原有系统参数散落在环境变量和代码硬编码中（采集间隔 90s、样本保留 8 天、聚合窗口 10 分钟等），无法在线调整。新增 `SYS_CONFIG` 配置表和可视化管理页面，支持热更新。

**核心变更：**

1. **SYS_CONFIG 配置表**（`backend/sql/migration_system_config.sql`）：
   - KEY-VALUE 结构，支持 NUMBER/STRING/BOOLEAN/SELECT 类型
   - 包含 MIN_VAL/MAX_VAL 范围校验、CATEGORY 分类、LABEL/DESCRIPTION 展示
   - 记录 UPDATED_BY（修改人）和 UPDATED_AT（修改时间）

2. **预置 11 个配置项**：

   | 分类 | 配置键 | 默认值 | 说明 |
   |------|--------|--------|------|
   | 采集频率 | `monitor.collect.interval_ms` | 90000 | 监控采集间隔(ms)，最小 60s |
   | 采集频率 | `monitor.collect.first_delay_ms` | 8000 | 首次采集延迟(ms) |
   | 告警延迟 | `alert.evaluation.default_duration_min` | 5 | 默认持续时长(分钟) |
   | 告警延迟 | `alert.aggregation.window_min` | 10 | 聚合窗口(分钟) |
   | 告警延迟 | `alert.suppression.default_window_min` | 60 | 默认抑制窗口(分钟) |
   | 保留策略 | `retention.metric_sample_days` | 8 | 监控样本保留(天) |
   | 保留策略 | `retention.alert_record_days` | 90 | 告警记录保留(天) |
   | 保留策略 | `retention.audit_log_days` | 180 | 审计日志保留(天) |
   | 保留策略 | `retention.sql_history_days` | 30 | SQL历史保留(天) |
   | 连接池 | `db.pool.max` | 20 | 最大连接数 |
   | 连接池 | `db.pool.min` | 2 | 最小连接数 |

3. **配置服务**（`backend/src/services/systemConfig.js`）：
   - 内存缓存 + 数据库持久化
   - `get(key, fallback)` / `getNumber(key, fallback)` / `set(key, value)`
   - `loadAll()` 启动预加载，`reset(key)` 恢复默认值

4. **后端 API**（`backend/src/routes/systemConfig.js`）：

   | 方法 | 路径 | 说明 |
   |------|------|------|
   | GET | `/api/system-config` | 获取所有配置 |
   | PUT | `/api/system-config/:key` | 更新配置值（ADMIN/DBA） |
   | POST | `/api/system-config/:key/reset` | 重置为默认值（ADMIN/DBA） |
   | POST | `/api/system-config/reload` | 重新加载缓存（ADMIN/DBA） |

5. **现有代码改造**（配置热生效）：
   - `backend/app.js`：采集间隔从 SYS_CONFIG 读取（环境变量仍可覆盖）
   - `backend/src/services/monitorCollectPersist.js`：`pruneOldSamples()` 读取 4 个保留策略配置，自动清理监控样本、告警记录、审计日志、SQL 历史
   - `backend/src/routes/alerts.js`：聚合窗口、抑制窗口从配置读取

6. **前端页面**（`frontend/src/views/settings/SystemConfig.vue`）：
   - 按分类分组展示（采集频率 / 告警延迟 / 保留策略 / 连接池）
   - 表格显示：配置项、说明、当前值、默认值、范围
   - 点击编辑图标进入编辑模式（数字输入 / 文本输入）
   - 已修改值高亮显示（橙色），支持一键重置为默认值
   - 菜单位置：系统设置 → 系统配置（ADMIN/DBA 可见）

**前端变更：**
- `frontend/src/api/index.js`：新增 `systemConfigApi`（4 个方法）
- `frontend/src/router/index.js`：新增 `/settings/system-config` 路由
- `frontend/src/components/layout/MainLayout.vue`：系统设置子菜单新增「系统配置」

---

### v3.20.0 — 2026-05-28  运维服务化-服务目录与工单系统（F-50）

> 完善服务目录管理和工单流转系统，与 CMDB 实例、用户 RBAC 关联，支持工单全生命周期管理。

#### 功能增强：运维服务化-服务目录与工单系统（F-50）

**需求来源：** SRS F-50 运维服务化，需要服务目录和工单系统

`OPS_SERVICE_CATALOG` 和 `OPS_SERVICE_ORDER` 表已在 init.sql 中定义但字段极少且无后端/前端。本次完善为完整的服务目录管理和工单流转系统。

**核心变更：**

1. **数据库增强**（`backend/sql/migration_service_catalog.sql`）：
   - `OPS_SERVICE_CATALOG` 新增：ICON、SORT_ORDER、ENABLED、SLA_HOURS、ASSIGNEE_ROLE、UPDATED_AT
   - `OPS_SERVICE_ORDER` 新增：TITLE、PRIORITY、ASSIGNED_TO、UPDATED_AT、RESOLVED_AT、CLOSED_AT、FEEDBACK_SCORE、FEEDBACK_COMMENT、ALERT_ID
   - 新建 `OPS_ORDER_COMMENT` 表（工单评论/流转记录）
   - 预置 6 个服务目录项：实例扩容、权限申请、数据导出、参数变更、故障处理、巡检报告
   - 菜单注册 `/service-catalog` (sort_order=65)，授权 ADMIN/DBA/OPS/DEV/REVIEWER

2. **后端 API**（`backend/src/routes/serviceCatalog.js`，15 个端点）：

   **服务目录：**

   | 方法 | 路径 | 说明 |
   |------|------|------|
   | GET | `/api/service-catalog/catalogs` | 目录列表 |
   | GET | `/api/service-catalog/catalogs/:id` | 目录详情 |
   | POST | `/api/service-catalog/catalogs` | 新增目录（ADMIN/DBA） |
   | PUT | `/api/service-catalog/catalogs/:id` | 编辑目录（ADMIN/DBA） |
   | DELETE | `/api/service-catalog/catalogs/:id` | 删除目录（ADMIN/DBA） |

   **工单管理：**

   | 方法 | 路径 | 说明 |
   |------|------|------|
   | GET | `/api/service-catalog/stats` | 统计（各状态工单数） |
   | GET | `/api/service-catalog/orders` | 工单列表（分页+筛选） |
   | GET | `/api/service-catalog/orders/:id` | 工单详情（含评论） |
   | POST | `/api/service-catalog/orders` | 创建工单 |
   | PUT | `/api/service-catalog/orders/:id` | 更新工单 |
   | POST | `/api/service-catalog/orders/:id/assign` | 指派工单 |
   | POST | `/api/service-catalog/orders/:id/status` | 变更状态 |
   | POST | `/api/service-catalog/orders/:id/comment` | 添加评论 |
   | POST | `/api/service-catalog/orders/:id/feedback` | 满意度评价 |
   | GET | `/api/service-catalog/my-orders` | 我的工单 |

3. **工单状态流转**：
   ```
   OPEN → IN_PROGRESS → RESOLVED → CLOSED
                   ↘ PENDING_REVIEW ↗
   OPEN → REJECTED（仅 ADMIN/DBA）
   ```
   - 创建者、指派人、管理员可变更状态
   - 仅创建者可提交满意度评价（RESOLVED/CLOSED 状态）

4. **前端页面**（`frontend/src/views/service/ServiceCatalog.vue`）：
   - **统计卡片**：全部/待处理/处理中/已解决工单数
   - **服务目录 Tab**：卡片网格展示（图标 + 名称 + 分类 + SLA + 描述），点击卡片提交工单
   - **工单列表 Tab**：表格展示 + 状态/优先级/关键词筛选
   - **我的工单 Tab**：我创建的 / 指派给我的
   - **工单详情抽屉**：基本信息 + 操作按钮（指派/变更状态/评价）+ 流转时间线 + 评论
   - **新增/编辑服务对话框**（ADMIN/DBA）

**前端变更：**
- `frontend/src/api/index.js`：新增 `serviceCatalogApi`（15 个方法）
- `frontend/src/router/index.js`：新增 `/service-catalog` 路由
- `frontend/src/components/layout/MainLayout.vue`：新增侧栏菜单项「服务工单」+ titleMap
- `backend/app.js`：注册 `/api/service-catalog` 路由

---

### v3.19.0 — 2026-05-28  健康评分-多维度评分算法（F-30）

> 健康评分从单一扣分制升级为四维度加权评分（连通性/性能/负载/资源），前端雷达图展示评分构成。

#### 功能增强：健康评分-多维度评分算法（F-30）

**需求来源：** SRS F-30 健康评分，CMDB 有 HEALTH_SCORE 字段但无多维度评分算法

原有 `computeHealthScore()` 仅检查缓存命中率和活跃会话两个指标，采用固定扣分制。升级为四维度加权评分模型，每个维度独立评分 0-100，加权汇总为总分。

**核心变更：**

1. **多维度评分模型**（`backend/src/services/monitorCollectPersist.js`）：

| 维度 | 权重 | Oracle/Dameng | MySQL | PostgreSQL |
|------|------|---------------|-------|------------|
| 连通性 | 20% | REACHABLE | REACHABLE | REACHABLE |
| 性能 | 30% | Buffer Cache Hit Ratio | innodb_buffer_pool_hit_ratio | pg_buffer_cache_hit_ratio |
| 负载 | 25% | Active Sessions | threads_running | numbackends |
| 资源 | 25% | Shared Pool Free % | slow_queries | xact_rollback 比率 |

2. **评分规则**（每维度 0-100 分）：
   - **连通性**：可达=100，不可达=0
   - **性能**：缓存命中率 >=95→100，90-95→70，80-90→40，<80→10
   - **负载**：根据引擎阈值线性映射（Oracle 上限 200，MySQL 上限 150，PG 上限 100）
   - **资源**：Oracle Shared Pool / MySQL 慢查询 / PG 回滚比率，分级映射

3. **数据存储**：
   - `MONITOR_METRIC_SAMPLE` 新增 `HEALTH_DETAIL CLOB` 列，存储各维度评分 JSON
   - `CMDB_INSTANCE.HEALTH_SCORE` 保持单值不变（向后兼容）
   - 迁移脚本：`backend/sql/migration_health_detail.sql`

4. **新增 API 端点**：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/monitor/instances/:id/health-detail` | 多维度健康评分详情 |

5. **前端评分可视化**（`frontend/src/views/monitor/InstanceDetail.vue`）：
   - 基本信息 tab 新增「多维度健康评分」区域
   - **雷达图**：ECharts radar chart 展示四维度评分
   - **维度进度条**：每个维度一行，显示名称、权重、分数、进度条、评分明细
   - 颜色阈值：>=80 绿色，60-79 黄色，<60 红色

**前端变更：**
- `frontend/src/api/index.js`：`monitorApi` 新增 `healthDetail(id)` 方法
- `frontend/src/views/monitor/InstanceDetail.vue`：基本信息 tab 增加雷达图 + 维度进度条

---

### v3.18.0 — 2026-05-28  在线SQL执行-语法高亮编辑器（F-25）

> SQL 工作台编辑器升级为 CodeMirror 6，支持 SQL 语法高亮、行号、括号匹配、自动补全和多数据库方言。

#### 功能增强：在线SQL执行-语法高亮编辑器（F-25）

**需求来源：** SRS F-25 在线SQL执行，需要语法高亮编辑器

将 Web SQL 工作台的纯文本 textarea 编辑器升级为基于 CodeMirror 6 的专业 SQL 编辑器，提供语法高亮、智能补全、行号显示等现代编辑器功能。

**核心变更：**

1. **CodeMirror 6 集成**（`frontend/src/views/sql/WebSQL.vue`）：
   - SQL 语法高亮：基于 `@codemirror/lang-sql`，支持多种数据库方言
   - 行号显示 + 当前行高亮 + 括号匹配 + 自动闭合括号
   - 代码折叠（Fold Gutter）
   - 多光标选择（Rectangular Selection）
   - 暗色主题（One Dark）
   - 历史撤销/重做（Ctrl+Z / Ctrl+Y）
   - 自动补全：SQL 关键词 + Schema 表名/列名（动态加载）

2. **数据库方言自动切换**：
   - 根据所选实例的 DB_TYPE 自动切换 SQL 方言：
     - ORACLE / 达梦 → PL/SQL
     - MYSQL → MySQL 方言
     - POSTGRES → PostgreSQL 方言
     - SQLITE → SQLite 方言
     - MSSQL → T-SQL 方言
   - Schema 树点击或列信息加载后，自动更新补全源

3. **快捷键支持**：
   - `F8` — 执行 SQL
   - `Ctrl+Enter` / `Cmd+Enter` — 执行 SQL
   - `Tab` — 缩进（2 空格）
   - `Ctrl+Z` / `Ctrl+Y` — 撤销 / 重做
   - `Ctrl+F` — 搜索
   - `Ctrl+Shift+F` — 格式化搜索

4. **新增依赖**：
   - `codemirror` ^6.0.2
   - `@codemirror/lang-sql` ^6.10.0（SQL 方言 + 自动补全）
   - `@codemirror/theme-one-dark` ^6.1.3（暗色主题）
   - `@codemirror/view` ^6.43.0
   - `@codemirror/state` ^6.6.0
   - `@codemirror/basic-setup` ^0.20.0

**前端变更：**
- `frontend/src/views/sql/WebSQL.vue`：textarea 替换为 CodeMirror 6 编辑器
- 保持所有现有功能不变（执行、执行计划、Schema 浏览、历史、消息）

---

### v3.17.0 — 2026-05-28  Web SQL 工作台（F-24）

> 内置 Web SQL 工作台，基于 CMDB 管理的实例连接信息直接执行 SQL，替代 Python Agent iframe 方案。

#### 功能增强：Web SQL 工作台（F-24）

**需求来源：** SRS F-24 数据库连接管理，需要内置 Web SQL 工作台

原 SQL 优化页（`SqlOptimization.vue`）通过 iframe 嵌入 Python Agent 的独立 HTML 页面，用户需手动输入连接信息。F-24 新增内置 Web SQL 工作台，复用 CMDB 已有实例连接信息，无需重复配置即可直接执行 SQL 查询。

**核心变更：**

1. **后端 SQL 执行引擎**（`backend/src/routes/sqlWorkbench.js`）：
   - 复用 `monitorTargetConn.js` 的连接基础设施
   - 支持 Oracle/MySQL/PostgreSQL/达梦 四种数据库
   - 安全限制：最大返回 500 行、30 秒超时、DDL/DCL 拦截
   - 查询历史记录到 `SQL_WORKBENCH_HISTORY` 表

2. **新增 API 端点**：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/workbench/instances` | 可用实例列表（RUNNING） |
| POST | `/api/workbench/execute` | 执行 SQL |
| POST | `/api/workbench/explain` | 执行 EXPLAIN 计划 |
| GET | `/api/workbench/schema/:id` | Schema 元数据（表/视图列表） |
| GET | `/api/workbench/columns/:id` | 表列信息 |
| GET | `/api/workbench/history` | 执行历史 |

3. **前端工作台页面**（`frontend/src/views/sql/WebSQL.vue`）：
   - **实例选择器**：下拉选择 CMDB 中的运行中实例
   - **SQL 编辑器**：等宽字体文本域，支持 Tab 缩进、快捷代码片段
   - **执行按钮**：支持 F8 / Ctrl+Enter 快捷执行
   - **安全开关**：「允许 DDL/DML」复选框（默认拦截 DROP/DELETE/ALTER 等）
   - **Schema 浏览器**：左侧可折叠面板，按 owner 分组展示表/视图树
     - 搜索过滤、点击插入表名、自动加载列信息
   - **结果面板**（4 个 Tab）：
     - 查询结果：数据表格展示
     - 执行计划：Oracle DBMS_XPLAN / MySQL EXPLAIN / PG EXPLAIN
     - 历史：可复用历史 SQL
     - 消息：执行日志和错误信息
   - **格式化**：SQL 关键词大写 + 主要关键词前换行

4. **新增数据库表**：
   - `SQL_WORKBENCH_HISTORY` — 执行历史记录
   - 迁移脚本：`backend/sql/migration_sql_workbench.sql`

**前端变更：**
- `frontend/src/api/index.js`：新增 `workbenchApi`（6 个方法）
- `frontend/src/router/index.js`：新增 `/workbench` 路由
- `frontend/src/components/layout/MainLayout.vue`：新增侧栏菜单项 + titleMap
- `backend/sql/init.sql`：新增 SYS_MENU 种子数据

---

### v3.16.0 — 2026-05-28  告警静默-维护窗口（F-18）

> 支持配置维护窗口（一次性/周期性），在维护期间自动静默告警，避免计划内运维触发误报。

#### 功能增强：告警静默-维护窗口（F-18）

**需求来源：** SRS F-18 告警静默，需要维护窗口配置

DBA 在执行计划内维护操作（如数据库补丁升级、存储扩容、网络割接）时，会在维护窗口期间产生大量预期告警。F-18 允许 DBA 配置静默规则，指定时间窗口和匹配条件，在维护期间自动静默匹配的告警，避免告警风暴干扰。

**核心变更：**

1. **新增数据库表**：
   - `ALERT_SILENCE_RULE` — 静默规则配置（支持一次性/周期性）
   - `ALERT_SILENCE_LOG` — 静默记录（记录哪些告警被静默）
   - `ALERT_RECORD` 新增字段：`SILENCE_RULE_ID`（触发静默的规则）、`SILENCED_AT`（静默时间）
   - 新增状态值：`SILENCED`
   - 迁移脚本：`backend/sql/migration_alert_silence.sql`

2. **静默规则类型**：
   - **ONCE（一次性）**：指定开始/结束时间，适合计划维护窗口
   - **RECURRING（周期性）**：使用 Cron 表达式 + 持续时长，适合日常维护（如"工作日凌晨2:00-4:00"）

3. **匹配条件**（均为可选，不填=全部匹配）：
   - `INSTANCE_ID` — 绑定特定实例
   - `SEVERITY` — 匹配指定告警级别（逗号分隔）
   - `RULE_NAME_MATCH` — 匹配特定告警规则名

4. **静默检查逻辑**（`checkSilenceForAlert`）：
   - 对每条 OPEN 告警，遍历所有启用的静默规则
   - 检查当前时间是否在规则的时间窗口内
   - 检查告警是否匹配规则条件
   - 命中则将告警状态更新为 `SILENCED`，并记录静默日志
   - 支持批量检查所有 OPEN 告警

5. **新增 API 端点**：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/alerts/silence-rules` | 静默规则列表 |
| POST | `/api/alerts/silence-rules` | 创建静默规则 |
| PUT | `/api/alerts/silence-rules/:id` | 更新静默规则 |
| DELETE | `/api/alerts/silence-rules/:id` | 删除静默规则 |
| POST | `/api/alerts/check-silence` | 检查单个告警 |
| POST | `/api/alerts/batch-check-silence` | 批量检查所有 OPEN 告警 |
| POST | `/api/alerts/:id/unsilence` | 手动取消静默 |
| GET | `/api/alerts/silence-stats` | 静默统计 |

6. **前端集成**（`AlertCenter.vue`）：
   - 告警状态筛选新增「已静默」选项
   - 右侧面板新增第 5 个 Tab「告警静默」
   - 静默规则列表：启用/禁用切换、类型标签（一次性/周期）、已过期标记
   - 新增静默规则 Dialog：支持一次性/周期性配置、实例绑定、级别匹配
   - 批量静默检查按钮
   - 告警列表新增「取消静默」操作
   - 底部静默概览：活跃规则数、被静默告警数、最近静默记录

**前端变更：**
- `frontend/src/api/index.js`：`alertApi` 新增 8 个静默方法
- `frontend/src/views/alerts/AlertCenter.vue`：新增静默 Tab + Dialog + 函数

---

### v3.15.0 — 2026-05-28  告警聚合去重（F-16）

> 同规则、同实例、同级别的告警在可配置时间窗口内自动合并，减少告警风暴中的重复噪声。

#### 功能增强：告警聚合去重（F-16）

**需求来源：** SRS F-16 告警聚合去重，需要 10 分钟窗口同类合并

在告警风暴场景中（如主机宕机触发大量关联告警），同一规则在同一实例上可能短时间内产生大量重复告警。F-16 通过可配置的时间窗口（默认 10 分钟），按「规则名 + 实例 + 严重度」自动聚合同类告警，保留一条代表告警，其余标记为已合并，显著降低告警噪声。

**核心变更：**

1. **新增数据库表**：
   - `ALERT_AGGREGATION` — 告警聚合组（聚合键、代表告警、合并数量、时间窗口）
   - `ALERT_RECORD` 新增字段：`AGG_GROUP_ID`（所属聚合组）、`IS_MERGED`（是否被合并）
   - 迁移脚本：`backend/sql/migration_alert_aggregation.sql`

2. **聚合逻辑**（`backend/src/routes/alerts.js`）：
   - `aggregateAlerts(windowMinutes)` — 核心聚合函数
     - 查找时间窗口内所有 OPEN/ACKNOWLEDGED 告警
     - 按 `RULE_NAME|INSTANCE_ID|SEVERITY` 分组
     - 组内 ≥ 2 条告警时，最早触发的为代表告警
     - 其余标记 `IS_MERGED=1`，关联到聚合组
     - 支持增量聚合（已有聚合组追加新告警）
   - `splitAggregation(aggId)` — 解散聚合组，恢复被合并告警

3. **新增 API 端点**：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/alerts/aggregate` | 执行聚合（可传 windowMinutes） |
| GET | `/api/alerts/aggregation-groups` | 聚合组列表（支持分页/筛选） |
| GET | `/api/alerts/aggregation-groups/stats` | 聚合统计 |
| GET | `/api/alerts/aggregation-groups/:id` | 聚合组详情（含成员告警） |
| POST | `/api/alerts/aggregation-groups/:id/resolve` | 批量解决组内所有告警 |
| POST | `/api/alerts/aggregation-groups/:id/split` | 解散聚合组 |

4. **前端集成**（`AlertCenter.vue`）：
   - 右侧面板新增第 4 个 Tab「聚合去重」
   - 可配置聚合窗口（1-60 分钟，默认 10）
   - 聚合组列表：显示严重度、规则名、实例、合并数量、代表告警内容
   - 聚合组详情 Dialog：成员告警表格（代表/已合并标记）
   - 支持批量解决和解散操作
   - 底部聚合概览：活跃聚合组数、被合并告警数、Top 聚合组
   - 统计卡片已包含被合并告警的计数

**前端变更：**
- `frontend/src/api/index.js`：`alertApi` 新增 6 个聚合方法
- `frontend/src/views/alerts/AlertCenter.vue`：新增聚合 Tab + 聚合详情 Dialog + 聚合统计

---

### v3.14.0 — 2026-05-28  自定义监控项（F-10）

> 新增自定义监控面板和指标功能，支持 DBA 自定义 SQL 查询和表达式指标，配置化仪表盘实时展示。

#### 功能增强：自定义监控项（F-10）

**需求来源：** SRS F-10 DBA 自定义监控面板，PromQL 面板配置

平台现有监控采集（`monitorCollectPersist`）已周期性将 `METRICS_JSON` 存入 `MONITOR_METRIC_SAMPLE`，但仅展示预置指标。F-10 允许 DBA 自定义监控面板和指标项，支持两种指标类型：

1. **SQL 类型** — 对被管数据库执行自定义 SQL，返回单行单列值（如活跃会话数、锁等待数）
2. **EXPRESSION 类型** — 从已有采集数据做聚合计算（如 `avg(METRIC_CPU)`、`last(HEALTH_SCORE)`、`max(METRIC_CONN)`）

**核心变更：**

1. **新增数据库表**：
   - `MONITOR_CUSTOM_PANEL` — 自定义监控面板配置
   - `MONITOR_CUSTOM_METRIC` — 面板内的指标项配置
   - 迁移脚本：`backend/sql/migration_custom_metrics.sql`

2. **后端服务**：
   - `backend/src/services/customMetricService.js` — 指标执行引擎
     - `evaluateExpression()` — 表达式解析器，支持 avg/last/max/min/sum/count 函数
     - `executeCustomSql()` — 对被管库执行自定义 SQL（支持 Oracle/MySQL/PG/Dameng）
     - `executePanelMetrics()` — 批量执行面板下所有指标
   - `backend/src/routes/customMetrics.js` — REST API（9 个端点）

3. **前端页面**：
   - `frontend/src/views/monitor/CustomMetrics.vue` — 自定义监控项管理页
     - 左侧面板列表 + 右侧指标详情
     - 面板 CRUD（新建/编辑/删除）
     - 指标 CRUD（支持 SQL 和表达式两种类型）
     - 执行查询并可视化结果（仪表盘/数字/折线/柱状/表格）
     - 测试执行功能
   - 侧栏菜单：监控中心区域新增「自定义监控项」入口

4. **表达式语法**：
   - `avg(METRIC_CPU)` — 平均 CPU
   - `last(HEALTH_SCORE)` — 最新健康分
   - `max(METRIC_CONN)` — 最大连接数
   - `sum(METRIC_CONN)` — 连接数总和
   - `count()` — 采样计数
   - 支持顶层列（METRIC_CPU/METRIC_CONN/HEALTH_SCORE）和 METRICS_JSON 内的指标名

5. **图表类型**：
   - `gauge` — 仪表盘（带阈值颜色）
   - `number` — 数字展示
   - `line` — 折线图
   - `bar` — 柱状图
   - `table` — 表格（SQL 多行结果）

**前端变更：**
- `frontend/src/api/index.js`：新增 `customMetricsApi`（12 个方法）
- `frontend/src/router/index.js`：新增 `/monitor/custom-metrics` 路由
- `frontend/src/components/layout/MainLayout.vue`：新增侧栏菜单项 + titleMap + activeMenu
- `backend/sql/init.sql`：新增 SYS_MENU 种子数据

**后端 API：**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/custom-metrics/panels` | 面板列表 |
| GET | `/api/custom-metrics/panels/:id` | 面板详情（含指标） |
| POST | `/api/custom-metrics/panels` | 创建面板 |
| PUT | `/api/custom-metrics/panels/:id` | 更新面板 |
| DELETE | `/api/custom-metrics/panels/:id` | 删除面板（级联） |
| POST | `/api/custom-metrics/metrics` | 创建指标 |
| PUT | `/api/custom-metrics/metrics/:id` | 更新指标 |
| DELETE | `/api/custom-metrics/metrics/:id` | 删除指标 |
| POST | `/api/custom-metrics/execute` | 执行单个指标 |
| GET | `/api/custom-metrics/panels/:id/execute` | 执行面板所有指标 |
| GET | `/api/custom-metrics/instances` | 可用实例列表 |
| GET | `/api/custom-metrics/available-metrics` | 可用指标名列表 |

---

### v3.13.0 — 2026-05-28  报表中心服务端真实分析（F-58~64）

> 报表中心从客户端模板拼接升级为服务端 SQL 聚合分析，新增 7 大报表维度，数据来自 CMDB、监控、告警、AI 等多张业务表。

#### 功能增强：报表中心服务端分析（F-58~64）

**需求来源：** SRS F-58 综合概览、F-59 SLA 可用性、F-60 告警趋势、F-61 容量分析、F-62 SQL 质量、F-63 巡检汇总、F-64 AI 分析

原报表页面（`Reports.vue`）使用前端模板字符串拼接静态数据，无真实后端分析能力。本次改造新增 7 个服务端分析 API，前端报表全部改为调用服务端接口，展示真实聚合数据。

**核心变更：**

1. **新增服务端报表分析 API**（F-58~64）：
   - `backend/src/routes/reports.js` 新增 7 个分析端点
   - 所有端点需要登录认证（`authMiddleware`）
   - 使用 `Promise.all` 并行查询多张表提升性能
   - 对可能不存在的表使用 `.catch(() => ({ rows: [] }))` 容错

2. **综合概览**（F-58）：
   - 实例统计：总数、运行中、异常、健康、平均健康分
   - 告警统计：总数、未处理、已确认、已解决、P1未处理
   - 最近 Top 5 未处理告警（按严重度排序）
   - 健康分分布：健康(≥80)/关注(60-79)/异常(<60)

3. **SLA 可用性报表**（F-59）：
   - 支持 7d/30d/90d 时间范围
   - 实例级 SLA：基于 `MONITOR_METRIC_SAMPLE` 采样计算可用率
   - 全局 SLA：所有实例汇总
   - MTTR（平均恢复时间）：从 `ALERT_RECORD` 计算

4. **告警趋势分析**（F-60）：
   - 每日告警数趋势
   - 按严重度分布（P1/P2/P3/P4）
   - Top 5 告警实例
   - 解决率统计

5. **容量分析**（F-61）：
   - 表空间使用 Top（来自 `MONITOR_TABLESPACE_SAMPLE`）
   - 实例连接数汇总
   - 高使用率警告（≥80%）

6. **SQL 质量报表**（F-62）：
   - Top 慢 SQL（来自 `SQL_OPT_HISTORY`）
   - SQL 评审统计（总数、通过率、平均分）
   - 评审状态分布

7. **巡检汇总**（F-63）：
   - 最近 10 份巡检报告
   - 巡检任务状态分布

8. **AI 分析报表**（F-64）：
   - RCA 统计（总数、平均置信度）
   - 异常检测统计（总数、严重数）
   - 告警聚类统计（总数、活跃数）
   - ChatOps 统计（会话数、消息数）
   - 最近 RCA 结果 Top 5

**前端变更：**
- `frontend/src/api/index.js`：新增 `reportApi`（7 个方法：overview/sla/alertTrend/capacity/sqlQuality/inspectSummary/aiStats）
- `frontend/src/views/reports/Reports.vue`：完全重写，7 个 Tab 使用服务端数据
  - 综合概览：实例/告警统计卡片 + 健康分布饼图 + Top 5 告警表
  - SLA 可用性：全局 SLA/MTTR 指标 + 实例 SLA 表格
  - 告警趋势：折线图(每日) + 饼图(严重度) + Top 5 实例 + 解决率
  - 容量分析：表空间柱状图 + 连接数表 + 高使用率警告
  - SQL 质量：Top 慢 SQL 表 + 评审统计卡片 + 状态分布饼图
  - 巡检汇总：最近报告表 + 任务状态饼图
  - AI 分析：RCA/异常/聚类/ChatOps 四维统计 + 最近 RCA 表

**后端 API（新增）：**

| 方法 | 路径 | 说明 | 功能编号 |
|------|------|------|----------|
| GET | `/api/reports/overview` | 综合概览 | F-58 |
| GET | `/api/reports/sla?range=7d\|30d\|90d` | SLA 可用性 | F-59 |
| GET | `/api/reports/alert-trend?days=7` | 告警趋势 | F-60 |
| GET | `/api/reports/capacity` | 容量分析 | F-61 |
| GET | `/api/reports/sql-quality` | SQL 质量 | F-62 |
| GET | `/api/reports/inspect-summary` | 巡检汇总 | F-63 |
| GET | `/api/reports/ai-stats` | AI 分析统计 | F-64 |

**涉及表：** CMDB_INSTANCE, ALERT_RECORD, MONITOR_METRIC_SAMPLE, MONITOR_TABLESPACE_SAMPLE, SQL_OPT_HISTORY, SQL_REVIEW_TICKET, INSPECT_REPORT, INSPECT_TASK, AI_RCA_RESULT, AI_ANOMALY_RECORD, AI_ALERT_CLUSTER, AI_CHAT_HISTORY

---

### v3.12.0 — 2026-05-28  AI 智能分析深度集成（F-54~57）

> 将已有 AI 微服务（RCA/异常检测/聚类/ChatOps/知识库）与前端深度集成，统一 API 调用、增强知识库与问答联动、新增服务健康监控。

#### 功能增强：AI 智能分析深度集成（F-54~57）

**需求来源：** SRS F-54 RCA 根因分析、F-55 异常检测、F-56 告警聚类降噪、F-57 ChatOps + 知识库

已有 Python AI 微服务（`ai-ops-agent`，端口 8001）完整实现了 RCA、异常检测、聚类、ChatOps RAG 问答、知识库管理。前端 `AIAnalysis.vue` 之前使用本地 axios 实例直接调用后端，与项目共享 API 层脱节。本次重构统一到共享 `aiApi`，并增强知识库与 ChatOps 的联动。

**核心变更：**

1. **统一 API 层**（F-54~57）：
   - `frontend/src/api/index.js` 的 `aiApi` 从 11 个方法扩展到 18 个，覆盖所有 Python 微服务端点
   - 新增方法：`chatSessions`、`chatHistory`、`knowledge`、`knowledgeSearch`、`addKnowledge`、`deleteKnowledge`、`reindexKnowledge`、`uploadKnowledge`、`health`
   - `AIAnalysis.vue` 移除本地 axios 实例，全部改用共享 `aiApi` 和 `cmdbApi`

2. **AI 服务健康监控**（F-54）：
   - 页面头部新增 AI 服务在线/离线状态标签（绿色在线/红色离线）
   - 显示 Python 微服务版本号
   - 页面加载时自动调用 `aiApi.health()` 检查服务状态

3. **知识库-ChatOps 联动**（F-57）：
   - Chat 输入区新增「知识库」按钮（Popover 弹出）
   - 支持在对话过程中语义检索知识库，点击结果自动插入上下文到输入框
   - AI 回复中的参考知识库标签改为可交互（Hover 显示文档摘要和相似度）
   - 实现"边聊边查"的 RAG 增强体验

4. **RCA 根因分析**（F-54）：触发实例 RCA → 多指标关联 + 拓扑传导 + LLM 结论，结果弹窗展示
5. **异常检测**（F-55）：Z-Score + MAD + Isolation Forest 三算法融合检测
6. **告警聚类降噪**（F-56）：向量相似度聚类，合并重复告警

**前端变更：**
- `aiApi` 扩展：18 个方法覆盖 ChatOps/RCA/异常/聚类/知识库/健康检查
- `AIAnalysis.vue` 重构：
  - 移除 `import axios` 和本地 `API` 实例
  - 所有 API 调用改用 `aiApi.xxx()` / `cmdbApi.xxx()`
  - 响应格式统一：`res.code === 200` 判断（共享拦截器已解包）
  - 新增 `aiHealth` 响应式状态 + `checkHealth()` 函数
  - 新增 `CircleClose` 图标导入
  - Chat 区新增知识库 Popover（`chatKbQuery`/`chatKbResults`/`chatKbLoading`/`chatKbSearch`/`insertKbContext`）
  - 参考知识库标签改为 `el-popover`（Hover 展示摘要）
  - 新增 CSS：`.kb-popover`/`.kb-popover-item` 等

**后端 API（已有，无需修改）：**

| 方法 | 路径 | 说明 | 功能编号 |
|------|------|------|----------|
| POST | `/api/ai/rca` | RCA 根因分析 | F-54 |
| GET | `/api/ai/rca/list` | RCA 历史列表 | F-54 |
| GET | `/api/ai/rca/:id` | RCA 详情 | F-54 |
| POST | `/api/ai/anomaly/detect` | 异常检测 | F-55 |
| GET | `/api/ai/anomaly` | 异常记录列表 | F-55 |
| POST | `/api/ai/cluster` | 告警聚类 | F-56 |
| GET | `/api/ai/cluster` | 聚类结果列表 | F-56 |
| POST | `/api/ai/chat` | ChatOps 问答 | F-57 |
| GET | `/api/ai/chat/sessions` | 会话列表 | F-57 |
| GET | `/api/ai/chat/:session_id` | 对话历史 | F-57 |
| GET | `/api/ai/knowledge` | 知识库文档列表 | F-57 |
| GET | `/api/ai/knowledge/search` | 知识库语义检索 | F-57 |
| POST | `/api/ai/knowledge` | 新增知识文档 | F-57 |
| POST | `/api/ai/knowledge/upload` | 上传文件到知识库 | F-57 |
| DELETE | `/api/ai/knowledge/:id` | 删除知识文档 | F-57 |
| POST | `/api/ai/knowledge/:id/reindex` | 重建向量索引 | F-57 |
| GET | `/api/ai/health` | AI 服务健康检查 | F-54~57 |

**关联 Python 微服务（已有，无需修改）：**
- `backend/ai-ops-agent/app.py` — FastAPI 入口（端口 8001）
- `backend/ai-ops-agent/rca_service.py` — RCA 根因分析
- `backend/ai-ops-agent/anomaly_service.py` — 异常检测（Z-Score + MAD + Isolation Forest）
- `backend/ai-ops-agent/cluster_service.py` — 告警聚类（向量相似度）
- `backend/ai-ops-agent/rag_service.py` — RAG 问答 + 知识库管理
- `backend/ai-ops-agent/llm_service.py` — LLM 与 Embedding 服务
- `backend/ai-ops-agent/db_service.py` — Oracle 数据库访问层

---

### v3.11.0 — 2026-05-28  跨实例性能对比（F-44）

> 新增独立的跨实例性能对比页面，支持选择多个运行中的实例进行关键指标的横向对比，复用已有性能采集 API。

#### 功能增强：跨实例性能对比（F-44）

**需求来源：** SRS F-44 跨实例性能对比

已有 `GET /api/monitor/instances/:id/performance` API 支持单实例实时性能采集（Oracle/MySQL/PostgreSQL/达梦）。本次新增独立页面，支持多实例并行采集后进行横向对比分析，帮助 DBA 快速发现性能差异和瓶颈实例。

**核心能力：**
- **实例选择**：多选下拉框，仅列出运行中的实例（支持模糊搜索），至少选择 2 个
- **并行采集**：对选中实例并行调用 performance + waits API，汇总标准化指标
- **指标标准化**：不同数据库类型的指标名映射到统一的对比维度：
  - 缓冲命中率（Oracle: Buffer Cache Hit Ratio / MySQL: InnoDB Buffer Pool Hit Ratio / PG: Buffer Cache Hit Ratio）
  - 活跃会话数、连接数、用户调用/事务数、CPU 使用率等
- **概览卡片**：每个实例一张卡片，展示命中率、活跃会话、连接数、主机 CPU 四项核心指标
- **图表对比**：4 组 ECharts 柱状图（缓冲命中率、活跃会话、连接数、CPU 使用），每根柱子对应一个实例，按实例着色
- **明细表格**：所有指标行 × 实例列的交叉表格
  - 绿色/红色高亮：命中率类指标越高越绿、会话/CPU 类指标越高越红
  - 空值显示为 `-`（该数据库类型不支持此指标）

**前端新增：**
- `PerformanceCompare.vue` 页面：
  - 实例多选 + 开始对比按钮
  - 概览卡片行（4 个实例卡片，每个展示 4 项核心指标）
  - 4 组 ECharts 柱状图对比
  - 指标明细交叉表格（9 行指标 × N 个实例）
- 路由：`/monitor/compare`
- 侧边栏：「性能对比」菜单项（TrendCharts 图标），位于「定时采集观测」之后
- titleMap：`'/monitor/compare': '性能对比'`

**后端 API（已有，无需修改）：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/monitor/instances/:id/performance` | 单实例实时性能采集 | 登录用户 |
| GET | `/api/monitor/instances/:id/waits` | 单实例等待事件 | 登录用户 |
| GET | `/api/monitor/instances` | 实例列表（用于选择） | 登录用户 |

---

### v3.10.0 — 2026-05-28  锁分析（F-41）

> 在 Oracle 实例详情页新增「锁分析」Tab，以可视化锁等待链和明细表格展示阻塞关系，复用已有 `GET /api/monitor/instances/:id/locks` API。

#### 功能增强：锁分析（F-41）

**需求来源：** SRS F-41 锁分析

已有后端 API 查询 Oracle `V$LOCK` 视图，返回持有者（Holder）和等待者（Waiter）的会话信息及等待时间。原前端未展示该数据，本次新增独立 Tab 提供完整的锁分析视图。

**核心能力：**
- **锁等待链可视化**：以 Holder → Waiter 流程图形式展示阻塞关系
  - 红色节点：持有者（SID、用户、程序）
  - 橙色节点：等待者（SID、用户、程序）
  - 箭头标注阻塞时长（分钟）和等待事件
- **无锁提示**：无锁等待时显示绿色成功提示
- **锁等待警告**：有锁等待时显示警告提示，标注锁等待组数
- **锁等待明细表**：
  - 持有者 SID（红色标签）、Serial#、用户、程序
  - 等待者 SID（橙色标签）、Serial#、用户、程序
  - 等待时长（>10 分钟红色，>5 分钟橙色高亮）
  - 等待事件

**前端变更：**
- `InstanceDetail.vue` 新增「⑨ 锁分析」Tab（仅 Oracle 实例显示）
  - 原 AWR 改为 ⑩，操作记录改为 ⑪
- 新增 `loadLocks()` 函数，调用 `monitorApi.locks(id)` 加载锁数据
- 新增 `locks`、`locksLoading` 响应式变量
- 新增锁链可视化 CSS 样式（`.lock-chain`、`.lock-node`、`.lock-arrow`）

**后端 API（已有，无需修改）：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/monitor/instances/:id/locks` | Oracle 锁分析（Holder/Waiter） | 登录用户 |

**数据源（Oracle）：**
- `V$LOCK` — 锁持有和请求信息
- `V$SESSION` — 持有者/等待者的用户名和程序
- 关联条件：`HOLDER.ID1=WAITER.ID1 AND HOLDER.ID2=WAITER.ID2 AND HOLDER.BLOCK=1 AND WAITER.REQUEST>0`

---

### v3.9.0 — 2026-05-28  等待事件分析（F-40）

> 在实例详情页新增「等待事件」Tab，展示等待事件分布图表和完整明细，复用已有 `GET /api/monitor/instances/:id/waits` API。

#### 功能增强：等待事件分析（F-40）

**需求来源：** SRS F-40 等待事件分析

已有后端 API（`exporter.getWaits`）支持 Oracle（V$SYSTEM_EVENT）、MySQL（performance_schema）、PostgreSQL（pg_stat_activity）、达梦四种数据库的等待事件采集。原前端仅在「实时性能」Tab 中展示 Top 5 摘要，本次新增独立 Tab 提供完整分析视图。

**核心能力：**
- **等待类分布饼图**：按 WAIT_CLASS 汇总累计等待时间，直观展示各类等待占比
- **Top 10 横向柱状图**：按累计等待时间排序的前 10 个等待事件，便于快速定位瓶颈
- **完整事件明细表**：所有等待事件的详细数据
  - 等待事件名、等待类（带彩色标签）
  - 总等待次数、超时次数
  - 累计等待时间（>100s 红色，>10s 橙色高亮）
  - 平均等待时间 ms（高亮阈值同上）
  - 超时率（>10% 红色高亮）

**前端变更：**
- `InstanceDetail.vue` 新增「⑧ 等待事件」Tab（原 AWR 改为 ⑨，操作记录改为 ⑩）
- 新增 `loadWaits()` 函数，调用 `monitorApi.waits(id)` 加载完整数据
- 新增 `initWaitCharts()` 函数，初始化 ECharts 饼图（等待类分布）和横向柱状图（Top 10）
- 新增 `waitClassColor()` 辅助函数，按等待类映射标签颜色
- 新增 `waitClassChartRef`、`waitEventChartRef` chart 引用

**后端 API（已有，无需修改）：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/monitor/instances/:id/waits` | 获取实例等待事件列表（Top 15） | 登录用户 |

**数据源：**
- Oracle：`V$SYSTEM_EVENT`（WAIT_CLASS NOT IN Idle/Other，按 TIME_WAITED_MICRO DESC 排序）
- MySQL：`performance_schema.events_waits_summary_global_by_event_name`（按 SUM_TIMER_WAIT DESC）
- PostgreSQL：`pg_stat_activity`（按 wait_event 分组统计）
- 达梦：复用 Oracle 查询逻辑

---

### v3.8.0 — 2026-05-28  SQL 评审系统（F-38）

> 新增 SQL 评审工单系统，支持在线/离线/自助三种评审流程，集成自动审核引擎，实现 SQL 变更的规范化管理。

#### 功能增强：SQL 评审（F-38）

**需求来源：** SRS F-38 SQL 评审流程

提供正式的 SQL 变更评审工单系统，支持在线提交、离线批量、自助评审三种模式，集成自动审核规则引擎（复用 F-31 规则），确保 SQL 变更经过充分评审后方可执行。

**核心能力：**
- **工单管理**：创建/查看/取消评审工单，支持标题、SQL 内容、目标实例、数据库类型、环境（DEV/STAGING/PROD）、来源、优先级、指定审核人
- **三种评审来源**：
  - ONLINE：在线提交，自动触发审核
  - OFFLINE：离线批量提交，人工排队审核
  - SELF：自助评审，开发自测后提交
- **自动审核引擎**：触发后自动执行规则检查（内置规则 + 动态 DDL_AUDIT_RULE），输出评分（0-100）和风险等级（LOW/MEDIUM/HIGH/CRITICAL）
  - 内置规则：NO_SELECT_STAR、WHERE_REQUIRED、NO_DROP_TABLE、NO_TRUNCATE、NO_IMPLICIT_CONVERT、NO_CARTESIAN、LIMIT_WITHOUT_ORDER
  - 性能提示：IN 列表过长、前缀 % 无法使用索引
- **审核流程**：支持通过/拒绝/要求修改三种操作，PROD 环境限制 DBA/ADMIN 审核
- **评论系统**：支持普通评论、系统自动消息（创建、审核结果、状态变更），审核操作自动写入评论
- **状态流转**：PENDING → IN_REVIEW → APPROVED / REJECTED / CHANGES_REQUESTED → CANCELLED
- **统计面板**：待审核数、平均评分、按状态/来源/风险分布

**后端新增 API：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/sql-review/tickets` | 工单列表（分页、状态/来源/优先级筛选） | 登录用户 |
| GET | `/api/sql-review/tickets/:id` | 工单详情（含自动审核结果） | 登录用户 |
| POST | `/api/sql-review/tickets` | 创建评审工单 | 登录用户 |
| POST | `/api/sql-review/tickets/:id/auto-audit` | 触发自动审核 | 登录用户 |
| POST | `/api/sql-review/tickets/:id/review` | 审核操作（APPROVE/REJECT/REQUEST_CHANGE） | 登录用户 |
| POST | `/api/sql-review/tickets/:id/cancel` | 取消工单 | 提交人/ADMIN/DBA |
| GET | `/api/sql-review/tickets/:id/comments` | 获取评论列表 | 登录用户 |
| POST | `/api/sql-review/tickets/:id/comments` | 添加评论 | 登录用户 |
| GET | `/api/sql-review/stats` | 评审统计 | 登录用户 |

**前端新增：**
- `sqlReviewApi`：9 个方法（tickets/ticket/createTicket/autoAudit/review/cancel/comments/addComment/stats）
- 新增 `SQLReview.vue` 页面：
  - 统计卡片：待审核数、平均评分、已通过数、已拒绝数
  - 工具栏：状态/来源/优先级筛选 + 新建工单按钮
  - 工单列表表格：ID、标题、实例、来源、环境、优先级、状态、评分、风险、提交人、评论数、创建时间
  - 新建工单弹窗：标题、SQL 内容、实例、数据库类型、环境、来源、优先级、指定审核人
  - 工单详情弹窗：SQL 内容、自动审核结果（评分/风险/问题列表/性能提示）、审核操作区、评论区
- 侧边栏新增「SQL评审」菜单项（CopyDocument 图标），路由 `/sql-review`
- 授权角色：ADMIN、DBA、OPS、DEV

**数据库迁移：**
- `backend/sql/migration_sql_review.sql`
  - `SQL_REVIEW_TICKET`：评审工单表（IDENTITY 主键、CLOB SQL 内容、MD5 哈希、环境/来源/状态/评分/风险/优先级、提交人/审核人/指定审核人、时间戳）
  - `SQL_REVIEW_COMMENT`：评论表（评论类型：COMMENT/APPROVE/REJECT/REQUEST_CHANGE/SYSTEM）
  - 菜单项 `/sql-review`（sort 32），授权 ADMIN/DBA/OPS/DEV

---

### v3.7.0 — 2026-05-28  AI 告警分析集成（F-20/22）

> 将已有的 RCA 根因分析、异常检测、告警聚类能力集成到告警中心，新增智能优先级排序。

#### 功能增强：AI 告警分析集成（F-20/22）

**需求来源：** SRS F-20 告警关联分析（AI）、F-22 智能优先级排序

将 `ai-ops-agent` 微服务中的 RCA、异常检测、聚类分析能力集成到告警中心，用户可直接从告警列表触发 AI 分析，并新增基于多因素的智能优先级排序。

**核心能力：**
- **RCA 根因分析（F-20）**：在告警列表中点击「RCA」按钮，自动触发根因分析（多指标关联 + 拓扑传播 + LLM 生成结论），结果弹窗展示根因结论、置信度、拓扑传播路径、异常指标点
- **异常检测**：在告警列表中点击「异常」按钮，触发实例异常检测（Z-Score + MAD + Isolation Forest 三算法融合），结果在 AI 面板中展示
- **告警聚类（F-21）**：右侧面板新增「AI分析」Tab，点击「聚类分析」对最近 24h OPEN 告警做向量相似度聚类，减少处理量 60%+
- **智能优先级排序（F-22）**：告警列表新增「优先级」列，基于五因素加权评分：
  - 严重度 (40%)：P1=100, P2=75, P3=50, P4=25
  - 业务影响 (20%)：基于标签（核心=100, 重要=75, 一般=30）
  - 持续时长 (20%)：>2h=100, >1h=80, >30m=60, >10m=40, <10m=20
  - 实例健康分 (10%)：健康分越低优先级越高
  - 依赖影响 (10%)：受影响应用数（基于 CMDB_APP_DB_RELATION 拓扑）
- **右侧面板 AI Tab**：
  - 聚类结果列表（簇 ID、告警数、平均相似度、聚类原因）
  - 最近 RCA 分析结果（点击查看详情）

**后端新增 API：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/alerts/smart-priority` | 智能优先级评分（支持 alertIds 参数） | 登录用户 |

**前端增强：**
- `aiApi` 扩展：新增 `rca`、`rcaList`、`rcaDetail`、`anomalyDetect`、`anomalyList`、`cluster`、`clusterList`、`smartPriority` 8 个方法
- 告警列表新增「优先级」列（数字分数，按 CRITICAL/HIGH/MEDIUM/LOW 着色）
- 告警列表新增「AI」列（RCA 按钮 + 异常检测按钮，带 loading 状态）
- 右侧面板新增「AI分析」Tab（聚类分析 + 最近 RCA 列表）
- 新增 RCA 详情弹窗（根因结论、置信度、拓扑传播路径 el-steps、异常指标点表格）
- 告警详情弹窗增强：支持查看 RCA 分析结果

**关联 Python 微服务（已有，无需修改）：**
- `backend/ai-ops-agent/rca_service.py` — RCA 根因分析
- `backend/ai-ops-agent/anomaly_service.py` — 异常检测（Z-Score + MAD + Isolation Forest）
- `backend/ai-ops-agent/cluster_service.py` — 告警聚类（向量相似度）
- `backend/ai-ops-agent/llm_service.py` — LLM 与 Embedding 服务
- 数据库迁移脚本：`backend/sql/migration_v1_4_ai_analysis.sql`（AI_RCA_RESULT、AI_ALERT_CLUSTER、AI_ANOMALY_RECORD 等表）

---

### v3.6.0 — 2026-05-28  告警抑制（F-17）

> 新增告警抑制系统（ALERT_SUPPRESSION_RULE / ALERT_SUPPRESSION），支持父告警自动抑制子告警，防止告警风暴。

#### 新增功能：告警抑制（F-17）

**需求来源：** SRS F-17 告警抑制（父级触发抑制子级，如主机宕机抑制库告警）

在告警中心新增抑制规则管理和抑制状态展示，当父级资源（主机/数据库实例/集群主节点）产生高级别告警时，自动抑制子级资源（依赖实例/应用/集群备节点）的低级别告警，防止告警风暴。父告警解决后自动解除子告警抑制。

**核心能力：**
- 四种抑制类型：
  - **TOPOLOGY（拓扑级联）**：主机告警抑制该主机上所有实例告警；数据库实例告警抑制依赖该实例的应用告警
  - **CLUSTER（集群抑制）**：集群 PRIMARY 节点告警抑制 STANDBY 节点告警
  - **SEVERITY（级别抑制）**：同实例 P1 告警抑制 P2/P3/P4 告警
  - **INSTANCE（同实例抑制）**：同实例高级别告警抑制低级别告警
- 自动抑制：新告警触发时自动检查是否存在父级告警，命中规则则标记为 SUPPRESSED
- 自动解除：父告警解决后，自动解除被其抑制的子告警（如无其他父告警）
- 手动解除：支持手动解除单条告警的抑制状态
- 批量检测：一键检测所有 OPEN 告警的抑制状态
- 抑制统计：活跃抑制数、已解除数、按类型分布、抑制最多的父告警

**后端新增 API：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/alerts/suppression-rules` | 抑制规则列表（含活跃抑制数） | 登录用户 |
| POST | `/api/alerts/suppression-rules` | 创建抑制规则 | 登录用户 |
| PUT | `/api/alerts/suppression-rules/:id` | 更新抑制规则 | 登录用户 |
| DELETE | `/api/alerts/suppression-rules/:id` | 删除抑制规则 | ADMIN/DBA |
| POST | `/api/alerts/check-suppression` | 检查指定告警是否应被抑制 | 登录用户 |
| POST | `/api/alerts/batch-check-suppression` | 批量检测所有 OPEN 告警 | 登录用户 |
| GET | `/api/alerts/:id/suppressed-by` | 获取抑制此告警的父告警 | 登录用户 |
| GET | `/api/alerts/:id/suppressing` | 获取此告警正在抑制的子告警 | 登录用户 |
| POST | `/api/alerts/:id/unsuppress` | 手动解除抑制 | 登录用户 |
| GET | `/api/alerts/suppression-stats` | 告警抑制统计 | 登录用户 |

**前端增强：**
- 统计卡片新增「已抑制」计数
- 告警列表新增「抑制来源」列，显示命中的抑制规则名
- 已抑制告警操作列新增「解除抑制」按钮
- 告警状态筛选新增「已抑制」选项
- 右侧面板新增「抑制规则」Tab：
  - 抑制规则列表（类型、启用状态、操作）
  - 新增抑制规则弹窗（类型、父/子告警级别、抑制窗口、自动解除开关）
  - 抑制概览（活跃抑制数、已解除数、按类型分布、Top 父告警）
  - 批量检测按钮
- 告警详情弹窗新增抑制信息：
  - 被抑制时显示抑制来源和父告警信息
  - 父告警显示正在抑制的子告警列表

**数据库迁移：**

```bash
sqlplus monitor/oracle@host:1521/sid @backend/sql/migration_alert_suppression.sql
```

该脚本创建 `ALERT_SUPPRESSION_RULE` 和 `ALERT_SUPPRESSION` 两张表，向 `ALERT_RECORD` 追加 `SUPPRESSED_BY_ID`、`SUPPRESSED_AT`、`SUPPRESSION_RULE` 三个字段，向 `SYS_MENU` 插入 `/alerts/suppression` 菜单项（排序22），自动授权 ADMIN、DBA 和 OPS 角色，并预置 4 条默认抑制规则。

---

### v3.5.0 — 2026-05-28  标签分组系统（F-05）

> 新增标签分组系统（CMDB_TAG_GROUP / CMDB_TAG / CMDB_INSTANCE_TAG），支持多维度标签管理、批量打标和按标签筛选实例。

#### 新增功能：标签分组系统（F-05）

**需求来源：** SRS F-05 标签分组系统（业务线/环境/层级标签、批量打标、按标签筛选）

新增标签管理页面 `/cmdb/tags`，支持按业务线、环境、层级、等级等维度对数据库实例进行标签化管理，提供批量打标和按标签筛选实例能力。

**核心能力：**
- 标签分组：按维度管理标签（预置：业务线、环境、层级、等级、自定义），支持增删改查、排序、启用/停用
- 标签管理：每个分组下的具体标签值，支持自定义颜色、描述、排序
- 实例打标：为数据库实例设置多标签（全量替换模式），支持按分组勾选
- 批量操作：多选实例 + 多选标签 → 批量打标 / 批量移除
- 按标签筛选：选择多个标签，支持「任意匹配」(ANY) 和「全部匹配」(ALL) 两种模式
- 统计概览：标签分组数、标签总数、标签关联数、未标记实例数

**后端新增 API：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/tags/groups` | 标签分组列表（含标签数统计） | 登录用户 |
| GET | `/api/tags/groups/:id` | 分组详情 | 登录用户 |
| POST | `/api/tags/groups` | 创建分组 | 登录用户 |
| PUT | `/api/tags/groups/:id` | 更新分组 | 登录用户 |
| DELETE | `/api/tags/groups/:id` | 删除分组（级联删除标签） | ADMIN/DBA |
| GET | `/api/tags` | 标签列表（支持 groupId/groupCode/keyword/status 过滤） | 登录用户 |
| POST | `/api/tags` | 创建标签 | 登录用户 |
| PUT | `/api/tags/:id` | 更新标签 | 登录用户 |
| DELETE | `/api/tags/:id` | 删除标签 | ADMIN/DBA |
| GET | `/api/tags/instance/:instanceId` | 获取实例的所有标签 | 登录用户 |
| POST | `/api/tags/instance/:instanceId` | 为实例设置标签（全量替换） | 登录用户 |
| POST | `/api/tags/batch-assign` | 批量为实例分配标签 | 登录用户 |
| POST | `/api/tags/batch-remove` | 批量移除实例标签 | 登录用户 |
| GET | `/api/tags/instances-by-tag` | 按标签筛选实例（ANY/ALL 模式） | 登录用户 |
| GET | `/api/tags/stats` | 标签统计概览 | 登录用户 |

**前端新增页面：**
- 概览卡片：标签分组数、标签总数、标签关联数、未标记实例数
- 左侧面板：标签分组表格（名称、编码、标签数、状态、编辑/删除）+ 标签列表表格（标签色块、分组、使用数、状态）
- 右侧面板：按标签筛选实例列表
  - 多标签选择器（按分组分组显示）、ANY/ALL 匹配模式切换
  - 批量操作栏：选中实例后可批量打标或批量移除标签
  - 实例状态着色（RUNNING 绿、ERROR 红、其他黄）
  - 单实例打标弹窗：按分组展示 check-tag，已选标签高亮
- 弹窗：新增/编辑分组、新增/编辑标签、实例打标
- 权限控制：所有用户可查看和打标，仅 ADMIN/DBA 可删除分组和标签

**数据库迁移：**

```bash
sqlplus monitor/oracle@host:1521/sid @backend/sql/migration_tag_group.sql
```

该脚本创建 `CMDB_TAG_GROUP`、`CMDB_TAG`、`CMDB_INSTANCE_TAG` 三张表，向 `SYS_MENU` 插入 `/cmdb/tags` 菜单项（排序58），自动授权 ADMIN、DBA 和 OPS 角色，并预置 5 个默认分组和 15 个默认标签。

---

### v3.4.0 — 2026-05-28  应用-数据库依赖关系（F-04）

> 新增应用-数据库依赖关系管理（CMDB_APP / CMDB_APP_DB_RELATION），支持依赖拓扑图可视化与爆炸半径分析。

#### 新增功能：应用-数据库依赖关系（F-04）

**需求来源：** SRS F-04 应用-数据库关系（依赖关系、拓扑图、告警影响面）

新增应用依赖关系管理页面 `/cmdb/app-relation`，支持应用/业务系统的 CRUD 管理、应用与数据库实例的依赖关系配置、ECharts 力导向拓扑图可视化、以及爆炸半径（Blast Radius）影响面分析。

**核心能力：**
- 应用管理：应用/业务系统的增删改查，支持 APP / SERVICE / MICROSERVICE / MIDDLEWARE 等类型
- 依赖关系：应用与数据库实例之间的依赖关系配置，支持 DEPENDS_ON / READS_FROM / WRITES_TO / BACKUP_FOR 类型，区分强/弱/可选依赖
- 依赖拓扑图：ECharts graph 力导向图，展示应用节点（蓝色圆角矩形）与数据库实例节点（按状态着色圆形），连线颜色区分强/弱依赖
- 爆炸半径分析：选择某个数据库实例，展示其影响的所有应用、同集群成员、活跃告警，统计强/弱依赖数和受影响业务线
- 应用影响分析：选择某个应用，展示其依赖的所有数据库实例及状态

**后端新增 API：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/app-relation/apps` | 应用列表（支持 keyword/appType/status 过滤） | 登录用户 |
| GET | `/api/app-relation/apps/:id` | 应用详情 | 登录用户 |
| POST | `/api/app-relation/apps` | 创建应用 | 登录用户 |
| PUT | `/api/app-relation/apps/:id` | 更新应用 | 登录用户 |
| DELETE | `/api/app-relation/apps/:id` | 删除应用（级联删除依赖关系） | ADMIN/DBA |
| GET | `/api/app-relation/relations` | 依赖关系列表 | 登录用户 |
| POST | `/api/app-relation/relations` | 创建依赖关系 | 登录用户 |
| DELETE | `/api/app-relation/relations/:id` | 删除依赖关系 | 登录用户 |
| GET | `/api/app-relation/topology` | 全量拓扑数据（nodes + edges） | 登录用户 |
| GET | `/api/app-relation/blast-radius/:instanceId` | 爆炸半径分析 | 登录用户 |
| GET | `/api/app-relation/app-impact/:appId` | 应用影响分析 | 登录用户 |
| GET | `/api/app-relation/stats` | 统计概览 | 登录用户 |

**前端新增页面：**
- 概览卡片：应用总数、依赖关系数、孤立应用数、未关联实例数
- Tab 1 - 依赖拓扑图：ECharts graph 力导向图
  - 应用节点（蓝色圆角矩形），数据库实例节点（按状态着色：RUNNING 绿、ERROR 红、其他黄）
  - 连线颜色区分强依赖（红色实线）和弱依赖（黄色虚线）
  - 支持拖拽、缩放、邻接高亮
  - 悬停展示应用/实例详细信息
- Tab 2 - 应用管理：应用 CRUD 表格，支持编辑和影响分析
- Tab 3 - 依赖关系：关系列表表格，支持爆炸半径分析
- 弹窗：新增/编辑应用、新增依赖关系、爆炸半径分析、应用影响分析
- 权限控制：所有用户可查看，仅 ADMIN/DBA 可删除应用

**数据库迁移：**

```bash
sqlplus monitor/oracle@host:1521/sid @backend/sql/migration_app_db_relation.sql
```

该脚本创建 `CMDB_APP` 和 `CMDB_APP_DB_RELATION` 两张表，向 `SYS_MENU` 插入 `/cmdb/app-relation` 菜单项（排序57），并自动授权 ADMIN、DBA 和 OPS 角色。

**关联需求：** 本功能为以下需求提供数据基础：
- F-17 告警抑制：基于依赖拓扑判断父级-子级关系
- F-20 告警关联分析：基于影响范围进行关联分析
- F-22 智能优先级排序：基于业务影响进行优先级排序
- F-54 根因分析（拓扑传播）：基于 CMDB 拓扑判断上游传导

---

### v3.3.0 — 2026-05-28  集群拓扑管理（F-03）

> 新增集群拓扑管理（CMDB_CLUSTER / CMDB_CLUSTER_MEMBER）完整 CRUD 页面与 ECharts 拓扑可视化。

#### 新增功能：集群拓扑管理（F-03）

**需求来源：** SRS F-03 集群拓扑管理

新增独立的集群拓扑管理页面 `/cmdb/clusters`，支持 Oracle RAC、Data Guard、MySQL MGR、PXC、Patroni 等集群类型的可视化拓扑展示与成员管理。

**后端新增 API：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/cmdb/clusters` | 集群列表（含成员数统计） | 登录用户 |
| GET | `/api/cmdb/clusters/:id` | 集群详情（含成员实例列表） | 登录用户 |
| POST | `/api/cmdb/clusters` | 创建集群 | ADMIN/DBA |
| PUT | `/api/cmdb/clusters/:id` | 更新集群 | ADMIN/DBA |
| DELETE | `/api/cmdb/clusters/:id` | 删除集群（级联删除成员） | ADMIN/DBA |
| POST | `/api/cmdb/clusters/:id/members` | 添加集群成员 | ADMIN/DBA |
| DELETE | `/api/cmdb/clusters/:id/members/:instanceId` | 移除集群成员 | ADMIN/DBA |

**前端新增页面：**
- 概览卡片：集群总数、RAC 集群数、DG 集群数、其他类型数
- 左侧面板：集群列表表格（名称、类型、状态、成员数、编辑/删除操作）
- 右侧面板：ECharts graph 力导向拓扑图
  - 集群中心节点（圆角矩形，蓝色）
  - 成员实例节点（圆形，按角色着色：PRIMARY 红、STANDBY 黄、READONLY 绿）
  - 节点大小按角色区分，悬停展示实例详情
  - 支持拖拽、缩放、邻接高亮
- 成员列表：实例名、类型、IP、角色、状态、健康分
- 弹窗：新建/编辑集群、添加成员（从已有实例中选择）
- 权限控制：仅 ADMIN/DBA 可增删改

**数据库迁移：**

```bash
sqlplus monitor/oracle@host:1521/sid @backend/sql/migration_cluster_topology.sql
```

该脚本创建 `CMDB_CLUSTER` 和 `CMDB_CLUSTER_MEMBER` 两张表，向 `SYS_MENU` 插入 `/cmdb/clusters` 菜单项（排序56），并自动授权 ADMIN 和 DBA 角色。

---

### v3.2.0 — 2026-05-28  主机管理（F-02）& Bug修复

> 新增主机管理（CMDB_HOST）完整 CRUD 页面，修复前后端多个安全和功能缺陷。

#### 新增功能：主机管理（F-02）

**需求来源：** SRS F-02 主机与容器管理

新增独立的主机管理页面 `/cmdb/hosts`，支持对物理机、虚拟机、K8s Pod 等主机资产进行全生命周期管理。

**后端新增 API：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/cmdb/hosts` | 主机列表（支持 keyword/status/datacenter 过滤） | 登录用户 |
| POST | `/api/cmdb/hosts` | 创建主机 | ADMIN/DBA |
| PUT | `/api/cmdb/hosts/:id` | 更新主机 | ADMIN/DBA |
| DELETE | `/api/cmdb/hosts/:id` | 删除主机（有关联实例时禁止删除） | ADMIN/DBA |

**前端新增页面：**
- 概览卡片：主机总数、在线、离线、数据中心数
- 工具栏：关键字搜索、状态筛选、数据中心筛选
- 表格：主机名、IP、OS、CPU、内存、数据中心、状态、创建时间
- 表单：新增/编辑主机（必填：主机名、IP地址）
- 删除：二次确认，有关联实例时阻止删除
- 权限控制：仅 ADMIN/DBA 可增删改

**数据库迁移：**

```bash
sqlplus monitor/oracle@host:1521/sid @backend/sql/migration_host_management.sql
```

该脚本向 `SYS_MENU` 插入 `/cmdb/hosts` 菜单项（排序55），并自动授权 ADMIN 和 DBA 角色。

#### Bug 修复

**前端修复：**

| 文件 | 问题 | 修复 |
|------|------|------|
| `api/index.js` | 错误提示乱码（mojibake） | 修复为正确的中文提示 |
| `stores/auth.js` | 空 menus 数组导致权限越界 | 空菜单时拒绝访问 |
| `MainLayout.vue` | setInterval 未清理导致内存泄漏 | onUnmounted 清除定时器 |
| `Dashboard.vue` | ECharts 实例和 resize 监听器未清理 | dispose 和移除监听器 |
| `InstanceDetail.vue` | loadBasic() 被调用两次 | 仅采集成功后刷新 |
| `Profile.vue` | 表单无验证、保存无错误处理 | 添加邮箱/手机号验证和 try-catch |
| `AlertCenter.vue` | ack/resolve 无错误处理 | 添加 try-catch |
| `UserManagement.vue` | 密码重置无错误处理 | 添加 try-catch |
| `RoleManagement.vue` | 删除角色无错误处理 | 添加 try-catch |

**后端修复：**

| 文件 | 问题 | 修复 |
|------|------|------|
| `routes/alerts.js` | 缺少 DELETE 规则端点、无状态检查 | 添加删除端点和状态校验 |
| `routes/auth.js` | 管理员重置密码无强度检查 | 添加8位+大小写+数字校验 |
| `routes/monitor.js` | Kill 会话 SQL 注入风险 | 添加 sid/serial 正整数校验 |

**Python 微服务修复：**

| 文件 | 问题 | 修复 |
|------|------|------|
| `ai-ops-agent/db_service.py` | insert_returning_id 返回 list 而非 int | 提取 getvalue() 首元素 |
| `ai-ops-agent/rag_service.py` | _split_chunks(None) 崩溃；用户消息错误记录 LLM 模型 | 添加 None 防护；用户消息不写 LLM_MODEL |

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
