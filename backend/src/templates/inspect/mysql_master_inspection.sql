-- ============================================================
-- MySQL 主库综合巡检脚本
-- 适用版本：MySQL 5.7 / 8.0 / 8.4（主库）
-- 执行用户：需 SUPER / REPLICATION CLIENT / PROCESS 权限
-- 执行方式：mysql -uroot -p --default-character-set=utf8mb4 < mysql_inspect.sql
-- ============================================================

SET SESSION group_concat_max_len = 1048576;
SET @inspect_time = NOW();

SELECT '============================================================' AS '===';
SELECT CONCAT('MySQL 综合巡检报告  执行时间: ', NOW()) AS '巡检信息';
SELECT '============================================================' AS '===';

-- ============================================================
-- §1  实例基本信息
-- ============================================================
SELECT '>>SECTION: 1. 实例基本信息' AS section;
SELECT
    @@hostname                          AS hostname,
    @@server_id                         AS server_id,
    @@version                           AS version,
    @@version_comment                   AS version_comment,
    @@datadir                           AS datadir,
    @@basedir                           AS basedir,
    @@port                              AS port,
    @@socket                            AS socket_path,
    @@innodb_data_file_path             AS ibdata_path,
    @@character_set_server              AS charset_server,
    @@collation_server                  AS collation_server,
    @@time_zone                         AS time_zone,
    @@read_only                         AS read_only,
    @@super_read_only                   AS super_read_only;

SELECT '>>SECTION: 2. 运行时长' AS section;
SELECT
    VARIABLE_VALUE                      AS uptime_seconds,
    SEC_TO_TIME(VARIABLE_VALUE)         AS uptime_hhmmss,
    FLOOR(VARIABLE_VALUE/86400)         AS uptime_days
FROM performance_schema.global_status
WHERE VARIABLE_NAME = 'Uptime';

-- ============================================================
-- §2  健康检查 (HEALTH)
-- ============================================================
SELECT '>>SECTION: 3. [HEALTH] 连接数概况' AS section;
SELECT
    (SELECT VARIABLE_VALUE FROM performance_schema.global_status  WHERE VARIABLE_NAME='Threads_connected')       AS threads_connected,
    (SELECT VARIABLE_VALUE FROM performance_schema.global_status  WHERE VARIABLE_NAME='Threads_running')         AS threads_running,
    (SELECT VARIABLE_VALUE FROM performance_schema.global_status  WHERE VARIABLE_NAME='Threads_cached')          AS threads_cached,
    (SELECT VARIABLE_VALUE FROM performance_schema.global_status  WHERE VARIABLE_NAME='Max_used_connections')    AS max_used_connections,
    @@max_connections                                                                                              AS max_connections_limit,
    ROUND((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Threads_connected')
          / @@max_connections * 100, 2)                                                                           AS connection_usage_pct;

SELECT '>>SECTION: 4. [HEALTH] 错误计数器' AS section;
SELECT
    VARIABLE_NAME,
    VARIABLE_VALUE
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
    'Connection_errors_max_connections',
    'Aborted_clients',
    'Aborted_connects',
    'Connection_errors_accept',
    'Connection_errors_internal',
    'Connection_errors_peer_address',
    'Connection_errors_select'
)
ORDER BY VARIABLE_NAME;

SELECT '>>SECTION: 5. [HEALTH] InnoDB 状态关键指标' AS section;
SELECT
    VARIABLE_NAME,
    VARIABLE_VALUE
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
    'Innodb_buffer_pool_reads',
    'Innodb_buffer_pool_read_requests',
    'Innodb_buffer_pool_pages_total',
    'Innodb_buffer_pool_pages_free',
    'Innodb_buffer_pool_pages_dirty',
    'Innodb_buffer_pool_pages_flushed',
    'Innodb_rows_read','Innodb_rows_inserted','Innodb_rows_updated','Innodb_rows_deleted',
    'Innodb_log_waits',
    'Innodb_os_log_pending_fsyncs',
    'Innodb_os_log_pending_writes',
    'Innodb_row_lock_current_waits',
    'Innodb_row_lock_waits',
    'Innodb_row_lock_time_avg',
    'Innodb_row_lock_time_max',
    'Innodb_deadlocks'
)
ORDER BY VARIABLE_NAME;

SELECT '>>SECTION: 6. [HEALTH] Buffer Pool 命中率' AS section;
SELECT
    ROUND(
        ( 1 - (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_reads')
            / NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_read_requests'),0)
        ) * 100, 4
    ) AS bp_hit_rate_pct,
    ROUND(@@innodb_buffer_pool_size/1073741824, 2) AS bp_size_gb;

-- ============================================================
-- §3  风险检查 (RISK)
-- ============================================================
SELECT '>>SECTION: 7. [RISK] 慢查询统计' AS section;
SELECT
    VARIABLE_NAME,
    VARIABLE_VALUE
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN ('Slow_queries','Long_query_time_saved')
UNION ALL
SELECT 'long_query_time_setting', CAST(@@long_query_time AS CHAR)
UNION ALL
SELECT 'slow_query_log', @@slow_query_log
UNION ALL
SELECT 'slow_query_log_file', @@slow_query_log_file;

SELECT '>>SECTION: 8. [RISK] TOP 10 慢 SQL (performance_schema)' AS section;
SELECT
    SCHEMA_NAME                         AS db_name,
    DIGEST_TEXT                         AS sql_text,
    COUNT_STAR                          AS exec_count,
    ROUND(SUM_TIMER_WAIT/1000000000000, 3)    AS total_time_sec,
    ROUND(AVG_TIMER_WAIT/1000000000000, 3)    AS avg_time_sec,
    ROUND(MAX_TIMER_WAIT/1000000000000, 3)    AS max_time_sec,
    SUM_ROWS_EXAMINED                   AS total_rows_examined,
    ROUND(SUM_ROWS_EXAMINED / NULLIF(COUNT_STAR,0), 0) AS avg_rows_examined,
    SUM_ROWS_SENT                       AS total_rows_sent,
    SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED AS no_index_used,
    LAST_SEEN
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME IS NOT NULL
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;

SELECT '>>SECTION: 9. [RISK] 当前长事务 (> 30s)' AS section;
SELECT
    TRX.TRX_ID,
    TRX.TRX_STATE,
    TRX.TRX_STARTED,
    TIMESTAMPDIFF(SECOND, TRX.TRX_STARTED, NOW()) AS trx_age_sec,
    TRX.TRX_ROWS_LOCKED,
    TRX.TRX_ROWS_MODIFIED,
    TRX.TRX_LOCK_STRUCTS,
    PROC.ID                             AS processlist_id,
    PROC.USER,
    PROC.HOST,
    PROC.DB,
    LEFT(PROC.INFO, 200)                AS sql_text
FROM information_schema.INNODB_TRX TRX
JOIN information_schema.PROCESSLIST PROC ON TRX.TRX_MYSQL_THREAD_ID = PROC.ID
WHERE TIMESTAMPDIFF(SECOND, TRX.TRX_STARTED, NOW()) > 30
ORDER BY trx_age_sec DESC;

SELECT '>>SECTION: 10. [RISK] 当前等待超过5秒的锁' AS section;
SELECT
    r.trx_id                            AS waiting_trx_id,
    r.trx_mysql_thread_id               AS waiting_thread,
    r.trx_query                         AS waiting_query,
    b.trx_id                            AS blocking_trx_id,
    b.trx_mysql_thread_id               AS blocking_thread,
    b.trx_query                         AS blocking_query,
    b.trx_started                       AS blocking_start,
    TIMESTAMPDIFF(SECOND,b.trx_started,NOW()) AS block_sec
FROM information_schema.INNODB_LOCK_WAITS w
JOIN information_schema.INNODB_TRX r ON w.requesting_trx_id = r.trx_id
JOIN information_schema.INNODB_TRX b ON w.blocking_trx_id   = b.trx_id
WHERE TIMESTAMPDIFF(SECOND,b.trx_started,NOW()) > 5
ORDER BY block_sec DESC;

SELECT '>>SECTION: 11. [RISK] 高权限账户清单' AS section;
SELECT
    USER,
    HOST,
    Select_priv, Insert_priv, Update_priv, Delete_priv,
    Super_priv, Grant_priv, Shutdown_priv,
    Repl_slave_priv, Repl_client_priv,
    password_expired,
    account_locked
FROM mysql.user
ORDER BY Super_priv DESC, USER;

SELECT '>>SECTION: 12. [RISK] 无主键的表 (TOP 30 大表)' AS section;
SELECT
    T.TABLE_SCHEMA,
    T.TABLE_NAME,
    T.TABLE_ROWS,
    ROUND((T.DATA_LENGTH + T.INDEX_LENGTH)/1073741824, 3) AS size_gb,
    T.ENGINE,
    T.ROW_FORMAT
FROM information_schema.TABLES T
LEFT JOIN information_schema.TABLE_CONSTRAINTS TC
    ON T.TABLE_SCHEMA = TC.TABLE_SCHEMA
   AND T.TABLE_NAME   = TC.TABLE_NAME
   AND TC.CONSTRAINT_TYPE = 'PRIMARY KEY'
WHERE TC.CONSTRAINT_NAME IS NULL
  AND T.TABLE_TYPE = 'BASE TABLE'
  AND T.TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
ORDER BY T.DATA_LENGTH DESC
LIMIT 30;

-- ============================================================
-- §4  参数异常检查 (PARAMETER)
-- ============================================================
SELECT '>>SECTION: 13. [PARAMETER] 关键变量' AS section;
SELECT
    VARIABLE_NAME,
    VARIABLE_VALUE
FROM performance_schema.global_variables
WHERE VARIABLE_NAME IN (
    'innodb_buffer_pool_size','innodb_buffer_pool_instances',
    'innodb_log_file_size','innodb_log_files_in_group','innodb_log_buffer_size',
    'innodb_flush_log_at_trx_commit','innodb_flush_method',
    'innodb_io_capacity','innodb_io_capacity_max',
    'innodb_read_io_threads','innodb_write_io_threads',
    'innodb_max_dirty_pages_pct','innodb_max_dirty_pages_pct_lwm',
    'innodb_lock_wait_timeout','innodb_deadlock_detect',
    'innodb_undo_tablespaces','innodb_undo_log_truncate',
    'max_connections','max_allowed_packet',
    'thread_cache_size','table_open_cache','open_files_limit',
    'query_cache_type','query_cache_size',
    'tmp_table_size','max_heap_table_size',
    'sort_buffer_size','join_buffer_size','read_buffer_size','read_rnd_buffer_size',
    'key_buffer_size',
    'binlog_format','binlog_row_image','sync_binlog','expire_logs_days',
    'gtid_mode','enforce_gtid_consistency',
    'transaction_isolation',
    'sql_mode',
    'character_set_server','collation_server',
    'explicit_defaults_for_timestamp',
    'lower_case_table_names',
    'slave_parallel_workers','slave_parallel_type',
    'group_replication_consistency'
)
ORDER BY VARIABLE_NAME;

-- ============================================================
-- §5  空间风险 (SPACE)
-- ============================================================
SELECT '>>SECTION: 14. [SPACE] 数据库大小汇总' AS section;
SELECT
    TABLE_SCHEMA                        AS db_name,
    COUNT(*)                            AS table_count,
    ROUND(SUM(DATA_LENGTH)/1073741824, 3)        AS data_gb,
    ROUND(SUM(INDEX_LENGTH)/1073741824, 3)       AS index_gb,
    ROUND(SUM(DATA_FREE)/1073741824, 3)          AS free_gb,
    ROUND(SUM(DATA_LENGTH+INDEX_LENGTH)/1073741824, 3) AS total_gb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
GROUP BY TABLE_SCHEMA
ORDER BY total_gb DESC;

SELECT '>>SECTION: 15. [SPACE] TOP 20 大表' AS section;
SELECT
    TABLE_SCHEMA,
    TABLE_NAME,
    ENGINE,
    TABLE_ROWS,
    ROUND((DATA_LENGTH+INDEX_LENGTH)/1073741824, 3)  AS total_gb,
    ROUND(DATA_LENGTH/1073741824, 3)                 AS data_gb,
    ROUND(INDEX_LENGTH/1073741824, 3)                AS index_gb,
    ROUND(DATA_FREE/1073741824, 3)                   AS free_gb,
    ROUND(DATA_FREE/NULLIF(DATA_LENGTH+INDEX_LENGTH,0)*100, 2) AS fragment_pct
FROM information_schema.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
  AND TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC
LIMIT 20;

SELECT '>>SECTION: 16. [SPACE] Binlog 文件列表与大小' AS section;
SHOW BINARY LOGS;

SELECT '>>SECTION: 17. [SPACE] InnoDB 表碎片率 TOP10 (>10%)' AS section;
SELECT
    TABLE_SCHEMA,
    TABLE_NAME,
    TABLE_ROWS,
    ROUND(DATA_LENGTH/1048576, 2)       AS data_mb,
    ROUND(DATA_FREE/1048576, 2)         AS free_mb,
    ROUND(DATA_FREE/NULLIF(DATA_LENGTH,0)*100, 2) AS fragment_pct
FROM information_schema.TABLES
WHERE ENGINE = 'InnoDB'
  AND DATA_FREE > 0
  AND DATA_LENGTH > 10485760
  AND TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
HAVING fragment_pct > 10
ORDER BY free_mb DESC
LIMIT 10;

-- ============================================================
-- §6  主从复制 HA 巡检 (HA)
-- ============================================================
SELECT '>>SECTION: 18. [HA] 主库 Binlog 位点' AS section;
SHOW MASTER STATUS;

SELECT '>>SECTION: 19. [HA] 从库列表 (connected slaves)' AS section;
SHOW SLAVE HOSTS;

SELECT '>>SECTION: 20. [HA] 主库复制相关配置' AS section;
SELECT
    VARIABLE_NAME,
    VARIABLE_VALUE
FROM performance_schema.global_variables
WHERE VARIABLE_NAME IN (
    'server_id','log_bin','binlog_format','binlog_row_image',
    'sync_binlog','expire_logs_days','binlog_expire_logs_seconds',
    'max_binlog_size','binlog_cache_size',
    'gtid_mode','enforce_gtid_consistency','gtid_executed',
    'master_info_repository','relay_log_info_repository',
    'log_slave_updates','log_replica_updates'
)
ORDER BY VARIABLE_NAME;

SELECT '>>SECTION: 21. [HA] Group Replication / MGR 状态' AS section;
SELECT
    MEMBER_ID,
    MEMBER_HOST,
    MEMBER_PORT,
    MEMBER_STATE,
    MEMBER_ROLE,
    MEMBER_VERSION
FROM performance_schema.replication_group_members;

SELECT '>>SECTION: 22. [HA] MGR 复制连接' AS section;
SELECT
    CHANNEL_NAME,
    MEMBER_ID,
    COUNT_TRANSACTIONS_IN_QUEUE,
    COUNT_TRANSACTIONS_CHECKED,
    COUNT_CONFLICTS_DETECTED,
    COUNT_TRANSACTIONS_ROWS_VALIDATING,
    TRANSACTIONS_COMMITTED_ALL_MEMBERS,
    LAST_CONFLICT_FREE_TRANSACTION,
    COUNT_TRANSACTIONS_REMOTE_IN_APPLIER_QUEUE,
    COUNT_TRANSACTIONS_REMOTE_APPLIED,
    COUNT_TRANSACTIONS_LOCAL_PROPOSED,
    COUNT_TRANSACTIONS_LOCAL_ROLLBACK
FROM performance_schema.replication_group_member_stats;

-- ============================================================
-- §7  从库状态（如脚本在从库执行）
-- ============================================================
SELECT '>>SECTION: 23. [HA] 从库复制状态 (SHOW SLAVE STATUS)' AS section;
SHOW SLAVE STATUS\G

SELECT '>>SECTION: 24. [HA] 复制通道延迟' AS section;
SELECT
    CHANNEL_NAME,
    SERVICE_STATE,
    SOURCE_UUID,
    TRANSPORT_RETRY_COUNT,
    TIME_SINCE_LAST_MESSAGE,
    LAST_QUEUED_TRANSACTION,
    LAST_QUEUED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP,
    LAST_QUEUED_TRANSACTION_IMMEDIATE_COMMIT_TIMESTAMP,
    LAST_QUEUED_TRANSACTION_START_QUEUE_TIMESTAMP
FROM performance_schema.replication_connection_status;

SELECT
    CHANNEL_NAME,
    SERVICE_STATE,
    LAST_APPLIED_TRANSACTION,
    LAST_APPLIED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP,
    LAST_APPLIED_TRANSACTION_APPLY_START_TIMESTAMP,
    LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP,
    APPLYING_TRANSACTION,
    APPLYING_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP
FROM performance_schema.replication_applier_status_by_worker
LIMIT 10;

-- ============================================================
-- §8  性能摘要
-- ============================================================
SELECT '>>SECTION: 25. [PERF] 等待事件 TOP10' AS section;
SELECT
    EVENT_NAME,
    COUNT_STAR,
    SUM_TIMER_WAIT/1000000000000                AS total_wait_sec,
    AVG_TIMER_WAIT/1000000000000                AS avg_wait_sec,
    MAX_TIMER_WAIT/1000000000000                AS max_wait_sec
FROM performance_schema.events_waits_summary_global_by_event_name
WHERE COUNT_STAR > 0
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;

SELECT '>>SECTION: 26. [PERF] 全表扫描 TOP10' AS section;
SELECT
    OBJECT_SCHEMA,
    OBJECT_NAME,
    COUNT_READ,
    COUNT_WRITE,
    COUNT_FETCH,
    SUM_ROWS_FETCHED,
    SUM_NO_INDEX_USED,
    SUM_NO_GOOD_INDEX_USED
FROM performance_schema.table_io_waits_summary_by_table
WHERE SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED > 0
  AND OBJECT_SCHEMA NOT IN ('performance_schema','information_schema','mysql','sys')
ORDER BY SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED DESC
LIMIT 10;

SELECT '>>SECTION: 27. [PERF] 文件IO TOP10' AS section;
SELECT
    FILE_NAME,
    COUNT_READ,
    SUM_NUMBER_OF_BYTES_READ/1048576      AS read_mb,
    COUNT_WRITE,
    SUM_NUMBER_OF_BYTES_WRITE/1048576     AS write_mb,
    SUM_TIMER_READ/1000000000             AS read_ms,
    SUM_TIMER_WRITE/1000000000            AS write_ms
FROM performance_schema.file_summary_by_instance
ORDER BY SUM_NUMBER_OF_BYTES_READ + SUM_NUMBER_OF_BYTES_WRITE DESC
LIMIT 10;

-- ============================================================
-- 结束
-- ============================================================
SELECT '============================================================' AS '===';
SELECT CONCAT('MySQL 巡检脚本执行完毕  ', NOW()) AS '完成时间';
SELECT '============================================================' AS '===';

-- ============================================================
-- ============================================================
-- §9  深度风险评估 (RISK DEEP) -- 来源: mysql_risk_parameter.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §9-1  连接数使用率风险（带阈值判定）
-- 经验：超过80%必须立即扩容或限流，超90%即将拒绝新连接
-- ============================================================
SELECT '>>SECTION: 28. [RISK-DEEP] 连接数使用率（带风险判定）' AS section;
SELECT
    CASE
        WHEN ROUND(curr/max_conn*100,2) >= 90 THEN '[CRITICAL]'
        WHEN ROUND(curr/max_conn*100,2) >= 80 THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    curr                                                        AS threads_connected,
    running                                                     AS threads_running,
    max_used                                                    AS max_used_connections,
    max_conn                                                    AS max_connections,
    ROUND(curr/max_conn*100, 2)                                 AS usage_pct,
    CASE
        WHEN ROUND(curr/max_conn*100,2) >= 80 THEN '连接数告警，检查连接池配置或是否存在连接泄漏'
        ELSE '连接数正常'
    END                                                         AS remark
FROM (
    SELECT
        (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Threads_connected')    AS curr,
        (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Threads_running')      AS running,
        (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Max_used_connections') AS max_used,
        @@max_connections                                                                                          AS max_conn
) t;

-- ============================================================
-- §9-2  Aborted 连接与错误（带风险判定）
-- 经验：Aborted_connects高 = 认证失败或网络问题；Aborted_clients高 = 连接池 timeout 设置不当
-- ============================================================
SELECT '>>SECTION: 29. [RISK-DEEP] 连接中断与错误统计（带风险判定）' AS section;
SELECT
    CASE
        WHEN VARIABLE_NAME='Aborted_connects'  AND VARIABLE_VALUE > 100 THEN '[WARNING]  频繁认证失败，检查账号/密码/防火墙'
        WHEN VARIABLE_NAME='Aborted_clients'   AND VARIABLE_VALUE > 1000 THEN '[WARNING]  大量客户端异常断开，检查wait_timeout'
        WHEN VARIABLE_NAME='Connection_errors_max_connections' AND VARIABLE_VALUE > 0 THEN '[CRITICAL] 已出现因连接数满拒绝的情况'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    VARIABLE_NAME,
    VARIABLE_VALUE
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
    'Aborted_clients','Aborted_connects',
    'Connection_errors_max_connections',
    'Connection_errors_internal',
    'Connection_errors_accept'
)
ORDER BY VARIABLE_VALUE DESC;

-- ============================================================
-- §9-3  InnoDB 行锁等待与死锁（带阈值判定）
-- 经验：死锁每天 > 10次需代码审查；行锁平均等待 > 100ms 需索引优化
-- ============================================================
SELECT '>>SECTION: 30. [RISK-DEEP] InnoDB 锁等待与死锁统计（带风险判定）' AS section;
SELECT
    CASE
        WHEN VARIABLE_NAME='Innodb_deadlocks'              AND VARIABLE_VALUE > 10 THEN '[WARNING]  死锁频繁，检查事务顺序和索引'
        WHEN VARIABLE_NAME='Innodb_row_lock_time_avg'      AND VARIABLE_VALUE > 100 THEN '[WARNING]  平均行锁等待>100ms，检查索引'
        WHEN VARIABLE_NAME='Innodb_row_lock_current_waits' AND VARIABLE_VALUE > 5  THEN '[CRITICAL] 当前有大量行锁等待'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    VARIABLE_NAME,
    VARIABLE_VALUE,
    CASE VARIABLE_NAME
        WHEN 'Innodb_deadlocks'              THEN '总死锁次数（自启动以来）'
        WHEN 'Innodb_row_lock_waits'         THEN '总行锁等待次数'
        WHEN 'Innodb_row_lock_time_avg'      THEN '平均行锁等待时间(ms)'
        WHEN 'Innodb_row_lock_time_max'      THEN '最大行锁等待时间(ms)'
        WHEN 'Innodb_row_lock_current_waits' THEN '当前等待行锁的数量'
        ELSE ''
    END                                                         AS description
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
    'Innodb_deadlocks',
    'Innodb_row_lock_waits',
    'Innodb_row_lock_time_avg',
    'Innodb_row_lock_time_max',
    'Innodb_row_lock_current_waits'
);

-- ============================================================
-- §9-4  慢查询率（带风险判定）
-- 经验：慢查询/总查询 > 0.01% 必须优化；slow_query_log 必须开启
-- ============================================================
SELECT '>>SECTION: 31. [RISK-DEEP] 慢查询风险综合评估' AS section;
SELECT
    CASE
        WHEN slow_log_enabled = 'OFF' THEN '[WARNING]  慢查询日志未开启'
        WHEN slow_ratio > 0.01        THEN '[WARNING]  慢查询率偏高'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    slow_queries,
    questions,
    ROUND(slow_ratio * 100, 6)                                  AS slow_query_pct,
    long_query_time_sec,
    slow_log_enabled,
    slow_log_file
FROM (
    SELECT
        (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Slow_queries')  AS slow_queries,
        (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Questions')     AS questions,
        (SELECT VARIABLE_VALUE+0 FROM performance_schema.global_status WHERE VARIABLE_NAME='Slow_queries') /
        NULLIF((SELECT VARIABLE_VALUE+0 FROM performance_schema.global_status WHERE VARIABLE_NAME='Questions'),0) AS slow_ratio,
        @@long_query_time                                                                                   AS long_query_time_sec,
        @@slow_query_log                                                                                    AS slow_log_enabled,
        @@slow_query_log_file                                                                               AS slow_log_file
) t;

-- ============================================================
-- §9-5  TOP 10 慢 SQL（带 [CRITICAL]/[WARNING] 标注）
-- ============================================================
SELECT '>>SECTION: 32. [RISK-DEEP] TOP 10 慢 SQL（带风险标注）' AS section;
SELECT
    CASE
        WHEN ROUND(avg_timer_wait/1000000000000,3) > 10 THEN '[CRITICAL]'
        WHEN ROUND(avg_timer_wait/1000000000000,3) > 1  THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    SCHEMA_NAME                                                 AS db_name,
    COUNT_STAR                                                  AS exec_count,
    ROUND(SUM_TIMER_WAIT/1000000000000, 2)                      AS total_sec,
    ROUND(AVG_TIMER_WAIT/1000000000000, 3)                      AS avg_sec,
    ROUND(MAX_TIMER_WAIT/1000000000000, 3)                      AS max_sec,
    SUM_ROWS_EXAMINED                                           AS rows_examined,
    ROUND(SUM_ROWS_EXAMINED/NULLIF(COUNT_STAR,0))               AS avg_rows_examined,
    SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED                  AS no_index_cnt,
    LEFT(DIGEST_TEXT, 150)                                      AS sql_text
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME NOT IN ('performance_schema','information_schema','mysql','sys')
  AND COUNT_STAR > 3
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;

-- ============================================================
-- ============================================================
-- §10  参数风险评估 (PARAMETER RISK) -- 来源: mysql_risk_parameter.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §10-1  InnoDB Buffer Pool 配置风险
-- 经验：BP 应为物理内存 60-80%；命中率 < 95% 必须扩容
-- ============================================================
SELECT '>>SECTION: 33. [PARAMETER-RISK] InnoDB Buffer Pool 参数评估' AS section;
SELECT
    CASE
        WHEN hit_rate_pct < 95 THEN '[WARNING]  命中率 <95%，强烈建议扩大 innodb_buffer_pool_size'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    ROUND(bp_size_gb, 2)                                        AS bp_size_gb,
    instances                                                   AS bp_instances,
    hit_rate_pct                                                AS bp_hit_rate_pct,
    'BP命中率=1-物理读/逻辑读，低于95%性能严重下降'            AS remark
FROM (
    SELECT
        @@innodb_buffer_pool_size / 1073741824                   AS bp_size_gb,
        @@innodb_buffer_pool_instances                            AS instances,
        ROUND(
            (1 - (SELECT VARIABLE_VALUE+0 FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_reads')
               / NULLIF((SELECT VARIABLE_VALUE+0 FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_read_requests'),0)
            ) * 100, 4
        )                                                         AS hit_rate_pct
    FROM DUAL
) t;

-- ============================================================
-- §10-2  关键参数对比推荐值（带风险判定）
-- ============================================================
SELECT '>>SECTION: 34. [PARAMETER-RISK] 关键参数异常对比（带推荐值）' AS section;
SELECT
    CASE
        WHEN param_name = 'sync_binlog'      AND current_val NOT IN ('1') THEN '[WARNING]  sync_binlog建议=1保障持久性'
        WHEN param_name = 'innodb_flush_log_at_trx_commit' AND current_val NOT IN ('1') THEN '[WARNING]  建议=1，当前设置有数据丢失风险'
        WHEN param_name = 'binlog_format'    AND current_val NOT IN ('ROW') THEN '[WARNING]  主从建议binlog_format=ROW'
        WHEN param_name = 'gtid_mode'        AND current_val NOT IN ('ON') THEN '[INFO]     建议启用GTID便于主从切换'
        WHEN param_name = 'slow_query_log'   AND current_val NOT IN ('1','ON') THEN '[WARNING]  慢查询日志未开启'
        WHEN param_name = 'log_bin'          AND current_val NOT IN ('1','ON') THEN '[CRITICAL] Binlog未开启，无法复制恢复'
        WHEN param_name = 'innodb_doublewrite' AND current_val NOT IN ('1','ON') THEN '[WARNING]  关闭了双写缓冲区，存在数据页损坏风险'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    param_name,
    current_val,
    recommend_val,
    description
FROM (
    SELECT 'innodb_flush_log_at_trx_commit' AS param_name, @@innodb_flush_log_at_trx_commit AS current_val,
           '1' AS recommend_val, '控制redo log刷盘策略，1=每次提交刷盘(最安全)' AS description
    UNION ALL SELECT 'sync_binlog', @@sync_binlog, '1', '控制binlog刷盘频率，1=最安全'
    UNION ALL SELECT 'binlog_format', @@binlog_format, 'ROW', '主从复制格式，ROW最精确'
    UNION ALL SELECT 'gtid_mode', @@gtid_mode, 'ON', 'GTID模式，简化主从切换和故障恢复'
    UNION ALL SELECT 'log_bin', IF(@@log_bin=1,'1','OFF'), '1', 'Binlog开关，必须开启'
    UNION ALL SELECT 'slow_query_log', IF(@@slow_query_log=1,'1','OFF'), '1', '慢查询日志，必须开启'
    UNION ALL SELECT 'innodb_doublewrite', IF(@@innodb_doublewrite=1,'1','OFF'), '1', '双写缓冲，防止数据页部分写'
    UNION ALL SELECT 'innodb_lock_wait_timeout', @@innodb_lock_wait_timeout, '30-50', '行锁超时(s)，过大影响业务'
    UNION ALL SELECT 'max_allowed_packet', @@max_allowed_packet, '67108864(64MB)', '最大包大小'
    UNION ALL SELECT 'character_set_server', @@character_set_server, 'utf8mb4', '服务器字符集'
    UNION ALL SELECT 'transaction_isolation', @@transaction_isolation, 'REPEATABLE-READ', '事务隔离级别'
    UNION ALL SELECT 'innodb_undo_log_truncate', @@innodb_undo_log_truncate, '1', 'UNDO日志自动收缩（8.0）'
    UNION ALL SELECT 'binlog_row_image', @@binlog_row_image, 'FULL', 'ROW格式binlog列记录策略'
    UNION ALL SELECT 'expire_logs_days', IF(@@expire_logs_days>0,@@expire_logs_days,@@binlog_expire_logs_seconds/86400), '7-14', 'Binlog保留天数'
) params
ORDER BY risk_level;

-- ============================================================
-- §10-3  内存配置 OOM 风险估算
-- 经验：线程内存 × max_connections 可能远超物理内存
-- ============================================================
SELECT '>>SECTION: 35. [PARAMETER-RISK] 内存配置 OOM 风险估算' AS section;
SELECT
    CASE
        WHEN (theoretical_max_mem_gb * 0.8) > innodb_bp_gb * 2 THEN '[WARNING]  线程内存理论峰值偏高，高并发下关注OOM'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    ROUND(innodb_bp_gb, 2)                                      AS innodb_bp_gb,
    per_thread_mb                                               AS per_thread_est_mb,
    max_connections,
    ROUND(per_thread_mb * max_connections / 1024, 2)            AS max_thread_mem_gb,
    ROUND(theoretical_max_mem_gb, 2)                            AS theoretical_max_gb,
    '理论最大内存 = BP + (线程内存*max_connections)'           AS formula
FROM (
    SELECT
        @@innodb_buffer_pool_size / 1073741824                   AS innodb_bp_gb,
        ROUND((@@sort_buffer_size + @@read_buffer_size +
               @@read_rnd_buffer_size + @@join_buffer_size +
               @@binlog_cache_size + 2097152) / 1048576, 1)     AS per_thread_mb,
        @@max_connections                                         AS max_connections,
        ( @@innodb_buffer_pool_size +
          (@@sort_buffer_size + @@read_buffer_size +
           @@read_rnd_buffer_size + @@join_buffer_size +
           @@binlog_cache_size) * @@max_connections
        ) / 1073741824                                           AS theoretical_max_mem_gb
    FROM DUAL
) t;

-- ============================================================
-- ============================================================
-- §11  空间深度分析 (SPACE DEEP) -- 来源: mysql_space_ha.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §11-1  各库空间总量与碎片（带风险判定）
-- 经验：DATA_FREE 过大说明碎片严重，影响全表扫描性能
-- ============================================================
SELECT '>>SECTION: 36. [SPACE-DEEP] 各库空间总量与碎片（带风险判定）' AS section;
SELECT
    CASE
        WHEN total_gb > 1000 THEN '[WARNING]  单库超1TB，考虑分库或分区'
        WHEN fragment_pct > 30 THEN '[WARNING]  碎片率>30%，建议 OPTIMIZE TABLE 或重建'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    TABLE_SCHEMA                                                AS db_name,
    table_cnt,
    ROUND(data_gb, 3)                                           AS data_gb,
    ROUND(index_gb, 3)                                          AS index_gb,
    ROUND(total_gb, 3)                                          AS total_gb,
    ROUND(free_gb, 3)                                           AS free_gb_fragment,
    ROUND(fragment_pct, 2)                                      AS fragment_pct
FROM (
    SELECT
        TABLE_SCHEMA,
        COUNT(*)                                                 AS table_cnt,
        SUM(DATA_LENGTH) / 1073741824                           AS data_gb,
        SUM(INDEX_LENGTH) / 1073741824                          AS index_gb,
        SUM(DATA_LENGTH + INDEX_LENGTH) / 1073741824            AS total_gb,
        SUM(DATA_FREE) / 1073741824                             AS free_gb,
        SUM(DATA_FREE) / NULLIF(SUM(DATA_LENGTH + INDEX_LENGTH),0) * 100 AS fragment_pct
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
    GROUP BY TABLE_SCHEMA
) t
ORDER BY total_gb DESC;

-- ============================================================
-- §11-2  TOP 30 大表（含碎片率分析）
-- 经验：碎片率 > 20% 的表执行大量全表扫描时性能下降明显
-- ============================================================
SELECT '>>SECTION: 37. [SPACE-DEEP] TOP 30 大表（碎片分析）' AS section;
SELECT
    CASE
        WHEN (DATA_FREE / NULLIF(DATA_LENGTH+INDEX_LENGTH,0) * 100) > 30 AND
             (DATA_LENGTH+INDEX_LENGTH) > 1073741824 THEN '[WARNING]  大表高碎片，建议低峰期 OPTIMIZE'
        WHEN (DATA_LENGTH+INDEX_LENGTH) / 1073741824 > 500 THEN '[WARNING]  超大表，评估分区/归档策略'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    TABLE_SCHEMA,
    TABLE_NAME,
    ENGINE,
    TABLE_ROWS,
    ROUND(DATA_LENGTH/1073741824, 3)                            AS data_gb,
    ROUND(INDEX_LENGTH/1073741824, 3)                           AS index_gb,
    ROUND((DATA_LENGTH+INDEX_LENGTH)/1073741824, 3)             AS total_gb,
    ROUND(DATA_FREE/1073741824, 3)                              AS free_gb,
    ROUND(DATA_FREE/NULLIF(DATA_LENGTH+INDEX_LENGTH,0)*100, 2) AS fragment_pct,
    ROW_FORMAT
FROM information_schema.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
  AND TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC
LIMIT 30;

-- ============================================================
-- §11-3  Binlog 保留策略评估
-- 经验：Binlog保留天数过长导致磁盘突然爆满，是常见生产事故
-- ============================================================
SELECT '>>SECTION: 38. [SPACE-DEEP] Binlog 保留策略评估' AS section;
SELECT
    CASE
        WHEN COALESCE(expire_days, expire_secs/86400) > 30 THEN '[WARNING]  保留天数过长(>30天)，磁盘风险高'
        WHEN COALESCE(expire_days, expire_secs/86400) < 3  THEN '[WARNING]  保留天数过短(<3天)，难以进行时间点恢复'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    expire_days,
    expire_secs,
    ROUND(COALESCE(expire_days, expire_secs/86400), 1)         AS effective_days,
    max_binlog_size_mb,
    sync_binlog_val
FROM (
    SELECT
        IF(@@expire_logs_days > 0, @@expire_logs_days, NULL)    AS expire_days,
        @@binlog_expire_logs_seconds                             AS expire_secs,
        ROUND(@@max_binlog_size / 1048576, 0)                   AS max_binlog_size_mb,
        @@sync_binlog                                            AS sync_binlog_val
) t;

-- ============================================================
-- §11-4  InnoDB 临时表空间使用
-- 经验：IBTMP1 文件无限增长是 MySQL 重大问题，重启才能释放
-- ============================================================
SELECT '>>SECTION: 39. [SPACE-DEEP] InnoDB 临时表空间使用（IBTMP1）' AS section;
SELECT
    CASE
        WHEN current_size_gb > 10 THEN '[CRITICAL] IBTMP1已超10GB，检查是否有异常大查询'
        WHEN current_size_gb > 2  THEN '[WARNING]  IBTMP1已超2GB，监控增长趋势'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    ROUND(current_size_gb, 3)                                   AS ibtmp1_gb,
    '临时表文件只增不减，重启实例才能释放，需监控大查询'       AS remark
FROM (
    SELECT
        SUM(ALLOCATED_SIZE) / 1073741824                        AS current_size_gb
    FROM information_schema.INNODB_TEMP_TABLE_INFO
) t;

-- ============================================================
-- ============================================================
-- §12  HA 深度分析 (HA DEEP) -- 来源: mysql_space_ha.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §12-1  复制线程状态精细化分析（IO/SQL 线程风险判定）
-- 经验：IO线程断开通常是网络/权限问题；SQL线程停止通常是SQL错误
-- ============================================================
SELECT '>>SECTION: 40. [HA-DEEP] 复制 IO/SQL 线程状态（带风险判定）' AS section;
SELECT
    CASE
        WHEN SERVICE_STATE = 'OFF' THEN '[CRITICAL]'
        WHEN LAST_ERROR_NUMBER > 0 THEN '[CRITICAL]'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    CHANNEL_NAME,
    'IO_THREAD'                                                 AS thread_type,
    SERVICE_STATE,
    SOURCE_UUID,
    TRANSPORT_RETRY_COUNT,
    LAST_ERROR_NUMBER,
    LAST_ERROR_MESSAGE,
    LAST_ERROR_TIMESTAMP
FROM performance_schema.replication_connection_status
UNION ALL
SELECT
    CASE
        WHEN SERVICE_STATE = 'OFF' THEN '[CRITICAL]'
        WHEN LAST_ERROR_NUMBER > 0 THEN '[CRITICAL]'
        ELSE '[INFO]    '
    END,
    CHANNEL_NAME,
    CONCAT('SQL_THREAD_WORKER_', WORKER_ID),
    SERVICE_STATE,
    NULL,
    0,
    LAST_ERROR_NUMBER,
    LAST_ERROR_MESSAGE,
    LAST_ERROR_TIMESTAMP
FROM performance_schema.replication_applier_status_by_worker
ORDER BY risk_level;

-- ============================================================
-- §12-2  GTID 状态检查
-- 经验：executed_gtid_set 出现 gap = 复制跳过了事务，数据可能不一致
-- ============================================================
SELECT '>>SECTION: 41. [HA-DEEP] GTID 配置与状态评估' AS section;
SELECT
    CASE
        WHEN gtid_mode != 'ON' THEN '[INFO]     GTID未启用，依赖位点复制'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    gtid_mode,
    enforce_gtid_consistency,
    master_auto_position,
    LENGTH(gtid_executed)                                       AS gtid_executed_len,
    IF(LENGTH(gtid_executed) > 200,
       CONCAT(LEFT(gtid_executed,200),'...'),
       gtid_executed)                                           AS gtid_executed_sample
FROM (
    SELECT
        @@gtid_mode                                              AS gtid_mode,
        @@enforce_gtid_consistency                               AS enforce_gtid_consistency,
        @@master_auto_position                                   AS master_auto_position,
        (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='GTID_EXECUTED') AS gtid_executed
) t;

-- ============================================================
-- §12-3  半同步复制状态（如启用）
-- 经验：半同步退化为异步时未必报警，需主动检测
-- ============================================================
SELECT '>>SECTION: 42. [HA-DEEP] 半同步复制状态（如启用）' AS section;
SELECT
    VARIABLE_NAME,
    VARIABLE_VALUE,
    CASE
        WHEN VARIABLE_NAME='Rpl_semi_sync_master_status' AND VARIABLE_VALUE='OFF' THEN '[WARNING]  半同步已降级为异步，数据安全性降低'
        WHEN VARIABLE_NAME='Rpl_semi_sync_master_clients' AND VARIABLE_VALUE='0'  THEN '[WARNING]  无从库处于半同步状态'
        ELSE '[INFO]    '
    END                                                         AS risk_level
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
    'Rpl_semi_sync_master_status',
    'Rpl_semi_sync_master_clients',
    'Rpl_semi_sync_master_net_avg_wait_time',
    'Rpl_semi_sync_master_no_tx',
    'Rpl_semi_sync_master_yes_tx',
    'Rpl_semi_sync_master_tx_avg_wait_time'
)
ORDER BY VARIABLE_NAME;

SELECT '============================================================' AS '===';
SELECT CONCAT('MySQL 综合巡检完成 (inspect + risk_parameter + space_ha)  ', NOW()) AS '完成时间';
SELECT '============================================================' AS '===';
