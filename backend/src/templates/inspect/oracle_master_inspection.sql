
-- ============================================================
-- §1  实例基本信息
-- ============================================================
PROMPT >>SECTION: 1. 实例基本信息
SELECT
    INSTANCE_NUMBER  AS INST_NO,
    INSTANCE_NAME,
    HOST_NAME,
    VERSION,
    STATUS,
    DATABASE_STATUS,
    INSTANCE_ROLE,
    ACTIVE_STATE,
    LOGINS,
    TO_CHAR(STARTUP_TIME,'YYYY-MM-DD HH24:MI:SS') AS STARTUP_TIME
FROM V$INSTANCE;

PROMPT >>SECTION: 2. 数据库基本信息
SELECT
    DBID,
    NAME          AS DB_NAME,
    DB_UNIQUE_NAME,
    CREATED,
    LOG_MODE,
    OPEN_MODE,
    PROTECTION_MODE,
    DATABASE_ROLE,
    SWITCHOVER_STATUS,
    DATAGUARD_BROKER,
    FORCE_LOGGING,
    PLATFORM_NAME
FROM V$DATABASE;

-- ============================================================
-- §2  健康检查 (HEALTH)
-- ============================================================
PROMPT >>SECTION: 3. [HEALTH] 告警日志最近50条 ORA- 错误
SELECT
    ORIGINATING_TIMESTAMP                  AS ERR_TIME,
    SUBSTR(MESSAGE_TEXT,1,200)             AS MESSAGE
FROM V$DIAG_ALERT_EXT
WHERE MESSAGE_TEXT LIKE '%ORA-%'
  AND ORIGINATING_TIMESTAMP >= SYSDATE - 7
ORDER BY ORIGINATING_TIMESTAMP DESC
FETCH FIRST 50 ROWS ONLY;

PROMPT >>SECTION: 4. [HEALTH] 无效对象统计
SELECT
    OWNER,
    OBJECT_TYPE,
    COUNT(*) AS INVALID_CNT
FROM DBA_OBJECTS
WHERE STATUS = 'INVALID'
GROUP BY OWNER, OBJECT_TYPE
ORDER BY INVALID_CNT DESC;

PROMPT >>SECTION: 5. [HEALTH] 锁等待 (等待 > 30s)
SELECT w.inst_id AS wait_inst,
       w.sid AS wait_sid,
       w.serial# AS wait_serial,
       w.username AS wait_user,
       w.seconds_in_wait,
       w.event,
       b.inst_id  AS block_inst,
       b.sid      AS block_sid,
       b.serial#  AS block_serial,
       b.username AS block_user,
       w.sql_id    AS wait_sql_id,
       q1.sql_text AS wait_sql,
       b.sql_id    AS block_sql_id,
       q2.sql_text AS block_sql
  FROM gv$session w
  LEFT JOIN gv$session b ON w.blocking_instance = b.inst_id
                        AND w.blocking_session = b.sid
  LEFT JOIN gv$sql q1 ON w.inst_id = q1.inst_id
                     AND w.sql_id = q1.sql_id
  LEFT JOIN gv$sql q2 ON b.inst_id = q2.inst_id
                     AND b.sql_id = q2.sql_id
 WHERE w.blocking_session IS NOT NULL
   AND w.seconds_in_wait > 30
   AND w.type != 'BACKGROUND'
 ORDER BY w.seconds_in_wait DESC;

PROMPT >>SECTION: 6. [HEALTH] 活跃会话概况
SELECT
    STATUS,
    USERNAME,
    COUNT(*) AS CNT
FROM V$SESSION
WHERE TYPE = 'USER'
GROUP BY STATUS, USERNAME
ORDER BY CNT DESC;

PROMPT >>SECTION: 7. [HEALTH] 最近10次检查点时间
SELECT
    CHECKPOINT_CHANGE#,
    TO_CHAR(CHECKPOINT_TIME,'YYYY-MM-DD HH24:MI:SS') AS CKPT_TIME
FROM V$DATAFILE_HEADER
WHERE ROWNUM <= 10
ORDER BY CHECKPOINT_TIME DESC;

-- ============================================================
-- §3  风险检查 (RISK)
-- ============================================================
PROMPT >>SECTION: 8. [RISK] TOP 10 高等待 SQL (近1小时)
SELECT *
FROM (
    SELECT
        SQL_ID,
        ELAPSED_TIME / NULLIF(EXECUTIONS,0) / 1000000   AS AVG_ELAPSED_SEC,
        EXECUTIONS,
        BUFFER_GETS / NULLIF(EXECUTIONS,0)               AS AVG_BUFFER_GETS,
        DISK_READS  / NULLIF(EXECUTIONS,0)               AS AVG_DISK_READS,
        ROWS_PROCESSED / NULLIF(EXECUTIONS,0)            AS AVG_ROWS,
        CPU_TIME / NULLIF(EXECUTIONS,0) / 1000000        AS AVG_CPU_SEC,
        PARSING_SCHEMA_NAME                              AS SCHEMA_NAME,
        SUBSTR(SQL_TEXT,1,200)                           AS SQL_PREVIEW
    FROM V$SQL
    WHERE LAST_ACTIVE_TIME >= SYSDATE - 1/24
      AND EXECUTIONS > 0
    ORDER BY ELAPSED_TIME DESC
)
WHERE ROWNUM <= 10;

PROMPT >>SECTION: 9. [RISK] 大事务 (UNDO > 100MB)
SELECT
    T.ADDR,
    T.XIDUSN,
    T.XIDSLOT,
    T.XIDSQN,
    S.USERNAME,
    S.SID,
    S.SERIAL#,
    S.STATUS,
    ROUND(T.USED_UBLK * 8192 / 1048576, 2)   AS UNDO_USED_MB,
    T.START_DATE,
    T.STATUS                                   AS TXN_STATUS
FROM V$TRANSACTION T
JOIN V$SESSION S ON T.SES_ADDR = S.SADDR
WHERE T.USED_UBLK * 8192 / 1048576 > 100
ORDER BY T.USED_UBLK DESC;

PROMPT >>SECTION: 10. [RISK] 审计权限过高账户
SELECT
    USERNAME,
    ACCOUNT_STATUS,
    PROFILE,
    DEFAULT_TABLESPACE,
    CREATED
FROM DBA_USERS
WHERE ACCOUNT_STATUS = 'OPEN'
  AND USERNAME NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN')
ORDER BY CREATED;

PROMPT >>SECTION: 11. [RISK] DBA角色授权列表
SELECT
    GRANTEE,
    GRANTED_ROLE,
    ADMIN_OPTION,
    DEFAULT_ROLE
FROM DBA_ROLE_PRIVS
WHERE GRANTED_ROLE = 'DBA'
  AND GRANTEE NOT IN ('SYS','SYSTEM')
ORDER BY GRANTEE;

PROMPT >>SECTION: 12. [RISK] 无索引的外键
SELECT
    C.OWNER,
    C.TABLE_NAME,
    C.CONSTRAINT_NAME,
    C.COLUMN_NAME,
    C.POSITION
FROM DBA_CONS_COLUMNS C
JOIN DBA_CONSTRAINTS   R
    ON C.CONSTRAINT_NAME = R.CONSTRAINT_NAME
   AND C.OWNER           = R.OWNER
WHERE R.CONSTRAINT_TYPE = 'R'
  AND NOT EXISTS (
      SELECT 1
      FROM DBA_IND_COLUMNS I
      WHERE I.TABLE_NAME   = C.TABLE_NAME
        AND I.COLUMN_NAME  = C.COLUMN_NAME
        AND I.COLUMN_POSITION = C.POSITION
        AND I.INDEX_OWNER  = C.OWNER
  )
  AND R.OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','ORDSYS','MDSYS','ORDDATA','ANONYMOUS','ORACLE_OCM','XDB')
ORDER BY C.OWNER, C.TABLE_NAME;

-- ============================================================
-- §4  参数异常检查 (PARAMETER)
-- ============================================================
PROMPT >>SECTION: 13. [PARAMETER] 关键初始化参数
SELECT
    NAME,
    VALUE,
    DESCRIPTION,
    ISDEFAULT,
    ISMODIFIED,
    ISDEPRECATED
FROM V$PARAMETER
WHERE NAME IN (
    'sga_target','sga_max_size','pga_aggregate_target','pga_aggregate_limit',
    'db_cache_size','shared_pool_size','large_pool_size','java_pool_size',
    'memory_target','memory_max_target',
    'processes','sessions','open_cursors','cursor_sharing',
    'db_block_size','db_file_multiblock_read_count',
    'log_buffer','undo_retention','undo_tablespace',
    'audit_trail','enable_ddl_logging',
    'parallel_max_servers','parallel_min_servers',
    'optimizer_mode','optimizer_features_enable',
    'archive_lag_target','db_recovery_file_dest_size',
    'log_archive_dest_1','log_archive_dest_2',
    'remote_login_passwordfile','sec_case_sensitive_logon'
)
ORDER BY NAME;

PROMPT >>SECTION: 14. [PARAMETER] 隐含参数（非默认值）
SELECT
    KSPPINM  AS PARAM_NAME,
    KSPPSTVL AS VALUE,
    KSPPDESC AS DESCRIPTION
FROM SYS.X$KSPPI  PI
JOIN SYS.X$KSPPCV CV ON PI.INDX = CV.INDX
WHERE KSPPINM LIKE '\_%' ESCAPE '\'
  AND KSPPSTDF = 'FALSE'
ORDER BY KSPPINM;

PROMPT >>SECTION: 15. [PARAMETER] 统计信息收集参数
SELECT
    DBMS_STATS.GET_PREFS('AUTOSTATS_TARGET')       AS AUTOSTATS_TARGET,
    DBMS_STATS.GET_PREFS('ESTIMATE_PERCENT')        AS ESTIMATE_PCT,
    DBMS_STATS.GET_PREFS('METHOD_OPT')              AS METHOD_OPT,
    DBMS_STATS.GET_PREFS('CASCADE')                 AS CASCADE,
    DBMS_STATS.GET_PREFS('DEGREE')                  AS DEGREE
FROM DUAL;

-- ============================================================
-- §5  空间风险检查 (SPACE)
-- ============================================================
PROMPT >>SECTION: 16. [SPACE] 表空间使用率
SELECT
    DF.TABLESPACE_NAME,
    DF.TOTAL_MB,
    NVL(FS.FREE_MB, 0)                             AS FREE_MB,
    DF.TOTAL_MB - NVL(FS.FREE_MB, 0)               AS USED_MB,
    ROUND((DF.TOTAL_MB - NVL(FS.FREE_MB,0)) / DF.TOTAL_MB * 100, 2) AS USED_PCT,
    DF.AUTOEXTENSIBLE,
    DF.MAX_MB,
    T.STATUS,
    T.CONTENTS                                      AS TYPE
FROM (
    SELECT TABLESPACE_NAME,
           ROUND(SUM(BYTES)/1048576, 2)      AS TOTAL_MB,
           ROUND(SUM(MAXBYTES)/1048576, 2)   AS MAX_MB,
           MAX(AUTOEXTENSIBLE)               AS AUTOEXTENSIBLE
    FROM DBA_DATA_FILES
    GROUP BY TABLESPACE_NAME
    UNION ALL
    SELECT TABLESPACE_NAME,
           ROUND(SUM(BYTES)/1048576, 2), 0, 'NO'
    FROM DBA_TEMP_FILES
    GROUP BY TABLESPACE_NAME
) DF
LEFT JOIN (
    SELECT TABLESPACE_NAME,
           ROUND(SUM(BYTES)/1048576, 2) AS FREE_MB
    FROM DBA_FREE_SPACE
    GROUP BY TABLESPACE_NAME
) FS ON DF.TABLESPACE_NAME = FS.TABLESPACE_NAME
JOIN DBA_TABLESPACES T ON DF.TABLESPACE_NAME = T.TABLESPACE_NAME
ORDER BY USED_PCT DESC;

PROMPT >>SECTION: 17. [SPACE] TOP 20 大表 (含分区)
SELECT *
FROM (
    SELECT
        OWNER,
        SEGMENT_NAME   AS TABLE_NAME,
        PARTITION_NAME,
        SEGMENT_TYPE,
        ROUND(SUM(BYTES)/1048576/1024, 3)  AS SIZE_GB,
        TABLESPACE_NAME
    FROM DBA_SEGMENTS
    WHERE SEGMENT_TYPE LIKE 'TABLE%'
      AND OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','ORDSYS','MDSYS','ORDDATA','ANONYMOUS','ORACLE_OCM')
    GROUP BY OWNER, SEGMENT_NAME, PARTITION_NAME, SEGMENT_TYPE, TABLESPACE_NAME
    ORDER BY SIZE_GB DESC
)
WHERE ROWNUM <= 20;

PROMPT >>SECTION: 18. [SPACE] TOP 20 大索引
SELECT *
FROM (
    SELECT
        OWNER,
        SEGMENT_NAME   AS INDEX_NAME,
        ROUND(SUM(BYTES)/1048576, 2) AS SIZE_MB,
        TABLESPACE_NAME
    FROM DBA_SEGMENTS
    WHERE SEGMENT_TYPE = 'INDEX'
      AND OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','ORDSYS','MDSYS','ORDDATA','ANONYMOUS','ORACLE_OCM')
    GROUP BY OWNER, SEGMENT_NAME, TABLESPACE_NAME
    ORDER BY SIZE_MB DESC
)
WHERE ROWNUM <= 20;

PROMPT >>SECTION: 19. [SPACE] UNDO 使用状况
SELECT
    TABLESPACE_NAME,
    STATUS,
    COUNT(*)                                           AS EXTENT_CNT,
    ROUND(SUM(BLOCKS * 8192)/1048576, 2)               AS SIZE_MB
FROM DBA_UNDO_EXTENTS
GROUP BY TABLESPACE_NAME, STATUS
ORDER BY TABLESPACE_NAME, STATUS;

PROMPT >>SECTION: 20. [SPACE] FRA (闪回区) 使用情况
SELECT
    NAME,
    ROUND(SPACE_LIMIT/1073741824, 2)          AS LIMIT_GB,
    ROUND(SPACE_USED /1073741824, 2)          AS USED_GB,
    ROUND(SPACE_RECLAIMABLE/1073741824, 2)    AS RECLAIMABLE_GB,
    ROUND(SPACE_USED/NULLIF(SPACE_LIMIT,0)*100, 2) AS USED_PCT,
    NUMBER_OF_FILES
FROM V$RECOVERY_FILE_DEST;

PROMPT >>SECTION: 21. [SPACE] 归档日志生成速率 (近7天,每天)
SELECT
    TRUNC(COMPLETION_TIME)              AS LOG_DATE,
    COUNT(*)                            AS ARCH_CNT,
    ROUND(SUM(BLOCKS*BLOCK_SIZE)/1073741824, 2) AS SIZE_GB
FROM V$ARCHIVED_LOG
WHERE COMPLETION_TIME >= SYSDATE - 7
  AND STANDBY_DEST = 'NO'
GROUP BY TRUNC(COMPLETION_TIME)
ORDER BY LOG_DATE;

-- ============================================================
-- §6  HA 风险检查 (HA) - 单机 + RAC
-- ============================================================
PROMPT >>SECTION: 22. [HA] 重做日志组状态
SELECT
    L.GROUP#,
    L.MEMBERS,
    L.BYTES / 1048576   AS SIZE_MB,
    L.STATUS,
    L.ARCHIVED,
    LF.MEMBER           AS LOG_FILE
FROM V$LOG     L
JOIN V$LOGFILE LF ON L.GROUP# = LF.GROUP#
ORDER BY L.GROUP#, LF.MEMBER;

PROMPT >>SECTION: 23. [HA] 数据文件状态
SELECT
    FILE#,
    NAME,
    STATUS,
    ENABLED,
    ROUND(BYTES/1073741824, 3)  AS SIZE_GB,
    CHECKPOINT_CHANGE#,
    TO_CHAR(LAST_TIME,'YYYY-MM-DD HH24:MI:SS') AS LAST_BACKUP_TIME
FROM V$DATAFILE
ORDER BY FILE#;

PROMPT >>SECTION: 24. [HA] RAC 节点状态
SELECT
    INST_ID,
    INSTANCE_NUMBER,
    INSTANCE_NAME,
    HOST_NAME,
    STATUS,
    ACTIVE_STATE,
    INSTANCE_ROLE,
    DATABASE_STATUS
FROM GV$INSTANCE
ORDER BY INST_ID;

PROMPT >>SECTION: 25. [HA] RAC 节点互联延迟 (ICM)
SELECT
    INST_ID,
    EVENT,
    ROUND(AVERAGE_WAIT,2) AS AVG_WAIT_MS,
    TOTAL_WAITS,
    ROUND(TIME_WAITED/100,2) AS TIME_WAITED_SEC,
    CASE
        WHEN AVERAGE_WAIT > 30 THEN 'CRITICAL'
        WHEN AVERAGE_WAIT > 15 THEN 'WARNING'
        ELSE 'OK'
    END AS STATUS
FROM GV$SYSTEM_EVENT
WHERE EVENT IN (
    'gc cr request',
    'gc current request'
)
ORDER BY AVERAGE_WAIT DESC;

PROMPT >>SECTION: 26. [HA] RAC 全局缓存等待 (GCS/GES)
SELECT
    INST_ID,
    NAME,
    VALUE
FROM GV$SYSSTAT
WHERE NAME IN (
    'gc cr blocks received',
    'gc current blocks received',
    'gc cr block receive time',
    'gc current block receive time',
    'gc blocks lost',
    'gc blocks corrupt',
    'global enqueue gets sync',
    'global enqueue get time'
)
ORDER BY INST_ID, NAME;

PROMPT >>SECTION: 27. [HA] RAC 等待事件 TOP10
SELECT *
FROM (
    SELECT
        INST_ID,
        EVENT,
        TOTAL_WAITS,
        ROUND(TIME_WAITED_MICRO/1000000,2) AS WAIT_SEC,
        ROUND(
            TIME_WAITED_MICRO / TOTAL_WAITS / 1000,
        2) AS AVG_WAIT_MS,
        CASE
            WHEN TIME_WAITED_MICRO / TOTAL_WAITS / 1000 > 30
                 THEN 'CRITICAL'
            WHEN TIME_WAITED_MICRO / TOTAL_WAITS / 1000 > 10
                 THEN 'WARNING'
            ELSE 'OK'
        END STATUS
    FROM GV$SYSTEM_EVENT
    WHERE EVENT LIKE 'gc%'
      AND TOTAL_WAITS > 0
)
ORDER BY AVG_WAIT_MS DESC
FETCH FIRST 10 ROWS ONLY;
-- ============================================================
-- §7  ADG (Data Guard) 巡检
-- ============================================================
PROMPT >>SECTION: 28. [ADG] Data Guard 配置
SELECT
    DB_UNIQUE_NAME,
    database_ROLE,
    PROTECTION_MODE,
    PROTECTION_LEVEL,
    DATABASE_ROLE,
    OPEN_MODE,
    SWITCHOVER_STATUS,
    DATAGUARD_BROKER,
    GUARD_STATUS,
    SUPPLEMENTAL_LOG_DATA_MIN AS SUPP_LOG_MIN,
    SUPPLEMENTAL_LOG_DATA_PK  AS SUPP_LOG_PK,
    FORCE_LOGGING
FROM V$DATABASE;

PROMPT >>SECTION: 29. [ADG] Redo Apply 进度 (备库执行)
SELECT
    TYPE,
    ITEM,
    SOFAR,
    TOTAL,
    UNITS,
    TIMESTAMP
FROM V$RECOVERY_PROGRESS
ORDER BY TIMESTAMP;

PROMPT >>SECTION: 30. [ADG] 同步延迟 (apply lag)
SELECT
    NAME,
    VALUE,
    DATUM_TIME,
    TIME_COMPUTED
FROM V$DATAGUARD_STATS
WHERE NAME IN ('transport lag','apply lag','apply finish time','estimated startup time')
ORDER BY NAME;

PROMPT >>SECTION: 31. [ADG] MRP / LSP 进程状态
SELECT
    PROCESS,
    STATUS,
    CLIENT_PROCESS,
    CLIENT_DBID,
    SEQUENCE#,
    THREAD#,
    DELAY_MINS,
    BLOCK#,
    ACTIVE_AGENTS,
    KNOWN_AGENTS
FROM V$MANAGED_STANDBY
ORDER BY PROCESS;

PROMPT >>SECTION: 32. [ADG] 归档传输间隙 (Gap)
SELECT
    THREAD#,
    LOW_SEQUENCE#,
    HIGH_SEQUENCE#
FROM V$ARCHIVE_GAP;

PROMPT >>SECTION: 33. [ADG] Redo Log 传输状态
SELECT
    DEST_ID,
    DEST_NAME,
    STATUS,
    TARGET,
    ARCHIVER,
    SCHEDULE,
    DESTINATION,
    AFFIRM,
    TRANSMIT_MODE,
    ASYNC_BLOCKS,
    NET_TIMEOUT,
    DELAY_MINS,
    MAX_FAILURE,
    REOPEN_SECS,
    DB_UNIQUE_NAME,
    APPLIED_SCN,
    ERROR
FROM V$ARCHIVE_DEST
WHERE STATUS != 'INACTIVE'
ORDER BY DEST_ID;

PROMPT >>SECTION: 34. [ADG] Standby Logfile 状态
SELECT
    GROUP#,
    THREAD#,
    SEQUENCE#,
    ROUND(BYTES/1048576,1)  AS SIZE_MB,
    USED,
    STATUS,
    ARCHIVED,
    FIRST_CHANGE#,
    TO_CHAR(FIRST_TIME,'YYYY-MM-DD HH24:MI:SS') AS FIRST_TIME
FROM V$STANDBY_LOG
ORDER BY GROUP#;

-- ============================================================
-- §8  AWR / ASH 性能摘要
-- ============================================================
PROMPT >>SECTION: 35. [PERF] 最近AWR快照概况
SELECT
    SNAP_ID,
    INSTANCE_NUMBER,
    TO_CHAR(BEGIN_INTERVAL_TIME,'YYYY-MM-DD HH24:MI') AS BEGIN_TIME,
    TO_CHAR(END_INTERVAL_TIME,'YYYY-MM-DD HH24:MI')   AS END_TIME,
    SNAP_LEVEL,
    ERROR_COUNT
FROM DBA_HIST_SNAPSHOT
WHERE BEGIN_INTERVAL_TIME >= SYSDATE - 1
ORDER BY SNAP_ID DESC
FETCH FIRST 24 ROWS ONLY;

PROMPT >>SECTION: 36. [PERF] 系统统计 DB Time / DB CPU (最近1快照间隔)
SELECT
    S.STAT_NAME,
    SN.VALUE   AS SNAP_VALUE
FROM DBA_HIST_SYS_TIME_MODEL SN
JOIN (SELECT STAT_ID, STAT_NAME FROM V$SYS_TIME_MODEL) S ON SN.STAT_ID = S.STAT_ID
WHERE SN.SNAP_ID = (SELECT MAX(SNAP_ID) FROM DBA_HIST_SNAPSHOT WHERE INSTANCE_NUMBER = 1)
  AND SN.INSTANCE_NUMBER = 1
  AND S.STAT_NAME IN ('DB time','DB CPU','background cpu time','parse time elapsed',
                      'hard parse elapsed time','PL/SQL execution elapsed time')
ORDER BY SN.VALUE DESC;

PROMPT >>SECTION: 37. [PERF] ASH 近10分钟等待 TOP10
SELECT *
FROM (
    SELECT
        EVENT,
        COUNT(*)                        AS SAMPLES,
        ROUND(COUNT(*)/SUM(COUNT(*)) OVER()*100, 2) AS PCT
    FROM V$ACTIVE_SESSION_HISTORY
    WHERE SAMPLE_TIME >= SYSDATE - 10/1440
      AND SESSION_TYPE = 'FOREGROUND'
      AND EVENT IS NOT NULL
    GROUP BY EVENT
    ORDER BY SAMPLES DESC
)
WHERE ROWNUM <= 10;

-- ============================================================
-- §9  备份状态
-- ============================================================
PROMPT >>SECTION: 38. [BACKUP] RMAN 最近备份记录
SELECT
    SESSION_KEY,
    TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
    TO_CHAR(END_TIME,'YYYY-MM-DD HH24:MI:SS')   AS END_TIME,
    INPUT_TYPE,
    STATUS,
    ROUND(INPUT_BYTES/1073741824, 2)             AS INPUT_GB,
    ROUND(OUTPUT_BYTES/1073741824, 2)            AS OUTPUT_GB,
    ROUND(ELAPSED_SECONDS/60, 1)                 AS ELAPSED_MIN,
    COMPRESSION_RATIO
FROM V$RMAN_BACKUP_JOB_DETAILS
WHERE START_TIME >= SYSDATE - 7
ORDER BY START_TIME DESC;

PROMPT >>SECTION: 39. [BACKUP] 不可恢复的数据文件
SELECT
    FILE#,
    NAME,
    UNRECOVERABLE_CHANGE#,
    TO_CHAR(UNRECOVERABLE_TIME,'YYYY-MM-DD HH24:MI:SS') AS UNRECOVERABLE_TIME
FROM V$DATAFILE
WHERE UNRECOVERABLE_CHANGE# > 0;

-- ============================================================
-- §10  对象统计陈旧检测
-- ============================================================
PROMPT >>SECTION: 40. [STAT] 统计信息过期 TOP20 大表
SELECT *
FROM (
    SELECT
        T.OWNER,
        T.TABLE_NAME,
        T.NUM_ROWS,
        T.BLOCKS,
        T.LAST_ANALYZED,
        T.STALE_STATS,
        ROUND(S.BYTES/1048576, 2) AS SIZE_MB
    FROM DBA_TAB_STATISTICS T
    LEFT JOIN (
        SELECT OWNER, SEGMENT_NAME, SUM(BYTES) AS BYTES
        FROM DBA_SEGMENTS
        WHERE SEGMENT_TYPE LIKE 'TABLE%'
        GROUP BY OWNER, SEGMENT_NAME
    ) S ON T.OWNER=S.OWNER AND T.TABLE_NAME=S.SEGMENT_NAME
    WHERE (T.STALE_STATS = 'YES' OR T.LAST_ANALYZED IS NULL)
      AND T.OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','ORDSYS','MDSYS','ORDDATA','ANONYMOUS','ORACLE_OCM')
    ORDER BY S.BYTES DESC NULLS LAST
)
WHERE ROWNUM <= 20;


-- ============================================================
-- ============================================================
-- §11  参数风险评估 (PARAMETER RISK) -- 来源: oracle_parameter.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §11-1  内存参数风险评估
-- 经验：SGA不足导致ORA-4031；PGA太小导致大量磁盘排序
-- ============================================================
PROMPT >>SECTION: 41. [PARAMETER-RISK] SGA / PGA 内存配置评估
SET LINESIZE 300 PAGESIZE 200 TRIMOUT ON TRIMSPOOL ON FEEDBACK OFF VERIFY OFF
COLUMN PARAM_NAME    FORMAT A38
COLUMN CURRENT_VALUE FORMAT A25
COLUMN RECOMMEND     FORMAT A25
COLUMN RISK_LEVEL    FORMAT A11
COLUMN REMARK        FORMAT A60
WITH MEM AS (
    SELECT
        (SELECT VALUE FROM V$PARAMETER WHERE NAME='sga_target')           AS SGA_TARGET,
        (SELECT VALUE FROM V$PARAMETER WHERE NAME='pga_aggregate_target') AS PGA_TARGET,
        (SELECT VALUE FROM V$PARAMETER WHERE NAME='memory_target')        AS MEM_TARGET,
        (SELECT SUM(VALUE) FROM V$SGA)                                    AS SGA_ACTUAL,
        (SELECT VALUE FROM V$PGASTAT WHERE NAME='aggregate PGA target parameter') AS PGA_ACTUAL,
        (SELECT VALUE FROM V$PGASTAT WHERE NAME='total PGA allocated')    AS PGA_ALLOC,
        (SELECT ROUND(VALUE/1073741824,2) FROM V$OSSTAT WHERE STAT_NAME='PHYSICAL_MEMORY_BYTES') AS OS_MEM_GB
    FROM DUAL
)
SELECT
    CASE
        WHEN SGA_ACTUAL / 1073741824 < 1                        THEN '[CRITICAL]'
        WHEN TO_NUMBER(SGA_TARGET) = 0 AND MEM_TARGET = '0'    THEN '[WARNING] '
        WHEN PGA_ALLOC / NULLIF(TO_NUMBER(PGA_TARGET),0) > 1.5 THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                          AS RISK_LEVEL,
    ROUND(OS_MEM_GB, 2)                                          AS OS_MEM_GB,
    ROUND(SGA_ACTUAL / 1073741824, 2)                           AS SGA_ACTUAL_GB,
    ROUND(TO_NUMBER(SGA_TARGET) / 1073741824, 2)                AS SGA_TARGET_GB,
    ROUND(TO_NUMBER(PGA_TARGET) / 1073741824, 2)                AS PGA_TARGET_GB,
    ROUND(PGA_ALLOC / 1073741824, 2)                            AS PGA_ALLOCATED_GB,
    ROUND(TO_NUMBER(MEM_TARGET) / 1073741824, 2)                AS MEMORY_TARGET_GB,
    CASE
        WHEN TO_NUMBER(SGA_TARGET) = 0 AND MEM_TARGET = '0'
            THEN 'advis enable AMM(memory_target) 或 ASMM(sga_target)'
        WHEN PGA_ALLOC / NULLIF(TO_NUMBER(PGA_TARGET),0) > 1.5
            THEN 'PGA 50% over target, increase limit pga_aggregate_target'
        ELSE 'RAM config OK'
    END                                                          AS REMARK
FROM MEM;

-- ============================================================
-- §11-2  连接数与进程数风险
-- 经验：processes达到上限直接OOM或拒绝新连接
-- ============================================================
PROMPT >>SECTION: 42. [PARAMETER-RISK] 连接数 / 进程数使用率
SELECT
    CASE
        WHEN CURR_CONN / MAX_CONN > 0.90 THEN '[CRITICAL]'
        WHEN CURR_CONN / MAX_CONN > 0.75 THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                          AS RISK_LEVEL,
    MAX_CONN                                                     AS MAX_PROCESSES,
    CURR_CONN                                                    AS CURR_PROCESSES,
    ROUND(CURR_CONN / MAX_CONN * 100, 2)                        AS PROC_USAGE_PCT,
    MAX_SESS                                                     AS MAX_SESSIONS,
    CURR_SESS                                                    AS CURR_SESSIONS,
    ROUND(CURR_SESS / MAX_SESS * 100, 2)                        AS SESS_USAGE_PCT,
    OPEN_CURSORS_LIMIT
FROM (
    SELECT
        (SELECT TO_NUMBER(VALUE) FROM V$PARAMETER WHERE NAME='processes')    AS MAX_CONN,
        (SELECT COUNT(*) FROM V$PROCESS WHERE BACKGROUND IS NULL)            AS CURR_CONN,
        (SELECT TO_NUMBER(VALUE) FROM V$PARAMETER WHERE NAME='sessions')     AS MAX_SESS,
        (SELECT COUNT(*) FROM V$SESSION WHERE TYPE='USER')                   AS CURR_SESS,
        (SELECT TO_NUMBER(VALUE) FROM V$PARAMETER WHERE NAME='open_cursors') AS OPEN_CURSORS_LIMIT
    FROM DUAL
);

-- ============================================================
-- §11-3  UNDO 参数风险（ORA-1555快照过旧根源）
-- 经验：undo_retention < 900s 在OLAP环境极易ORA-1555；AUM模式要开guarantee
-- ============================================================
PROMPT >>SECTION: 43. [PARAMETER-RISK] UNDO 配置参数评估
SELECT
    CASE
        WHEN UNDO_RETENTION < 900    THEN '[CRITICAL]'
        WHEN UNDO_RETENTION < 3600   THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                          AS RISK_LEVEL,
    UNDO_RETENTION                                               AS UNDO_RETENTION_SEC,
    UNDO_TBSP,
    UNDO_MGMT,
    GUARANTEE,
    ROUND(UNDO_TOTAL_GB, 2)                                     AS UNDO_TOTAL_GB,
    ROUND(UNDO_USED_GB, 2)                                      AS UNDO_USED_GB,
    ROUND(ACTIVE_GB, 2)                                         AS ACTIVE_GB,
    UNEXPIRED_GB,
    CASE
        WHEN UNDO_RETENTION < 900
            THEN 'advise undo_retention>=3600 enable GUARANTEE'
        WHEN GUARANTEE = 'NOGUARANTEE'
            THEN 'Recommend enabling RETENTION GUARANTEE on the UNDO tablespace'
        ELSE 'Proper parameter configuration'
    END                                                          AS REMARK
FROM (
    SELECT
        (SELECT TO_NUMBER(VALUE) FROM V$PARAMETER WHERE NAME='undo_retention')      AS UNDO_RETENTION,
        (SELECT VALUE FROM V$PARAMETER WHERE NAME='undo_tablespace')                AS UNDO_TBSP,
        (SELECT VALUE FROM V$PARAMETER WHERE NAME='undo_management')                AS UNDO_MGMT,
        (SELECT RETENTION FROM DBA_TABLESPACES WHERE CONTENTS='UNDO' AND ROWNUM=1) AS GUARANTEE,
        (SELECT ROUND(SUM(BYTES)/1073741824,3) FROM DBA_DATA_FILES F
             JOIN DBA_TABLESPACES T ON F.TABLESPACE_NAME=T.TABLESPACE_NAME
             WHERE T.CONTENTS='UNDO')                                               AS UNDO_TOTAL_GB,
        (SELECT ROUND(SUM(USED_UBLK)*8192/1073741824,3) FROM V$TRANSACTION)        AS UNDO_USED_GB,
        (SELECT ROUND(SUM(BLOCKS)*8192/1073741824,3)
             FROM DBA_UNDO_EXTENTS WHERE STATUS='ACTIVE')                           AS ACTIVE_GB,
        (SELECT ROUND(SUM(BLOCKS)*8192/1073741824,3)
             FROM DBA_UNDO_EXTENTS WHERE STATUS='UNEXPIRED')                        AS UNEXPIRED_GB
    FROM DUAL
);

-- ============================================================
-- §11-4  日志缓冲区与归档参数风险
-- 经验：log_buffer < 8MB 在高并发写入时严重影响提交性能
-- ============================================================
PROMPT >>SECTION: 44. [PARAMETER-RISK] Redo Log 相关参数评估
SELECT
    CASE
        WHEN LB_MB < 8                 THEN '[WARNING] '
        WHEN ARC_LAG > 0               THEN '[WARNING] '
        WHEN LOG_MODE = 'NOARCHIVELOG' THEN '[CRITICAL]'
        ELSE '[INFO]    '
    END                                                          AS RISK_LEVEL,
    LB_MB                                                        AS LOG_BUFFER_MB,
    LOG_GROUP_CNT,
    LOG_SIZE_MB,
    ARC_LAG                                                      AS ARCHIVE_LAG_TARGET_SEC,
    LOG_MODE,
    FRA_SIZE_GB,
    CASE
        WHEN LB_MB < 8         THEN 'log_buffer advis>=8M (Current OLTP high-concurrency scenario)'
        WHEN LOG_SIZE_MB < 500 THEN 'Redo advis>=500MB'
        WHEN LOG_GROUP_CNT < 3 THEN 'configure at least 3 redo log group'
        ELSE 'configuration is reasonably set'
    END                                                          AS REMARK
FROM (
    SELECT
        ROUND((SELECT TO_NUMBER(VALUE) FROM V$PARAMETER WHERE NAME='log_buffer')/1048576,1) AS LB_MB,
        (SELECT COUNT(DISTINCT GROUP#) FROM V$LOG)                                           AS LOG_GROUP_CNT,
        ROUND((SELECT AVG(BYTES)/1048576 FROM V$LOG),0)                                      AS LOG_SIZE_MB,
        (SELECT TO_NUMBER(VALUE) FROM V$PARAMETER WHERE NAME='archive_lag_target')            AS ARC_LAG,
        (SELECT LOG_MODE FROM V$DATABASE)                                                      AS LOG_MODE,
        ROUND((SELECT SPACE_LIMIT/1073741824 FROM V$RECOVERY_FILE_DEST WHERE ROWNUM=1),1)     AS FRA_SIZE_GB
    FROM DUAL
);

-- ============================================================
-- §11-5  游标共享与优化器参数风险
-- 经验：cursor_sharing=FORCE 在 12c 以后有 BUG；optimizer 错配导致执行计划突变
-- ============================================================
PROMPT >>SECTION: 45. [PARAMETER-RISK] 优化器与游标关键参数（含风险判定）
SELECT
    NAME                                                         AS PARAM_NAME,
    VALUE                                                        AS CURRENT_VALUE,
    CASE NAME
        WHEN 'cursor_sharing'
            THEN CASE WHEN VALUE='EXACT' THEN '[INFO]    ' ELSE '[WARNING] ' END
        WHEN 'optimizer_mode'
            THEN CASE WHEN VALUE='ALL_ROWS' THEN '[INFO]    ' ELSE '[WARNING] ' END
        WHEN 'db_file_multiblock_read_count'
            THEN CASE WHEN TO_NUMBER(VALUE) > 128 THEN '[WARNING] ' ELSE '[INFO]    ' END
        WHEN 'parallel_max_servers'
            THEN CASE WHEN TO_NUMBER(VALUE) > 100 THEN '[WARNING] ' ELSE '[INFO]    ' END
        ELSE '[INFO]    '
    END                                                          AS RISK_LEVEL,
    CASE NAME
        WHEN 'cursor_sharing'             THEN 'EXACT，FORCE/SIMILAR BUG'
        WHEN 'optimizer_mode'             THEN 'ALL_ROWS；FIRST_ROWS OLTP'
        WHEN 'optimizer_features_enable'  THEN ''
        WHEN 'parallel_max_servers'       THEN 'Large → CPU burnout. Set to cores * 2'
        WHEN 'db_file_multiblock_read_count' THEN 'Oversized → impacts CBO full table scan costing'
        ELSE ' '
    END                                                          AS REMARK
FROM V$PARAMETER
WHERE NAME IN (
    'cursor_sharing','optimizer_mode','optimizer_features_enable',
    'db_file_multiblock_read_count','parallel_max_servers',
    'parallel_min_servers','parallel_degree_policy',
    '_optimizer_use_feedback','_optimizer_adaptive_cursor_sharing'
)
ORDER BY RISK_LEVEL;
-- ============================================================
-- §11-6  已弃用(DEPRECATED)参数检测
-- ============================================================
PROMPT >>SECTION: 46. [PARAMETER-RISK] 已弃用(DEPRECATED)的参数
SELECT
    '[WARNING] '                                                 AS RISK_LEVEL,
    NAME                                                         AS PARAM_NAME,
    VALUE                                                        AS CURRENT_VALUE,
    DESCRIPTION
FROM V$PARAMETER
WHERE ISDEPRECATED = 'TRUE'
  AND VALUE != '0'
  AND VALUE IS NOT NULL
ORDER BY NAME;

-- ============================================================
-- §11-7  安全参数风险检测
-- 经验：remote_login_passwordfile=EXCLUSIVE + 默认密码 = 高危
-- ============================================================
PROMPT >>SECTION: 47. [PARAMETER-RISK] 安全相关参数评估
SELECT
    NAME,
    VALUE,
    CASE
        WHEN NAME='audit_trail'               AND VALUE='NONE'  THEN '[WARNING]  Audit off, set DB'
        WHEN NAME='sec_case_sensitive_logon'  AND VALUE='FALSE' THEN '[WARNING] Pwd case-insensitive'
        WHEN NAME='remote_login_passwordfile' AND VALUE='NONE'  THEN '[WARNING]  No pwfile → sysdba remote disabled'
        WHEN NAME='enable_ddl_logging'        AND VALUE='FALSE' THEN '[INFO]     Suggest enable DDL log'
        WHEN NAME='O7_DICTIONARY_ACCESSIBILITY' AND VALUE='TRUE' THEN '[CRITICAL] Allow ordinary users access data dict'
        ELSE '[INFO]    '
    END                                                          AS RISK_LEVEL
FROM V$PARAMETER
WHERE NAME IN (
    'audit_trail','sec_case_sensitive_logon','remote_login_passwordfile',
    'enable_ddl_logging','O7_DICTIONARY_ACCESSIBILITY','utl_file_dir',
    'remote_os_authent','os_authent_prefix'
)
ORDER BY RISK_LEVEL;


-- ============================================================
-- ============================================================
-- §12  深度风险分析 (DEEP RISK) -- 来源: oracle_risk.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §12-1  系统级等待事件 TOP15
-- 经验：db file sequential read >5ms、log file sync >5ms 必须关注
-- ============================================================
PROMPT >>SECTION: 48. [DEEP-RISK] 系统级等待事件 TOP15（排除空闲类）
SELECT
    CASE
        WHEN TIME_WAITED / NULLIF(TOTAL_WAITS,0) / 100 > 20 THEN '[CRITICAL]'
        WHEN TIME_WAITED / NULLIF(TOTAL_WAITS,0) / 100 > 5  THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    EVENT                                                       AS WAIT_EVENT,
    TOTAL_WAITS,
    TOTAL_TIMEOUTS,
    ROUND(TIME_WAITED / 100, 2)                                 AS TOTAL_WAIT_SEC,
    ROUND(TIME_WAITED / NULLIF(TOTAL_WAITS,0) / 100, 4)        AS AVG_WAIT_SEC,
    WAIT_CLASS
FROM V$SYSTEM_EVENT
WHERE WAIT_CLASS NOT IN ('Idle','Other','Administrative')
ORDER BY TIME_WAITED DESC
FETCH FIRST 15 ROWS ONLY;

-- ============================================================
-- §12-2  高全表扫描 SQL（索引缺失直接体现）
-- 经验：平均每次 >1000 块物理读且高频执行必须添加索引
-- ============================================================
PROMPT >>SECTION: 49. [DEEP-RISK] 高全表扫描 SQL（最近1天，平均>1000物理读/次）
SELECT
    '[WARNING] '                                                AS RISK_LEVEL,
    SQL_ID,
    EXECUTIONS,
    ROUND(ELAPSED_TIME/NULLIF(EXECUTIONS,0)/1000000, 3)        AS AVG_ELAPSED_SEC,
    ROWS_PROCESSED,
    BUFFER_GETS,
    DISK_READS,
    ROUND(DISK_READS/NULLIF(EXECUTIONS,0), 0)                  AS AVG_DISK_READS,
    PARSING_SCHEMA_NAME                                         AS SCHEMA_NAME,
    SUBSTR(SQL_TEXT,1,120)                                      AS SQL_PREVIEW
FROM V$SQL
WHERE LAST_ACTIVE_TIME >= SYSDATE - 1
  AND EXECUTIONS > 10
  AND DISK_READS / NULLIF(EXECUTIONS,0) > 1000
ORDER BY DISK_READS DESC
FETCH FIRST 15 ROWS ONLY;

-- ============================================================
-- §12-3  死锁历史（近7天 alert.log）
-- 经验：死锁通常源于无索引外键或应用层事务顺序问题
-- ============================================================
PROMPT >>SECTION: 50. [DEEP-RISK] 近7天死锁告警记录
SELECT
    '[CRITICAL]'                                                AS RISK_LEVEL,
    ORIGINATING_TIMESTAMP                                       AS LOG_TIME,
    SUBSTR(MESSAGE_TEXT, 1, 200)                                AS DEADLOCK_MSG
FROM V$DIAG_ALERT_EXT
WHERE (MESSAGE_TEXT LIKE '%Deadlock%'
    OR MESSAGE_TEXT LIKE '%ORA-00060%')
  AND ORIGINATING_TIMESTAMP >= SYSDATE - 7
ORDER BY ORIGINATING_TIMESTAMP DESC
FETCH FIRST 30 ROWS ONLY;

-- ============================================================
-- §12-4  ORA 错误高频统计（近7天）
-- 经验：ORA-4031 共享池溢出、ORA-1555 UNDO不足是最常见问题
-- ============================================================
PROMPT >>SECTION: 51. [DEEP-RISK] 近7天 ORA- 错误频次统计（TOP20）
SELECT
    CASE
        WHEN CNT > 100 THEN '[CRITICAL]'
        WHEN CNT > 10  THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    ORA_CODE,
    CNT                                                         AS ERR_COUNT,
    FIRST_OCCUR,
    LAST_OCCUR
FROM (
    SELECT
        REGEXP_SUBSTR(MESSAGE_TEXT,'ORA-[0-9]+')               AS ORA_CODE,
        COUNT(*)                                                AS CNT,
        MIN(ORIGINATING_TIMESTAMP)                              AS FIRST_OCCUR,
        MAX(ORIGINATING_TIMESTAMP)                              AS LAST_OCCUR
    FROM V$DIAG_ALERT_EXT
    WHERE ORIGINATING_TIMESTAMP >= SYSDATE - 7
      AND MESSAGE_TEXT LIKE '%ORA-%'
    GROUP BY REGEXP_SUBSTR(MESSAGE_TEXT,'ORA-[0-9]+')
)
WHERE ORA_CODE IS NOT NULL
ORDER BY CNT DESC
FETCH FIRST 20 ROWS ONLY;

-- ============================================================
-- §12-5  长事务检测（活跃时间 > 5 分钟）
-- 经验：超 30 分钟必须确认；超 2 小时基本属于异常
-- ============================================================
PROMPT >>SECTION: 52. [DEEP-RISK] 长事务检测（活跃 > 5分钟）
SELECT
    CASE
        WHEN (SYSDATE - T.START_DATE) * 1440 > 120 THEN '[CRITICAL]'
        WHEN (SYSDATE - T.START_DATE) * 1440 > 30  THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    S.SID,
    S.SERIAL#,
    S.USERNAME,
    S.STATUS,
    S.MACHINE,
    S.MODULE,
    ROUND((SYSDATE - T.START_DATE) * 1440, 1)                  AS TRX_MIN,
    ROUND(T.USED_UBLK * 8192 / 1048576, 1)                     AS UNDO_MB,
    T.LOG_IO,
    T.PHY_IO,
    SUBSTR(S.SQL_ID,1,13)                                       AS CURR_SQL_ID
FROM V$TRANSACTION T
JOIN V$SESSION S ON T.SES_ADDR = S.SADDR
WHERE (SYSDATE - T.START_DATE) * 1440 > 5
ORDER BY TRX_MIN DESC;

-- ============================================================
-- §12-6  高CPU消耗 SQL TOP10（近1小时）
-- 经验：平均 CPU > 1s/次的 SQL 必须优化；排序/哈希操作过多是根源
-- ============================================================
PROMPT >>SECTION: 53. [DEEP-RISK] 高CPU耗用 SQL TOP10（近1小时）
SELECT
    CASE
        WHEN CPU_TIME/NULLIF(EXECUTIONS,0)/1000000 > 5 THEN '[CRITICAL]'
        WHEN CPU_TIME/NULLIF(EXECUTIONS,0)/1000000 > 1 THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    SQL_ID,
    EXECUTIONS,
    ROUND(CPU_TIME/NULLIF(EXECUTIONS,0)/1000000, 3)             AS AVG_CPU_SEC,
    ROUND(ELAPSED_TIME/NULLIF(EXECUTIONS,0)/1000000, 3)         AS AVG_ELAPSED_SEC,
    SORTS,
    BUFFER_GETS,
    PARSING_SCHEMA_NAME,
    SUBSTR(SQL_TEXT,1,100)                                       AS SQL_PREVIEW
FROM V$SQL
WHERE LAST_ACTIVE_TIME >= SYSDATE - 1/24
  AND EXECUTIONS > 0
ORDER BY CPU_TIME DESC
FETCH FIRST 10 ROWS ONLY;

-- ============================================================
-- §12-7  硬解析率与游标泄漏风险
-- 经验：hard_parse_count 高 = 绑定变量未使用；open_cursors 接近上限是崩溃前兆
-- ============================================================
PROMPT >>SECTION: 54. [DEEP-RISK] 解析风险（硬解析率、游标使用）
SELECT
    CASE
        WHEN HARD_PARSE_RATIO > 30 THEN '[CRITICAL]'
        WHEN HARD_PARSE_RATIO > 10 THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    HARD_PARSE_CNT,
    SOFT_PARSE_CNT,
    HARD_PARSE_RATIO                                            AS HARD_PARSE_PCT,
    CURR_OPEN_CURSORS,
    MAX_OPEN_CURSORS_SETTING,
    ROUND(CURR_OPEN_CURSORS / MAX_OPEN_CURSORS_SETTING * 100, 2) AS CURSOR_USAGE_PCT
FROM (
    SELECT
        (SELECT VALUE FROM V$SYSSTAT WHERE NAME='parse count (hard)')    AS HARD_PARSE_CNT,
        (SELECT VALUE FROM V$SYSSTAT WHERE NAME='parse count (total)') -
        (SELECT VALUE FROM V$SYSSTAT WHERE NAME='parse count (hard)')    AS SOFT_PARSE_CNT,
        ROUND(
            (SELECT VALUE FROM V$SYSSTAT WHERE NAME='parse count (hard)') * 100 /
            NULLIF((SELECT VALUE FROM V$SYSSTAT WHERE NAME='parse count (total)'),0), 2
        )                                                                  AS HARD_PARSE_RATIO,
        (SELECT SUM(VALUE) FROM V$SESSTAT ST JOIN V$STATNAME SN
            ON ST.STATISTIC# = SN.STATISTIC#
            WHERE SN.NAME='opened cursors current')                        AS CURR_OPEN_CURSORS,
        (SELECT TO_NUMBER(VALUE) FROM V$PARAMETER WHERE NAME='open_cursors') AS MAX_OPEN_CURSORS_SETTING
    FROM DUAL
);
-- ============================================================
-- §12-8  无效对象明细清单（含风险等级）
-- 经验：TRIGGER 失效直接导致数据完整性问题
-- （§4 仅汇总计数，本节输出逐行明细供逐一排查）
-- ============================================================
PROMPT >>SECTION: 55. [DEEP-RISK] 无效数据库对象明细（含风险等级）
SELECT
    CASE OBJECT_TYPE
        WHEN 'TRIGGER'      THEN '[CRITICAL]'
        WHEN 'PACKAGE BODY' THEN '[WARNING] '
        WHEN 'PROCEDURE'    THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    OWNER,
    OBJECT_TYPE,
    OBJECT_NAME,
    TO_CHAR(LAST_DDL_TIME,'YYYY-MM-DD HH24:MI:SS')             AS LAST_DDL,
    STATUS
FROM DBA_OBJECTS
WHERE STATUS = 'INVALID'
  AND OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','ORDSYS','MDSYS','ORDDATA','ANONYMOUS','ORACLE_OCM','XDB')
ORDER BY RISK_LEVEL, OWNER, OBJECT_TYPE;


-- ============================================================
-- ============================================================
-- §13  空间深度分析 (SPACE DEEP) -- 来源: oracle_space.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §13-1  FRA 文件类型分布（补充 §20 FRA 概况，显示可回收明细）
-- ============================================================
PROMPT >>SECTION: 56. [SPACE-DEEP] FRA 闪回区文件类型空间分布
SELECT
    FILE_TYPE,
    PERCENT_SPACE_USED,
    PERCENT_SPACE_RECLAIMABLE,
    NUMBER_OF_FILES
FROM V$RECOVERY_AREA_USAGE
ORDER BY PERCENT_SPACE_USED DESC;

-- ============================================================
-- §13-2  行迁移/行链接高比例表
-- 经验：CHAIN_CNT 高 = PCTFREE 太小或大字段更新，需 ALTER TABLE MOVE 修复
-- ============================================================
PROMPT >>SECTION: 57. [SPACE-DEEP] 行迁移率过高的表（CHAIN_CNT/NUM_ROWS > 10%）
SELECT
    '[WARNING] '                                                AS RISK_LEVEL,
    OWNER,
    TABLE_NAME,
    NUM_ROWS,
    CHAIN_CNT,
    ROUND(CHAIN_CNT / NULLIF(NUM_ROWS,0) * 100, 2)            AS CHAIN_PCT,
    AVG_ROW_LEN,
    TO_CHAR(LAST_ANALYZED,'YYYY-MM-DD')                        AS LAST_ANALYZED
FROM DBA_TABLES
WHERE NUM_ROWS > 10000
  AND CHAIN_CNT > 0
  AND CHAIN_CNT / NULLIF(NUM_ROWS,0) > 0.10
  AND OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','ORDSYS','MDSYS','ORDDATA','ANONYMOUS','ORACLE_OCM','XDB')
FETCH FIRST 20 ROWS ONLY;

-- ============================================================
-- §13-3  分区表中空置旧分区（空间浪费）
-- 经验：历史分区 NUM_ROWS=0 但仍占磁盘，可压缩或清理
-- ============================================================
PROMPT >>SECTION: 58. [SPACE-DEEP] 分区表未使用的旧分区（>100MB 的空分区）
SELECT
    '[INFO]    '                                                AS RISK_LEVEL,
    P.TABLE_OWNER,
    P.TABLE_NAME,
    P.PARTITION_NAME,
    P.HIGH_VALUE,
    P.NUM_ROWS,
    ROUND(S.BYTES/1073741824, 3)                               AS PART_SIZE_GB,
    TO_CHAR(P.LAST_ANALYZED,'YYYY-MM-DD')                      AS LAST_ANALYZED
FROM DBA_TAB_PARTITIONS P
JOIN DBA_SEGMENTS S
    ON P.TABLE_OWNER    = S.OWNER
   AND P.TABLE_NAME     = S.SEGMENT_NAME
   AND P.PARTITION_NAME = S.PARTITION_NAME
WHERE P.NUM_ROWS = 0
  AND S.BYTES / 1073741824 > 0.1
  AND P.TABLE_OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','ORDSYS','MDSYS','ORDDATA','ANONYMOUS','ORACLE_OCM','XDB')
ORDER BY S.BYTES DESC
FETCH FIRST 20 ROWS ONLY;

-- ============================================================
-- §13-4  TEMP 表空间当前使用（按会话）
-- 经验：TEMP 暴涨通常是大 Sort/Hash 查询或笛卡尔积导致
-- ============================================================
PROMPT >>SECTION: 59. [SPACE-DEEP] TEMP 表空间当前使用明细（按会话）
/* [SPACE-DEEP] TEMP 表空间当前使用明细（按会话/RAC） */
SELECT CASE
         WHEN ROUND(SU.BLOCKS * TO_NUMBER(P.VALUE) / 1024 / 1024 / 1024, 2) >= 10 THEN
          '[CRITICAL]'
         WHEN ROUND(SU.BLOCKS * TO_NUMBER(P.VALUE) / 1024 / 1024 / 1024, 2) >= 1 THEN
          '[WARNING] '
         ELSE
          '[INFO]    '
       END AS RISK_LEVEL,
       S.INST_ID,
       S.SID,
       S.SERIAL#,
       S.USERNAME,
       S.STATUS,
       ROUND(SU.BLOCKS * TO_NUMBER(P.VALUE) / 1024 / 1024, 2) AS TEMP_USED_MB,
       ROUND(SU.BLOCKS * TO_NUMBER(P.VALUE) / 1024 / 1024 / 1024, 2) AS TEMP_USED_GB,
       SU.TABLESPACE,
       SU.SEGTYPE,
       S.SQL_ID,
       SUBSTR(Q.SQL_TEXT, 1, 80) AS SQL_TEXT,
       S.OSUSER,
       S.MACHINE,
       S.PROGRAM,
       S.MODULE
  FROM GV$SORT_USAGE SU
  JOIN GV$SESSION S ON SU.SESSION_ADDR = S.SADDR
                   AND SU.INST_ID = S.INST_ID
  LEFT JOIN GV$SQL Q ON S.SQL_ID = Q.SQL_ID
                    AND S.INST_ID = Q.INST_ID
 CROSS
  JOIN (SELECT VALUE FROM V$PARAMETER WHERE NAME = 'db_block_size') P
 WHERE S.USERNAME IS NOT NULL
   AND S.USERNAME NOT IN ('SYS')
 ORDER BY TEMP_USED_MB DESC;

-- ============================================================
-- §13-5  表空间近30天增长趋势（基于AWR历史）
-- 经验：月增长超 100GB 需提前规划扩容；配合 S-01 表空间当前容量看
-- ============================================================
PROMPT >>SECTION: 60. [SPACE-DEEP] 表空间近30天增长量（AWR）
WITH TBS_HIST AS (
    SELECT
        TB.NAME AS TABLESPACE_NAME,
        S.BEGIN_INTERVAL_TIME,
        /* To MB */
        H.TABLESPACE_SIZE * TS.BLOCK_SIZE / 1024 / 1024
            AS SIZE_MB,
        ROW_NUMBER() OVER (
            PARTITION BY TB.NAME
            ORDER BY S.BEGIN_INTERVAL_TIME ASC
        ) AS RN_ASC,
        ROW_NUMBER() OVER (
            PARTITION BY TB.NAME
            ORDER BY S.BEGIN_INTERVAL_TIME DESC
        ) AS RN_DESC
    FROM DBA_HIST_TBSPC_SPACE_USAGE H
    JOIN DBA_HIST_SNAPSHOT S
      ON H.SNAP_ID = S.SNAP_ID
     AND H.DBID    = S.DBID
    JOIN V$TABLESPACE TB
      ON H.TABLESPACE_ID = TB.TS#
    JOIN DBA_TABLESPACES TS
      ON TB.NAME = TS.TABLESPACE_NAME
    WHERE S.BEGIN_INTERVAL_TIME >= SYSDATE - 30
),
TBS_GROWTH AS (
    SELECT
        TABLESPACE_NAME,
        MIN(CASE WHEN RN_ASC = 1 THEN SIZE_MB END)
            AS BEGIN_SIZE_MB,
        MAX(CASE WHEN RN_DESC = 1 THEN SIZE_MB END)
            AS END_SIZE_MB
    FROM TBS_HIST
    GROUP BY TABLESPACE_NAME
)
SELECT
    TABLESPACE_NAME,
    ROUND(BEGIN_SIZE_MB / 1024, 2)
       AS BEGIN_SIZE_GB,
    ROUND(END_SIZE_MB / 1024, 2)
        AS END_SIZE_GB,
    ROUND((END_SIZE_MB - BEGIN_SIZE_MB) / 1024, 2)
        AS GROWTH_GB,
    ROUND(
        CASE
            WHEN BEGIN_SIZE_MB = 0 THEN NULL
            ELSE ((END_SIZE_MB - BEGIN_SIZE_MB)
                 / BEGIN_SIZE_MB) * 100
        END,
        2
    ) AS GROWTH_PCT,
    CASE
        WHEN (END_SIZE_MB - BEGIN_SIZE_MB) / 1024 > 100
            THEN '[WARNING] Grew >100GB, watch disk. Convert to MB'
        ELSE '[INFO]    '
    END AS RISK_LEVEL
FROM TBS_GROWTH
WHERE BEGIN_SIZE_MB IS NOT NULL
  AND END_SIZE_MB   IS NOT NULL
ORDER BY GROWTH_GB DESC;
