'use strict';
/**
 * 内置检查项（非 SQL 洞察部分）。
 * 约定：每个 impl 的采集 SQL 都只取数，结果列用统一别名 OBJ / VAL / TXT（其余列为证据）；判定由 judge.js 完成。
 * 版本差异用 fallback 数组吸收（主 SQL 报错——视图不存在/列不存在——时依次尝试）。
 * 取不到数（权限不足 / 视图不存在）只记为该检查项“采集失败”，不算数据库异常。
 */
const ORA_SYS = "'SYS','SYSTEM','DBSNMP','SYSMAN','XDB','AUDSYS','GSMADMIN_INTERNAL','ORDS_METADATA','MDSYS','CTXSYS','WMSYS','OUTLN','APPQOSSYS','ORACLE_OCM','DVSYS','LBACSYS','OJVMSYS','ORDDATA','ORDSYS','SI_INFORMTN_SCHEMA','REMOTE_SCHEDULER_AGENT','DIP','ANONYMOUS','XS$NULL'";
const DM_SYS = "'SYS','SYSDBA','SYSAUDITOR','SYSSSO','CTISYS'";

const ITEMS = [
  // ------------------------------------------------------------------ 可用性
  {
    code: 'avail.instance_status', name: '实例状态', category: 'AVAILABILITY', sort: 10,
    desc: '实例是否处于可对外服务的状态（Oracle OPEN / PG 主备角色 / DM OPEN）。连不上的实例记为“巡检失败”，不在此项判定。',
    rule: { type: 'STATUS', ok: ['OPEN', 'PRIMARY', 'STANDBY'], level: 'CRITICAL' },
    advice: '确认实例是否处于 MOUNT / RESTRICTED / 恢复中，检查告警日志与最近的重启、切换操作。',
    impls: {
      ORACLE: { sql: "SELECT instance_name AS OBJ, status AS TXT, database_status AS DB_STATUS, host_name AS HOST_NAME, TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI:SS') AS STARTUP FROM v$instance" },
      MYSQL: { sql: "SELECT @@hostname AS OBJ, 'OPEN' AS TXT, VERSION() AS VERSION, @@read_only AS READ_ONLY" },
      POSTGRESQL: { sql: "SELECT current_database() AS OBJ, CASE WHEN pg_is_in_recovery() THEN 'STANDBY' ELSE 'PRIMARY' END AS TXT, version() AS VERSION" },
      DAMENG: { sql: "SELECT INSTANCE_NAME AS OBJ, STATUS$ AS TXT, MODE$ AS DB_MODE, TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS') AS STARTUP FROM V$INSTANCE" },
    },
  },
  {
    code: 'avail.uptime', name: '实例运行时长', category: 'AVAILABILITY', sort: 20,
    desc: '实例近期是否发生过重启（运行时长过短说明刚重启 / 切换 / 崩溃恢复）。',
    rule: { type: 'THRESHOLD', direction: 'LOW', unit: '小时' }, warn: 24, crit: 1,
    advice: '确认重启原因（计划内变更 / 宕机 / 主备切换），核对告警日志并检查重启后缓存预热与应用连接恢复情况。',
    impls: {
      ORACLE: { sql: "SELECT instance_name AS OBJ, ROUND((SYSDATE - startup_time) * 24, 1) AS VAL, TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI:SS') AS STARTUP FROM v$instance" },
      MYSQL: {
        sql: "SELECT 'mysql' AS OBJ, ROUND(VARIABLE_VALUE / 3600, 1) AS VAL FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime'",
        fallback: ["SELECT 'mysql' AS OBJ, ROUND(VARIABLE_VALUE / 3600, 1) AS VAL FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Uptime'"],
      },
      POSTGRESQL: { sql: "SELECT current_database() AS OBJ, ROUND((EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time())) / 3600)::numeric, 1) AS VAL" },
      DAMENG: { sql: "SELECT INSTANCE_NAME AS OBJ, ROUND((SYSDATE - START_TIME) * 24, 1) AS VAL FROM V$INSTANCE" },
    },
  },

  // ------------------------------------------------------------------ 资源
  {
    code: 'res.conn_usage', name: '连接 / 会话使用率', category: 'RESOURCE', sort: 30,
    desc: '当前连接（会话）数占上限（sessions / max_connections / MAX_SESSIONS）的比例。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%' }, warn: 80, crit: 90,
    advice: '排查连接泄漏与异常来源 IP，核对应用连接池大小；确需扩容时评估 sessions / max_connections 与内存的匹配。',
    impls: {
      ORACLE: { sql: "SELECT resource_name AS OBJ, ROUND(current_utilization * 100 / NULLIF(TO_NUMBER(TRIM(limit_value)), 0), 1) AS VAL, current_utilization AS CUR_VAL, TRIM(limit_value) AS LIMIT_VAL FROM v$resource_limit WHERE resource_name IN ('sessions','processes') AND TRIM(limit_value) <> 'UNLIMITED'" },
      MYSQL: {
        sql: "SELECT 'connections' AS OBJ, ROUND(t.v * 100 / NULLIF(m.v, 0), 1) AS VAL, t.v AS CUR_VAL, m.v AS LIMIT_VAL FROM (SELECT VARIABLE_VALUE + 0 AS v FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected') t, (SELECT VARIABLE_VALUE + 0 AS v FROM performance_schema.global_variables WHERE VARIABLE_NAME = 'max_connections') m",
        fallback: ["SELECT 'connections' AS OBJ, ROUND(t.v * 100 / NULLIF(m.v, 0), 1) AS VAL, t.v AS CUR_VAL, m.v AS LIMIT_VAL FROM (SELECT VARIABLE_VALUE + 0 AS v FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Threads_connected') t, (SELECT VARIABLE_VALUE + 0 AS v FROM information_schema.GLOBAL_VARIABLES WHERE VARIABLE_NAME = 'max_connections') m"],
      },
      POSTGRESQL: { sql: "SELECT 'connections' AS OBJ, ROUND(count(*) * 100.0 / NULLIF(current_setting('max_connections')::int, 0), 1) AS VAL, count(*) AS CUR_VAL, current_setting('max_connections')::int AS LIMIT_VAL FROM pg_stat_activity" },
      DAMENG: {
        sql: "SELECT 'sessions' AS OBJ, ROUND(c.n * 100.0 / NULLIF(p.v, 0), 1) AS VAL, c.n AS CUR_VAL, p.v AS LIMIT_VAL FROM (SELECT COUNT(*) AS n FROM V$SESSIONS) c, (SELECT TO_NUMBER(PARA_VALUE) AS v FROM V$DM_INI WHERE PARA_NAME = 'MAX_SESSIONS') p",
        fallback: ["SELECT 'sessions' AS OBJ, ROUND(c.n * 100.0 / NULLIF(p.v, 0), 1) AS VAL, c.n AS CUR_VAL, p.v AS LIMIT_VAL FROM (SELECT COUNT(*) AS n FROM V$SESSIONS) c, (SELECT TO_NUMBER(VALUE) AS v FROM V$PARAMETER WHERE NAME = 'MAX_SESSIONS') p"],
      },
    },
  },

  // ------------------------------------------------------------------ 存储
  {
    code: 'storage.tablespace', name: '表空间使用率', category: 'STORAGE', sort: 40,
    desc: '各表空间已用比例（Oracle 按可扩展上限计算，DM 按已分配数据文件计算）。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%', objLabel: '表空间' }, warn: 85, crit: 95,
    advice: '核查空间增长趋势，必要时扩容数据文件 / 开启自动扩展，并清理历史与归档数据。',
    impls: {
      ORACLE: { sql: "SELECT m.tablespace_name AS OBJ, ROUND(m.used_percent, 1) AS VAL, ROUND(m.used_space * t.block_size / 1048576) AS USED_MB, ROUND(m.tablespace_size * t.block_size / 1048576) AS TOTAL_MB FROM dba_tablespace_usage_metrics m JOIN dba_tablespaces t ON t.tablespace_name = m.tablespace_name ORDER BY m.used_percent DESC" },
      DAMENG: { sql: "SELECT d.tablespace_name AS OBJ, ROUND((d.total - NVL(f.free, 0)) * 100 / d.total, 1) AS VAL, ROUND((d.total - NVL(f.free, 0)) / 1048576) AS USED_MB, ROUND(d.total / 1048576) AS TOTAL_MB FROM (SELECT tablespace_name, SUM(bytes) AS total FROM dba_data_files GROUP BY tablespace_name) d LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS free FROM dba_free_space GROUP BY tablespace_name) f ON d.tablespace_name = f.tablespace_name WHERE d.total > 0 ORDER BY VAL DESC" },
    },
  },
  {
    code: 'storage.temp_space', name: '临时表空间使用率', category: 'STORAGE', sort: 41,
    desc: '临时表空间已用比例，持续偏高多为大排序 / 哈希连接未释放。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%', objLabel: '临时表空间' }, warn: 80, crit: 90,
    advice: '定位占用临时空间的会话与 SQL（v$tempseg_usage），优化排序 / 哈希连接，必要时扩容临时文件。',
    impls: {
      ORACLE: { sql: "SELECT tablespace_name AS OBJ, ROUND((tablespace_size - free_space) * 100 / NULLIF(tablespace_size, 0), 1) AS VAL, ROUND(tablespace_size / 1048576) AS TOTAL_MB FROM dba_temp_free_space" },
    },
  },
  {
    code: 'storage.asm', name: 'ASM 磁盘组使用率', category: 'STORAGE', sort: 42,
    desc: 'ASM 磁盘组已用比例（非 ASM 环境无返回）。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%', objLabel: '磁盘组' }, warn: 85, crit: 95,
    advice: '规划扩容 ASM 磁盘或清理归档 / 备份；注意冗余模式下的可用空间。',
    impls: {
      ORACLE: { sql: "SELECT name AS OBJ, ROUND((total_mb - free_mb) * 100 / NULLIF(total_mb, 0), 1) AS VAL, total_mb AS TOTAL_MB, free_mb AS FREE_MB, state AS STATE FROM v$asm_diskgroup WHERE total_mb > 0" },
    },
  },
  {
    code: 'storage.fra', name: '闪回恢复区（FRA）使用率', category: 'STORAGE', sort: 43,
    desc: '快速恢复区已用（扣除可回收空间）比例，写满会导致归档无法写出、库挂起。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%' }, warn: 80, crit: 90,
    advice: '核对 RMAN 保留策略并执行 DELETE OBSOLETE，确认归档已备份后清理，必要时调大 db_recovery_file_dest_size。',
    impls: {
      ORACLE: { sql: "SELECT name AS OBJ, ROUND((space_used - space_reclaimable) * 100 / NULLIF(space_limit, 0), 1) AS VAL, ROUND(space_used / 1048576) AS USED_MB, ROUND(space_limit / 1048576) AS LIMIT_MB FROM v$recovery_file_dest WHERE space_limit > 0" },
    },
  },
  {
    code: 'storage.db_size', name: '库 / Schema 容量排行', category: 'STORAGE', sort: 44,
    desc: '按库 / Schema 统计的数据量排行，仅展示、不判定，用于容量趋势参考。',
    rule: { type: 'INFO' },
    advice: '',
    impls: {
      ORACLE: { sql: `SELECT * FROM (SELECT owner AS OBJ, ROUND(SUM(bytes) / 1048576) AS SIZE_MB, COUNT(*) AS SEGMENTS FROM dba_segments WHERE owner NOT IN (${ORA_SYS}) GROUP BY owner ORDER BY SUM(bytes) DESC) WHERE ROWNUM <= {{TOPN}}` },
      MYSQL: { sql: "SELECT table_schema AS OBJ, ROUND(SUM(data_length + index_length) / 1048576) AS SIZE_MB, COUNT(*) AS TABLES_CNT FROM information_schema.tables WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') GROUP BY table_schema ORDER BY SUM(data_length + index_length) DESC LIMIT {{TOPN}}" },
      POSTGRESQL: { sql: "SELECT datname AS OBJ, ROUND(pg_database_size(datname) / 1048576) AS SIZE_MB FROM pg_database WHERE datistemplate = false ORDER BY pg_database_size(datname) DESC LIMIT {{TOPN}}" },
      DAMENG: { sql: `SELECT * FROM (SELECT owner AS OBJ, ROUND(SUM(bytes) / 1048576) AS SIZE_MB, COUNT(*) AS SEGMENTS FROM dba_segments WHERE owner NOT IN (${DM_SYS}) GROUP BY owner ORDER BY SUM(bytes) DESC) WHERE ROWNUM <= {{TOPN}}` },
    },
  },

  // ------------------------------------------------------------------ 性能
  {
    code: 'perf.cache_hit', name: '缓冲池命中率', category: 'PERFORMANCE', sort: 50,
    desc: '数据块在内存缓冲池中命中的比例（越低说明物理读越多）。',
    rule: { type: 'THRESHOLD', direction: 'LOW', unit: '%' }, warn: 90, crit: 80,
    advice: '结合负载评估缓冲池 / SGA 大小；排查全表扫描与低效 SQL（见 SQL 洞察），避免盲目加大内存。',
    impls: {
      ORACLE: { sql: "SELECT 'buffer cache' AS OBJ, ROUND((1 - phy.value / NULLIF(cur.value + con.value, 0)) * 100, 2) AS VAL FROM v$sysstat phy, v$sysstat cur, v$sysstat con WHERE phy.name = 'physical reads cache' AND cur.name = 'db block gets from cache' AND con.name = 'consistent gets from cache'" },
      MYSQL: {
        sql: "SELECT 'innodb_buffer_pool' AS OBJ, ROUND((1 - r.v / NULLIF(q.v, 0)) * 100, 2) AS VAL FROM (SELECT VARIABLE_VALUE + 0 AS v FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads') r, (SELECT VARIABLE_VALUE + 0 AS v FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests') q",
        fallback: ["SELECT 'innodb_buffer_pool' AS OBJ, ROUND((1 - r.v / NULLIF(q.v, 0)) * 100, 2) AS VAL FROM (SELECT VARIABLE_VALUE + 0 AS v FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads') r, (SELECT VARIABLE_VALUE + 0 AS v FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests') q"],
      },
      POSTGRESQL: { sql: "SELECT datname AS OBJ, ROUND(blks_hit * 100.0 / NULLIF(blks_hit + blks_read, 0), 2) AS VAL FROM pg_stat_database WHERE datname = current_database()" },
      DAMENG: { sql: "SELECT NAME AS OBJ, ROUND((1 - N_DISC_READS * 1.0 / NULLIF(N_LOGIC_READS, 0)) * 100, 2) AS VAL FROM V$BUFFERPOOL WHERE N_LOGIC_READS > 0" },
    },
  },
  {
    code: 'perf.lock_wait', name: '锁等待 / 阻塞', category: 'PERFORMANCE', sort: 51, sqlBearing: true, dimension: 'LOCK',
    desc: '正在被其他会话阻塞的会话及其等待的 SQL（带 sql_id）；BLOCKER_* 列为阻塞源。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '秒', maxFindings: 20 }, warn: 30, crit: 300,
    advice: '定位阻塞源会话与持锁 SQL，评估终止会话或缩短事务；业务侧避免长事务与热点行并发更新。',
    impls: {
      ORACLE: { sql: "SELECT * FROM (SELECT w.sid || ',' || w.serial# AS OBJ, w.seconds_in_wait AS VAL, w.blocking_session AS BLOCKER_SID, b.sql_id AS BLOCKER_SQL_ID, w.event AS EVENT, w.username AS USERNAME, w.machine AS MACHINE, w.sql_id AS SQL_ID, w.sql_child_number AS CHILD_NO, SUBSTR(q.sql_text, 1, 500) AS SQL_TEXT FROM v$session w LEFT JOIN v$session b ON b.sid = w.blocking_session LEFT JOIN v$sql q ON q.sql_id = w.sql_id AND q.child_number = w.sql_child_number WHERE w.blocking_session IS NOT NULL AND w.type = 'USER' ORDER BY w.seconds_in_wait DESC) WHERE ROWNUM <= 20" },
      MYSQL: {
        sql: "SELECT w.waiting_pid AS OBJ, w.wait_age_secs AS VAL, w.blocking_pid AS BLOCKER_SID, w.locked_table AS LOCKED_TABLE, w.blocking_query AS BLOCKER_QUERY, (SELECT e.DIGEST FROM performance_schema.threads t JOIN performance_schema.events_statements_current e ON e.THREAD_ID = t.THREAD_ID WHERE t.PROCESSLIST_ID = w.waiting_pid LIMIT 1) AS SQL_ID, LEFT(w.waiting_query, 500) AS SQL_TEXT FROM sys.innodb_lock_waits w ORDER BY w.wait_age_secs DESC LIMIT 20",
        fallback: ["SELECT w.waiting_pid AS OBJ, w.wait_age_secs AS VAL, w.blocking_pid AS BLOCKER_SID, w.locked_table AS LOCKED_TABLE, w.blocking_query AS BLOCKER_QUERY, LEFT(w.waiting_query, 500) AS SQL_TEXT FROM sys.innodb_lock_waits w ORDER BY w.wait_age_secs DESC LIMIT 20"],
      },
      POSTGRESQL: {
        sql: "SELECT a.pid::text AS OBJ, ROUND(EXTRACT(EPOCH FROM (now() - a.query_start))::numeric) AS VAL, pg_blocking_pids(a.pid)::text AS BLOCKER_SID, a.wait_event AS EVENT, a.usename AS USERNAME, a.client_addr::text AS MACHINE, a.query_id::text AS SQL_ID, LEFT(a.query, 500) AS SQL_TEXT FROM pg_stat_activity a WHERE cardinality(pg_blocking_pids(a.pid)) > 0 ORDER BY a.query_start LIMIT 20",
        fallback: ["SELECT a.pid::text AS OBJ, ROUND(EXTRACT(EPOCH FROM (now() - a.query_start))::numeric) AS VAL, pg_blocking_pids(a.pid)::text AS BLOCKER_SID, a.wait_event AS EVENT, a.usename AS USERNAME, a.client_addr::text AS MACHINE, LEFT(a.query, 500) AS SQL_TEXT FROM pg_stat_activity a WHERE cardinality(pg_blocking_pids(a.pid)) > 0 ORDER BY a.query_start LIMIT 20"],
      },
      DAMENG: {
        sql: "SELECT s.SESS_ID AS OBJ, ROUND((SYSDATE - s.LAST_RECV_TIME) * 86400) AS VAL, b.SESS_ID AS BLOCKER_SID, s.USER_NAME AS USERNAME, s.CLNT_IP AS MACHINE, s.SQL_ID AS SQL_ID, SUBSTR(s.SQL_TEXT, 1, 500) AS SQL_TEXT FROM V$TRXWAIT w JOIN V$SESSIONS s ON s.TRX_ID = w.ID LEFT JOIN V$SESSIONS b ON b.TRX_ID = w.WAIT_FOR_ID",
        fallback: ["SELECT s.SESS_ID AS OBJ, ROUND((SYSDATE - s.LAST_RECV_TIME) * 86400) AS VAL, b.SESS_ID AS BLOCKER_SID, s.USER_NAME AS USERNAME, s.CLNT_IP AS MACHINE, SUBSTR(s.SQL_TEXT, 1, 500) AS SQL_TEXT FROM V$TRXWAIT w JOIN V$SESSIONS s ON s.TRX_ID = w.ID LEFT JOIN V$SESSIONS b ON b.TRX_ID = w.WAIT_FOR_ID"],
      },
    },
  },
  {
    code: 'perf.long_tx', name: '长事务', category: 'PERFORMANCE', sort: 52, sqlBearing: true, dimension: 'TX',
    desc: '未提交时间过长的事务及其当前 / 最近 SQL（带 sql_id）。长事务会持锁、撑大 undo / WAL / 复制延迟。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '秒', maxFindings: 20 }, warn: 600, crit: 3600,
    advice: '联系业务确认长事务来源，拆分事务或加提交点；必要时在评估后终止会话。',
    impls: {
      ORACLE: { sql: "SELECT * FROM (SELECT s.sid || ',' || s.serial# AS OBJ, ROUND((SYSDATE - t.start_date) * 86400) AS VAL, s.username AS USERNAME, s.machine AS MACHINE, t.used_ublk AS UNDO_BLOCKS, NVL(s.sql_id, s.prev_sql_id) AS SQL_ID, SUBSTR(q.sql_text, 1, 500) AS SQL_TEXT FROM v$transaction t JOIN v$session s ON s.taddr = t.addr LEFT JOIN v$sqlarea q ON q.sql_id = NVL(s.sql_id, s.prev_sql_id) ORDER BY t.start_date) WHERE ROWNUM <= 20" },
      MYSQL: {
        sql: "SELECT x.trx_id AS OBJ, TIMESTAMPDIFF(SECOND, x.trx_started, NOW()) AS VAL, x.trx_mysql_thread_id AS THREAD_ID, x.trx_state AS STATE, x.trx_rows_modified AS ROWS_MODIFIED, (SELECT e.DIGEST FROM performance_schema.threads t JOIN performance_schema.events_statements_current e ON e.THREAD_ID = t.THREAD_ID WHERE t.PROCESSLIST_ID = x.trx_mysql_thread_id LIMIT 1) AS SQL_ID, LEFT(x.trx_query, 500) AS SQL_TEXT FROM information_schema.innodb_trx x ORDER BY x.trx_started LIMIT 20",
        fallback: ["SELECT x.trx_id AS OBJ, TIMESTAMPDIFF(SECOND, x.trx_started, NOW()) AS VAL, x.trx_mysql_thread_id AS THREAD_ID, x.trx_state AS STATE, x.trx_rows_modified AS ROWS_MODIFIED, LEFT(x.trx_query, 500) AS SQL_TEXT FROM information_schema.innodb_trx x ORDER BY x.trx_started LIMIT 20"],
      },
      POSTGRESQL: {
        sql: "SELECT pid::text AS OBJ, ROUND(EXTRACT(EPOCH FROM (now() - xact_start))::numeric) AS VAL, usename AS USERNAME, state AS STATE, client_addr::text AS MACHINE, query_id::text AS SQL_ID, LEFT(query, 500) AS SQL_TEXT FROM pg_stat_activity WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY xact_start LIMIT 20",
        fallback: ["SELECT pid::text AS OBJ, ROUND(EXTRACT(EPOCH FROM (now() - xact_start))::numeric) AS VAL, usename AS USERNAME, state AS STATE, client_addr::text AS MACHINE, LEFT(query, 500) AS SQL_TEXT FROM pg_stat_activity WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid() ORDER BY xact_start LIMIT 20"],
      },
      DAMENG: {
        sql: "SELECT * FROM (SELECT t.ID AS OBJ, ROUND((SYSDATE - t.START_TIME) * 86400) AS VAL, s.USER_NAME AS USERNAME, s.CLNT_IP AS MACHINE, s.SQL_ID AS SQL_ID, SUBSTR(s.SQL_TEXT, 1, 500) AS SQL_TEXT FROM V$TRX t LEFT JOIN V$SESSIONS s ON s.TRX_ID = t.ID WHERE t.STATUS = 'ACTIVE' ORDER BY t.START_TIME) WHERE ROWNUM <= 20",
        fallback: [
          "SELECT * FROM (SELECT t.ID AS OBJ, ROUND((SYSDATE - t.START_TIME) * 86400) AS VAL, s.USER_NAME AS USERNAME, s.CLNT_IP AS MACHINE, SUBSTR(s.SQL_TEXT, 1, 500) AS SQL_TEXT FROM V$TRX t LEFT JOIN V$SESSIONS s ON s.TRX_ID = t.ID WHERE t.STATUS = 'ACTIVE' ORDER BY t.START_TIME) WHERE ROWNUM <= 20",
          "SELECT * FROM (SELECT t.ID AS OBJ, ROUND((SYSDATE - t.BEGIN_TIME) * 86400) AS VAL, s.USER_NAME AS USERNAME, s.CLNT_IP AS MACHINE, SUBSTR(s.SQL_TEXT, 1, 500) AS SQL_TEXT FROM V$TRX t LEFT JOIN V$SESSIONS s ON s.TRX_ID = t.ID WHERE t.STATUS = 'ACTIVE' ORDER BY t.BEGIN_TIME) WHERE ROWNUM <= 20",
        ],
      },
    },
  },
  {
    code: 'perf.top_waits', name: '等待事件 Top5', category: 'PERFORMANCE', sort: 53,
    desc: '累计等待时间最长的等待事件（仅展示）。',
    rule: { type: 'INFO' }, advice: '',
    impls: {
      ORACLE: { sql: "SELECT * FROM (SELECT event AS OBJ, ROUND(time_waited_micro / 1000000) AS WAIT_SEC, total_waits AS WAITS, wait_class AS WAIT_CLASS FROM v$system_event WHERE wait_class <> 'Idle' ORDER BY time_waited_micro DESC) WHERE ROWNUM <= 5" },
      MYSQL: { sql: "SELECT EVENT_NAME AS OBJ, ROUND(SUM_TIMER_WAIT / 1000000000000) AS WAIT_SEC, COUNT_STAR AS WAITS FROM performance_schema.events_waits_summary_global_by_event_name WHERE COUNT_STAR > 0 AND EVENT_NAME NOT LIKE 'idle%' ORDER BY SUM_TIMER_WAIT DESC LIMIT 5" },
      POSTGRESQL: { sql: "SELECT wait_event_type || ':' || wait_event AS OBJ, COUNT(*) AS SESSIONS FROM pg_stat_activity WHERE wait_event IS NOT NULL AND state <> 'idle' GROUP BY 1 ORDER BY 2 DESC LIMIT 5" },
    },
  },
  {
    code: 'perf.tmp_disk_tables', name: '磁盘临时表占比', category: 'PERFORMANCE', sort: 54,
    desc: '创建的临时表中落盘的比例，偏高说明存在大结果集排序 / 分组或 tmp_table_size 偏小。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%' }, warn: 25, crit: 50,
    advice: '结合 SQL 洞察定位产生大临时表的 SQL（GROUP BY / ORDER BY / DISTINCT），补索引或改写；评估 tmp_table_size / max_heap_table_size。',
    impls: {
      MYSQL: {
        sql: "SELECT 'tmp_tables' AS OBJ, ROUND(d.v * 100 / NULLIF(t.v, 0), 1) AS VAL, d.v AS DISK_TMP, t.v AS ALL_TMP FROM (SELECT VARIABLE_VALUE + 0 AS v FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Created_tmp_disk_tables') d, (SELECT VARIABLE_VALUE + 0 AS v FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Created_tmp_tables') t",
        fallback: ["SELECT 'tmp_tables' AS OBJ, ROUND(d.v * 100 / NULLIF(t.v, 0), 1) AS VAL, d.v AS DISK_TMP, t.v AS ALL_TMP FROM (SELECT VARIABLE_VALUE + 0 AS v FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Created_tmp_disk_tables') d, (SELECT VARIABLE_VALUE + 0 AS v FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Created_tmp_tables') t"],
      },
    },
  },
  {
    code: 'perf.dead_tuples', name: '表膨胀（死元组占比）', category: 'PERFORMANCE', sort: 55,
    desc: 'PostgreSQL 表中死元组占比过高说明 autovacuum 跟不上，会拖慢扫描并占用空间。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%', objLabel: '表', maxFindings: 20 }, warn: 20, crit: 50,
    advice: '检查 autovacuum 是否开启与参数是否合理，对高膨胀表在低峰执行 VACUUM (ANALYZE)；严重膨胀时评估 pg_repack。',
    impls: {
      POSTGRESQL: { sql: "SELECT schemaname || '.' || relname AS OBJ, ROUND(n_dead_tup * 100.0 / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS VAL, n_dead_tup AS DEAD_TUP, n_live_tup AS LIVE_TUP, TO_CHAR(last_autovacuum, 'YYYY-MM-DD HH24:MI:SS') AS LAST_AUTOVACUUM FROM pg_stat_user_tables WHERE n_dead_tup > 10000 ORDER BY n_dead_tup DESC LIMIT 20" },
    },
  },
  {
    code: 'perf.xid_age', name: '事务 ID 回卷风险', category: 'PERFORMANCE', sort: 56,
    desc: 'PostgreSQL 数据库事务 ID 年龄占回卷上限（约 20 亿）的比例，逼近上限会强制停库做冻结。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%', objLabel: '数据库' }, warn: 50, crit: 80,
    advice: '立即检查长事务 / 未使用的复制槽 / 悬挂的 prepared transaction，并对年龄最大的库执行 VACUUM FREEZE。',
    impls: {
      POSTGRESQL: { sql: "SELECT datname AS OBJ, ROUND(age(datfrozenxid) * 100.0 / 2000000000, 1) AS VAL, age(datfrozenxid) AS XID_AGE FROM pg_database WHERE datallowconn ORDER BY age(datfrozenxid) DESC" },
    },
  },
  {
    code: 'object.invalid', name: '失效对象 / 失效索引', category: 'PERFORMANCE', sort: 57,
    desc: 'Oracle / DM 状态非 VALID 的对象数（按 Schema 统计）；PG 为失效索引数（CREATE INDEX CONCURRENTLY 失败遗留）。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '个', objLabel: 'Schema' }, warn: 1, crit: 50,
    advice: '重新编译失效对象（ALTER … COMPILE / UTL_RECOMP），排查导致失效的变更；PG 失效索引需 DROP 后重建。',
    impls: {
      ORACLE: { sql: `SELECT owner AS OBJ, COUNT(*) AS VAL, MAX(object_type) AS SAMPLE_TYPE FROM dba_objects WHERE status <> 'VALID' AND owner NOT IN (${ORA_SYS}) GROUP BY owner ORDER BY COUNT(*) DESC` },
      DAMENG: { sql: `SELECT owner AS OBJ, COUNT(*) AS VAL, MAX(object_type) AS SAMPLE_TYPE FROM dba_objects WHERE status <> 'VALID' AND owner NOT IN (${DM_SYS}) GROUP BY owner ORDER BY COUNT(*) DESC` },
      POSTGRESQL: { sql: "SELECT current_database() AS OBJ, COUNT(*) AS VAL FROM pg_index WHERE NOT indisvalid" },
    },
  },

  // ------------------------------------------------------------------ 高可用
  {
    code: 'ha.replication_lag', name: '主备复制延迟', category: 'HA', sort: 60,
    desc: '备库 / 从库的复制延迟（非备库无返回；MySQL 复制线程停止时延迟为空，按严重处理）。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '秒', nullLevel: 'CRITICAL', nullText: '复制线程未运行或延迟未知' }, warn: 60, crit: 300,
    advice: '检查复制链路与线程状态、网络与归档 / binlog / WAL 积压，评估从库的 IO 与大事务；必要时重建复制。',
    impls: {
      ORACLE: { sql: "SELECT 'apply lag' AS OBJ, EXTRACT(DAY FROM x.iv) * 86400 + EXTRACT(HOUR FROM x.iv) * 3600 + EXTRACT(MINUTE FROM x.iv) * 60 + EXTRACT(SECOND FROM x.iv) AS VAL FROM (SELECT TO_DSINTERVAL(value) AS iv FROM v$dataguard_stats WHERE name = 'apply lag' AND value IS NOT NULL) x" },
      MYSQL: {
        sql: 'SHOW REPLICA STATUS',
        fallback: ['SHOW SLAVE STATUS'],
        map: { obj: ['CHANNEL_NAME', 'SOURCE_HOST', 'MASTER_HOST'], val: ['SECONDS_BEHIND_SOURCE', 'SECONDS_BEHIND_MASTER'] },
      },
      POSTGRESQL: { sql: "SELECT application_name || '@' || COALESCE(client_addr::text, '-') AS OBJ, ROUND(COALESCE(EXTRACT(EPOCH FROM replay_lag), 0)::numeric, 1) AS VAL, state AS STATE, sync_state AS SYNC_STATE FROM pg_stat_replication UNION ALL SELECT 'standby', ROUND(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::numeric, 1), 'streaming', '-' WHERE pg_is_in_recovery()" },
    },
  },
  {
    code: 'ha.replication_state', name: '复制 / 同步状态', category: 'HA', sort: 61,
    desc: '复制链路是否正常：Oracle 备库归档目标状态、MySQL IO/SQL 线程、PG 流复制状态。',
    rule: { type: 'STATUS', ok: ['VALID', 'RUNNING', 'STREAMING'], level: 'CRITICAL' },
    advice: '查看复制 / 归档传输错误信息，恢复链路后确认延迟回落；长期中断需评估重建备库。',
    impls: {
      ORACLE: { sql: "SELECT dest_name AS OBJ, status AS TXT, error AS ERROR FROM v$archive_dest WHERE target = 'STANDBY' AND status <> 'INACTIVE'" },
      MYSQL: {
        sql: 'SHOW REPLICA STATUS', fallback: ['SHOW SLAVE STATUS'],
        map: { obj: ['CHANNEL_NAME', 'SOURCE_HOST', 'MASTER_HOST'], txtAllYes: [['REPLICA_IO_RUNNING', 'SLAVE_IO_RUNNING'], ['REPLICA_SQL_RUNNING', 'SLAVE_SQL_RUNNING']] },
      },
      POSTGRESQL: { sql: "SELECT application_name || '@' || COALESCE(client_addr::text, '-') AS OBJ, UPPER(state) AS TXT, sync_state AS SYNC_STATE FROM pg_stat_replication" },
    },
  },

  // ------------------------------------------------------------------ 备份
  {
    code: 'backup.last_backup', name: '最近一次成功备份距今', category: 'BACKUP', sort: 70,
    desc: '最近一次成功备份（Oracle RMAN / DM 备份集）距今小时数；无成功备份记录按严重处理。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '小时', nullLevel: 'CRITICAL', nullText: '无成功备份记录' }, warn: 26, crit: 72,
    advice: '检查备份作业与调度是否失败，确认备份介质空间；补做一次全备并演练恢复。',
    impls: {
      ORACLE: { sql: "SELECT 'RMAN' AS OBJ, ROUND((SYSDATE - MAX(end_time)) * 24, 1) AS VAL, TO_CHAR(MAX(end_time), 'YYYY-MM-DD HH24:MI:SS') AS LAST_END FROM v$rman_backup_job_details WHERE status IN ('COMPLETED', 'COMPLETED WITH WARNINGS')" },
      DAMENG: {
        sql: "SELECT 'BACKUP' AS OBJ, ROUND((SYSDATE - MAX(END_TIME)) * 24, 1) AS VAL FROM V$BACKUPSET",
        fallback: ["SELECT 'BACKUP' AS OBJ, ROUND((SYSDATE - MAX(START_TIME)) * 24, 1) AS VAL FROM V$BACKUPSET", "SELECT 'BACKUP' AS OBJ, ROUND((SYSDATE - MAX(BACKUP_TIME)) * 24, 1) AS VAL FROM V$BACKUPSET"],
      },
    },
  },
  {
    code: 'backup.archive_mode', name: '归档 / Binlog / WAL 归档开启', category: 'BACKUP', sort: 71,
    desc: '是否开启归档日志（Oracle ARCHIVELOG、DM 归档、MySQL log_bin、PG archive_mode），关闭则无法做时间点恢复。',
    rule: { type: 'STATUS', ok: ['ARCHIVELOG', 'ON', '1', 'ALWAYS'], level: 'WARNING' },
    advice: '生产库应开启归档并配合备份；变更需维护窗口重启（Oracle / DM 需切换归档模式，PG 需重启）。',
    impls: {
      ORACLE: { sql: 'SELECT name AS OBJ, log_mode AS TXT FROM v$database' },
      MYSQL: {
        sql: "SELECT 'log_bin' AS OBJ, UPPER(VARIABLE_VALUE) AS TXT FROM performance_schema.global_variables WHERE VARIABLE_NAME = 'log_bin'",
        fallback: ["SELECT 'log_bin' AS OBJ, UPPER(VARIABLE_VALUE) AS TXT FROM information_schema.GLOBAL_VARIABLES WHERE VARIABLE_NAME = 'log_bin'"],
      },
      POSTGRESQL: { sql: "SELECT 'archive_mode' AS OBJ, UPPER(current_setting('archive_mode')) AS TXT" },
      DAMENG: { sql: "SELECT 'ARCH_MODE' AS OBJ, CASE ARCH_MODE WHEN 'Y' THEN 'ARCHIVELOG' ELSE 'NOARCHIVELOG' END AS TXT FROM V$DATABASE" },
    },
  },
  {
    code: 'backup.archive_failing', name: 'WAL 归档失败', category: 'BACKUP', sort: 72,
    desc: 'PostgreSQL 开启归档后，最近一次归档失败晚于最近一次成功，会导致 WAL 堆积撑满磁盘。',
    rule: { type: 'STATUS', bad: ['FAILING'], level: 'CRITICAL' },
    advice: '检查 archive_command 执行结果与归档目标空间 / 权限，修复后确认 pg_stat_archiver.last_archived_time 持续前进。',
    impls: {
      POSTGRESQL: { sql: "SELECT 'archiver' AS OBJ, CASE WHEN last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time) THEN 'FAILING' ELSE 'OK' END AS TXT, failed_count AS FAILED_COUNT, TO_CHAR(last_failed_time, 'YYYY-MM-DD HH24:MI:SS') AS LAST_FAILED FROM pg_stat_archiver WHERE current_setting('archive_mode') <> 'off'" },
    },
  },

  // ------------------------------------------------------------------ 配置
  {
    code: 'config.key_params', name: '关键参数一览', category: 'CONFIG', sort: 80,
    desc: '内存、连接、日志刷盘等关键参数当前值（仅展示，供基线对照）。',
    rule: { type: 'INFO' }, advice: '',
    impls: {
      ORACLE: { sql: "SELECT name AS OBJ, value AS TXT FROM v$parameter WHERE name IN ('sga_target','sga_max_size','pga_aggregate_target','memory_target','processes','sessions','open_cursors','db_files','undo_retention','compatible','cursor_sharing','statistics_level') ORDER BY name" },
      MYSQL: {
        sql: "SELECT VARIABLE_NAME AS OBJ, VARIABLE_VALUE AS TXT FROM performance_schema.global_variables WHERE VARIABLE_NAME IN ('innodb_buffer_pool_size','max_connections','innodb_flush_log_at_trx_commit','sync_binlog','binlog_format','long_query_time','slow_query_log','transaction_isolation','character_set_server','innodb_log_file_size') ORDER BY VARIABLE_NAME",
        fallback: ["SELECT VARIABLE_NAME AS OBJ, VARIABLE_VALUE AS TXT FROM information_schema.GLOBAL_VARIABLES WHERE VARIABLE_NAME IN ('innodb_buffer_pool_size','max_connections','innodb_flush_log_at_trx_commit','sync_binlog','binlog_format','long_query_time','slow_query_log','transaction_isolation','character_set_server','innodb_log_file_size') ORDER BY VARIABLE_NAME"],
      },
      POSTGRESQL: { sql: "SELECT name AS OBJ, setting || COALESCE(' ' || unit, '') AS TXT FROM pg_settings WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','max_connections','effective_cache_size','wal_level','max_wal_size','checkpoint_timeout','autovacuum','synchronous_commit','shared_preload_libraries') ORDER BY name" },
      DAMENG: {
        sql: "SELECT PARA_NAME AS OBJ, PARA_VALUE AS TXT FROM V$DM_INI WHERE PARA_NAME IN ('MAX_SESSIONS','MEMORY_POOL','BUFFER','MAX_BUFFER','TEMP_SIZE','RLOG_BUF_SIZE','ENABLE_MONITOR','SVR_LOG') ORDER BY PARA_NAME",
        fallback: ["SELECT NAME AS OBJ, VALUE AS TXT FROM V$PARAMETER WHERE NAME IN ('MAX_SESSIONS','MEMORY_POOL','BUFFER','MAX_BUFFER','TEMP_SIZE','RLOG_BUF_SIZE','ENABLE_MONITOR','SVR_LOG') ORDER BY NAME"],
      },
    },
  },

  // ------------------------------------------------------------------ 安全
  {
    code: 'security.pwd_expiry', name: '账户口令即将过期', category: 'SECURITY', sort: 90,
    desc: '启用状态的账户口令距过期的天数，过期后应用连接会失败。',
    rule: { type: 'THRESHOLD', direction: 'LOW', unit: '天', objLabel: '账户', maxFindings: 20 }, warn: 14, crit: 3,
    advice: '提前修改口令或调整 profile（PASSWORD_LIFE_TIME）；应用账户建议使用不过期 profile 并走密钥托管。',
    impls: {
      ORACLE: { sql: "SELECT username AS OBJ, ROUND(expiry_date - SYSDATE) AS VAL, account_status AS STATUS FROM dba_users WHERE account_status = 'OPEN' AND expiry_date IS NOT NULL AND expiry_date < SYSDATE + 14 ORDER BY expiry_date" },
      DAMENG: { sql: "SELECT username AS OBJ, ROUND(expiry_date - SYSDATE) AS VAL, account_status AS STATUS FROM dba_users WHERE expiry_date IS NOT NULL AND expiry_date < SYSDATE + 14 ORDER BY expiry_date" },
      POSTGRESQL: { sql: "SELECT rolname AS OBJ, ROUND(EXTRACT(EPOCH FROM (rolvaliduntil - now())) / 86400) AS VAL FROM pg_roles WHERE rolcanlogin AND rolvaliduntil IS NOT NULL AND rolvaliduntil < now() + interval '14 days' ORDER BY rolvaliduntil" },
    },
  },
  {
    code: 'security.weak_account', name: '默认口令 / 空口令账户', category: 'SECURITY', sort: 91,
    desc: 'Oracle 使用默认口令的开放账户、MySQL / PG 口令为空的可登录账户。',
    rule: { type: 'ROWS', level: 'CRITICAL', objLabel: '账户', maxFindings: 20 },
    advice: '立即修改口令或锁定账户；MySQL 空口令账户应删除或设置口令并限制来源主机。',
    impls: {
      ORACLE: { sql: "SELECT d.username AS OBJ, u.account_status AS TXT FROM dba_users_with_defpwd d JOIN dba_users u ON u.username = d.username WHERE u.account_status = 'OPEN'" },
      MYSQL: {
        sql: "SELECT CONCAT(user, '@', host) AS OBJ, plugin AS TXT FROM mysql.user WHERE (authentication_string IS NULL OR authentication_string = '') AND account_locked = 'N' AND plugin NOT IN ('auth_socket', 'unix_socket')",
        fallback: ["SELECT CONCAT(user, '@', host) AS OBJ, plugin AS TXT FROM mysql.user WHERE (authentication_string IS NULL OR authentication_string = '') AND plugin NOT IN ('auth_socket', 'unix_socket')"],
      },
      POSTGRESQL: { sql: "SELECT usename AS OBJ, 'NO_PASSWORD' AS TXT FROM pg_shadow WHERE passwd IS NULL AND (valuntil IS NULL OR valuntil > now())" },
    },
  },

  // ------------------------------------------------------------------ 日志
  {
    code: 'log.errors', name: '近 24 小时错误日志', category: 'LOG', sort: 95,
    desc: '告警日志 / 错误日志里近 24 小时的错误条数（Oracle 取 v$diag_alert_ext 的 ORA- 错误，MySQL 8.0.22+ 取 error_log 表）。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '条' }, warn: 1, crit: 50,
    advice: '逐条核对错误日志，处理根因（空间 / 权限 / 死锁 / 网络），确认没有持续新增。',
    impls: {
      ORACLE: { sql: "SELECT 'alert.log' AS OBJ, COUNT(*) AS VAL, MAX(SUBSTR(message_text, 1, 200)) AS SAMPLE FROM v$diag_alert_ext WHERE originating_timestamp > SYSTIMESTAMP - INTERVAL '1' DAY AND message_text LIKE '%ORA-%'" },
      MYSQL: { sql: "SELECT 'error.log' AS OBJ, COUNT(*) AS VAL, MAX(LEFT(DATA, 200)) AS SAMPLE FROM performance_schema.error_log WHERE LOGGED > NOW() - INTERVAL 1 DAY AND PRIO = 'Error'" },
    },
  },
];

module.exports = { ITEMS, ORA_SYS, DM_SYS };
