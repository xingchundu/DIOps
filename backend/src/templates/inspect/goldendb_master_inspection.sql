-- ============================================================
-- GoldenDB 综合巡检脚本
-- GoldenDB 是基于 MySQL 的分布式数据库，底层兼容 MySQL 5.7/8.0
-- 执行层级：① GoldenDB CN (协调节点)  ② DN (数据节点)  ③ GTM (全局事务管理)
-- 执行用户：root / 具备 SUPER + PROCESS + REPLICATION CLIENT 权限
-- 执行方式：
--   CN 节点：mysql -h <CN_IP> -P <CN_PORT> -uroot -p < goldendb_inspect.sql
--   DN 节点：mysql -h <DN_IP> -P <DN_PORT> -uroot -p < goldendb_inspect.sql
-- ============================================================

SET SESSION group_concat_max_len = 1048576;
SET SESSION sql_mode = '';

SELECT '============================================================' AS separator;
SELECT CONCAT('GoldenDB 综合巡检报告  执行时间: ', NOW())             AS inspect_info;
SELECT CONCAT('节点标识: ', @@hostname, '  端口: ', @@port)           AS node_info;
SELECT '============================================================' AS separator;

-- ============================================================
-- §1  GoldenDB 集群拓扑与节点信息
-- ============================================================
SELECT '>>SECTION: 1. GoldenDB 集群基本信息' AS section;
SELECT
    @@hostname              AS hostname,
    @@server_id             AS server_id,
    @@port                  AS port,
    @@version               AS mysql_version,
    @@version_comment       AS version_comment,
    @@datadir               AS datadir,
    @@character_set_server  AS charset,
    @@read_only             AS read_only,
    @@super_read_only       AS super_read_only,
    @@gtid_mode             AS gtid_mode,
    @@binlog_format         AS binlog_format;

SELECT '>>SECTION: 2. GoldenDB 集群状态 (CN节点执行)' AS section;
-- GoldenDB 特有系统表
SHOW CLUSTER STATUS;

SELECT '>>SECTION: 3. GoldenDB 节点列表' AS section;
SHOW NODES;

SELECT '>>SECTION: 4. GoldenDB 分片规则' AS section;
SELECT * FROM information_schema.GOLDENDB_SHARDINFO LIMIT 100;

SELECT '>>SECTION: 5. GoldenDB 分布式事务配置' AS section;
SELECT
    VARIABLE_NAME,
    VARIABLE_VALUE
FROM performance_schema.global_variables
WHERE VARIABLE_NAME IN (
    'goldendb_txn_model',
    'goldendb_distributed_trx',
    'goldendb_2pc_enable',
    'goldendb_xa_enable',
    'goldendb_global_trx_timeout',
    'goldendb_node_count',
    'goldendb_cn_count',
    'goldendb_gtm_count'
)
ORDER BY VARIABLE_NAME;

-- ============================================================
-- §2  健康检查 (HEALTH)
-- ============================================================
SELECT '>>SECTION: 6. [HEALTH] 实例运行时长' AS section;
SELECT
    VARIABLE_VALUE                  AS uptime_seconds,
    SEC_TO_TIME(VARIABLE_VALUE)     AS uptime_hhmmss,
    FLOOR(VARIABLE_VALUE/86400)     AS uptime_days
FROM performance_schema.global_status
WHERE VARIABLE_NAME = 'Uptime';

SELECT '>>SECTION: 7. [HEALTH] 连接数概况' AS section;
SELECT
    (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Threads_connected')    AS threads_connected,
    (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Threads_running')      AS threads_running,
    (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Max_used_connections') AS max_used_connections,
    @@max_connections                                                                                          AS max_connections,
    ROUND(
        (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Threads_connected')
        / @@max_connections * 100, 2
    )                                                                                                          AS connection_usage_pct;

SELECT '>>SECTION: 8. [HEALTH] 错误计数' AS section;
SELECT VARIABLE_NAME, VARIABLE_VALUE
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
    'Aborted_clients','Aborted_connects',
    'Connection_errors_max_connections',
    'Connection_errors_internal',
    'Com_rollback','Com_xa_rollback'
)
ORDER BY VARIABLE_NAME;

SELECT '>>SECTION: 9. [HEALTH] InnoDB 核心指标' AS section;
SELECT VARIABLE_NAME, VARIABLE_VALUE
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
    'Innodb_buffer_pool_read_requests',
    'Innodb_buffer_pool_reads',
    'Innodb_buffer_pool_pages_total',
    'Innodb_buffer_pool_pages_free',
    'Innodb_buffer_pool_pages_dirty',
    'Innodb_row_lock_current_waits',
    'Innodb_row_lock_waits',
    'Innodb_row_lock_time_avg',
    'Innodb_row_lock_time_max',
    'Innodb_deadlocks',
    'Innodb_log_waits',
    'Innodb_os_log_pending_fsyncs'
)
ORDER BY VARIABLE_NAME;

SELECT '>>SECTION: 10. [HEALTH] Buffer Pool 命中率' AS section;
SELECT
    ROUND(
        (1 - (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_reads')
           / NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_read_requests'),0)
        ) * 100, 4
    ) AS bp_hit_rate_pct,
    ROUND(@@innodb_buffer_pool_size / 1073741824, 2) AS bp_size_gb;

-- ============================================================
-- §3  风险检查 (RISK)
-- ============================================================
SELECT '>>SECTION: 11. [RISK] 当前活跃长查询 (>30s)' AS section;
SELECT
    ID,
    USER,
    HOST,
    DB,
    COMMAND,
    TIME,
    STATE,
    LEFT(INFO, 300)             AS sql_preview
FROM information_schema.PROCESSLIST
WHERE COMMAND != 'Sleep'
  AND TIME > 30
ORDER BY TIME DESC;

SELECT '>>SECTION: 12. [RISK] TOP 10 慢 SQL' AS section;
SELECT
    SCHEMA_NAME                         AS db_name,
    COUNT_STAR                          AS exec_count,
    ROUND(SUM_TIMER_WAIT/1000000000000, 3)     AS total_sec,
    ROUND(AVG_TIMER_WAIT/1000000000000, 3)     AS avg_sec,
    ROUND(MAX_TIMER_WAIT/1000000000000, 3)     AS max_sec,
    SUM_ROWS_EXAMINED                   AS total_rows_scanned,
    SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED AS no_index_used,
    LAST_SEEN,
    LEFT(DIGEST_TEXT, 200)              AS sql_text
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME IS NOT NULL
  AND SCHEMA_NAME NOT IN ('performance_schema','information_schema','mysql','sys')
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;

SELECT '>>SECTION: 13. [RISK] 长事务 (>60s)' AS section;
SELECT
    TRX.TRX_ID,
    TRX.TRX_STATE,
    TRX.TRX_STARTED,
    TIMESTAMPDIFF(SECOND, TRX.TRX_STARTED, NOW()) AS trx_age_sec,
    TRX.TRX_ROWS_LOCKED,
    TRX.TRX_ROWS_MODIFIED,
    PROC.USER,
    PROC.HOST,
    PROC.DB,
    LEFT(PROC.INFO, 200) AS sql_text
FROM information_schema.INNODB_TRX TRX
LEFT JOIN information_schema.PROCESSLIST PROC ON TRX.TRX_MYSQL_THREAD_ID = PROC.ID
WHERE TIMESTAMPDIFF(SECOND, TRX.TRX_STARTED, NOW()) > 60
ORDER BY trx_age_sec DESC;

SELECT '>>SECTION: 14. [RISK] GoldenDB 分布式事务挂起 (悬挂XA)' AS section;
XA RECOVER;

SELECT '>>SECTION: 15. [RISK] 跨分片查询统计 (CN节点)' AS section;
SELECT
    VARIABLE_NAME,
    VARIABLE_VALUE
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
    'goldendb_cross_node_queries',
    'goldendb_cross_node_trx_count',
    'goldendb_multi_node_plan_count',
    'goldendb_broadcast_count',
    'goldendb_gather_count'
)
ORDER BY VARIABLE_NAME;

SELECT '>>SECTION: 16. [RISK] 无主键大表 TOP20' AS section;
SELECT
    T.TABLE_SCHEMA,
    T.TABLE_NAME,
    T.TABLE_ROWS,
    ROUND((T.DATA_LENGTH+T.INDEX_LENGTH)/1073741824, 3) AS size_gb,
    T.ENGINE
FROM information_schema.TABLES T
LEFT JOIN information_schema.TABLE_CONSTRAINTS TC
    ON T.TABLE_SCHEMA = TC.TABLE_SCHEMA
   AND T.TABLE_NAME   = TC.TABLE_NAME
   AND TC.CONSTRAINT_TYPE = 'PRIMARY KEY'
WHERE TC.CONSTRAINT_NAME IS NULL
  AND T.TABLE_TYPE = 'BASE TABLE'
  AND T.TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
ORDER BY (T.DATA_LENGTH+T.INDEX_LENGTH) DESC
LIMIT 20;

-- ============================================================
-- §4  参数异常检查 (PARAMETER)
-- ============================================================
SELECT '>>SECTION: 17. [PARAMETER] 关键参数' AS section;
SELECT VARIABLE_NAME, VARIABLE_VALUE
FROM performance_schema.global_variables
WHERE VARIABLE_NAME IN (
    'innodb_buffer_pool_size','innodb_buffer_pool_instances',
    'innodb_log_file_size','innodb_log_files_in_group',
    'innodb_flush_log_at_trx_commit','innodb_flush_method',
    'innodb_io_capacity','innodb_io_capacity_max',
    'innodb_lock_wait_timeout','innodb_deadlock_detect',
    'max_connections','max_allowed_packet','thread_cache_size',
    'table_open_cache','tmp_table_size','max_heap_table_size',
    'sort_buffer_size','join_buffer_size',
    'binlog_format','binlog_row_image','sync_binlog',
    'expire_logs_days','binlog_expire_logs_seconds',
    'gtid_mode','enforce_gtid_consistency',
    'transaction_isolation','lower_case_table_names',
    'character_set_server','collation_server',
    'goldendb_cn_timeout','goldendb_dn_timeout',
    'goldendb_xa_timeout','goldendb_global_trx_timeout',
    'goldendb_max_packet_size','goldendb_enable_ddl_broadcast',
    'slave_parallel_workers','slave_parallel_type'
)
ORDER BY VARIABLE_NAME;

-- ============================================================
-- §5  空间风险 (SPACE)
-- ============================================================
SELECT '>>SECTION: 18. [SPACE] 各库数据量' AS section;
SELECT
    TABLE_SCHEMA                                 AS db_name,
    COUNT(*)                                     AS table_count,
    ROUND(SUM(DATA_LENGTH)/1073741824, 3)        AS data_gb,
    ROUND(SUM(INDEX_LENGTH)/1073741824, 3)       AS index_gb,
    ROUND(SUM(DATA_FREE)/1073741824, 3)          AS free_gb,
    ROUND(SUM(DATA_LENGTH+INDEX_LENGTH)/1073741824, 3) AS total_gb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
GROUP BY TABLE_SCHEMA
ORDER BY total_gb DESC;

SELECT '>>SECTION: 19. [SPACE] TOP 20 大表' AS section;
SELECT
    TABLE_SCHEMA,
    TABLE_NAME,
    ENGINE,
    TABLE_ROWS,
    ROUND(DATA_LENGTH/1073741824, 3)                 AS data_gb,
    ROUND(INDEX_LENGTH/1073741824, 3)                AS index_gb,
    ROUND((DATA_LENGTH+INDEX_LENGTH)/1073741824, 3)  AS total_gb,
    ROUND(DATA_FREE/NULLIF(DATA_LENGTH+INDEX_LENGTH,0)*100,2) AS fragment_pct
FROM information_schema.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
  AND TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC
LIMIT 20;

SELECT '>>SECTION: 20. [SPACE] Binlog 文件' AS section;
SHOW BINARY LOGS;

SELECT '>>SECTION: 21. [SPACE] GoldenDB 数据节点磁盘分布' AS section;
SELECT * FROM information_schema.GOLDENDB_DN_STATUS;

-- ============================================================
-- §6  HA 复制状态 (HA)
-- ============================================================
SELECT '>>SECTION: 22. [HA] 主库 Binlog 位点' AS section;
SHOW MASTER STATUS;

SELECT '>>SECTION: 23. [HA] 从节点列表' AS section;
SHOW SLAVE HOSTS;

SELECT '>>SECTION: 24. [HA] 主从复制状态' AS section;
SHOW SLAVE STATUS\G

SELECT '>>SECTION: 25. [HA] 复制通道 - 接收状态' AS section;
SELECT
    CHANNEL_NAME,
    SERVICE_STATE,
    SOURCE_UUID,
    LAST_QUEUED_TRANSACTION,
    LAST_QUEUED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP,
    LAST_QUEUED_TRANSACTION_IMMEDIATE_COMMIT_TIMESTAMP
FROM performance_schema.replication_connection_status;

SELECT '>>SECTION: 26. [HA] 复制通道 - 应用状态' AS section;
SELECT
    CHANNEL_NAME,
    WORKER_ID,
    SERVICE_STATE,
    LAST_APPLIED_TRANSACTION,
    LAST_APPLIED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP,
    LAST_APPLIED_TRANSACTION_APPLY_START_TIMESTAMP,
    LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP,
    APPLYING_TRANSACTION
FROM performance_schema.replication_applier_status_by_worker
LIMIT 10;

SELECT '>>SECTION: 27. [HA] MGR / Group Replication 状态' AS section;
SELECT
    MEMBER_ID,
    MEMBER_HOST,
    MEMBER_PORT,
    MEMBER_STATE,
    MEMBER_ROLE,
    MEMBER_VERSION
FROM performance_schema.replication_group_members;

SELECT '>>SECTION: 28. [HA] GoldenDB HA 切换历史' AS section;
SELECT * FROM information_schema.GOLDENDB_HA_HISTORY ORDER BY EVENT_TIME DESC LIMIT 20;

SELECT '>>SECTION: 29. [HA] GoldenDB 节点心跳状态' AS section;
SELECT * FROM information_schema.GOLDENDB_NODE_HEARTBEAT;

-- ============================================================
-- §7  GoldenDB 全局事务 & 分布式特有
-- ============================================================
SELECT '>>SECTION: 30. [DIST] GTM 全局事务状态' AS section;
SELECT * FROM information_schema.GOLDENDB_GTM_STATUS;

SELECT '>>SECTION: 31. [DIST] 分片路由策略' AS section;
SELECT
    SCHEMA_NAME,
    TABLE_NAME,
    SHARD_KEY,
    SHARD_TYPE,
    SHARD_COUNT,
    DN_COUNT
FROM information_schema.GOLDENDB_TABLE_SHARDINFO
ORDER BY SCHEMA_NAME, TABLE_NAME
LIMIT 100;

SELECT '>>SECTION: 32. [DIST] 分片数据倾斜 TOP10' AS section;
SELECT
    NODE_ID,
    SCHEMA_NAME,
    TABLE_NAME,
    ROUND(DATA_SIZE/1073741824, 3)   AS data_gb,
    ROUND(INDEX_SIZE/1073741824, 3)  AS index_gb,
    TABLE_ROWS
FROM information_schema.GOLDENDB_SHARD_SIZE
ORDER BY DATA_SIZE DESC
LIMIT 10;

SELECT '>>SECTION: 33. [DIST] 跨节点死锁历史' AS section;
SELECT
    TRX_ID,
    NODE_ID,
    LOCK_TYPE,
    LOCK_TABLE,
    LOCK_INDEX,
    TRX_STATUS,
    EVENT_TIME
FROM information_schema.GOLDENDB_DEADLOCK_HISTORY
ORDER BY EVENT_TIME DESC
LIMIT 20;

-- ============================================================
-- §8  性能摘要
-- ============================================================
SELECT '>>SECTION: 34. [PERF] 等待事件 TOP10' AS section;
SELECT
    EVENT_NAME,
    COUNT_STAR                              AS count,
    ROUND(SUM_TIMER_WAIT/1000000000000, 3) AS total_sec,
    ROUND(AVG_TIMER_WAIT/1000000000000, 3) AS avg_sec,
    ROUND(MAX_TIMER_WAIT/1000000000000, 3) AS max_sec
FROM performance_schema.events_waits_summary_global_by_event_name
WHERE COUNT_STAR > 100
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;

SELECT '>>SECTION: 35. [PERF] 全表扫描 TOP10' AS section;
SELECT
    OBJECT_SCHEMA,
    OBJECT_NAME,
    COUNT_READ,
    SUM_ROWS_FETCHED,
    SUM_NO_INDEX_USED                   AS full_scan_count,
    SUM_NO_GOOD_INDEX_USED              AS bad_index_count
FROM performance_schema.table_io_waits_summary_by_table
WHERE SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED > 0
  AND OBJECT_SCHEMA NOT IN ('performance_schema','information_schema','mysql','sys')
ORDER BY SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED DESC
LIMIT 10;

-- ============================================================
-- 结束
-- ============================================================
SELECT '============================================================' AS separator;
SELECT CONCAT('GoldenDB 巡检脚本执行完毕  ', NOW()) AS finish_time;
SELECT '============================================================' AS separator;

-- ============================================================
-- ============================================================
-- §9  参数风险评估 (PARAMETER RISK) -- 来源: goldendb_4types.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §9-1  关键参数风险评估（带推荐值与风险判定）
-- ============================================================
SELECT '>>SECTION: 36. [PARAMETER-RISK] 关键参数风险评估（含GoldenDB专属参数）' AS section;
SELECT
    CASE
        WHEN param_name='sync_binlog'                  AND current_val NOT IN ('1')        THEN '[WARNING]  sync_binlog建议=1'
        WHEN param_name='innodb_flush_log_at_trx_commit' AND current_val NOT IN ('1')      THEN '[WARNING]  持久性风险'
        WHEN param_name='gtid_mode'                    AND current_val NOT IN ('ON')        THEN '[INFO]     GTID未开启'
        WHEN param_name='log_bin'                      AND current_val NOT IN ('1','ON')    THEN '[CRITICAL] Binlog未启用'
        WHEN param_name='slow_query_log'               AND current_val NOT IN ('1','ON')    THEN '[WARNING]  慢查询日志未开启'
        WHEN param_name='goldendb_2pc_enable'          AND current_val NOT IN ('1','ON')    THEN '[CRITICAL] 分布式2PC未启用'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    param_name,
    current_val,
    recommend_val,
    description
FROM (
    SELECT 'innodb_flush_log_at_trx_commit' AS param_name, @@innodb_flush_log_at_trx_commit AS current_val,
           '1' AS recommend_val, 'InnoDB事务持久性，1=最安全' AS description
    UNION ALL SELECT 'sync_binlog', @@sync_binlog, '1', 'Binlog刷盘频率，1=最安全'
    UNION ALL SELECT 'log_bin', IF(@@log_bin=1,'1','OFF'), '1', 'Binlog开关，必须启用'
    UNION ALL SELECT 'gtid_mode', @@gtid_mode, 'ON', 'GTID模式，便于主从切换'
    UNION ALL SELECT 'binlog_format', @@binlog_format, 'ROW', '复制格式，ROW最精确'
    UNION ALL SELECT 'slow_query_log', IF(@@slow_query_log,'ON','OFF'), 'ON', '慢查询日志'
    UNION ALL SELECT 'transaction_isolation', @@transaction_isolation, 'REPEATABLE-READ', '事务隔离级别'
    UNION ALL SELECT 'max_connections', @@max_connections, '>500', '最大连接数配置'
    UNION ALL SELECT 'innodb_buffer_pool_size', ROUND(@@innodb_buffer_pool_size/1073741824,1), '物理内存50-70%GB', 'InnoDB缓冲池'
    UNION ALL SELECT 'character_set_server', @@character_set_server, 'utf8mb4', '字符集'
    UNION ALL SELECT 'innodb_lock_wait_timeout', @@innodb_lock_wait_timeout, '30-50', '行锁超时(s)'
    -- GoldenDB 专属参数
    UNION ALL SELECT 'goldendb_cn_timeout', @@goldendb_cn_timeout, '建议>30000(ms)', 'CN节点超时'
    UNION ALL SELECT 'goldendb_global_trx_timeout', @@goldendb_global_trx_timeout, '建议>60000(ms)', '全局事务超时'
) params
ORDER BY risk_level;

-- ============================================================
-- §9-2  内存配置 OOM 风险估算
-- ============================================================
SELECT '>>SECTION: 37. [PARAMETER-RISK] 内存配置 OOM 风险估算' AS section;
SELECT
    CASE
        WHEN per_thread_mb * max_connections / 1024 + bp_gb > bp_gb * 2
            THEN '[WARNING]  线程内存理论峰值较高，高并发下关注OOM'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    ROUND(bp_gb,2)                                              AS innodb_bp_gb,
    per_thread_mb                                               AS per_thread_est_mb,
    max_connections,
    ROUND(per_thread_mb * max_connections / 1024, 2)            AS max_thread_mem_gb,
    '线程内存估算 = sort_buf + join_buf + read_buf + binlog_cache' AS note
FROM (
    SELECT
        @@innodb_buffer_pool_size/1073741824                    AS bp_gb,
        ROUND((@@sort_buffer_size + @@join_buffer_size +
               @@read_buffer_size + @@read_rnd_buffer_size +
               @@binlog_cache_size) / 1048576, 1)              AS per_thread_mb,
        @@max_connections                                        AS max_connections
) t;

-- ============================================================
-- ============================================================
-- §10  空间深度分析 (SPACE DEEP) -- 来源: goldendb_4types.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §10-1  Binlog 保留策略评估
-- ============================================================
SELECT '>>SECTION: 38. [SPACE-DEEP] Binlog 保留策略评估' AS section;
SELECT
    CASE
        WHEN COALESCE(IF(@@expire_logs_days>0,@@expire_logs_days,NULL), @@binlog_expire_logs_seconds/86400) > 30
            THEN '[WARNING]  Binlog保留超30天，磁盘风险'
        WHEN COALESCE(IF(@@expire_logs_days>0,@@expire_logs_days,NULL), @@binlog_expire_logs_seconds/86400) < 3
            THEN '[WARNING]  Binlog保留不足3天，PITR能力弱'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    IF(@@expire_logs_days>0, @@expire_logs_days, NULL)         AS expire_logs_days,
    @@binlog_expire_logs_seconds                                AS expire_logs_secs,
    ROUND(@@max_binlog_size/1048576,0)                         AS max_binlog_mb;

-- ============================================================
-- ============================================================
-- §11  HA 深度分析 (HA DEEP) -- 来源: goldendb_4types.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §11-1  各节点心跳状态（带风险判定）
-- 经验：心跳超时未更新 = 该节点与集群断联，可能触发选主或服务降级
-- ============================================================
SELECT '>>SECTION: 39. [HA-DEEP] GoldenDB 各节点心跳状态（带风险判定）' AS section;
SELECT
    CASE
        WHEN HEARTBEAT_STATUS != 'NORMAL' THEN '[CRITICAL] 节点心跳异常！'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    NODE_ID,
    NODE_TYPE,
    NODE_HOST,
    NODE_PORT,
    HEARTBEAT_STATUS,
    LAST_HEARTBEAT_TIME
FROM information_schema.GOLDENDB_NODE_HEARTBEAT
ORDER BY NODE_TYPE, NODE_ID;

-- ============================================================
-- §11-2  DN 复制 IO/SQL 线程状态精细化分析
-- 经验：GoldenDB 每个DN分片组有独立主从，需逐DN检查
-- ============================================================
SELECT '>>SECTION: 40. [HA-DEEP] DN 复制 IO/SQL 线程状态分析' AS section;
SELECT
    CASE
        WHEN SERVICE_STATE = 'OFF' THEN '[CRITICAL] 复制线程停止！'
        WHEN LAST_ERROR_NUMBER > 0 THEN '[CRITICAL] 复制报错！'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    CHANNEL_NAME,
    'IO_THREAD'                                                 AS thread_type,
    SERVICE_STATE,
    LAST_ERROR_NUMBER,
    LAST_ERROR_MESSAGE,
    LAST_ERROR_TIMESTAMP
FROM performance_schema.replication_connection_status
UNION ALL
SELECT
    CASE
        WHEN SERVICE_STATE = 'OFF' THEN '[CRITICAL] SQL线程停止！'
        WHEN LAST_ERROR_NUMBER > 0 THEN '[CRITICAL] SQL线程错误！'
        ELSE '[INFO]    '
    END,
    CHANNEL_NAME,
    CONCAT('SQL_WORKER_', WORKER_ID),
    SERVICE_STATE,
    LAST_ERROR_NUMBER,
    LAST_ERROR_MESSAGE,
    LAST_ERROR_TIMESTAMP
FROM performance_schema.replication_applier_status_by_worker
ORDER BY risk_level;

-- ============================================================
-- §11-3  GTM 全局事务管理器状态（带风险判定）
-- 经验：GTM 是 GoldenDB 分布式事务的核心，故障导致全局事务无法提交
-- ============================================================
SELECT '>>SECTION: 41. [HA-DEEP] GTM 全局事务管理器状态（带风险判定）' AS section;
SELECT
    CASE
        WHEN STATUS != 'ONLINE' THEN '[CRITICAL] GTM不在线！全局事务无法提交'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    GTM_ID,
    GTM_HOST,
    GTM_PORT,
    STATUS,
    ROLE,
    CURRENT_GTID
FROM information_schema.GOLDENDB_GTM_STATUS;

-- ============================================================
-- §11-4  HA 切换历史（近30条，带风险判定）
-- 经验：频繁切换说明集群不稳定，需排查根因
-- ============================================================
SELECT '>>SECTION: 42. [HA-DEEP] GoldenDB HA 切换历史（近30条，带风险判定）' AS section;
SELECT
    CASE
        WHEN EVENT_TYPE = 'FAILOVER' THEN '[WARNING]  故障切换，检查根因'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    EVENT_TYPE,
    NODE_ID,
    FROM_ROLE,
    TO_ROLE,
    EVENT_TIME,
    RESULT,
    DETAIL
FROM information_schema.GOLDENDB_HA_HISTORY
ORDER BY EVENT_TIME DESC
LIMIT 30;

-- ============================================================
-- §11-5  InnoDB 行锁与死锁风险（DN层核心指标）
-- 经验：分布式长事务锁定资源跨多个 DN，影响范围更大
-- ============================================================
SELECT '>>SECTION: 43. [HA-DEEP] InnoDB 锁风险统计（DN层）' AS section;
SELECT
    CASE
        WHEN VARIABLE_NAME='Innodb_deadlocks'              AND VARIABLE_VALUE > 10 THEN '[WARNING]  死锁频繁'
        WHEN VARIABLE_NAME='Innodb_row_lock_current_waits' AND VARIABLE_VALUE > 10 THEN '[CRITICAL] 大量行锁等待'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    VARIABLE_NAME,
    VARIABLE_VALUE
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
    'Innodb_deadlocks',
    'Innodb_row_lock_waits',
    'Innodb_row_lock_time_avg',
    'Innodb_row_lock_current_waits',
    'Innodb_row_lock_time_max'
)
ORDER BY VARIABLE_VALUE DESC;

SELECT '============================================================' AS sep;
SELECT CONCAT('GoldenDB 综合巡检完成 (inspect + 4types)  ', NOW()) AS finish;
SELECT '============================================================' AS sep;
