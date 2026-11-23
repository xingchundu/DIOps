-- ============================================================================
-- SQL 洞察（问题识别 + 异常波动检测 + 原因诊断）数据模型 —— 可重复执行
-- 对应设计：docs/SQL_INSIGHT_DESIGN.md
--   新增 11 张 DI_* 表；SQL_AUDIT_RECORD / SQL_REVIEW_TICKET / SQL_OPT_HISTORY / SQL_BASELINE 增加 ASSET_ID；
--   SQL_SLOW_SUMMARY 改造为“慢 SQL 快照”表：每次采集按采集时间整批追加（Oracle/磐维/达梦/MySQL/PG/SQLServer）
-- 执行：sqlplus user/pwd@db @migration_sql_insight.sql
-- ============================================================================
SET SERVEROUTPUT ON

-- 小工具：存在则跳过（ORA-00955 已存在 / ORA-01430 列已存在 / ORA-01408 索引已存在 / ORA-02275 约束已存在）
CREATE OR REPLACE PROCEDURE DI_EXEC_IGNORE(p_sql IN VARCHAR2) IS
BEGIN
  EXECUTE IMMEDIATE p_sql;
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE NOT IN (-955, -1430, -1408, -2275, -2260, -2261, -1442, -942) THEN RAISE; END IF;
END;
/

-- ---------------------------------------------------------------- SQL 资产
BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_SQL_ASSET (
  ASSET_ID         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  DB_TYPE          VARCHAR2(32)  NOT NULL,          -- 方言族：ORACLE/MYSQL/POSTGRESQL/DAMENG/PANWEI/SQLSERVER/GOLDENDB
  SCHEMA_NAME      VARCHAR2(128) DEFAULT '-' NOT NULL,
  FINGERPRINT      VARCHAR2(64)  NOT NULL,          -- SHA-256(方言 + Schema + 归一化SQL) 前 32 位
  NORMALIZED_SQL   CLOB,
  SAMPLE_SQL       CLOB,                            -- 首次见到的原文（可能已被源库截断/参数化）
  STMT_TYPE        VARCHAR2(32),                    -- SELECT/INSERT/UPDATE/DELETE/MERGE/DDL/OTHER
  TABLES           VARCHAR2(2000),
  PARSE_STATUS     VARCHAR2(16) DEFAULT 'PARSED',   -- PARSED / FALLBACK（解析失败，用文本归一化）
  STATIC_STATUS    VARCHAR2(16) DEFAULT 'PENDING',  -- PENDING / ANALYZED / UNANALYZED（解析失败不能视为通过）
  STATIC_RESULT    CLOB,                            -- JSON：[{code,severity,message,detail}]
  STATIC_RISK      VARCHAR2(16),
  IS_CORE          NUMBER(1) DEFAULT 0,             -- 人工标记核心 SQL
  BIZ_TYPE         VARCHAR2(16),                    -- OLTP/BATCH/REPORT，为空继承实例
  OWNER            VARCHAR2(64),
  NOTE             VARCHAR2(512),
  FIRST_SEEN       TIMESTAMP DEFAULT SYSTIMESTAMP,
  LAST_SEEN        TIMESTAMP DEFAULT SYSTIMESTAMP,
  CREATED_AT       TIMESTAMP DEFAULT SYSTIMESTAMP,
  CONSTRAINT UK_DI_SQL_ASSET UNIQUE (DB_TYPE, SCHEMA_NAME, FINGERPRINT)
)]'); END;
/

BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_SQL_ASSET_SOURCE (
  ASSET_ID     NUMBER NOT NULL,
  INSTANCE_ID  NUMBER NOT NULL,
  NATIVE_ID    VARCHAR2(160) NOT NULL,              -- Oracle SQL_ID / MySQL SCHEMA|DIGEST / PG userid|dbid|queryid|toplevel ...
  FIRST_SEEN   TIMESTAMP DEFAULT SYSTIMESTAMP,
  LAST_SEEN    TIMESTAMP DEFAULT SYSTIMESTAMP,
  CONSTRAINT PK_DI_SQL_ASSET_SOURCE PRIMARY KEY (ASSET_ID, INSTANCE_ID, NATIVE_ID)
)]'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_DI_ASRC_NATIVE ON DI_SQL_ASSET_SOURCE (INSTANCE_ID, NATIVE_ID)'); END;
/

-- ---------------------------------------------------------------- 分钟增量统计（幂等：实例+SQL+计划+时间）
BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_SQL_STATS_MIN (
  STAT_ID                 NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  INSTANCE_ID             NUMBER NOT NULL,
  ASSET_ID                NUMBER NOT NULL,
  PLAN_HASH               VARCHAR2(64) DEFAULT 'NA' NOT NULL,
  WINDOW_START            TIMESTAMP NOT NULL,
  WINDOW_MINUTES          NUMBER(6,2) DEFAULT 1,
  BATCH_ID                VARCHAR2(64),
  DATA_QUALITY            VARCHAR2(16) NOT NULL,    -- NORMAL / PARTIAL（BASELINE/RESET/GAP 窗口不落库，只计数）
  EXCLUDE_BASELINE        NUMBER(1) DEFAULT 0,      -- 变更窗口 / 人工排除
  ANOMALY_FLAGS           NUMBER DEFAULT 0,         -- 本窗口通过“四项判定”的指标位图（持续性判断用，替代 Redis）
  D_EXEC                  NUMBER,
  D_ELAPSED_MS            NUMBER,
  D_CPU_MS                NUMBER,
  D_LOGICAL_READS         NUMBER,
  D_PHYSICAL_READS        NUMBER,
  D_ROWS_EXAMINED         NUMBER,
  D_ROWS_RETURNED         NUMBER,
  D_ERRORS                NUMBER,
  D_TMP_DISK              NUMBER,
  D_NO_INDEX              NUMBER,
  AVG_ELAPSED_MS          NUMBER,
  CPU_PER_EXEC_MS         NUMBER,
  LOGICAL_READS_PER_EXEC  NUMBER,
  PHYSICAL_READS_PER_EXEC NUMBER,
  ROWS_EXAMINED_PER_EXEC  NUMBER,
  SCAN_RATIO              NUMBER,
  EXEC_PER_MIN            NUMBER,
  DB_TIME_SHARE           NUMBER,                   -- 0~1，分母为已采集 SQL 的耗时之和（近似值）
  ERROR_RATE              NUMBER,                   -- 0~1
  CREATED_AT              TIMESTAMP DEFAULT SYSTIMESTAMP,
  CONSTRAINT UK_DI_SQL_STATS_MIN UNIQUE (INSTANCE_ID, ASSET_ID, PLAN_HASH, WINDOW_START)
)]'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_DI_STATS_INST_TIME ON DI_SQL_STATS_MIN (INSTANCE_ID, WINDOW_START)'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_DI_STATS_ASSET_TIME ON DI_SQL_STATS_MIN (ASSET_ID, INSTANCE_ID, WINDOW_START)'); END;
/

-- ---------------------------------------------------------------- 能力矩阵
BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_SQL_CAPABILITY (
  INSTANCE_ID  NUMBER NOT NULL,
  METRIC       VARCHAR2(64) NOT NULL,               -- exec/elapsed/cpu/logical_reads/.../plan_hash/active_session/lock_wait；_source 记录来源与版本
  SUPPORTED    NUMBER(1) NOT NULL,
  SOURCE       VARCHAR2(128),
  DETAIL       VARCHAR2(1000),
  PROBED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP,
  CONSTRAINT PK_DI_SQL_CAPABILITY PRIMARY KEY (INSTANCE_ID, METRIC)
)]'); END;
/

-- ---------------------------------------------------------------- 规则与阈值（SQL > 实例 > 业务类型 > 数据库类型 > 全局）
BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_SQL_RULE (
  RULE_ID      NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  RULE_CODE    VARCHAR2(16)  NOT NULL,              -- P-001..P-013 / S-001..S-007 / D-001.. / H-001..
  RULE_NAME    VARCHAR2(128) NOT NULL,
  CATEGORY     VARCHAR2(16)  NOT NULL,              -- RUNTIME / STATIC / POLICY / HINT
  SCOPE_TYPE   VARCHAR2(16)  DEFAULT 'GLOBAL' NOT NULL,  -- GLOBAL / DB_TYPE / BIZ_TYPE / INSTANCE / SQL
  SCOPE_VALUE  VARCHAR2(128) DEFAULT '*' NOT NULL,
  ENABLED      NUMBER(1) DEFAULT 1,
  SEVERITY     VARCHAR2(16),
  PARAMS       VARCHAR2(2000),                      -- JSON 阈值
  DESCRIPTION  VARCHAR2(1000),
  UPDATED_BY   VARCHAR2(64),
  UPDATED_AT   TIMESTAMP DEFAULT SYSTIMESTAMP,
  CONSTRAINT UK_DI_SQL_RULE UNIQUE (RULE_CODE, SCOPE_TYPE, SCOPE_VALUE)
)]'); END;
/

-- ---------------------------------------------------------------- 问题（规则命中）
BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_SQL_PROBLEM (
  PROBLEM_ID   NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  EVENT_KEY    VARCHAR2(256) NOT NULL,              -- RULE|INSTANCE|ASSET(|附加键)
  RULE_CODE    VARCHAR2(16)  NOT NULL,
  INSTANCE_ID  NUMBER,
  ASSET_ID     NUMBER,
  SEVERITY     VARCHAR2(16),
  STATUS       VARCHAR2(16)  DEFAULT 'OPEN',        -- OPEN / RESOLVED / SKIPPED（指标不支持，DETAIL 写原因）
  METRIC_VALUE NUMBER,
  THRESHOLD    NUMBER,
  DETAIL       VARCHAR2(2000),
  EVIDENCE     CLOB,
  HIT_COUNT    NUMBER DEFAULT 1,
  ALERT_ID     NUMBER,
  FIRST_SEEN   TIMESTAMP DEFAULT SYSTIMESTAMP,
  LAST_SEEN    TIMESTAMP DEFAULT SYSTIMESTAMP,
  RESOLVED_AT  TIMESTAMP
)]'); END;
/
BEGIN DI_EXEC_IGNORE(q'[CREATE UNIQUE INDEX UK_DI_PROBLEM_ACTIVE ON DI_SQL_PROBLEM (CASE WHEN STATUS IN ('OPEN','SKIPPED') THEN EVENT_KEY END)]'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_DI_PROBLEM_INST ON DI_SQL_PROBLEM (INSTANCE_ID, STATUS, LAST_SEEN)'); END;
/

-- ---------------------------------------------------------------- 基线（中位数 + MAD）
BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_SQL_BASELINE (
  INSTANCE_ID   NUMBER NOT NULL,
  ASSET_ID      NUMBER NOT NULL,
  METRIC        VARCHAR2(32) NOT NULL,
  DAY_TYPE      VARCHAR2(4)  NOT NULL,              -- WD 工作日 / WE 周末 / R24 最近 24 小时回退
  HOUR_OF_DAY   NUMBER(2)    NOT NULL,              -- 0~23；R24 为 -1
  MEDIAN_VAL    NUMBER,
  MAD_VAL       NUMBER,
  SAMPLE_COUNT  NUMBER,
  WINDOW_FROM   TIMESTAMP,
  WINDOW_TO     TIMESTAMP,
  REFRESHED_AT  TIMESTAMP DEFAULT SYSTIMESTAMP,
  CONSTRAINT PK_DI_SQL_BASELINE PRIMARY KEY (INSTANCE_ID, ASSET_ID, METRIC, DAY_TYPE, HOUR_OF_DAY)
)]'); END;
/

BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_SQL_BASELINE_ANCHOR (
  ANCHOR_ID    NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  INSTANCE_ID  NUMBER,
  ASSET_ID     NUMBER NOT NULL,
  ANCHOR_TIME  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  REASON       VARCHAR2(32) NOT NULL,               -- ACCEPT_NEW / OPTIMIZED / PLAN_CONFIRMED / PUBLISH
  OPERATOR     VARCHAR2(64),
  NOTE         VARCHAR2(512),
  CREATED_AT   TIMESTAMP DEFAULT SYSTIMESTAMP
)]'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_DI_ANCHOR_ASSET ON DI_SQL_BASELINE_ANCHOR (ASSET_ID, INSTANCE_ID, ANCHOR_TIME)'); END;
/

-- ---------------------------------------------------------------- 异常事件
BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_SQL_ANOMALY (
  ANOMALY_ID     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  EVENT_KEY      VARCHAR2(256) NOT NULL,            -- INSTANCE|ASSET|METRIC|DIRECTION 或 INSTANCE|*|INSTANCE
  SCOPE          VARCHAR2(16) DEFAULT 'SQL',        -- SQL / INSTANCE
  INSTANCE_ID    NUMBER NOT NULL,
  ASSET_ID       NUMBER,
  METRIC         VARCHAR2(32),
  DIRECTION      VARCHAR2(8),                       -- UP / DOWN
  ANOMALY_TYPE   VARCHAR2(24),                      -- SPIKE / SUSTAINED / SLOW_DEGRADATION
  SEVERITY       VARCHAR2(16) DEFAULT 'WARNING',
  STATUS         VARCHAR2(16) DEFAULT 'OPEN',       -- OPEN / RESOLVED / ACCEPTED（接受为新基线）
  IN_CHANGE_WINDOW NUMBER(1) DEFAULT 0,
  BASELINE_VALUE NUMBER,
  CURRENT_VALUE  NUMBER,
  PEAK_VALUE     NUMBER,
  RATIO          NUMBER,
  Z_SCORE        NUMBER,
  DB_TIME_SHARE  NUMBER,
  HIT_COUNT      NUMBER DEFAULT 1,
  RECOVER_COUNT  NUMBER DEFAULT 0,
  START_TIME     TIMESTAMP,
  LAST_TIME      TIMESTAMP,
  ALERT_ID       NUMBER,
  DIAGNOSED      NUMBER(1) DEFAULT 0,
  DETAIL         VARCHAR2(2000),
  RESOLVED_AT    TIMESTAMP,
  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP
)]'); END;
/
BEGIN DI_EXEC_IGNORE(q'[CREATE UNIQUE INDEX UK_DI_ANOMALY_OPEN ON DI_SQL_ANOMALY (CASE WHEN STATUS = 'OPEN' THEN EVENT_KEY END)]'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_DI_ANOMALY_INST ON DI_SQL_ANOMALY (INSTANCE_ID, STATUS, LAST_TIME)'); END;
/

BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_SQL_ANOMALY_DIAGNOSIS (
  DIAG_ID        NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ANOMALY_ID     NUMBER NOT NULL,
  PRIMARY_CAUSE  VARCHAR2(32),
  CAUSES         VARCHAR2(512),                     -- 候选原因（按优先级，逗号分隔）
  EVIDENCE       CLOB,                              -- JSON
  SNAPSHOT       CLOB,                              -- JSON 诊断快照
  SUGGESTIONS    CLOB,                              -- JSON
  REPORT_TEXT    CLOB,
  AI_EXPLANATION CLOB,
  STATUS         VARCHAR2(16) DEFAULT 'DONE',       -- DONE / FAILED
  ERROR_MSG      VARCHAR2(1000),
  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP
)]'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_DI_DIAG_ANOMALY ON DI_SQL_ANOMALY_DIAGNOSIS (ANOMALY_ID, CREATED_AT)'); END;
/

-- ---------------------------------------------------------------- 变更窗口
BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE DI_CHANGE_WINDOW (
  WINDOW_ID    NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  INSTANCE_ID  NUMBER,                              -- 为空表示全部实例
  WINDOW_TYPE  VARCHAR2(16) NOT NULL,               -- RELEASE / BATCH / MAINTENANCE
  TITLE        VARCHAR2(256),
  START_TIME   TIMESTAMP NOT NULL,
  END_TIME     TIMESTAMP NOT NULL,
  SOURCE       VARCHAR2(16) DEFAULT 'MANUAL',       -- MANUAL / PUBLISH
  REF_ID       VARCHAR2(64),
  CREATED_BY   VARCHAR2(64),
  CREATED_AT   TIMESTAMP DEFAULT SYSTIMESTAMP
)]'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_DI_CHGWIN_TIME ON DI_CHANGE_WINDOW (START_TIME, END_TIME)'); END;
/

-- ---------------------------------------------------------------- 现有表关联资产
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_AUDIT_RECORD ADD (ASSET_ID NUMBER)'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_REVIEW_TICKET ADD (ASSET_ID NUMBER)'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_OPT_HISTORY ADD (ASSET_ID NUMBER)'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_BASELINE ADD (ASSET_ID NUMBER)'); END;
/
-- 实例业务类型（OLTP/BATCH/REPORT）：规则阈值“业务类型”覆盖的来源，空为 OLTP；SQL 洞察页面可修改
BEGIN DI_EXEC_IGNORE('ALTER TABLE CMDB_INSTANCE ADD (SQL_BIZ_TYPE VARCHAR2(16))'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_AUDIT_ASSET ON SQL_AUDIT_RECORD (ASSET_ID)'); END;
/

-- DDL_AUDIT_RULE 中与 AST 规则重复的内置正则停用（S-001/S-002/S-003/S-006/D-001/D-002/D-003/H-002 已覆盖，且正则会被注释/子查询误判）
-- 用户自建的正则规则保留，作为“自定义策略”继续生效
DECLARE v NUMBER; BEGIN
  SELECT COUNT(*) INTO v FROM USER_TABLES WHERE TABLE_NAME = 'DDL_AUDIT_RULE';
  IF v = 1 THEN
    EXECUTE IMMEDIATE q'[UPDATE DDL_AUDIT_RULE SET ENABLED = 0
      WHERE RULE_CODE IN ('NO_SELECT_STAR','WHERE_REQUIRED','NO_DROP_TABLE','NO_TRUNCATE','NO_IMPLICIT_CONVERT',
                          'NO_DELETE_LARGE_TABLE','NO_DELETE_NOINDEX','ADD_COL_DEFAULT','NO_CARTESIAN','LIMIT_WITHOUT_ORDER')]';
  END IF;
END;
/

-- ---------------------------------------------------------------- 慢 SQL 快照：沿用 SQL_SLOW_SUMMARY，按采集时间整批存放
-- 每次“立即采集 / 定时采集”写一批：同一 CAPTURE_TIME + CAPTURE_BATCH；保留天数 sqlinsight.retention.slow_days
-- 统计口径：源库统计视图“截至采集时刻”的累计值（平均耗时 = 累计耗时 / 累计执行次数）
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (CAPTURE_BATCH VARCHAR2(40))'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (CAPTURE_SOURCE VARCHAR2(16))'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (SCHEMA_NAME VARCHAR2(128))'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (NATIVE_SQL_ID VARCHAR2(160))'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (ASSET_ID NUMBER)'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (CPU_TIME_MS NUMBER)'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (LOGICAL_READS NUMBER)'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (PHYSICAL_READS NUMBER)'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (ROWS_PROCESSED NUMBER)'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (LAST_ACTIVE_TIME TIMESTAMP)'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE SQL_SLOW_SUMMARY ADD (STAT_SOURCE VARCHAR2(64))'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_SLOW_CAPTURE_TIME ON SQL_SLOW_SUMMARY (CAPTURE_TIME)'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_SLOW_BATCH ON SQL_SLOW_SUMMARY (CAPTURE_BATCH)'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_SLOW_ASSET ON SQL_SLOW_SUMMARY (ASSET_ID, INSTANCE_ID, CAPTURE_TIME)'); END;
/
COMMENT ON TABLE SQL_SLOW_SUMMARY IS '慢 SQL 快照：按采集时间整批存放（CAPTURE_TIME / CAPTURE_BATCH），SQL_ID 列为行号';
-- 治理闭环：问题 / 波动 → 优化工单（SQL_REVIEW_TICKET，SOURCE='SQL_INSIGHT'）
BEGIN DI_EXEC_IGNORE('ALTER TABLE DI_SQL_PROBLEM ADD (TICKET_ID NUMBER)'); END;
/
BEGIN DI_EXEC_IGNORE('ALTER TABLE DI_SQL_ANOMALY ADD (TICKET_ID NUMBER)'); END;
/
BEGIN DI_EXEC_IGNORE('CREATE INDEX IDX_SRT_ASSET ON SQL_REVIEW_TICKET (ASSET_ID, STATUS)'); END;
/
-- 上一版的兼容视图不再需要
BEGIN DI_EXEC_IGNORE('DROP VIEW V_SQL_SLOW_SUMMARY'); END;
/

-- ---------------------------------------------------------------- 规则种子（全局默认，OLTP 初始阈值）
MERGE INTO DI_SQL_RULE t USING (
  SELECT 'P-001' c, '运行中慢 SQL' n, 'RUNTIME' cat, 'WARNING' sev, '{"runSec":3,"consecutive":2}' p, '活动会话运行时长 ≥ runSec，连续 consecutive 次采样' d FROM DUAL UNION ALL
  SELECT 'P-002','运行中超长 SQL','RUNTIME','CRITICAL','{"runSec":10,"consecutive":2}','活动会话运行时长 ≥ runSec，连续 consecutive 次采样' FROM DUAL UNION ALL
  SELECT 'P-003','窗口慢 SQL','RUNTIME','WARNING','{"avgElapsedMs":3000,"minExec":1}','avg_elapsed_ms ≥ 阈值' FROM DUAL UNION ALL
  SELECT 'P-004','高 CPU SQL','RUNTIME','WARNING','{"cpuPerExecMs":2000,"minExec":1}','cpu_per_exec_ms ≥ 阈值' FROM DUAL UNION ALL
  SELECT 'P-005','高逻辑读 SQL','RUNTIME','WARNING','{"logicalReadsPerExec":100000,"minExec":1}','logical_reads_per_exec ≥ 阈值' FROM DUAL UNION ALL
  SELECT 'P-006','高频 SQL','RUNTIME','WARNING','{"execPerMin":10000}','exec_per_min ≥ 阈值' FROM DUAL UNION ALL
  SELECT 'P-007','资源占比高','RUNTIME','WARNING','{"dbTimeShare":0.2,"consecutive":3}','db_time_share ≥ 阈值，连续 3 个窗口' FROM DUAL UNION ALL
  SELECT 'P-008','扫描效率低','RUNTIME','WARNING','{"scanRatio":1000,"rowsExaminedPerExec":10000}','scan_ratio 与单次扫描行数同时超阈值' FROM DUAL UNION ALL
  SELECT 'P-009','未走索引','RUNTIME','WARNING','{"rowsPerExec":10000}','无索引标记或全表扫描计划，且单次扫描 ≥ 阈值（Oracle 以单次逻辑读近似）' FROM DUAL UNION ALL
  SELECT 'P-010','锁等待','RUNTIME','CRITICAL','{"waitSec":10}','等待时长 ≥ 阈值或存在阻塞链' FROM DUAL UNION ALL
  SELECT 'P-011','SQL 错误','RUNTIME','WARNING','{"errorRate":0.05,"minErrors":5}','error_rate ≥ 阈值且窗口错误数 ≥ minErrors' FROM DUAL UNION ALL
  SELECT 'P-012','磁盘临时空间','RUNTIME','WARNING','{"consecutive":2}','连续窗口产生磁盘临时表/临时块' FROM DUAL UNION ALL
  SELECT 'P-013','未绑定变量','RUNTIME','WARNING','{"nativeIds":100}','同一规范化 SQL 对应的原生 SQL ID ≥ 阈值' FROM DUAL UNION ALL
  SELECT 'S-001','UPDATE/DELETE 无 WHERE','STATIC','CRITICAL','{}','AST 判断' FROM DUAL UNION ALL
  SELECT 'S-002','多表连接缺少连接条件','STATIC','CRITICAL','{}','AST 判断（笛卡尔积）' FROM DUAL UNION ALL
  SELECT 'S-003','SELECT *','STATIC','INFO','{}','AST 判断' FROM DUAL UNION ALL
  SELECT 'S-004','LIKE 前导通配符','STATIC','WARNING','{}','AST 判断' FROM DUAL UNION ALL
  SELECT 'S-005','索引列使用函数或运算','STATIC','WARNING','{}','AST + 索引元数据（无元数据时降为 INFO 提示）' FROM DUAL UNION ALL
  SELECT 'S-006','疑似隐式类型转换','STATIC','WARNING','{}','AST + 字段类型元数据（无元数据时跳过）' FROM DUAL UNION ALL
  SELECT 'S-007','IN 列表过长','STATIC','WARNING','{"maxInList":1000}','参数个数 ≥ 阈值' FROM DUAL UNION ALL
  SELECT 'D-001','禁止 DROP TABLE','POLICY','CRITICAL','{}','发布/审核策略：需走数据安全申请' FROM DUAL UNION ALL
  SELECT 'D-002','禁止 TRUNCATE','POLICY','CRITICAL','{}','发布/审核策略：需人工审批' FROM DUAL UNION ALL
  SELECT 'D-003','新增列未设置默认值','POLICY','WARNING','{}','ALTER TABLE ADD 列建议 DEFAULT' FROM DUAL UNION ALL
  SELECT 'H-001','NOT IN 子查询','HINT','INFO','{}','子查询含 NULL 时结果为空，建议 NOT EXISTS' FROM DUAL UNION ALL
  SELECT 'H-002','分页未排序','HINT','INFO','{}','LIMIT/ROWNUM/FETCH 分页建议配合 ORDER BY' FROM DUAL UNION ALL
  SELECT 'H-003','深分页','HINT','INFO','{"maxOffset":10000}','OFFSET 过大建议改为游标/键集分页' FROM DUAL
) s ON (t.RULE_CODE = s.c AND t.SCOPE_TYPE = 'GLOBAL' AND t.SCOPE_VALUE = '*')
WHEN NOT MATCHED THEN INSERT (RULE_CODE, RULE_NAME, CATEGORY, SCOPE_TYPE, SCOPE_VALUE, ENABLED, SEVERITY, PARAMS, DESCRIPTION)
  VALUES (s.c, s.n, s.cat, 'GLOBAL', '*', 1, s.sev, s.p, s.d);

-- 批处理 / 报表业务类型的放宽阈值（避免持续误报）
MERGE INTO DI_SQL_RULE t USING (
  SELECT 'P-003' c, 'BATCH' v, '{"avgElapsedMs":60000,"minExec":1}' p FROM DUAL UNION ALL
  SELECT 'P-003','REPORT','{"avgElapsedMs":30000,"minExec":1}' FROM DUAL UNION ALL
  SELECT 'P-001','BATCH','{"runSec":300,"consecutive":2}' FROM DUAL UNION ALL
  SELECT 'P-002','BATCH','{"runSec":1800,"consecutive":2}' FROM DUAL UNION ALL
  SELECT 'P-005','REPORT','{"logicalReadsPerExec":5000000,"minExec":1}' FROM DUAL
) s ON (t.RULE_CODE = s.c AND t.SCOPE_TYPE = 'BIZ_TYPE' AND t.SCOPE_VALUE = s.v)
WHEN NOT MATCHED THEN INSERT (RULE_CODE, RULE_NAME, CATEGORY, SCOPE_TYPE, SCOPE_VALUE, ENABLED, PARAMS, DESCRIPTION)
  VALUES (s.c, s.c || '(' || s.v || ')', 'RUNTIME', 'BIZ_TYPE', s.v, 1, s.p, '业务类型覆盖');

-- ---------------------------------------------------------------- 告警中心挂接规则（METRIC 为占位，监控评估器会跳过；ENABLED=0 即关闭 SQL 洞察的告警推送）
MERGE INTO ALERT_RULE t USING (
  SELECT 'SQL问题' n, 'sqlinsight_problem' m, 'P2' s FROM DUAL UNION ALL
  SELECT 'SQL异常波动', 'sqlinsight_anomaly', 'P2' FROM DUAL
) x ON (t.RULE_NAME = x.n)
WHEN NOT MATCHED THEN INSERT (RULE_NAME, RULE_TYPE, METRIC, OPERATOR, THRESHOLD, DURATION, SEVERITY, ENABLED)
  VALUES (x.n, 'SQL_INSIGHT', x.m, 'gt', 0, 0, x.s, 1);

-- ---------------------------------------------------------------- 系统配置（分阶段开关）
MERGE INTO SYS_CONFIG t USING (
  SELECT 'sqlinsight.collect.enabled' k, '1' v, 'BOOLEAN' ty, 'SQL分钟统计采集' l, '阶段1：采集累计快照并计算分钟增量' d FROM DUAL UNION ALL
  SELECT 'sqlinsight.collect.top_n', '1000', 'NUMBER', '每次采集SQL上限', '只采集最近2分钟活跃的 SQL，按耗时取前 N 条' FROM DUAL UNION ALL
  SELECT 'sqlinsight.sampler.interval_sec', '15', 'NUMBER', '活动会话采样周期(秒)', '用于运行中慢SQL/锁等待，建议 10~15' FROM DUAL UNION ALL
  SELECT 'sqlinsight.rules.enabled', '1', 'BOOLEAN', 'SQL问题规则', '阶段2：运行态规则 P-001~P-013' FROM DUAL UNION ALL
  SELECT 'sqlinsight.problem.alert_min_severity', 'CRITICAL', 'STRING', 'SQL问题推送告警的最低级别', 'CRITICAL / WARNING' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.enabled', '1', 'BOOLEAN', 'SQL波动检测', '阶段3：开启检测（建议先静默观察 2 周）' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.notify', '0', 'BOOLEAN', 'SQL波动推送告警', '阶段4：校准阈值后再打开' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.notify_core_only', '1', 'BOOLEAN', '仅核心SQL推送波动告警', '阶段4 先对核心业务开放' FROM DUAL UNION ALL
  SELECT 'sqlinsight.baseline.focus_top_n', '200', 'NUMBER', '每实例重点SQL数', '按 DB Time 取前 N 条 + 人工标记核心 SQL 建立基线' FROM DUAL UNION ALL
  SELECT 'sqlinsight.diagnosis.enabled', '1', 'BOOLEAN', 'SQL原因诊断', '阶段5：持续升高时自动诊断' FROM DUAL UNION ALL
  SELECT 'sqlinsight.retention.stats_days', '35', 'NUMBER', '分钟统计保留天数', '基线需要 28 天' FROM DUAL UNION ALL
  SELECT 'sqlinsight.panwei.time_divisor', '1000', 'NUMBER', '磐维时间字段换算除数', 'dbe_perf.statement 时间字段按微秒推定（/1000 → 毫秒），实测后调整' FROM DUAL UNION ALL
  SELECT 'sqlinsight.dameng.time_divisor', '1', 'NUMBER', '达梦时间字段换算除数', 'V$SQL_STAT 时间字段单位待实测（毫秒=1，微秒=1000）' FROM DUAL UNION ALL
  SELECT 'sqlinsight.collect.interval_sec', '60', 'NUMBER', 'SQL采集周期(秒)', '分钟统计的采集周期，修改后重启生效' FROM DUAL UNION ALL
  SELECT 'sqlinsight.collect.parallel', '4', 'NUMBER', 'SQL采集并发实例数', '同时采集的实例数，修改后重启生效' FROM DUAL UNION ALL
  SELECT 'sqlinsight.baseline.min_samples', '30', 'NUMBER', '基线最少样本数', '分时段样本不足时回退到最近24小时，仍不足则不检测' FROM DUAL UNION ALL
  SELECT 'sqlinsight.baseline.days', '28', 'NUMBER', '基线回看天数', '中位数+MAD 的计算窗口' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.z', '3.5', 'NUMBER', '波动稳健Z分数阈值', '|x-中位数|/(1.4826×MAD)' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.min_exec', '5', 'NUMBER', '波动判定最少执行次数', '窗口执行次数低于此值不判定（避免偶发一次慢）' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.spike_ratio', '5', 'NUMBER', '突增倍率', '单窗口达到此倍率记为突增（只记录不告警）' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.window', '5', 'NUMBER', '持续性判断窗口数', '最近 N 个窗口' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.need', '3', 'NUMBER', '持续性命中窗口数', 'N 个窗口中命中 M 个为持续升高' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.recover_ratio', '1.5', 'NUMBER', '恢复倍率', '低于基线该倍数视为恢复中' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.recover_windows', '10', 'NUMBER', '恢复窗口数', '连续 N 个窗口恢复则关闭事件' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.degradation_ratio', '1.5', 'NUMBER', '缓慢劣化倍率', '连续3天日中位数高于历史该倍数' FROM DUAL UNION ALL
  SELECT 'sqlinsight.anomaly.instance_merge_threshold', '5', 'NUMBER', '实例级合并阈值', '同一实例同时持续升高的 SQL 数达到该值合并为实例级事件' FROM DUAL UNION ALL
  SELECT 'sqlinsight.slow.min_avg_ms', '1000', 'NUMBER', '慢SQL阈值(ms)', '单次平均耗时达到该值的 SQL 进入慢 SQL 快照' FROM DUAL UNION ALL
  SELECT 'sqlinsight.slow.top_n', '50', 'NUMBER', '慢SQL每次采集条数', '每个实例每次最多采集的慢 SQL 条数（按平均耗时倒序）' FROM DUAL UNION ALL
  SELECT 'sqlinsight.slow.capture_interval_min', '30', 'NUMBER', '慢SQL定时采集间隔(分钟)', '0 表示只在页面手动采集' FROM DUAL UNION ALL
  SELECT 'sqlinsight.retention.slow_days', '30', 'NUMBER', '慢SQL快照保留天数', '超过天数的快照每小时清理一次' FROM DUAL
) s ON (t.CONFIG_KEY = s.k)
WHEN NOT MATCHED THEN INSERT (CONFIG_KEY, CONFIG_VALUE, DEFAULT_VALUE, CATEGORY, LABEL, DESCRIPTION, VALUE_TYPE)
  VALUES (s.k, s.v, s.v, 'SQL洞察', s.l, s.d, s.ty);

-- ---------------------------------------------------------------- 菜单
DECLARE v NUMBER; BEGIN
  SELECT COUNT(*) INTO v FROM USER_TABLES WHERE TABLE_NAME = 'SYS_MENU';
  IF v = 1 THEN
    EXECUTE IMMEDIATE q'[MERGE INTO SYS_MENU t USING (SELECT '/sql-insight' p, 'SQL洞察' n, 285 o FROM DUAL) s
      ON (t.MENU_PATH = s.p) WHEN NOT MATCHED THEN INSERT (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES (s.p, s.n, s.o)]';
    EXECUTE IMMEDIATE q'[INSERT INTO SYS_ROLE_MENU (ROLE_ID, MENU_ID)
      SELECT r.ROLE_ID, m.MENU_ID FROM SYS_ROLE r, SYS_MENU m
       WHERE m.MENU_PATH = '/sql-insight' AND r.ROLE_CODE IN ('DBA','OPS','DEV','VIEWER')
         AND NOT EXISTS (SELECT 1 FROM SYS_ROLE_MENU x WHERE x.ROLE_ID = r.ROLE_ID AND x.MENU_ID = m.MENU_ID)]';
  END IF;
END;
/

COMMIT;
DROP PROCEDURE DI_EXEC_IGNORE;


-- ---------------------------------------------------------------- 功能精简：移除的菜单
-- “性能对比”“定时采集观测”页面已删除（监控中心已有性能曲线与采集状态）
DECLARE v NUMBER; BEGIN
  SELECT COUNT(*) INTO v FROM USER_TABLES WHERE TABLE_NAME = 'SYS_MENU';
  IF v = 1 THEN
    EXECUTE IMMEDIATE q'[DELETE FROM SYS_ROLE_MENU WHERE MENU_ID IN (SELECT MENU_ID FROM SYS_MENU WHERE MENU_PATH IN ('/monitor/compare', '/monitor/collect-scheduler'))]';
    EXECUTE IMMEDIATE q'[DELETE FROM SYS_MENU WHERE MENU_PATH IN ('/monitor/compare', '/monitor/collect-scheduler')]';
  END IF;
END;
/
COMMIT;
