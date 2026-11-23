-- ============================================================
-- PostgreSQL 综合巡检脚本
-- 适用版本：PostgreSQL 10 / 11 / 12 / 13 / 14 / 15 / 16
-- 执行用户：superuser 或具备 pg_monitor / pg_stat_scan_tables 权限
-- 执行方式：psql -U postgres -f pg_inspect.sql
-- ============================================================

\set QUIET on
\pset format aligned
\pset border 1
\pset null '<NULL>'
\timing on

\echo '============================================================'
\echo 'PostgreSQL 综合巡检报告'
\echo '============================================================'
SELECT current_timestamp AS exec_time;

-- ============================================================
-- §1  实例基本信息
-- ============================================================
\echo '>>SECTION: 1. 实例基本信息'
SELECT
    current_database()                          AS current_db,
    pg_postmaster_start_time()                  AS start_time,
    now() - pg_postmaster_start_time()          AS uptime,
    version()                                   AS pg_version,
    inet_server_addr()                          AS server_addr,
    inet_server_port()                          AS server_port,
    pg_is_in_recovery()                         AS is_standby,
    current_setting('data_directory')           AS data_dir,
    pg_size_pretty(pg_database_size(current_database())) AS current_db_size;

\echo '>>SECTION: 2. 所有数据库列表'
SELECT
    datname             AS db_name,
    pg_size_pretty(pg_database_size(datname)) AS size,
    datcollate          AS collation,
    datconnlimit        AS conn_limit,
    datacl              AS acl
FROM pg_database
WHERE datistemplate = false
ORDER BY pg_database_size(datname) DESC;

-- ============================================================
-- §2  健康检查 (HEALTH)
-- ============================================================
\echo '>>SECTION: 3. [HEALTH] 连接状态概况'
SELECT
    state,
    wait_event_type,
    wait_event,
    COUNT(*)                AS cnt,
    MAX(now() - state_change) AS max_duration
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
GROUP BY state, wait_event_type, wait_event
ORDER BY cnt DESC;

\echo '>>SECTION: 4. [HEALTH] 长事务 (>60s)'
SELECT
    pid,
    usename,
    application_name,
    client_addr,
    state,
    wait_event_type,
    wait_event,
    now() - xact_start           AS txn_duration,
    now() - query_start          AS query_duration,
    LEFT(query, 200)             AS query_preview
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
  AND now() - xact_start > interval '60 seconds'
  AND pid <> pg_backend_pid()
ORDER BY txn_duration DESC;

\echo '>>SECTION: 5. [HEALTH] 锁等待'
SELECT
    blocked.pid                    AS blocked_pid,
    blocked.usename                AS blocked_user,
    blocked.query                  AS blocked_query,
    blocking.pid                   AS blocking_pid,
    blocking.usename               AS blocking_user,
    blocking.query                 AS blocking_query,
    now() - blocked.query_start    AS wait_duration
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking
    ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0
ORDER BY wait_duration DESC;

\echo '>>SECTION: 6. [HEALTH] 数据库统计 (事务/缓存命中率)'
SELECT
    datname             AS db_name,
    numbackends         AS connections,
    xact_commit,
    xact_rollback,
    blks_read,
    blks_hit,
    ROUND(blks_hit::numeric / NULLIF(blks_hit+blks_read, 0) * 100, 4) AS cache_hit_pct,
    tup_returned,
    tup_fetched,
    tup_inserted,
    tup_updated,
    tup_deleted,
    conflicts,
    temp_files,
    pg_size_pretty(temp_bytes) AS temp_size,
    deadlocks,
    stats_reset
FROM pg_stat_database
WHERE datname NOT IN ('template0','template1')
ORDER BY xact_commit DESC;

-- ============================================================
-- §3  风险检查 (RISK)
-- ============================================================
\echo '>>SECTION: 7. [RISK] TOP 10 慢 SQL (pg_stat_statements)'
SELECT
    userid::regrole      AS user_name,
    dbid::regdatabase    AS db_name,
    calls,
    ROUND(total_exec_time/1000::numeric, 3)    AS total_sec,
    ROUND(mean_exec_time /1000::numeric, 3)    AS avg_sec,
    ROUND(max_exec_time  /1000::numeric, 3)    AS max_sec,
    ROUND(stddev_exec_time/1000::numeric, 3)   AS stddev_sec,
    rows,
    shared_blks_hit,
    shared_blks_read,
    ROUND(shared_blks_hit::numeric / NULLIF(shared_blks_hit+shared_blks_read, 0)*100, 2) AS blk_hit_pct,
    temp_blks_read,
    temp_blks_written,
    LEFT(query, 200)     AS query_text
FROM pg_stat_statements
WHERE calls > 5
ORDER BY total_exec_time DESC
LIMIT 10;

\echo '>>SECTION: 8. [RISK] 高 dead_tuple 比率表 (需 VACUUM)'
SELECT
    schemaname,
    relname                 AS table_name,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2) AS dead_pct,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY dead_pct DESC
LIMIT 20;

\echo '>>SECTION: 9. [RISK] 表膨胀 TOP10'
SELECT
    schemaname,
    relname                 AS table_name,
    pg_size_pretty(pg_relation_size(relid))         AS table_size,
    pg_size_pretty(pg_total_relation_size(relid))   AS total_size,
    n_live_tup,
    n_dead_tup,
    seq_scan,
    idx_scan
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 10;

\echo '>>SECTION: 10. [RISK] 未使用索引 (idx_scan=0, size>1MB)'
SELECT
    schemaname,
    relname         AS table_name,
    indexrelname    AS index_name,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND pg_relation_size(indexrelid) > 1048576
  AND NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conindid = indexrelid
  )
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;

\echo '>>SECTION: 11. [RISK] 超级用户账户列表'
SELECT
    usename,
    usesuper,
    usecreatedb,
    usecreaterole,
    usebypassrls,
    valuntil           AS password_expiry,
    useconfig
FROM pg_user
ORDER BY usesuper DESC, usename;

-- ============================================================
-- §4  参数异常检查 (PARAMETER)
-- ============================================================
\echo '>>SECTION: 12. [PARAMETER] 关键配置参数'
SELECT name, setting, unit, context, boot_val, reset_val, source
FROM pg_settings
WHERE name IN (
    'max_connections','superuser_reserved_connections',
    'shared_buffers','effective_cache_size',
    'work_mem','maintenance_work_mem','temp_buffers',
    'wal_buffers','wal_writer_delay',
    'checkpoint_timeout','max_wal_size','min_wal_size','checkpoint_completion_target',
    'effective_io_concurrency','random_page_cost','seq_page_cost',
    'default_statistics_target',
    'wal_level','wal_compression','archive_mode','archive_command','archive_status',
    'max_wal_senders','wal_keep_size','max_replication_slots',
    'hot_standby','hot_standby_feedback','max_standby_streaming_delay',
    'synchronous_commit','synchronous_standby_names',
    'log_min_duration_statement','log_slow_autovacuum_min_duration',
    'autovacuum','autovacuum_max_workers','autovacuum_vacuum_cost_delay',
    'track_activities','track_counts','track_io_timing',
    'log_temp_files','log_checkpoints','log_connections','log_lock_waits',
    'timezone','lc_messages','lc_monetary',
    'max_worker_processes','max_parallel_workers','max_parallel_workers_per_gather',
    'enable_partitionwise_join','enable_partitionwise_aggregate'
)
ORDER BY name;

\echo '>>SECTION: 13. [PARAMETER] 非默认参数一览'
SELECT name, setting, unit, source
FROM pg_settings
WHERE source NOT IN ('default','override')
ORDER BY name;

-- ============================================================
-- §5  空间风险 (SPACE)
-- ============================================================
\echo '>>SECTION: 14. [SPACE] TOP 20 大表 (含索引)'
SELECT
    schemaname,
    relname         AS table_name,
    pg_size_pretty(pg_relation_size(relid))         AS table_size,
    pg_size_pretty(pg_indexes_size(relid))          AS indexes_size,
    pg_size_pretty(pg_total_relation_size(relid))   AS total_size,
    pg_size_pretty(pg_table_size(relid))            AS table_only,
    n_live_tup,
    n_dead_tup
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20;

\echo '>>SECTION: 15. [SPACE] 表空间使用'
SELECT
    spcname         AS tablespace_name,
    pg_size_pretty(pg_tablespace_size(spcname)) AS size,
    spcoptions
FROM pg_tablespace;

\echo '>>SECTION: 16. [SPACE] WAL 目录大小'
SELECT pg_size_pretty(sum(size)) AS wal_size
FROM pg_ls_waldir();

\echo '>>SECTION: 17. [SPACE] 临时文件使用 (per DB)'
SELECT
    datname,
    temp_files,
    pg_size_pretty(temp_bytes) AS temp_size
FROM pg_stat_database
WHERE temp_bytes > 0
ORDER BY temp_bytes DESC;

-- ============================================================
-- §6  HA 复制状态 (HA)
-- ============================================================
\echo '>>SECTION: 18. [HA] Streaming Replication 状态 (主库视角)'
SELECT
    pid,
    usename,
    application_name,
    client_addr,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    pg_size_pretty(sent_lsn - replay_lsn)  AS replication_lag,
    write_lag,
    flush_lag,
    replay_lag,
    sync_state,
    sync_priority
FROM pg_stat_replication
ORDER BY sync_priority;

\echo '>>SECTION: 19. [HA] 复制槽状态'
SELECT
    slot_name,
    plugin,
    slot_type,
    datoid::regdatabase AS database,
    active,
    active_pid,
    xmin,
    catalog_xmin,
    restart_lsn,
    confirmed_flush_lsn,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag_size,
    wal_status,
    safe_wal_size
FROM pg_replication_slots
ORDER BY slot_name;

\echo '>>SECTION: 20. [HA] 备库 WAL 接收状态 (备库执行)'
SELECT
    pid,
    status,
    receive_start_lsn,
    receive_start_tli,
    written_lsn,
    flushed_lsn,
    received_tli,
    last_msg_send_time,
    last_msg_receipt_time,
    last_msg_receipt_time - last_msg_send_time AS msg_lag,
    latest_end_lsn,
    latest_end_time,
    slot_name,
    sender_host,
    sender_port,
    conninfo
FROM pg_stat_wal_receiver;

\echo '>>SECTION: 21. [HA] Recovery 进度 (备库执行)'
SELECT
    pg_is_in_recovery()                         AS is_standby,
    pg_last_wal_receive_lsn()                   AS received_lsn,
    pg_last_wal_replay_lsn()                    AS replayed_lsn,
    pg_last_xact_replay_timestamp()             AS last_replay_time,
    now() - pg_last_xact_replay_timestamp()     AS replay_lag,
    pg_is_wal_replay_paused()                   AS replay_paused;

\echo '>>SECTION: 22. [HA] Patroni/Repmgr 相关表 (如有)'
SELECT COUNT(*) AS repmgr_installed FROM information_schema.schemata WHERE schema_name = 'repmgr';

-- ============================================================
-- §7  VACUUM / AUTOVACUUM 状态
-- ============================================================
\echo '>>SECTION: 23. [VACUUM] 正在运行的 VACUUM'
SELECT
    pid,
    usename,
    phase,
    datname,
    relid::regclass    AS table_name,
    heap_blks_total,
    heap_blks_scanned,
    heap_blks_vacuumed,
    index_vacuum_count,
    max_dead_tuples,
    num_dead_tuples
FROM pg_stat_progress_vacuum;

\echo '>>SECTION: 24. [VACUUM] 长时间未 VACUUM 的大表 TOP10'
SELECT
    schemaname,
    relname         AS table_name,
    n_live_tup,
    n_dead_tup,
    last_autovacuum,
    last_autoanalyze,
    pg_size_pretty(pg_total_relation_size(relid)) AS size,
    autovacuum_count,
    autoanalyze_count
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
   OR last_autovacuum < NOW() - INTERVAL '7 days'
   OR last_autovacuum IS NULL
ORDER BY n_dead_tup DESC
LIMIT 10;

\echo '>>SECTION: 25. [VACUUM] 表年龄 (XID Wraparound 风险)'
SELECT
    datname,
    age(datfrozenxid)           AS db_age,
    pg_size_pretty(pg_database_size(datname)) AS db_size
FROM pg_database
WHERE datallowconn = true
ORDER BY age(datfrozenxid) DESC;

SELECT
    n.nspname,
    c.relname           AS table_name,
    age(c.relfrozenxid) AS table_age,
    pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE c.relkind = 'r'
  AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
  AND age(c.relfrozenxid) > 1500000000
ORDER BY age(c.relfrozenxid) DESC
LIMIT 20;

-- ============================================================
-- §8  备份状态
-- ============================================================
\echo '>>SECTION: 26. [BACKUP] 基础备份状态'
SELECT
    backup_start,
    backup_stop,
    labelfile,
    spcmapfile
FROM pg_stat_archiver
-- 只有存在记录时展示
UNION ALL
SELECT NULL, NULL, NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM pg_stat_archiver WHERE archived_count > 0)
LIMIT 1;

SELECT
    archived_count,
    last_archived_wal,
    last_archived_time,
    failed_count,
    last_failed_wal,
    last_failed_time,
    stats_reset
FROM pg_stat_archiver;

-- ============================================================
-- 结束
-- ============================================================
\echo '============================================================'
\echo 'PostgreSQL 巡检脚本执行完毕'
\echo '============================================================'
SELECT current_timestamp AS finish_time;

-- ============================================================
-- ============================================================
-- §9  深度风险分析 (RISK DEEP) -- 来源: postgresql_4types.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §9-1  长事务与 IDLE-IN-TRANSACTION 会话
-- 经验：idle in transaction 持有锁而不释放，拖死整个系统
-- ============================================================
\echo '>>SECTION: 27. [RISK-DEEP] 长事务与 IDLE-IN-TRANSACTION 会话'
SELECT
    CASE
        WHEN state = 'idle in transaction'
             AND now() - xact_start > interval '5 minutes' THEN '[CRITICAL]'
        WHEN state = 'idle in transaction'                  THEN '[WARNING] '
        WHEN now() - xact_start > interval '30 minutes'    THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    pid,
    usename,
    application_name,
    client_addr,
    state,
    wait_event_type,
    wait_event,
    now() - xact_start                                          AS txn_age,
    now() - query_start                                         AS query_age,
    LEFT(query, 150)                                            AS query_preview
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND xact_start IS NOT NULL
  AND (state = 'idle in transaction' OR now() - xact_start > interval '5 minutes')
ORDER BY txn_age DESC;

-- ============================================================
-- §9-2  锁等待链（递归分析，完整显示谁堵谁）
-- ============================================================
\echo '>>SECTION: 28. [RISK-DEEP] 锁等待链分析（递归）'
WITH RECURSIVE lock_chain AS (
    SELECT
        blocked.pid              AS blocked_pid,
        blocked.usename          AS blocked_user,
        blocking.pid             AS blocking_pid,
        blocking.usename         AS blocking_user,
        now() - blocked.query_start AS wait_duration,
        blocked.query            AS blocked_query,
        blocking.query           AS blocking_query,
        1                        AS depth
    FROM pg_stat_activity blocked
    JOIN pg_stat_activity blocking
        ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
    WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0
)
SELECT
    CASE
        WHEN wait_duration > interval '60 seconds' THEN '[CRITICAL]'
        WHEN wait_duration > interval '10 seconds' THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    blocked_pid,
    blocked_user,
    blocking_pid,
    blocking_user,
    wait_duration,
    LEFT(blocked_query, 100)                                    AS blocked_query,
    LEFT(blocking_query, 100)                                   AS blocking_query
FROM lock_chain
ORDER BY wait_duration DESC;

-- ============================================================
-- §9-3  Dead Tuple 比率过高表（需 VACUUM）
-- 经验：dead_ratio > 20% 说明 autovacuum 跟不上 DML 速率
-- ============================================================
\echo '>>SECTION: 29. [RISK-DEEP] Dead Tuple 比率过高表（>10%，带风险判定）'
SELECT
    CASE
        WHEN dead_ratio > 30 THEN '[CRITICAL]'
        WHEN dead_ratio > 10 THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    schemaname,
    relname                                                     AS table_name,
    n_live_tup,
    n_dead_tup,
    ROUND(dead_ratio, 2)                                        AS dead_pct,
    pg_size_pretty(pg_total_relation_size(relid))               AS total_size,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    CASE
        WHEN dead_ratio > 20 THEN '建议立即执行 VACUUM ANALYZE'
        ELSE '关注autovacuum频率'
    END                                                         AS remark
FROM (
    SELECT
        schemaname,
        relname,
        relid,
        n_live_tup,
        n_dead_tup,
        n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100 AS dead_ratio,
        last_vacuum,
        last_autovacuum,
        last_analyze
    FROM pg_stat_user_tables
    WHERE n_dead_tup > 1000
) t
WHERE dead_ratio > 10
ORDER BY dead_ratio DESC
LIMIT 20;

-- ============================================================
-- §9-4  XID Wraparound 风险（最严重的 PG 定时炸弹）
-- 经验：表年龄接近 2^31 时 PG 会自动 shutdown 并拒绝所有写入
-- ============================================================
\echo '>>SECTION: 30. [RISK-DEEP] XID Wraparound 风险评估（高危！带风险判定）'
SELECT
    CASE
        WHEN age(c.relfrozenxid) > 1800000000 THEN '[CRITICAL] 极度危险!立即执行 VACUUM FREEZE'
        WHEN age(c.relfrozenxid) > 1500000000 THEN '[CRITICAL] 高度危险,尽快执行 VACUUM FREEZE'
        WHEN age(c.relfrozenxid) > 1000000000 THEN '[WARNING]  开始关注wraparound风险'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    n.nspname                                                   AS schema_name,
    c.relname                                                   AS table_name,
    age(c.relfrozenxid)                                         AS table_age,
    2147483648 - age(c.relfrozenxid)                           AS xids_remaining,
    pg_size_pretty(pg_total_relation_size(c.oid))               AS size
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE c.relkind = 'r'
  AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
ORDER BY age(c.relfrozenxid) DESC
LIMIT 15;

-- 数据库级别 wraparound
SELECT
    CASE
        WHEN age(datfrozenxid) > 1800000000 THEN '[CRITICAL]'
        WHEN age(datfrozenxid) > 1500000000 THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    datname,
    age(datfrozenxid)                                           AS db_age,
    pg_size_pretty(pg_database_size(datname))                   AS db_size
FROM pg_database
WHERE datallowconn = true
ORDER BY age(datfrozenxid) DESC;

-- ============================================================
-- §9-5  TOP 10 慢 SQL（带风险标注）
-- ============================================================
\echo '>>SECTION: 31. [RISK-DEEP] TOP 10 慢 SQL（带风险标注）'
SELECT
    CASE
        WHEN ROUND(mean_exec_time/1000::numeric, 3) > 10 THEN '[CRITICAL]'
        WHEN ROUND(mean_exec_time/1000::numeric, 3) > 1  THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    userid::regrole                                             AS db_user,
    calls,
    ROUND(total_exec_time/1000::numeric, 2)                     AS total_sec,
    ROUND(mean_exec_time/1000::numeric, 3)                      AS avg_sec,
    ROUND(max_exec_time/1000::numeric, 3)                       AS max_sec,
    shared_blks_read,
    temp_blks_read + temp_blks_written                          AS temp_blk_io,
    rows,
    LEFT(query, 150)                                            AS query_text
FROM pg_stat_statements
WHERE calls > 5
ORDER BY total_exec_time DESC
LIMIT 10;

-- ============================================================
-- ============================================================
-- §10  参数风险评估 (PARAMETER RISK) -- 来源: postgresql_4types.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §10-1  关键内存参数评估
-- 经验：shared_buffers 建议内存 25%；work_mem 设太大 × 并发连接数 = OOM
-- ============================================================
\echo '>>SECTION: 32. [PARAMETER-RISK] 内存参数评估（带风险判定）'
SELECT
    CASE
        WHEN name = 'shared_buffers'
             AND setting::bigint * 8192 < pg_database_size(current_database()) * 0.1
             THEN '[WARNING]  shared_buffers < 10% DB大小，缓存效果差'
        WHEN name = 'work_mem'
             AND setting::bigint * 1024 > 500 * 1024 * 1024
             THEN '[WARNING]  work_mem > 500MB，高并发下OOM风险'
        WHEN name = 'maintenance_work_mem'
             AND setting::bigint * 1024 < 64 * 1024 * 1024
             THEN '[INFO]     maintenance_work_mem < 64MB，VACUUM/CREATE INDEX较慢'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    name,
    CASE unit
        WHEN '8kB' THEN pg_size_pretty(setting::bigint * 8192)
        WHEN 'kB'  THEN pg_size_pretty(setting::bigint * 1024)
        WHEN 'MB'  THEN pg_size_pretty(setting::bigint * 1024 * 1024)
        ELSE setting
    END                                                         AS current_value,
    unit,
    source,
    context
FROM pg_settings
WHERE name IN (
    'shared_buffers','work_mem','maintenance_work_mem',
    'effective_cache_size','temp_buffers','wal_buffers'
)
ORDER BY name;

-- ============================================================
-- §10-2  WAL 与检查点参数（带风险判定）
-- 经验：checkpoint_completion_target < 0.7 导致 IO 突刺；max_wal_size 太小触发频繁检查点
-- ============================================================
\echo '>>SECTION: 33. [PARAMETER-RISK] WAL 与检查点参数（带风险判定）'
SELECT
    CASE
        WHEN name='checkpoint_completion_target' AND setting::float < 0.7 THEN '[WARNING]  过小，IO高峰时写入抖动明显'
        WHEN name='wal_level' AND setting NOT IN ('replica','logical')     THEN '[WARNING]  不支持复制'
        WHEN name='synchronous_commit' AND setting='off'                   THEN '[WARNING]  异步提交，崩溃可能丢失数据'
        WHEN name='max_wal_size' AND setting::bigint * 1024 * 1024 < 1073741824 THEN '[WARNING]  max_wal_size<1GB，检查点过频'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    name,
    setting,
    unit,
    CASE name
        WHEN 'checkpoint_completion_target' THEN '建议0.9，让检查点平滑写入不产生IO突刺'
        WHEN 'max_wal_size'                 THEN '建议>=2GB，减少频繁检查点'
        WHEN 'wal_keep_size'                THEN '复制槽故障时防止WAL被删，建议按从库数量配置'
        WHEN 'synchronous_commit'           THEN 'on=同步提交安全；off=异步性能高但可能丢数据'
        ELSE ''
    END                                                         AS remark
FROM pg_settings
WHERE name IN (
    'wal_level','synchronous_commit','fsync',
    'checkpoint_timeout','checkpoint_completion_target',
    'max_wal_size','min_wal_size','wal_keep_size',
    'wal_compression','archive_mode','archive_command'
)
ORDER BY risk_level;

-- ============================================================
-- §10-3  连接与并发参数（带阈值判定）
-- ============================================================
\echo '>>SECTION: 34. [PARAMETER-RISK] 连接与并发参数（带使用率评估）'
SELECT
    max_conn,
    super_conn,
    curr_conn,
    ROUND(curr_conn::numeric / max_conn * 100, 2)               AS conn_usage_pct,
    max_parallel,
    max_workers,
    CASE
        WHEN curr_conn::float / max_conn > 0.85 THEN '[CRITICAL] 连接使用率 >85%'
        WHEN curr_conn::float / max_conn > 0.70 THEN '[WARNING]  连接使用率 >70%'
        ELSE '[INFO]    连接数正常'
    END                                                         AS risk_level
FROM (
    SELECT
        (SELECT setting::int FROM pg_settings WHERE name='max_connections')            AS max_conn,
        (SELECT setting::int FROM pg_settings WHERE name='superuser_reserved_connections') AS super_conn,
        (SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid())          AS curr_conn,
        (SELECT setting::int FROM pg_settings WHERE name='max_parallel_workers_per_gather') AS max_parallel,
        (SELECT setting::int FROM pg_settings WHERE name='max_worker_processes')       AS max_workers
) t;

-- ============================================================
-- ============================================================
-- §11  HA 深度分析 (HA DEEP) -- 来源: postgresql_4types.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §11-1  流复制状态（带风险判定）
-- 经验：replay_lag > RPO 要求是最核心指标
-- ============================================================
\echo '>>SECTION: 35. [HA-DEEP] 流复制状态（带风险判定）'
SELECT
    CASE
        WHEN state != 'streaming'              THEN '[CRITICAL]'
        WHEN replay_lag > interval '5 minutes' THEN '[CRITICAL]'
        WHEN replay_lag > interval '60 seconds' THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    pid,
    usename,
    application_name,
    client_addr,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    pg_size_pretty(pg_wal_lsn_diff(sent_lsn, replay_lsn))      AS replication_lag_bytes,
    write_lag,
    flush_lag,
    replay_lag,
    sync_state,
    sync_priority
FROM pg_stat_replication
ORDER BY sync_priority;

-- ============================================================
-- §11-2  复制槽积压（最危险！槽积压会无限保留 WAL 导致磁盘爆满）
-- ============================================================
\echo '>>SECTION: 36. [HA-DEEP] 复制槽状态（WAL积压风险）'
SELECT
    CASE
        WHEN NOT active AND pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) > 5368709120
            THEN '[CRITICAL] 非活跃槽积压>5GB，立即评估是否删除该槽'
        WHEN NOT active
            THEN '[WARNING]  复制槽非活跃，WAL无法清理'
        WHEN pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) > 10737418240
            THEN '[WARNING]  活跃槽积压>10GB，检查从库消费速度'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    slot_name,
    slot_type,
    active,
    active_pid,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_lag_size,
    restart_lsn,
    confirmed_flush_lsn,
    wal_status,
    safe_wal_size
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), COALESCE(restart_lsn,'0/0')) DESC;

-- ============================================================
-- §11-3  WAL 接收状态（备库执行）
-- 经验：last_msg_receipt_time 超过 30s 未更新 = 主备网络断开
-- ============================================================
\echo '>>SECTION: 37. [HA-DEEP] WAL 接收状态（备库执行，带风险判定）'
SELECT
    CASE
        WHEN status != 'streaming'                              THEN '[CRITICAL]'
        WHEN now() - last_msg_receipt_time > interval '30 sec' THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    pid,
    status,
    receive_start_lsn,
    written_lsn,
    flushed_lsn,
    last_msg_send_time,
    last_msg_receipt_time,
    last_msg_receipt_time - last_msg_send_time                  AS msg_lag,
    sender_host,
    sender_port,
    slot_name
FROM pg_stat_wal_receiver;

-- ============================================================
-- §11-4  备库应用延迟综合评估（Patroni/Repmgr 通用视角）
-- ============================================================
\echo '>>SECTION: 38. [HA-DEEP] 备库应用延迟综合评估（备库执行）'
SELECT
    CASE
        WHEN NOT pg_is_in_recovery() THEN '[INFO]     当前为主库，此项跳过'
        WHEN now() - pg_last_xact_replay_timestamp() > interval '5 minutes' THEN '[CRITICAL]'
        WHEN now() - pg_last_xact_replay_timestamp() > interval '60 seconds' THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    pg_is_in_recovery()                                         AS is_standby,
    pg_last_wal_receive_lsn()                                   AS received_lsn,
    pg_last_wal_replay_lsn()                                    AS replayed_lsn,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())
    )                                                           AS lag_bytes,
    pg_last_xact_replay_timestamp()                             AS last_replay_time,
    now() - pg_last_xact_replay_timestamp()                     AS replay_lag,
    pg_is_wal_replay_paused()                                   AS replay_paused;

-- ============================================================
-- §11-5  WAL 归档状态（带风险判定）
-- 经验：归档失败直接影响 PITR 和 standby 传输
-- ============================================================
\echo '>>SECTION: 39. [HA-DEEP] WAL 归档状态（带风险判定）'
SELECT
    CASE
        WHEN failed_count > 0     THEN '[WARNING]  归档存在失败，检查archive_command'
        WHEN archived_count = 0   THEN '[INFO]     归档未启用或无WAL产生'
        ELSE '[INFO]    '
    END                                                         AS risk_level,
    archived_count,
    last_archived_wal,
    last_archived_time,
    failed_count,
    last_failed_wal,
    last_failed_time,
    stats_reset
FROM pg_stat_archiver;

\echo '============================================================'
\echo 'PostgreSQL 综合巡检完成 (inspect + 4types)'
\echo '============================================================'
SELECT current_timestamp AS finish_time;
