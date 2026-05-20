-- ============================================================
-- DIOps AI 智能分析模块 - Oracle 平台库迁移脚本 v1.4
-- 执行用户: monitor
-- 功能: RCA根因分析、告警聚类降噪、异常检测、知识库(RAG)、ChatOps
-- ============================================================

-- ① AI RCA 根因分析结果表
CREATE TABLE AI_RCA_RESULT (
  RCA_ID           NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ALERT_ID         NUMBER,                        -- 关联告警
  INSTANCE_ID      NUMBER,                        -- 关联实例
  ANALYSIS_TIME    TIMESTAMP DEFAULT SYSTIMESTAMP,
  ROOT_CAUSE       VARCHAR2(1024),                -- 根因结论（LLM输出）
  CONFIDENCE       NUMBER(5,2),                   -- 置信度 0-100
  PROPAGATION_PATH CLOB,                          -- 拓扑传导路径 JSON
  METRICS_SNAPSHOT CLOB,                          -- 前后15分钟指标快照 JSON
  ANOMALY_POINTS   CLOB,                          -- 异常突变点 JSON
  RECOMMENDATIONS  CLOB,                          -- 处置建议（LLM输出）
  LLM_MODEL        VARCHAR2(64) DEFAULT 'deepseek-r1:1.5b',
  STATUS           VARCHAR2(16) DEFAULT 'DONE',   -- PENDING/DONE/ERROR
  ERR_MSG          VARCHAR2(512),
  CREATED_BY       VARCHAR2(64),
  CREATED_AT       TIMESTAMP DEFAULT SYSTIMESTAMP
);

COMMENT ON TABLE  AI_RCA_RESULT IS 'AI根因分析结果（RCA）';
COMMENT ON COLUMN AI_RCA_RESULT.PROPAGATION_PATH IS '拓扑传导路径，JSON数组，示例: [{layer:"APP",host:"app01"},{layer:"DB",host:"db01"}]';
COMMENT ON COLUMN AI_RCA_RESULT.METRICS_SNAPSHOT IS '前后15分钟多维指标快照，JSON格式';
COMMENT ON COLUMN AI_RCA_RESULT.ANOMALY_POINTS   IS '各指标异常突变点，JSON格式';

CREATE INDEX IDX_AI_RCA_ALERT    ON AI_RCA_RESULT(ALERT_ID);
CREATE INDEX IDX_AI_RCA_INSTANCE ON AI_RCA_RESULT(INSTANCE_ID, ANALYSIS_TIME DESC);

-- ② 告警聚类/降噪结果表
CREATE TABLE AI_ALERT_CLUSTER (
  CLUSTER_ID     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  CLUSTER_KEY    VARCHAR2(256),                   -- 聚类特征摘要
  ALERT_IDS      CLOB,                            -- 被合并的告警ID列表 JSON Array
  ALERT_COUNT    NUMBER DEFAULT 1,
  SIMILARITY_AVG NUMBER(5,2),                     -- 平均相似度
  REPRESENTATIVE_ALERT_ID NUMBER,                 -- 代表性告警
  CLUSTER_REASON VARCHAR2(1024),                  -- 聚类原因说明
  STATUS         VARCHAR2(16) DEFAULT 'ACTIVE',   -- ACTIVE/RESOLVED
  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP,
  UPDATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP
);

COMMENT ON TABLE AI_ALERT_CLUSTER IS 'AI告警聚类降噪结果（相似告警合并）';
CREATE INDEX IDX_AI_CLUSTER_STATUS ON AI_ALERT_CLUSTER(STATUS, CREATED_AT DESC);

-- ③ 异常检测记录表（无阈值，基于时序统计）
CREATE TABLE AI_ANOMALY_RECORD (
  ANOMALY_ID      NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  INSTANCE_ID     NUMBER NOT NULL,
  METRIC_NAME     VARCHAR2(128) NOT NULL,         -- cpu/memory/io/connections/locks
  DETECTED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP,
  METRIC_VALUE    NUMBER,                         -- 异常时刻的实际值
  EXPECTED_VALUE  NUMBER,                         -- 预期值（模型估计）
  DEVIATION       NUMBER(8,4),                    -- 偏差量
  ANOMALY_SCORE   NUMBER(5,2),                    -- 异常分 0-100
  ALGORITHM       VARCHAR2(64) DEFAULT 'IsolationForest', -- IsolationForest/ZScore/MAD
  SEVERITY        VARCHAR2(16) DEFAULT 'MEDIUM',  -- LOW/MEDIUM/HIGH/CRITICAL
  IS_CONFIRMED    NUMBER(1) DEFAULT 0,            -- 是否DBA确认为真实异常
  DETAIL          CLOB,                           -- 上下文时序数据 JSON
  CREATED_AT      TIMESTAMP DEFAULT SYSTIMESTAMP
);

COMMENT ON TABLE AI_ANOMALY_RECORD IS 'AI异常检测记录（无阈值时序算法）';
CREATE INDEX IDX_AI_ANOMALY_INST   ON AI_ANOMALY_RECORD(INSTANCE_ID, DETECTED_AT DESC);
CREATE INDEX IDX_AI_ANOMALY_METRIC ON AI_ANOMALY_RECORD(METRIC_NAME, DETECTED_AT DESC);

-- ④ 知识库文档表（RAG 原始文档）
CREATE TABLE AI_KNOWLEDGE_DOC (
  DOC_ID         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  TITLE          VARCHAR2(512) NOT NULL,
  DOC_TYPE       VARCHAR2(64) DEFAULT 'EXPERIENCE', -- SQL_CASE/EXPERIENCE/MANUAL/FAQ
  CONTENT        CLOB NOT NULL,                   -- 原始文档内容
  TAGS           VARCHAR2(512),                   -- 标签，逗号分隔
  SOURCE         VARCHAR2(256),                   -- 来源（文件名/URL）
  CHUNK_COUNT    NUMBER DEFAULT 0,                -- 已分块数量
  ENABLED        NUMBER(1) DEFAULT 1,
  CREATED_BY     VARCHAR2(64),
  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP,
  UPDATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP
);

COMMENT ON TABLE AI_KNOWLEDGE_DOC IS '知识库原始文档（SQL优化案例/故障经验/运维手册）';
CREATE INDEX IDX_AI_DOC_TYPE ON AI_KNOWLEDGE_DOC(DOC_TYPE, ENABLED);

-- ⑤ 知识库分块向量索引表（RAG Chunk + Embedding）
CREATE TABLE AI_KB_CHUNK (
  CHUNK_ID       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  DOC_ID         NUMBER NOT NULL,                 -- 关联文档
  CHUNK_INDEX    NUMBER NOT NULL,                 -- 块序号（0-based）
  CHUNK_TEXT     CLOB NOT NULL,                   -- 块文本
  EMBEDDING      CLOB,                            -- 向量 JSON Array (float[])，存储于Oracle CLOB
  EMBEDDING_DIM  NUMBER DEFAULT 384,              -- 向量维度
  KEYWORD_HASH   VARCHAR2(256),                   -- 关键词哈希，用于快速过滤
  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP
);

COMMENT ON TABLE AI_KB_CHUNK IS '知识库分块向量索引（Embedding存Oracle CLOB，RAG检索用）';
CREATE INDEX IDX_AI_CHUNK_DOC ON AI_KB_CHUNK(DOC_ID, CHUNK_INDEX);

-- ⑥ ChatOps 对话历史表
CREATE TABLE AI_CHAT_HISTORY (
  CHAT_ID        NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  SESSION_ID     VARCHAR2(128) NOT NULL,          -- 前端会话ID
  ROLE           VARCHAR2(16) NOT NULL,           -- user/assistant
  CONTENT        CLOB NOT NULL,                   -- 消息内容
  INSTANCE_ID    NUMBER,                          -- 关联实例（可选）
  RETRIEVED_DOCS CLOB,                            -- RAG检索到的知识条目 JSON
  LLM_MODEL      VARCHAR2(64) DEFAULT 'deepseek-r1:1.5b',
  TOKENS_USED    NUMBER,
  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP
);

COMMENT ON TABLE AI_CHAT_HISTORY IS 'ChatOps对话历史（用户自然语言问答记录）';
CREATE INDEX IDX_AI_CHAT_SESSION ON AI_CHAT_HISTORY(SESSION_ID, CREATED_AT);

-- ⑦ AI任务队列表（异步RCA/异常检测任务状态跟踪）
CREATE TABLE AI_TASK_QUEUE (
  TASK_ID        NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  TASK_TYPE      VARCHAR2(64) NOT NULL,           -- RCA/ANOMALY/CLUSTER/KB_INDEX
  PAYLOAD        CLOB,                            -- 任务参数 JSON
  STATUS         VARCHAR2(16) DEFAULT 'PENDING',  -- PENDING/RUNNING/DONE/ERROR
  RESULT_ID      NUMBER,                          -- 结果关联ID
  ERR_MSG        VARCHAR2(512),
  CREATED_BY     VARCHAR2(64),
  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP,
  STARTED_AT     TIMESTAMP,
  FINISHED_AT    TIMESTAMP
);

COMMENT ON TABLE AI_TASK_QUEUE IS 'AI异步任务队列（RCA/异常检测/知识库索引）';
CREATE INDEX IDX_AI_TASK_STATUS ON AI_TASK_QUEUE(STATUS, CREATED_AT DESC);
CREATE INDEX IDX_AI_TASK_TYPE   ON AI_TASK_QUEUE(TASK_TYPE, STATUS);

-- ⑧ 内置知识库初始化数据（SQL优化案例、故障经验）
INSERT INTO AI_KNOWLEDGE_DOC (TITLE, DOC_TYPE, CONTENT, TAGS, SOURCE, CREATED_BY)
VALUES (
  'Oracle SQL优化案例 - 全表扫描与索引优化',
  'SQL_CASE',
  '【场景】查询慢，执行计划走全表扫描（TABLE ACCESS FULL）。
【原因分析】
1. WHERE条件列缺少索引；
2. 索引列使用了函数（如 TO_CHAR(create_time)），导致索引失效；
3. 统计信息过期，CBO选错执行计划。
【优化方案】
1. 针对高频查询的过滤列建立合适索引（普通索引/组合索引/函数索引）；
2. 避免对索引列使用函数，改用等价条件；
3. 执行 DBMS_STATS.GATHER_TABLE_STATS 刷新统计信息；
4. 对于大表范围扫描，考虑分区裁剪。
【示例】
慢SQL: SELECT * FROM orders WHERE TO_CHAR(create_time,''YYYY-MM'')=''2024-01''
优化: SELECT * FROM orders WHERE create_time>=DATE''2024-01-01'' AND create_time<DATE''2024-02-01''',
  'SQL优化,索引,全表扫描,执行计划',
  '内置案例库',
  'SYSTEM'
);

INSERT INTO AI_KNOWLEDGE_DOC (TITLE, DOC_TYPE, CONTENT, TAGS, SOURCE, CREATED_BY)
VALUES (
  'Oracle 锁等待故障处理经验',
  'EXPERIENCE',
  '【故障现象】数据库大量会话处于等待状态，v$session中等到EVENT为''enq: TX - row lock contention''。
【诊断步骤】
1. 查询锁持有者: SELECT s.sid, s.serial#, s.username, s.sql_id FROM v$session s WHERE s.blocking_session IS NOT NULL;
2. 查询被锁对象: SELECT * FROM v$lock WHERE block=1;
3. 查看持锁SQL: SELECT sql_text FROM v$sql WHERE sql_id=:sql_id;
【处置建议】
1. 评估后通过 ALTER SYSTEM KILL SESSION 终止持锁会话（需确认业务影响）；
2. 排查业务代码：事务过长、未提交、并发更新同一行；
3. 建议：大事务拆分为小事务；热点行更新引入队列机制；
4. 监控：定期检查v$lock，设置锁等待告警（>30秒触发P2）。',
  '锁等待,TX锁,行锁,会话管理,死锁',
  '内置案例库',
  'SYSTEM'
);

INSERT INTO AI_KNOWLEDGE_DOC (TITLE, DOC_TYPE, CONTENT, TAGS, SOURCE, CREATED_BY)
VALUES (
  'Oracle CPU高负载根因排查手册',
  'MANUAL',
  '【现象】Oracle数据库所在主机CPU使用率持续超过85%。
【排查步骤】
1. 确认CPU消耗来自Oracle进程还是OS其他进程（top/htop）；
2. Oracle内部诊断：
   a. 查询Top SQL: SELECT sql_id, cpu_time, executions FROM v$sql ORDER BY cpu_time DESC;
   b. 检查并行查询: SELECT * FROM v$px_session;
   c. 检查递归SQL: 查看大量触发器或存储过程循环执行；
3. ASH分析: SELECT * FROM v$active_session_history WHERE session_state=''ON CPU'' ORDER BY sample_time DESC;
【常见原因及处置】
1. 热SQL大量执行 → 优化SQL/增加索引/绑定变量减少硬解析；
2. 并行度设置过高 → 调低PARALLEL_DEGREE_LIMIT；
3. 统计信息收集中 → 错峰执行DBMS_STATS；
4. 硬解析频繁 → 使用绑定变量，调大shared_pool_size。',
  'CPU高负载,性能优化,ASH,AWR,SQL诊断',
  '内置案例库',
  'SYSTEM'
);

INSERT INTO AI_KNOWLEDGE_DOC (TITLE, DOC_TYPE, CONTENT, TAGS, SOURCE, CREATED_BY)
VALUES (
  'Oracle 内存/SGA调优最佳实践',
  'EXPERIENCE',
  '【背景】Oracle内存管理直接影响性能，不合理配置导致频繁IO或OOM。
【关键参数】
1. MEMORY_TARGET (AMM): 自动管理SGA+PGA总量（推荐小型实例）；
2. SGA_TARGET + PGA_AGGREGATE_TARGET: 分别管理共享区和进程内存；
3. DB_CACHE_SIZE: Buffer Cache大小，影响物理读；
4. SHARED_POOL_SIZE: 共享池，影响SQL硬解析和元数据缓存。
【调优建议】
1. OLTP环境: SGA占可用内存50-70%，PGA占20%；
2. 数仓/分析环境: 适当增大PGA（支持大排序）；
3. 监控指标: Buffer Hit Ratio > 95%, Library Cache Hit > 99%;
4. 告警阈值: SGA空闲内存 < 10% → 告警扩容。
【常用诊断SQL】
SELECT component, current_size/1024/1024 MB FROM v$sga_dynamic_components;
SELECT name, value FROM v$pgastat WHERE name IN (''aggregate PGA target parameter'',''total PGA allocated'');',
  '内存,SGA,PGA,Buffer Cache,Shared Pool,AMM',
  '内置案例库',
  'SYSTEM'
);

COMMIT;
