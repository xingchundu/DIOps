-- ============================================================
-- SQL Server 综合巡检脚本（T-SQL）
-- 适用版本：SQL Server 2016 / 2019 / 2022
-- ============================================================

SELECT '>>SECTION: 1. 实例基本信息' AS section_marker;
SELECT @@VERSION AS version, DB_NAME() AS current_db, SERVERPROPERTY('ServerName') AS server_name, GETDATE() AS exec_time;

SELECT '>>SECTION: 2. 连接概况' AS section_marker;
SELECT status, COUNT(*) AS cnt FROM sys.dm_exec_sessions WHERE is_user_process = 1 GROUP BY status;

SELECT '>>SECTION: 3. [HEALTH] 性能计数器' AS section_marker;
SELECT counter_name, cntr_value
FROM sys.dm_os_performance_counters
WHERE counter_name IN ('User Connections', 'Batch Requests/sec', 'Page life expectancy', 'Buffer cache hit ratio', 'Buffer cache hit ratio base')
  AND (instance_name = '' OR instance_name IS NULL);

SELECT '>>SECTION: 4. [SPACE] 数据库容量' AS section_marker;
SELECT d.name AS db_name, d.state_desc, ROUND(SUM(mf.size) * 8.0 / 1024 / 1024, 2) AS size_gb
FROM sys.databases d
JOIN sys.master_files mf ON d.database_id = mf.database_id
WHERE d.database_id > 4
GROUP BY d.name, d.state_desc
ORDER BY size_gb DESC;

SELECT '>>SECTION: 5. [HA] 镜像/AlwaysOn 概况' AS section_marker;
SELECT DB_NAME(database_id) AS db_name, mirroring_state_desc, synchronization_state_desc
FROM sys.database_mirroring
WHERE mirroring_state IS NOT NULL;

SELECT '>>SECTION: 6. 等待事件 TOP10' AS section_marker;
SELECT TOP 10 wait_type, waiting_tasks_count, wait_time_ms / 1000.0 AS wait_time_sec
FROM sys.dm_os_wait_stats
WHERE wait_type NOT LIKE 'SLEEP%'
ORDER BY wait_time_ms DESC;
