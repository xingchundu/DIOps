# 代码审查与缺陷修复报告

> 范围：后端 Node.js（重点：认证/RBAC/系统配置/CMDB/监控采集/告警，其余模块做了针对性扫描），以及新建的 Java 后端 `dbops-server`。
> 标记说明：**Node** = 已在原 Node 代码中修复；**Java** = 在 Java 版中修复（Java 接管该模块后 Node 版对应代码不再运行）。

## 一、严重（影响正确性 / 安全 / 可用性）

| # | 问题 | 位置 | 影响 | 修复 |
|---|------|------|------|------|
| 1 | 分页参数是字符串，`offset + size` 变成字符串拼接；且直接拼进 SQL | `config/db.js` queryPage | 所有分页列表第 2 页起一次返回上千行（page=2,size=20 → `ROWNUM <= 2020`）；有注入风险 | Node + Java：转成受限整数（size≤500），Java 用绑定变量 |
| 2 | node-oracledb 位置绑定按“出现次数”计数，同一 `:1` 出现两次只给一个值 → NJS-098 | 7 处，见下 | 功能静默失效 | Node：改命名绑定/补齐参数；Java：JDBC `?` 天然无此问题 |
| 2a | └ 慢 SQL 采集 MERGE | `routes/sql.js` | 异常被 `.catch` 吞掉，慢 SQL 从未入库却提示“成功采集 N 条” | Node |
| 2b | └ 容量预测 MERGE | `routes/automation.js` | “生成预测”报错（README v3.23 称已修复，实际仍是重复占位符） | Node |
| 2c | └ 慢 SQL 导入审核 | `routes/automation.js` | 导入报错 | Node |
| 2d | └ 批量打标签 | `routes/tagGroup.js` | 全部失败且被吞掉 | Node |
| 2e | └ 应用关系-同集群实例 | `routes/appRelation.js` | 接口报错 | Node |
| 2f | └ 主机关键字搜索 | `routes/cmdb.js` | 搜索报错 | Node + Java |
| 2g | └ 告警抑制关系 / 静默日志 / 集群抑制 | `routes/alerts.js` | 抑制关系从未写入 → 父告警解决后子告警**永远停在 SUPPRESSED**；集群抑制从未生效 | Node + Java |
| 3 | 告警去重只判断 `STATUS='OPEN'` | `monitorAlertEvaluator.js` | 告警被确认/静默/抑制后，下一轮采集（90s）又插入一条 → **告警风暴** | Node + Java |
| 4 | 实例连不上时不做告警评估 | `monitorCollectPersist.js` | **数据库宕机不告警** | Java：不可达时 `db_reachable=0` 参与评估；新增默认规则「数据库实例不可达」 |
| 5 | 只对 ORACLE / PANWEI 评估告警 | `monitorCollectPersist.js` | MySQL/PG/达梦/SQL Server/GoldenDB 配了规则也永远不触发 | Java：全部类型评估，所有 exporter 指标名均可作为规则 METRIC |
| 6 | `init.sql` 种子规则的指标名（`tablespace_usage_pct`/`db_active_sessions`/`oracle_buffer_cache_hit`）从未被采集产出 | `sql/init.sql` vs 采集代码 | 默认规则永远不触发 | Java：补别名映射 |
| 7 | `ALERT_RULE.DURATION`（持续分钟）完全未使用 | `monitorAlertEvaluator.js` | 一次抖动就告警 | Java：连续满足 DURATION 分钟才触发 |
| 8 | 指标恢复后告警不会自动关闭 | 同上 | 告警只增不减 | Java：自动 RESOLVED（`RESOLVE_BY=SYSTEM`），`alert.auto_resolve=0` 可关闭 |
| 9 | JWT 密钥缺省 `'dbops_secret'` | `middleware/auth.js` | 未配置时任何人可伪造 ADMIN token | Node + Java：生产模式拒绝启动 |
| 10 | 只验签不查库 | `middleware/auth.js` | 账号禁用/降权后旧 token 8 小时内仍有效 | Java：30s 缓存回查用户状态与角色 |
| 11 | `spawnSync` 执行备份/部署脚本 | `backupRestoreRunner.js` `deployRunner.js` | 脚本执行期间（最长 1 小时）**整个后端无响应**，定时采集也停摆 | Node：改异步 spawn |
| 12 | SLA 报表查询不存在的列 `RESOLVED_TIME`（表中为 `RESOLVE_TIME`）；MTTR 只取 HOUR/MINUTE 分量 | `routes/reports.js` | SLA 接口整体报 ORA-00904；超过 24h 的恢复时间被截断 | Node |
| 13 | 保留期清理直接删 ALERT_RECORD，但 ALERT_SUPPRESSION / ALERT_SILENCE_LOG 有外键 | `monitorCollectPersist.js` | ORA-02292 被吞，**告警表永不清理** | Node + Java |
| 14 | SQL Server `counter_name` 为 nchar(128) 带尾随空格，JS 用 `===` 比较 | `monitorExporterCollect.js` | SQL Server 缓冲命中率/PLE/用户连接数全部为空，健康分恒为 50 | Java：RTRIM + 忽略大小写 |
| 15 | SQL Server 会话查询引用不存在的 `dm_exec_sessions.request_id`；等待事件查询引用不存在的 `wait_category_desc` | 同上 | SQL Server 会话页报错；等待事件恒为空 | Java |
| 16 | PG 会话查询 `ROUND(double precision, int)` | 同上 | PG 13 及以下会话页报错 | Java：先转 numeric |
| 17 | 删除实例时 `CMDB_APP_DB_RELATION` 外键无级联 | `routes/cmdb.js` | 挂了应用关系的实例删不掉（ORA-02292） | Node + Java |
| 18 | 静默规则时间字符串（ISO）直接绑定 TIMESTAMP | `routes/alerts.js` | 受 NLS 影响 ORA-01861，一次性静默无法创建 | Node + Java |

## 二、一般（结果不准 / 体验 / 健壮性）

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| 19 | 周期静默 cron 解析：`1-5` 被 parseInt 成 1、不支持 7/步长/日/月；跨零点窗口用当天星期判断 | 工作日维护窗口只有周一生效 | Java：完整 5 段 cron + 回溯窗口算法 |
| 20 | 实例不可达时健康分为 40（其余三维各给 50） | 宕机实例显示“亚健康” | Java：0 分 |
| 21 | Oracle 趋势 CPU 用 `Host CPU Usage Per Sec`（厘秒/秒） | CPU 曲线可能 >100% | Java：`Host CPU Utilization (%)`，有 SSH 时优先主机 CPU |
| 22 | SQL Server Batch Requests/sec、MySQL Slow_queries 是累计计数器却当瞬时值 | 速率失真；MySQL 运行越久健康分越低且回不来 | Java：按两次采样求速率/增量（重启后从最近样本取基准） |
| 23 | Top SQL 单位：MySQL 总耗时是毫秒、PG 平均耗时是秒、SQL Server 总耗时是毫秒（列名都标秒/毫秒） | 跨库对比差 1000 倍 | Java：统一 `*_TOTAL` 秒、`AVG_*` 毫秒 |
| 24 | MySQL 等待事件 AVG 用 /1e6（得到微秒） | 偏大 1000 倍 | Java |
| 25 | 达梦 V$DATAFILE.TOTAL_SIZE 单位是页，按字节换算 | 容量偏小数千倍 | Java：`* PAGE()` |
| 26 | 磐维 TOP SQL 查询 `dbe_perf.statement` 用了不存在的列；复制延迟回退分支列名错误 | 永远走回退/取不到 | Java：按 openGauss 列名 |
| 27 | CRS 输出解析逐行匹配资源名，`-t` 格式下资源名与状态不在同一行 | 回退成“全文 OFFLINE 计数”，目标就是 OFFLINE 的资源也算故障 | Java：只统计 Target=ONLINE 且 State≠ONLINE |
| 28 | gs_om 判断用全文 `/Normal/` | cluster_state=Degraded 时被判正常 | Java：解析 `cluster_state` |
| 29 | 主机 `SSH_ENABLED=0` 被忽略（有凭据就登录） | 无法关闭 SSH 采集 | Java（⚠ 行为变更：未勾选“启用 SSH”的主机不再采集） |
| 30 | 全局定时、实例级定时、“立即采集”可同时采同一实例 | 重复样本、重复告警 | Java：实例级互斥；设置了单独间隔的实例不再进全局轮次 |
| 31 | 告警聚合：`IS_MERGED IS NULL` 不命中 UPDATE 却计数；已有聚合组时新批次最早告警不合并 | 统计不准、组内多条未合并 | Java |
| 32 | SEVERITY 型抑制允许同级互相抑制 | 同实例两条 P2 互相抑制，都看不见 | Java：父告警必须严格更高级 |
| 33 | 智能优先级 `HEALTH_SCORE || 100` | 健康分 0 的宕机实例被当成 100 分 | Java |
| 34 | 删除抑制规则未处理外键 | ORA-02292 | Java |
| 35 | 角色菜单保存先 DELETE 再逐条 INSERT（自动提交） | 中途失败角色丢失全部菜单 | Java：事务 |
| 36 | 编辑内置角色只要带 roleName 就拒绝 | 内置角色无法启停 | Java |
| 37 | 管理员可通过 PUT 把自己禁用或去掉 ADMIN | 系统可能没有管理员 | Java |
| 38 | 新建用户不校验密码强度 | 可建弱口令 | Java |
| 39 | 登录先判断“禁用”再校验密码 | 不知道密码也能探测账号状态 | Java |
| 40 | Oracle 只填 SID 时按服务名连接 | SID≠服务名的库连不上 | Java：SID 语法优先，ORA-12505 再回退 |
| 41 | 新建实例端口缺省一律 1521 | MySQL/PG 不填端口时连错 | Java：按类型默认端口 |
| 42 | 批量导入不查重复 | 同一 Excel 导两次出现两份实例 | Java |
| 43 | 主机更新不查 IP 重复；集群更新未传字段被置 NULL | 数据异常 / 报错 | Java |
| 44 | 主机连通性检测首个端口连通后其余 socket 未销毁；不含 1433/5236 | 连接泄漏 / 误判 | Java |
| 45 | 实例审计 `DETAIL LIKE '%Instance:1%'` 且 `RESOURCE_ID=1` 不区分资源类型 | 混入 Instance:10/用户 1 的审计 | Java |
| 46 | V$LOCK 自连接缺 `TYPE` 条件 | 锁分析误配对 | Java |
| 47 | `GET /api/alerts` 每次都同步跑全量静默/抑制/聚合 | 列表慢、GET 改数据、并发冲突 | Java：新告警即时处理 + 采集后批量 + GET 30s 节流 |
| 48 | Oracle 表空间 GB 取整（小表空间显示 0）；SQL Server 表空间跨库 FILEPROPERTY 为 NULL | 显示错误 | Java |
| 49 | 监控页“采集周期”只读环境变量，忽略系统配置 | 显示与实际不一致 | Java |
| 50 | RBAC 表存在性永久缓存；系统配置加载失败后每次请求都查库 | 迁移后需重启 / 性能 | Java |
| 51 | Excel 富文本单元格密码变成 `[object Object]`；PG 会话统计包含后台进程；达梦活跃会话为 0 时硬写 1 | 数据错误 | Java |
| 52 | 聚合组缺表时返回 `{rows:[]}`，正常为 `{list:[]}` | 前端取不到数据 | Java |

## 三、已知但本次未改（建议后续处理）

1. **被管库密码 / SSH 凭据仅 Base64 编码**（`init.sql` 注释已注明“非 AES”）。平台库账号泄露即等于所有被管库密码泄露。建议改为 AES-GCM + 外部密钥（KMS/环境变量），需配套数据迁移，故本次保持兼容。
2. **部署模板 SHELL 步骤**：`{{var}}` 参数原样拼进 `bash -c`，ADMIN/DBA 可执行任意命令（`deployRunner.js`）。属于功能设计，建议增加参数白名单或改为脚本+参数数组执行。
3. **SSH 默认不校验主机指纹**（与 Node 一致）。Java 版可通过 `MONITOR_SSH_STRICT_HOST_KEY=true` + `MONITOR_SSH_KNOWN_HOSTS` 开启。
4. MySQL/PG 的“CPU”趋势是“活跃会话/连接数”比例近似，不是真实 CPU；配置主机 SSH 后 Java 版会改用主机 CPU。
5. `automation.js`（2376 行）、`sqlWorkbench.js` 等未迁移模块只做了针对性扫描（绑定变量、阻塞调用、SQL 拼接、列名），未逐行审查业务逻辑。

---

## 四、SQL 洞察融合时发现并修复的问题（第二轮）

| # | 位置 | 问题 | 处理 |
|---|------|------|------|
| 1 | `sqlWorkbench.js /explain`（SQL Server） | `SET SHOWPLAN_TEXT ON`、SQL、`OFF` 分别用连接池的三个 `request()` 执行，可能落在不同连接上 → SHOWPLAN 不生效，**DML 被真实执行** | 改由 Java `ExplainService` 在同一个 `Statement` 上执行 |
| 2 | 工作台 / sql.js `isDangerous` | 正则 `(^\|;\s*)DROP` 可被 `/* x */ DROP`、`; /*x*/ delete`、PG `WITH … DELETE` 绕过；PG `EXPLAIN a; b` 会把第二条语句一并执行 | AST 逐条判断语句类型；执行计划只接受单条语句；Java 不可达时退回“先去注释/字符串再判断”的加强正则 |
| 3 | 4 套审核规则 `WHERE_REQUIRED` | `(DELETE\|UPDATE)\s+\w+(?![\s\S]*WHERE)` 遇到子查询里的 WHERE 即漏报（`UPDATE t SET a=(SELECT … WHERE …)`） | Druid AST 判断顶层语句的 WHERE（单测覆盖） |
| 4 | 发布预审 / SQL 评审自动审核 | INSERT 后用 `SELECT MAX(AUDIT_ID) WHERE SQL_HASH=…` 取回 ID，同一 SQL 并发提交会关联到别人的审核记录 | `RETURNING AUDIT_ID INTO` |
| 5 | `reports.js /sql-quality` | 查询 `SQL_OPT_HISTORY` 中不存在的 `SQL_ID/EXECUTIONS/ELAPSED_TIME_TOTAL` 等列，异常被 `.catch` 吞掉，Top SQL 永远为空 | 改读 SQL 洞察分钟统计 |
| 6 | 故障自愈 SLOW_QUERY | 往审核表插入 `-- 慢查询自动收录` 占位文本、审核分写死 60 | 触发即时采集，推送真实 Top 问题 SQL 并做真实审核 |
| 7 | SQL 治理“回归检测” | 对基线 SQL 重新跑正则审核比较“规则得分”（与运行性能无关），退化写 `FAULT_EXEC_LOG`，进不了告警中心 | 改为分钟级运行指标 + 中位数/MAD 基线的波动检测，告警走 `ALERT_RECORD` |
| 8 | 成本分析 Top SQL | `Math.random()` 生成的假数据 | 改取 SQL 洞察近 24 小时 DB Time Top 5（其余成本系数仍为原逻辑，未改） |
| 9 | 三套 SQL hash | md5 / sha256 截断 / SQL_ID 互不相认，字面量不同即视为不同 SQL | 统一为 `DI_SQL_ASSET.FINGERPRINT`（方言 + Schema + Druid 参数化文本），审核记录/工单写 `ASSET_ID` |
| 10 | 慢 SQL 采集 | 只存累计值快照，无法判断“慢 / 波动”；仅 Oracle、手动 | 分钟增量 + 数据质量（BASELINE/RESET/GAP/PARTIAL），7 种库，后台自动 |

说明：`automation.js` 中 `SQL_BASELINE` 的列表/固化/激活接口保留（前端仍在用），但发布成功不再写入“候选基线”，改写 SQL 洞察的基线锚点与变更窗口。

---

## 五、第三轮：SQL 洞察“接口不存在”、登录与会话

### 5.1 “接口不存在: GET /api/sql-insight/...、/api/sql/slow”的原因与修复

这些接口只在 Java dbops-server 里实现。出现这个提示说明请求到了 Node 而不是新版 Java，常见两种情况：

1. 用 `start-all.sh / start-all.bat` 启动：原脚本只启动 Node（端口 3000），根本没有 Java 服务。
2. 用 `start-java.sh / start-java.bat` 启动，但 `dbops-server/target/dbops-server.jar` 是上一轮构建的旧包：原脚本**只在 jar 不存在时才构建**，升级代码后仍运行旧 jar，旧 jar 不认识新路径，转给 Node，Node 返回 404。

修复：

| 位置 | 处理 |
|------|------|
| `scripts/ensure-java-jar.sh / .ps1`（新增） | 源码或 `pom.xml` 比 jar 新时自动 `mvn -DskipTests package`；没有 Maven 时明确报错，不再悄悄运行旧 jar |
| `start-java.sh / .bat` | 启动前调用上面的检查；给 Node 设置 `JAVA_SERVER_URL` |
| `start-all.sh / .bat` | 有 JDK 且 jar 可用时改为 **Java 网关 :3000 + Node :3001**（与 start-java 相同的架构）；否则退回仅 Node 并在启动时警告。`DBOPS_NODE_ONLY=1` 可强制仅 Node |
| `backend/src/routes/javaGateway.js`（新增） | 请求到了 Node 时：Java 在别的端口则原样转发；Java 未启动 / 地址指向自己 / Java 是旧版本（用 `X-DIOps-Via` 头识别回环）时返回 **503 + 具体处理办法**，不再是“接口不存在” |
| SQL 洞察页面 | 服务不可用时页面顶部显示一次说明和“重试”按钮，不再每个标签各弹一次错误 |
| `GlobalExceptionHandler` | 平台库未执行 `migration_sql_insight.sql`（ORA-00942）时提示执行哪个脚本，而不是“服务器内部错误” |

### 5.2 代码检查中发现并修复的问题

| # | 位置 | 问题 | 处理 |
|---|------|------|------|
| 1 | `V_SQL_SLOW_SUMMARY` 视图 | `GROUP BY` 中包含 CLOB 列 `SAMPLE_SQL`，Oracle 报 ORA-00932，迁移脚本建视图失败 → `/api/sql/slow` 不可用 | 先按 (资产, 实例) 聚合再关联资产表 |
| 2 | 波动列表“可能原因”列 | 标量子查询里用 `ORDER BY … FETCH FIRST`，部分 Oracle 版本报错 | 改为 `MAX(...) KEEP (DENSE_RANK LAST ORDER BY ...)` |
| 3 | `app.js` SQL 优化 Agent 代理 | `express.json()` 已读走请求体，http-proxy-middleware v3 转发 POST 时 Agent 收到空体；`onProxyRes` 是 v2 写法，v3 不识别（SSE 防缓冲头未生效） | `on.proxyReq: fixRequestBody`，事件改为 v3 的 `on: {...}` |
| 4 | 发布执行 → 变更窗口 | 执行接口没有查 `TICKET_NO`，变更窗口标题/引用只能显示数字 ID | 查询补上 `TICKET_NO` |
| 5 | 顶栏“退出登录” | `ElMessageBox.confirm(...).catch(() => null)` 吞掉了“取消”，**点取消也会退出** | 取消即返回 |
| 6 | 退出 / 401 | `localStorage.clear()` 把用户的界面偏好、记住的用户名一起清掉；直接 `location.href='/login'` 丢失原页面 | 只清登录相关键；跳转带 `redirect` 与原因 |
| 7 | 退出登录（Java） | 只记审计日志，token 在 8 小时有效期内仍可继续使用 | `TokenRevocations`：退出的 token 到期前在 Java 接口与转发给 Node 的接口上都被拒绝 |
| 8 | 登录页 | 失败时全局拦截器和登录页各弹一次错误；可回车+点击重复提交；失败后密码不清空 | 登录请求 `silent`，只提示一次；提交中忽略重复触发；失败清空密码并聚焦 |

### 5.3 登录与 10 分钟无操作自动退出

- `frontend/src/utils/session.js`：鼠标/键盘/点击/滚动/触摸算“操作”，**后台轮询不算**；10 分钟无操作 → 调用退出接口（token 失效）→ 回到登录页并提示“10 分钟内没有操作，已自动退出”。到期前 60 秒弹出提醒，有任何操作即续期。
- 多标签页共享最近操作时间；任一标签页退出，其他标签页同步回到登录页。
- 关闭浏览器或电脑休眠超过 10 分钟后再打开，路由守卫直接要求重新登录。
- 登录后回到原页面（只允许站内路径，防止开放跳转）；可选“记住用户名”；大写锁定提示。
- 时长可通过前端环境变量 `VITE_IDLE_TIMEOUT_MIN` 调整（默认 10）。


## 六、第四轮：精简、慢 SQL 采集、SQL 洞察补全

详细设计见 `docs/SQL_INSIGHT_DESIGN.md` 第 8 节。本轮发现并修复的问题：

| # | 问题 | 修复 |
|---|------|------|
| 6.1 | “立即采集慢 SQL”只支持 Oracle，且触发的是分钟增量采集，采完慢 SQL 列表没有新数据 | 新 `SlowSqlSource / SlowSqlService`：读累计统计视图，按阈值取慢 SQL，整批按采集时间写入 `SQL_SLOW_SUMMARY`；支持磐维、达梦（`V$LONG_EXEC_SQLS` → `V$SQL_STAT`）等 |
| 6.2 | AI 优化页请求不带 `Authorization`，全部 401 | Agent 页同源请求自动带令牌，401 提示并跳转登录 |
| 6.3 | 诊断的原因分类与原设计方案不一致（“发布变更”被当成原因；缺失指标按 0 参与判断） | 按方案 6.2 重写：8 类原因、1.5/1.2 阈值、NaN 不参与；发布作为证据；补 ERROR_SURGE、实例 CPU 证据、6.3 报告格式 |
| 6.4 | 规则改写 NOT IN → NOT EXISTS 在列可为 NULL 时结果不同 | 仅当两侧列都确认 NOT NULL（目标库元数据）才自动改写，否则只给建议 |
| 6.5 | `AutomationCenter.vue` 删除治理中心后残留半个函数体，前端构建失败 | 删除残留代码 |
| 6.6 | `SQLReview.vue` 取消 / 审核确认框点“取消”仍会提交 | 只有确认才提交 |
| 6.7 | 成本分析用随机数生成 CPU/IO/内存成本 | 删除该功能（前端页签与 Node 接口） |
| 6.8 | Node 与 Java 各有一套 auth/monitor/cmdb/alerts/users/rbac/systemConfig 实现 | 删除 Node 版本，Java 网关统一处理 |


## 七、第五轮：监控中心 / 控制台 / 报表中心重做与模块检查

设计说明见 `docs/MONITOR_DESIGN.md`。

| # | 问题 | 修复 |
|---|------|------|
| 7.1 | 健康分加权平均，单点严重问题被摊薄；未采集项按 50 分计拉低分数；负载用固定绝对值；连接失败显示 0 分 | 改为扣分制 + 封顶（严重 ≤59、警告 ≤89），未采集不扣分，连接数按占上限比例，离线单独显示 |
| 7.2 | 监控中心卡片只能看出在线与否 | 卡片显示等级、关键指标、走势、主要问题、离线原因，按严重程度排序，可分组 |
| 7.3 | 控制台只有总数和类型饼图 | 改为“需要处理什么”：一句话结论、需关注实例、容量风险、告警、SQL、待办 |
| 7.4 | 报表中心：巡检汇总列名错误、容量查询的表不存在、`FETCH FIRST n ROWS` 缺 `ONLY`，多个页签实际为空；没有周期报告与导出 | 重做为运行报告（日 / 周 / 月 / 自定义，按环境 / 实例），可打印为 PDF、导出 CSV |
| 7.5 | SQL 工作台编辑器无法加载：`@codemirror/basic-setup@0.20` 带入第二份 `@codemirror/state`，与 6.x 冲突 | 删除 basic-setup，统一为 CodeMirror 6 依赖 |
| 7.6 | 界面出现实现细节（“内置类 Exporter 拉取”“对接 Prometheus”“engineMetrics / migration”、内部配置键与表名等） | 全部改为面向用户的说明；采集元信息不再携带说明文字 |
| 7.7 | 从监控中心点告警跳到告警中心后看到的是全部告警 | 告警中心支持按实例过滤（`?instanceId=`） |
| 7.8 | 资产管理、实例详情的健康分颜色仍按旧阈值（≥80 绿色） | 统一为 ≥90 健康、60~89 关注、<60 严重，离线显示“离线” |

## 八、第六轮：按代码审查报告逐项修复（2026-11-12）

审查报告列出 31 项 P0、约 70 项 P1、10 类 P2。逐项核对源码后的处理结论（已修复 / 不适用 / 暂缓及原因）、升级步骤与验证情况见
[docs/CODE_REVIEW_RESPONSE.md](./docs/CODE_REVIEW_RESPONSE.md)。要点：

| 类别 | 主要修复 |
|---|---|
| 假成功 | 发布回滚真正执行回滚 SQL；恢复超时/无脚本记失败；巡检连库失败不再出空白报告；删除定时“模拟备份”；容量预测改用真实快照回归；RCA 失败不再回“完成” |
| 并发与事务 | `db.withTransaction`；发布执行/回滚、评审、服务工单、巡检任务用条件更新抢占；标签替换、基线重建、统计 MERGE 在事务内 / 可重入 |
| 鉴权 | 网关回查吊销/禁用/改密并签名转发，Node 校验；自审自批禁止；sql-agent 模型接口加鉴权；两个 Python 服务改为内部令牌、去 CORS；告警策略与主机探测接口加角色 |
| 注入与 SSRF | 部署参数走环境变量；EXPLAIN 语句白名单（防 `EXPLAIN ANALYZE DELETE`）；自定义指标只读事务；SQL 优化服务限制目标地址与 LLM 地址；iframe 内 LLM 输出清洗 |
| 凭据 | AES-256-GCM（Java/Node 同格式，存量自动迁移）；备份脚本命令行不再带密码；SSH 默认校验主机指纹；MySQL TLS PREFERRED；启动脚本自动生成强密钥 |
| 统计正确性 | SQL 增量按行级窗口计算；倍率封顶；持续性窗口按采集间隔；MySQL 行锁等待识别；改写引擎不再做不等价改写 |
| 前端与配置 | 个人信息保存、故障策略适用实例、WebSQL 格式化与危险确认、图表释放、登录页不踢掉其他标签；nginx 长任务超时/上传上限/安全头；init.sql 缺列合入，新增 `migration_security_fixes.sql` |
