# 代码审查报告逐项处理说明（2026-11-12）

对应审查报告：《DIOps-sql-insight 全工程代码审查报告》（31 项 P0、约 70 项 P1、10 类 P2）。
每一项都先对照源码确认是否属实，再处理。结论分三种：

- **已修复**：问题属实，已改代码（必要时附带测试）。
- **不适用 / 部分属实**：与代码实际情况不符，或风险比描述小；写明原因与是否仍做了加固。
- **暂缓**：属实，但改动面大或需要部署侧配合，本次未做，写明原因与建议。

升级须知（部署侧必须做的事）见文末「升级步骤」。

---

## 一、P0

| # | 位置 | 结论 | 处理 |
|---|---|---|---|
| 1 | automation.js HA 预检 `STATUS !== 'ACTIVE'` | 已修复 | 接受 `RUNNING / ACTIVE / NORMAL`；预检异常按“不健康”处理，不再放行 |
| 2 | 回滚不执行 ROLLBACK_SQL | 已修复 | 读取完整 CLOB → 抢占 `ROLLING_BACK` → 在目标库按事务执行；失败恢复原状态并返回错误。没有回滚 SQL 时必须勾选“人工回滚已完成”才能标记（前端已加确认框） |
| 3 | `_auditRulesCache` 未定义 | 已修复 | DDL 规则接口与页签已删除（审核规则统一在「SQL 洞察 → 规则配置」），页签改为指引说明 |
| 4 | 发布执行无幂等锁 | 已修复 | `UPDATE … SET STATUS='EXECUTING' WHERE STATUS=:原状态` 抢占，0 行返回 409 |
| 5 | 标签全量替换无事务 | 已修复 | 新增 `db.withTransaction`，DELETE + executeMany 同一事务 |
| 6 | 自审自批 | 已修复 | 所有环境都要求 ADMIN/DBA；提交人不能 APPROVE；只有待审状态可审，条件更新防并发 |
| 7 | Node 不回查用户状态 / 撤销 | 已修复 | Java 网关对每个带 token 的 /api 请求回查：吊销、禁用、改密时间（`PWD_CHANGED` 之前签发的 token 失效），平台库不可用时拒绝（不再放行）；转发给 Node 时附加 HMAC 签名的网关头，Node 校验签名，`DIOPS_REQUIRE_GATEWAY=true` 时拒绝绕过网关的请求 |
| 8 | 无事务 API | 已修复 | `db.withTransaction(fn)`（`tx.execute / tx.executeMany`，autoCommit=false，异常回滚） |
| 9 | 巡检连库失败仍 ok=True | 已修复 | 连接失败直接返回 `ok: False` 与原因，不再生成空白报告 |
| 10 | 恢复超时/启动失败标 SUCCESS | 已修复 | 超时、脚本失败、没有脚本、bash 不可用一律 FAILED 并写明原因；MySQL/PG 的 PITR、MySQL 单表恢复原脚本只打印“OK”什么也没做，改为明确提示需人工执行（退出码 3） |
| 11 | spawnSync 阻塞事件循环 | 已修复 | Python Word 报告改为异步 spawn（超时杀进程组）；bash 探测结果缓存 |
| 12 | 部署参数命令注入 | 已修复 | SHELL 步骤参数改为环境变量 `DIOPS_P_<名>` 传入、命令里引用 `"${DIOPS_P_x}"`；SQL/检查步骤参数白名单字符；超时杀整个进程组。单测覆盖 |
| 13 | 自定义指标只读校验是黑名单 | 已修复 | 各库只读事务（Oracle `SET TRANSACTION READ ONLY`、MySQL `START TRANSACTION READ ONLY`、PG `BEGIN READ ONLY`、SQL Server 回滚）+ 语句超时 15s + 最多 100 行，函数黑名单保留为第二道防线；`/execute` 全部写审计日志 |
| 14 | 凭据仅 Base64 | 已修复 | Java/Node 统一 AES-256-GCM（`AESGCM:v1:`，密钥 `DBOPS_SECRET_KEY`），Java 启动时把存量 Base64 迁移为密文；两端互通有单测 |
| 15 | SQL 洞察无界队列 | 已修复 | 有界队列（2000）+ 同一“任务类型+实例”排队中不重复入队，满了本轮跳过 |
| 16 | DeltaEngine 按实例分钟数除 | 已修复 | 按“该 SQL 上次出现时间”计算窗口长度；跨多个周期的窗口标 PARTIAL，不进基线。单测覆盖 |
| 17 | DiagnosisService inFlight 泄漏 | 已修复 | 改 AbortPolicy，拒绝时移出 inFlight |
| 18 | queryQuietly 返回 null 导致 NPE | 已修复 | 新增 `TargetDb.queryOrEmpty`，报告列出的 6 处全部改用；其余调用方本来就判空，保持不变 |
| 19 | explain 无语句白名单 / SQL Server 执行用户 SQL | 已修复 | 只对 SELECT/INSERT/UPDATE/DELETE/MERGE 取计划（SQL Server 只允许 SELECT）；以 EXPLAIN/ANALYZE/SET/EXEC/CALL/BEGIN 等开头的文本直接拒绝（防 PG/磐维 `EXPLAIN ANALYZE DELETE` 真执行）；/explain 与审核内的实例检查都走同一校验 |
| 20 | 函数包裹列改写遇绑定变量改变占位符 | 已修复 | 只有比较值是“不带时间的日期常量”时才自动改写，绑定变量/列/带时分秒的 TO_DATE 只给建议。单测覆盖 |
| 21 | ai-ops CORS * + 回环信任 | 已修复 | 去掉 CORS；必须携带内部令牌（`AI_INTERNAL_TOKEN`，start-all 自动生成）；未配置令牌时只接受本机且拒绝一切浏览器请求（带 Origin / Sec-Fetch-Site） |
| 22 | EMBED_MODEL 回退到生成模型 | 已修复 | 必须显式配置，缺失时启动告警、入库报明确错误 |
| 23 | sql-optimizer 无鉴权 / SSRF / 阻塞事件循环 | 已修复 | 内部令牌中间件、去 CORS；数据库地址拒绝云元数据/链路本地，可用 `SQL_OPT_ALLOWED_HOSTS` 限定白名单；LLM base_url 只允许白名单；DB 调用全部 `asyncio.to_thread` |
| 24 | 用户所选模型被忽略 | 已修复 | `llm_config.model` 生效 |
| 25 | Profile.vue profileRef 未声明 | 已修复 | |
| 26 | faultForm 无 instanceIds | 已修复 | 加“适用实例”多选（按库类型过滤，HA 故障转移必选）；后端编辑也能修改适用实例 |
| 27 | 同源 iframe 可读 token | 部分修复 | iframe 内的 LLM 输出改为“原始 HTML 一律转义 + 白名单清洗”（去脚本、事件属性、javascript: 链接），堵住提示注入→XSS→盗 token 的路径；iframe 加 sandbox。**彻底隔离需独立域名或 httpOnly Cookie，暂缓（见 P2-8）** |
| 28 | nginx /api 统一 30s | 已修复 | 长任务 location 300s；知识库入库 600s；`/api/sql-agent/` 关闭缓冲（SSE）600s |
| 29 | 无 client_max_body_size | 已修复 | 50m |
| 30 | init.sql FAULT_EXEC_LOG 缺 HA_CORRELATION_ID | 已修复 | 合入建表语句 |
| 31 | init.sql 缺 ASSET_ID | 已修复 | SQL_AUDIT_RECORD / SQL_REVIEW_TICKET 合入 ASSET_ID 与索引；CMDB_HOST 补齐 SSH_* 列；DB_PASSWORD 加长到 1024；已有库执行 `migration_security_fixes.sql` |

## 二、P1

### Node 路由层
| 位置 | 结论 | 处理 |
|---|---|---|
| app.js `/api/sql-agent/api` 未鉴权 | 已修复 | 挂到 authMiddleware 之后；代理到 Python 时附加内部令牌、去掉客户端自带的内部头 |
| app.js async rejection | 已修复 | `utils/asyncErrors.js` 把 async 路由的 rejection 交给 `next(err)`（npm 仓库不可用，未引入 express-async-errors，实现等价）；加 unhandledRejection / uncaughtException 兜底 |
| security.js Origin 缺 3000 | 已修复 | |
| security.js 登录限流挂错位置 | 已修复 | 去掉 Node 侧无效限流；Java RateLimitFilter 负责（并修了 contextPath 问题） |
| automation.js 巡检分页拼接 | 已修复 | `db.toPageInt` 转整数并限范围 |
| automation.js 策略脚本截断 4000 | 已修复 | 列表返回完整 CONDITION_JSON / ACTION_SCRIPT |
| HA 命令发给故障旧主节点 / shell 无法执行 | 已修复 | 计划切换在目标节点执行（`execOn=SOURCE` 可指定源节点，故障转移永远不在旧主执行）；shell 命令经 SSH 在实例所在主机执行（参数走环境变量，要求 known_hosts）；失败写 FAILED 记录 |
| 内置修复 SQL 多语句 | 已修复 | 统一用 `utils/sqlScript.runScript` 逐条执行（事务内），失败指出第几条 |
| 容量预测硬编码假数据 | 已修复 | 用最近 60 天快照做线性回归，少于 5 天数据不预测，置信度 = R²，磁盘上限取实际总量 |
| DDL_AUDIT_RULE 死功能 | 已修复 | 同 P0-3 |
| customMetrics `/execute` 绕过拦截与审计 | 已修复 | 同 P0-13，并写审计 |
| PUT 部分更新清空字段（customMetrics/appRelation/serviceCatalog 等） | 已修复 | `utils/partialUpdate.partialSet` 只更新请求中出现的字段；自定义指标用“出现标志”区分“没传”和“清空” |
| outBinds 少取一层 | 已修复 | serviceCatalog / sqlOptHistory / sqlReview 改 `[0][0]` |
| sqlWorkbench 无超时 / 全量取回 | 已修复 | 各驱动语句超时；查询包一层限 501 行（判断截断）；达梦 schema 查询限 500 行 |
| deploy.js 取消后被覆盖 | 已修复 | 终态写入带 `WHERE STATUS IN ('PENDING','RUNNING')` |
| ai.js 上传端口写死 80 | 已修复 | |
| sqlOptHistory createdBy 取自请求体 | 已修复 | 取 token 中的用户 |

### Node 服务层
| 位置 | 结论 | 处理 |
|---|---|---|
| sqlInsightClient JWT 回退 / 用户缓存错误 | 已修复 | 按身份分别缓存；签发统一走 auth.js（弱密钥直接拒绝启动） |
| Base64 密码 / 命令行明文密码 / 连接无超时 | 已修复 | 见 P0-14；备份恢复脚本密码改为 `MYSQL_PWD` / `PGPASSWORD` / `SQLCMDPASSWORD` 环境变量、Oracle/达梦用 600 权限的临时 parfile 或 here-doc 内 CONNECT；巡检配置文件 600 权限；Oracle/MySQL 连接超时 20s |
| MySQL/PG 缺脚本回退 rman | 已修复 | 不再回退 |
| 超时只杀 bash | 已修复 | detached + 杀进程组 |
| 模拟备份写假 SUCCESS / reload 先清后查 | 已修复 | 删除模拟备份与模拟空间巡检；reload 先查完再对比，表达式未变的任务保留，不再每 90 秒重建 |
| 批次默认巡检实例 1 | 已修复 | 未配置实例直接报错；非 Oracle 跳过记为 SKIPPED（原来记“PASS 100 分”） |
| inspectTaskRun TOCTOU | 已修复 | 检查与占用之间无 await；另加库级条件更新占用（多节点 / 定时与手工并发） |
| 容量伪指标 | 已修复 | 只保留可测量的值，测不到的为空，不再用公式冒充 |
| MySQL/PG 表空间 USED_PCT 恒 100；达梦 execute count 冒充速率 | 已修复 | 无上限的库不填总量/使用率；达梦改为累计计数指标 |
| inspectScriptExecutor 拆碎 PL/SQL | 已修复 | 统一用 `sqlScript.splitSql`（识别引号、注释、`$$`、PL/SQL 块与 `/` 结束符） |
| systemConfig.set 只 UPDATE | 已修复 | MERGE |

### Java（非 sqlinsight）
| 位置 | 结论 | 处理 |
|---|---|---|
| AuthFilter 平台库异常时跳过回查 | 已修复 | 缓存最多沿用 5 分钟，再久无法回查即返回 503 |
| RateLimitFilter 未去 contextPath | 已修复 | |
| SSH StrictHostKeyChecking 默认关闭；MySQL useSSL=false | 已修复 | 默认校验主机指纹（未单独配置 known_hosts 时用运行账号的 `~/.ssh/known_hosts`，`MONITOR_SSH_STRICT_HOST_KEY=false` 可关闭）；MySQL 改为 `sslMode=PREFERRED`，可设 `DBOPS_MYSQL_SSL_MODE=REQUIRED` |
| LicenseService 防回拨 HMAC 可推导 | 已修复 | 密钥混入服务器环境变量 `DBOPS_SECRET_KEY`（无则 JWT_SECRET）；旧记录校验通过后自动用新算法重签。注：平台库管理员仍可删除该记录让检测“重新开始”，这是库内记录方案的固有限制 |
| AlertController updateRule / updateSilenceRule 覆盖为 NULL | 已修复 | 通知字段与静默时间窗等只在请求带了该字段时更新，其余沿用库中旧值 |
| 改密/重置密码不吊销 token | 已修复 | 写 PWD_CHANGED 并清网关用户缓存，旧 token 立即失效 |
| CmdbController checkHost 无角色 / 审计 / 未取消 future | 已修复 | ADMIN/DBA/OPS；写审计；命中或超时后取消剩余探测 |
| LegacyProxy URI 未编码 | 已修复 | 非法 URI 返回 400；去掉客户端伪造的网关头 |
| jwt-secret 空串 + 开发回退已知密钥 | 已修复 | 弱/空密钥拒绝启动（`DBOPS_ALLOW_WEAK_SECRET=true` 时用随机密钥，仅限开发）；start-all 自动生成强密钥写入 backend/.env |
| AlertController 多个 POST 无角色校验 | 已修复 | apply-policies / check-suppression / batch-check-suppression / check-silence / batch-check-silence 要求 ADMIN/DBA/OPS |

### Java sqlinsight
| 位置 | 结论 | 处理 |
|---|---|---|
| AnomalyDetector ratio=Infinity | 已修复 | 倍率封顶 999，是否告警仍由 Z 分数与绝对变化量决定；单测覆盖 |
| AnomalyService 持续性窗口按 60s；null 覆盖 | 已修复 | 按配置的采集间隔回看；本窗口无值时保留原 RATIO/Z_SCORE |
| DeltaEngine.forget 与注释矛盾 | 已修复 | 行为保留（失败期间的增量不可知，重新从基线开始是正确的），注释改正 |
| SqlCollectService 探测失败缓存 6 小时；时区 | 已修复 | 失败只缓存 5 分钟；所有与 JVM 写入的 WINDOW_START 比较改用 LOCALTIMESTAMP（会话时区=JVM 时区），不再混用库端 SYSTIMESTAMP |
| StatsRepo MERGE 无 WHEN MATCHED | 已修复 | 同一窗口重复写入以最新为准 |
| SessionSampler MySQL 锁等待 | 已修复 | 读 `sys.innodb_lock_waits`，5.6/5.7 回退 `information_schema.innodb_lock_waits` |
| SlowSqlService DBMS_LOB.INSTR | 已修复 | 改为在前 4000 字符内 `INSTR(LOWER(DBMS_LOB.SUBSTR(…)))`，不再对 CLOB 生成临时 LOB |
| CauseClassifier 优先级 | 部分属实 | 原式 `a && b \|\| c && b` 按 Java 优先级与设计一致，结果没错；已加括号写清楚。I/O 等待维度未接入（恒 NaN）属实，**暂缓**：需要先采集实例级 I/O 等待基线 |
| StaticRuleEngine `a.x+1=a.y` 误报 / SET 子句不遍历 | 已修复 | 另一侧是同表列时跳过；UPDATE 的 SET 子句纳入检查。MERGE 的 WHEN 子句未遍历，**暂缓**（Druid 各版本 AST 结构不同，需对照实际依赖版本实现） |
| RewriteEngine NOT IN / 数字→字符 | 已修复 | 子查询带 LIMIT/FETCH/ROWNUM 不改写；数字→字符只给建议 |
| ProblemService SKIPPED 唯一索引 | 已修复 | 先关闭能力已恢复规则的 SKIPPED 记录，再写本窗口命中 |
| AlertBridge ERROR→P3 | 已修复 | ERROR 映射 P2（规则本身为 P1 时 P1） |
| InstanceDirectory 未命中每次 reload | 已修复 | 未命中最多 5 秒刷新一次 |
| BaselineService 先删后插无事务 | 已修复 | 同一事务 |
| 人工关闭问题不恢复告警 | 已修复 | 与自动恢复一致 |
| RuleConfigService reload 异常不更新 loadedAt | 已修复 | 失败 30 秒后重试，期间沿用旧规则 |

### Python
| 位置 | 结论 | 处理 |
|---|---|---|
| ai-ops 身份头可伪造；全部 HTTP 200 + 原始异常 | 已修复 | 身份头只信任携带内部令牌的平台请求（Node 转发时覆盖该头）；错误返回真实状态码，未预期异常只回错误编号、详情写日志 |
| ai-ops `_ensure_pool` 竞态 | 已修复 | 双重检查加锁；新增 close_pool（shutdown 时关闭） |
| rag add_document 半索引 / 串行 embedding | 已修复 | 先并发（默认 4）完成全部向量化再写库，写库失败删除已写部分 |
| RCA 失败仍回“分析完成” | 已修复 | 写 FAILED 记录后返回 502 与 rca_id |
| opt db_service 连接泄漏 / 表名拼接 / 前导注释误拒 / 拼 EXPLAIN | 已修复 | try/finally 关闭；表名转义与参数化；去注释后判断；拒绝多语句与 EXPLAIN 前缀；PG/MySQL 只读会话 |
| opt embedding 回退哈希伪向量 | 已修复 | 失败抛错（仅 `ALLOW_HASH_EMBEDDING=1` 调试时允许） |
| opt sessions 无界 / 不绑定用户 / 覆写 system | 已修复 | 按“用户+会话”隔离，最多 500 个、每个保留 20 轮、2 小时过期；system 消息每次请求单独拼 |
| explain_analyzer SQL Server 用 PG 解析器 | 已修复 | 新增 SHOWPLAN_TEXT 解析（Table Scan / Index Scan / Key Lookup / Sort） |
| Milvus/PgVector 空壳 | 部分修复 | 配置后启动时明确告警“尚未实现”。实现本身**暂缓**（需引入 pymilvus / pgvector 依赖与部署） |
| （附带）优化记录保存恒失败 | 已修复 | 审查未列出：Python 调 Node `/api/sql-opt/save` 不带令牌，一直 401；现在转发当前用户的令牌 |

### 前端
| 位置 | 结论 | 处理 |
|---|---|---|
| WebSQL formatSql 改坏字符串 | 已修复 | 先切分代码/字符串/注释，只格式化代码部分 |
| allowDangerous 无二次确认 | 已修复 | 执行含写操作/DDL 的语句前弹确认（显示实例名与语句类型） |
| InstanceDetail 图表泄漏、雷达图死代码 | 已修复 | onBeforeUnmount 释放全部图表；删除雷达图死代码 |
| nginx 安全头不继承 | 已修复 | 每个自带 add_header 的 location 重复安全头，加 `always` |
| nginx 无 /api/sql-agent | 已修复 | |
| AlertCenter 死代码；翻页先全量 applyPolicies | 已修复 | 删除；列表接口本身按时间节流应用策略 |
| SQLReview 筛选不重置页码 | 已修复 | |
| ServiceCatalog 无重新打开 | 已修复 | CLOSED/REJECTED → OPEN（前后端一致），状态变更带条件更新；按钮文字按目标状态显示 |
| AppDbRelation resize 监听累积 | 已修复 | 只注册一次；tooltip 转义 |
| UserManagement 无防抖 | 已修复 | 300ms 防抖 + 请求序号 |
| Login 无条件 clearSession | 已修复 | 只在被踢回登录页（带 reason）或 token 过期/损坏时清理；有效登录直接回原页面 |
| stores/auth JSON.parse | 已修复 | 损坏时丢弃并按未登录处理 |
| AIAnalysis v-html & 未转义 | 已修复 | 先转义 `&` 再转义尖括号与引号 |
| API 全局 30s 超时 | 已修复 | 长任务 300s，知识库入库 600s（与 nginx 一致） |
| `code!==200` 统一 reject 使 else 分支成死代码 | 不适用 | 属代码风格问题，不影响功能；统一 reject 是有意设计（错误提示集中处理），未改 |

## 三、P2（下迭代）

| # | 内容 | 结论 |
|---|---|---|
| 1 | 多租户未使用 | **暂缓**：需要全量梳理 Node/Java 查询加租户条件并补数据迁移，属独立需求 |
| 2 | 普遍无 CAS | 部分完成：发布执行/回滚、评审、服务工单、部署取消、巡检任务占用已改为条件更新；其余低风险接口暂缓 |
| 3 | 错误详情回显 | 部分完成：Python 服务已脱敏；Node 路由 `msg: e.message` 量大，暂缓（建议在生产统一由错误中间件脱敏） |
| 4 | 凭据链路 / TLS | 大部分完成：凭据加密、命令行不带密码、SSH 指纹校验、MySQL TLS PREFERRED；SQL Server `encrypt=false` 未改（多数内网 SQL Server 无受信证书，强制会连不上），可按需配置 |
| 5 | 时区口径 | 部分完成：SQL 洞察窗口比较已统一；全链路 UTC 化暂缓 |
| 6 | 内存残留 | 暂缓 |
| 7 | 角色口径分散 | 暂缓（建议集中权限表） |
| 8 | Token 存 localStorage | 暂缓：根治需改 httpOnly Cookie + CSRF 防护，前后端与网关都要改。本次已堵住已知的两个放大点（iframe 内 XSS、AIAnalysis v-html） |
| 9 | 脚本/依赖 | 部分完成：init.sql 缺列已直接合入；sql-optimizer 增加 python-dotenv 上界。build_init_sql.py 加断言暂缓 |
| 10 | 前端工程化（lint/test） | 暂缓 |

---

## 升级步骤

1. **执行迁移**：`backend/sql/migration_security_fixes.sql`（可重复执行）。
2. **配置密钥**：用 `start-all.sh` / `start-all.bat` 启动时会自动生成 `JWT_SECRET`、`DBOPS_SECRET_KEY`、`AI_INTERNAL_TOKEN` 写入 `backend/.env`。手工部署须自行配置这三项（各 32 字节以上随机值）。
   - **`DBOPS_SECRET_KEY` 必须备份**：被管库密码、SSH 口令/私钥用它加密，丢失后只能逐个重新录入。
   - 首次以新版本启动 Java 服务时，会把库里存量的 Base64 密码自动改为密文（日志 `[secrets] migrated …`）。
3. **SSH 主机指纹**：默认校验。在平台服务器上执行 `ssh-keyscan -H <主机IP> >> ~/.ssh/known_hosts`（运行 Java 与 Node 的账号），或设置 `MONITOR_SSH_KNOWN_HOSTS` / `DBOPS_SSH_KNOWN_HOSTS` 指向文件；仅内网测试可设 `MONITOR_SSH_STRICT_HOST_KEY=false`、`DBOPS_SSH_STRICT=false`。
4. **AI 服务**：知识库需配置向量模型 `EMBED_MODEL`（如 `nomic-embed-text`）。SQL 优化页面连接的目标库地址可用 `SQL_OPT_ALLOWED_HOSTS` 限定；自定义 OpenAI 兼容地址需加入 `LLM_OPENAI_BASE_URL_ALLOWLIST`。
5. **nginx**：替换为新的 `nginx.conf`（长任务超时、上传 50m、安全头、`/api/sql-agent`）。
6. **可选**：确认所有请求都经 Java 网关后，可设 `DIOPS_REQUIRE_GATEWAY=true`，让 Node 拒绝直连请求。

## 验证情况（如实说明）

- Java：本环境无法联网下载 Maven 依赖，用本地桩类编译全部源码并运行 101 个单元测试，全部通过（新增 Secrets 与 Node 互通、Delta 行级窗口、倍率封顶、改写安全性等用例）。**未执行 `mvn package`。**
- Node：所有改动文件 `node --check` 通过；`npm test`（`backend/test/fixes.test.js`）覆盖语句切分、AES-GCM、部分更新、部署参数注入，4 项通过。
- Python：全部 `py_compile` 通过；两个 Agent 用 FastAPI TestClient 验证了令牌拦截、浏览器请求拦截、SSRF 拦截与多语句拒绝。
- 前端：`vite build` 成功；Playwright 回归页面无报错，并验证了故障策略“适用实例”、登录页不再踢掉有效会话、本地 user 数据损坏不白屏。
- nginx：`nginx -t` 通过。
- **未连接真实 Oracle/MySQL/PG/达梦/SQL Server 与真实 SSH 主机**：回滚执行、HA SSH 切换、备份恢复脚本、迁移 SQL 需在测试环境实际跑一遍。
