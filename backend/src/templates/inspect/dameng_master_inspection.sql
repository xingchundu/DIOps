-- ============================================================
-- 达梦数据库 (DM8 / DM7) 综合巡检脚本
-- 适用版本：达梦 DM7.6+ / DM8
-- 执行用户：SYSDBA 或具备 DBA 权限的账户
-- 执行方式：disql SYSDBA/密码@IP:端口 `< dm_inspect.sql`
-- 或通过达梦管理工具 Manager 执行
-- ============================================================

SET LINESIZE 300;
SET PAGESIZE 200;
SET TIMING ON;
SET FEEDBACK OFF;

PRINT '============================================================';
PRINT '达梦 (DM) 综合巡检报告';
PRINT '============================================================';
SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') AS EXEC_TIME FROM DUAL;

-- ============================================================
-- §1  实例基本信息
-- ============================================================
PRINT '>>SECTION: 1. 实例基本信息';
SELECT
    INSTANCE_NAME,
    HOST_NAME,
    DB_NAME,
    PARA_FILE,
    STATUS$         AS STATUS,
    MODE$           AS OPEN_MODE,
    ARCH_MODE       AS ARCHIVE_MODE,
    OGUID,
    SERVER_VERSION,
    SVR_VERSION
FROM V$INSTANCE;

PRINT '>>SECTION: 2. 数据库信息';
SELECT
    NAME            AS DB_NAME,
    ID              AS DB_ID,
    CREATED         AS CREATE_TIME,
    LOG_MODE        AS REDO_LOG_MODE,
    OPEN_STATUS     AS OPEN_STATUS,
    CHARSET         AS CHARACTER_SET,
    LENGTH_IN_CHAR  AS LENGTH_IN_CHAR,
    CASE_SENSITIVE  AS CASE_SENSITIVE,
    DB_MAGIC
FROM V$DATABASE;

-- ============================================================
-- §2  健康检查 (HEALTH)
-- ============================================================
PRINT '>>SECTION: 3. [HEALTH] 连接数概况';
SELECT
    (SELECT COUNT(*) FROM V$SESSIONS WHERE STATE='ACTIVE')     AS ACTIVE_SESSIONS,
    (SELECT COUNT(*) FROM V$SESSIONS WHERE STATE='IDLE')       AS IDLE_SESSIONS,
    (SELECT COUNT(*) FROM V$SESSIONS)                          AS TOTAL_SESSIONS,
    (SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME='MAX_SESSIONS') AS MAX_SESSIONS_LIMIT;

PRINT '>>SECTION: 4. [HEALTH] 当前活跃会话';
SELECT
    SESS_ID,
    CONN_ID,
    CLNT_HOST,
    CLNT_IP,
    USER_NAME,
    SCHEMA_NAME,
    STATE,
    APPNAME,
    LAST_RECV_TIME,
    CURR_SQL
FROM V$SESSIONS
WHERE STATE = 'ACTIVE'
  AND SESS_ID <> (SELECT SESS_ID FROM V$SESSIONS WHERE CONN_ID = SF_SESSID())
ORDER BY LAST_RECV_TIME;

PRINT '>>SECTION: 5. [HEALTH] 锁等待情况';
SELECT
    L.LADDR,
    L.STATUS,
    L.LTYPE           AS LOCK_TYPE,
    L.TID             AS TRX_ID,
    T.CONN_ID,
    T.USER_NAME,
    T.CURR_SQL
FROM V$LOCK L
JOIN V$SESSIONS T ON L.TID = T.TRX_ID
WHERE L.STATUS = 'WAITING'
ORDER BY L.LADDR;

PRINT '>>SECTION: 6. [HEALTH] 最近 DM 日志错误 (近7天)';
SELECT *
FROM (
    SELECT
        LOG_TIME,
        LOG_TYPE,
        SUBSTR(LOG_MSG, 1, 300) AS LOG_MSG
    FROM V$DM_ALERT_LOG
    WHERE LOG_TYPE IN ('ERROR','WARNING')
      AND LOG_TIME >= SYSDATE - 7
    ORDER BY LOG_TIME DESC
)
WHERE ROWNUM <= 50;

PRINT '>>SECTION: 7. [HEALTH] 无效对象';
SELECT
    OWNER,
    OBJECT_TYPE,
    OBJECT_NAME,
    STATUS,
    CREATED,
    LAST_DDL_TIME
FROM DBA_OBJECTS
WHERE STATUS = 'INVALID'
ORDER BY OWNER, OBJECT_TYPE;

-- ============================================================
-- §3  风险检查 (RISK)
-- ============================================================
PRINT '>>SECTION: 8. [RISK] TOP 10 高代价 SQL (V$SQL)';
SELECT *
FROM (
    SELECT
        SQL_ID,
        EXECUTIONS,
        DISK_READS,
        BUFFER_GETS,
        ELAPSED_TIME / 1000000.0     AS ELAPSED_SEC,
        CPU_TIME / 1000000.0         AS CPU_SEC,
        ROWS_PROCESSED,
        SORTS,
        LOADS,
        SUBSTR(SQL_TEXT, 1, 200)     AS SQL_PREVIEW
    FROM V$SQL
    WHERE EXECUTIONS > 0
    ORDER BY ELAPSED_TIME DESC
)
WHERE ROWNUM <= 10;

PRINT '>>SECTION: 9. [RISK] 大事务 (V$TRX)';
SELECT
    TRX_ID,
    STATUS,
    CONN_ID,
    USER_NAME,
    START_TIME,
    UNDO_PAGES,
    REDO_SIZE / 1048576     AS REDO_MB,
    DTIME
FROM V$TRX
WHERE STATUS IN ('ACTIVE','IDLE')
  AND UNDO_PAGES > 1000
ORDER BY UNDO_PAGES DESC;

PRINT '>>SECTION: 10. [RISK] 高权限账户';
SELECT
    U.USERNAME,
    U.ACCOUNT_STATUS,
    U.CREATED,
    U.EXPIRY_DATE,
    U.PROFILE,
    R.GRANTED_ROLE
FROM DBA_USERS U
JOIN DBA_ROLE_PRIVS R ON U.USERNAME = R.GRANTEE
WHERE R.GRANTED_ROLE = 'DBA'
  AND U.USERNAME NOT IN ('SYSDBA','SYSAUDITOR')
ORDER BY U.USERNAME;

PRINT '>>SECTION: 11. [RISK] 无索引外键';
SELECT
    C.OWNER,
    C.TABLE_NAME,
    C.CONSTRAINT_NAME,
    C.COLUMN_NAME
FROM DBA_CONS_COLUMNS C
JOIN DBA_CONSTRAINTS R
    ON C.CONSTRAINT_NAME = R.CONSTRAINT_NAME
   AND C.OWNER           = R.OWNER
WHERE R.CONSTRAINT_TYPE = 'R'
  AND NOT EXISTS (
      SELECT 1 FROM DBA_IND_COLUMNS I
      WHERE I.TABLE_NAME   = C.TABLE_NAME
        AND I.COLUMN_NAME  = C.COLUMN_NAME
        AND I.COLUMN_POSITION = C.POSITION
        AND I.INDEX_OWNER  = C.OWNER
  )
  AND C.OWNER NOT IN ('SYS','SYSAUDITOR')
ORDER BY C.OWNER, C.TABLE_NAME;

-- ============================================================
-- §4  参数异常检查 (PARAMETER)
-- ============================================================
PRINT '>>SECTION: 12. [PARAMETER] DM 关键初始化参数';
SELECT
    PARA_NAME,
    PARA_VALUE,
    PARA_TYPE,
    DESCRIPTION
FROM V$DM_INI
WHERE PARA_NAME IN (
    'MEMORY_POOL','MEMORY_TARGET','BUFFER','MAX_BUFFER',
    'RECYCLE','MAX_SESSIONS','MAX_ACTIVE_SESSIONS',
    'UNDO_RETENTION','RLOG_BUF_SIZE','RLOG_APPEND_LOGIC',
    'ARCH_INI','BAK_USE_AP','ENABLE_ENCRYPT',
    'AUDIT_STATUS','ENABLE_INJECT','SOI_CHKPARAM',
    'GLOBAL_TRANS','DIST_TRANS_ALLOW_ERR',
    'PARALLEL_POLICY','MAX_PARALLEL_DEGREE',
    'DFS_ENABLE','DMDSC_MODE',
    'DM_SVR_ENCODE','DM_SVR_CASE_SENSITIVE',
    'CTL_PATH','SYSTEM_PATH','LOG_PATH','TEMP_PATH'
)
ORDER BY PARA_NAME;

PRINT '>>SECTION: 13. [PARAMETER] 内存使用详情';
SELECT
    NAME,
    TOTAL,
    USED,
    TOTAL - USED           AS FREE,
    ROUND(USED / NULLIF(TOTAL, 0) * 100, 2) AS USED_PCT
FROM V$MEM_POOL
ORDER BY USED DESC;

-- ============================================================
-- §5  空间风险 (SPACE)
-- ============================================================
PRINT '>>SECTION: 14. [SPACE] 表空间使用率';
SELECT
    T.NAME              AS TABLESPACE_NAME,
    T.STATUS,
    T.TYPE              AS TS_TYPE,
    ROUND(SUM(F.TOTAL_SIZE * PAGE()) / 1073741824, 3)                AS TOTAL_GB,
    ROUND(SUM(F.FREE_SIZE  * PAGE()) / 1073741824, 3)                AS FREE_GB,
    ROUND((SUM(F.TOTAL_SIZE) - SUM(F.FREE_SIZE)) * PAGE() / 1073741824, 3) AS USED_GB,
    ROUND((1 - SUM(F.FREE_SIZE)/NULLIF(SUM(F.TOTAL_SIZE),0)) * 100, 2)    AS USED_PCT
FROM V$TABLESPACE T
JOIN V$DATAFILE   F ON T.ID = F.GROUP_ID
GROUP BY T.NAME, T.STATUS, T.TYPE
ORDER BY USED_PCT DESC;

PRINT '>>SECTION: 15. [SPACE] 数据文件列表';
SELECT
    DF.PATH             AS FILE_PATH,
    DF.STATUS,
    DF.STATE,
    DF.AUTO_EXTEND,
    ROUND(DF.TOTAL_SIZE * PAGE() / 1073741824, 3) AS TOTAL_GB,
    ROUND(DF.FREE_SIZE  * PAGE() / 1073741824, 3) AS FREE_GB,
    T.NAME              AS TABLESPACE_NAME
FROM V$DATAFILE DF
JOIN V$TABLESPACE T ON DF.GROUP_ID = T.ID
ORDER BY T.NAME, DF.PATH;

PRINT '>>SECTION: 16. [SPACE] TOP 20 大表';
SELECT *
FROM (
    SELECT
        T.OWNER,
        T.TABLE_NAME,
        T.NUM_ROWS,
        ROUND(S.SIZE_USED * 8192 / 1073741824, 4) AS SIZE_GB,
        T.TABLESPACE_NAME
    FROM DBA_TABLES T
    LEFT JOIN (
        SELECT OBJECT_ID, SUM(SIZE_USED) AS SIZE_USED
        FROM V$SEGMENT
        GROUP BY OBJECT_ID
    ) S ON T.OBJECT_ID = S.OBJECT_ID
    WHERE T.OWNER NOT IN ('SYS','SYSAUDITOR')
    ORDER BY SIZE_GB DESC NULLS LAST
)
WHERE ROWNUM <= 20;

PRINT '>>SECTION: 17. [SPACE] 归档日志使用 (近7天)';
SELECT
    ARCH_DATE,
    TRUNC(TOTAL_ARCH_SIZE / 1073741824, 2) AS ARCH_GB,
    ARCH_COUNT
FROM (
    SELECT
        TRUNC(CREATE_TIME) AS ARCH_DATE,
        SUM(FILE_LENGTH)   AS TOTAL_ARCH_SIZE,
        COUNT(*)           AS ARCH_COUNT
    FROM V$ARCHIVED_LOG
    WHERE CREATE_TIME >= SYSDATE - 7
    GROUP BY TRUNC(CREATE_TIME)
)
ORDER BY ARCH_DATE;

-- ============================================================
-- §6  HA 检查 (DSC 集群 / DMDSC / DMRG)
-- ============================================================
PRINT '>>SECTION: 18. [HA] 重做日志文件状态';
SELECT
    FILE_ID,
    PATH            AS LOG_PATH,
    STATUS,
    ROUND(FILE_SIZE * PAGE() / 1048576, 2) AS SIZE_MB,
    ARCH_FLAG
FROM V$RLOGFILE
ORDER BY FILE_ID;

PRINT '>>SECTION: 19. [HA] DMDSC 节点状态 (集群版本)';
SELECT
    INST_ID,
    INST_NAME,
    HOST,
    PORT,
    STATUS,
    MON_STATUS
FROM V$DSC_INST_INFO
ORDER BY INST_ID;

PRINT '>>SECTION: 20. [HA] DMRG 守护组状态';
SELECT
    GROUP_NAME,
    GROUP_TYPE,
    N_EP,
    MODE,
    STATUS,
    OGUID
FROM V$DMRG_INFO;

PRINT '>>SECTION: 21. [HA] DMRG 端点状态';
SELECT
    EP_NAME,
    EP_SEQNO,
    ADDR,
    PORT,
    EP_MODE,
    EP_STATUS,
    FLSN,
    CLSN,
    RLSN
FROM V$DMRG_EP_INFO
ORDER BY EP_SEQNO;

PRINT '>>SECTION: 22. [HA] DMRG 同步状态/延迟';
SELECT
    EP_NAME,
    LOG_SYNC_RATE,
    LOG_SYNC_STATUS,
    PKG_WAIT_TIMEOUT,
    NET_ERR_COUNT,
    SEND_FAIL_COUNT
FROM V$DMRG_SYNC_INFO;

-- ============================================================
-- §7  统计信息 & 备份
-- ============================================================
PRINT '>>SECTION: 23. [STAT] 统计信息未收集的大表 TOP10';
SELECT *
FROM (
    SELECT
        OWNER,
        TABLE_NAME,
        NUM_ROWS,
        LAST_ANALYZED,
        ROUND(NVL(NUM_ROWS, 0))  AS EST_ROWS
    FROM DBA_TABLES
    WHERE (LAST_ANALYZED IS NULL OR LAST_ANALYZED < SYSDATE - 7)
      AND OWNER NOT IN ('SYS','SYSAUDITOR')
    ORDER BY NUM_ROWS DESC NULLS LAST
)
WHERE ROWNUM <= 10;

PRINT '>>SECTION: 24. [BACKUP] 最近备份记录';
SELECT
    BKID,
    BKNAME,
    BKTYPE,
    BKSTATUS,
    BK_BEGIN_TIME,
    BK_END_TIME,
    ROUND(SIZE / 1073741824, 3)   AS SIZE_GB,
    COMPRESSED,
    ENCRYPTED,
    DB_MAGIC
FROM V$BACKUPSET
ORDER BY BK_BEGIN_TIME DESC
FETCH FIRST 20 ROWS ONLY;

-- ============================================================
-- 结束
-- ============================================================
PRINT '============================================================';
PRINT '达梦巡检脚本执行完毕';
PRINT '============================================================';
SELECT TO_CHAR(SYSDATE,'YYYY-MM-DD HH24:MI:SS') AS FINISH_TIME FROM DUAL;

-- ============================================================
-- ============================================================
-- §8  深度风险分析 (RISK DEEP) -- 来源: dameng_4types.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §8-1  锁等待详情（带等待时长阈值判定）
-- 经验：达梦行锁基于对象锁体系，长时间锁等待影响并发性能
-- ============================================================
PRINT '>>SECTION: 25. [RISK-DEEP] 当前锁等待详情（带风险判定）';
SELECT
    CASE
        WHEN DATEDIFF('SECOND', WAIT_START_TIME, SYSDATE) > 300 THEN '[CRITICAL]'
        WHEN DATEDIFF('SECOND', WAIT_START_TIME, SYSDATE) > 30  THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    L.LTYPE                                                     AS LOCK_TYPE,
    L.STATUS                                                    AS LOCK_STATUS,
    L.TID                                                       AS WAIT_TRX_ID,
    T.CONN_ID,
    T.USER_NAME,
    T.CLNT_IP,
    DATEDIFF('SECOND', WAIT_START_TIME, SYSDATE)               AS WAIT_SEC,
    SUBSTR(T.CURR_SQL, 1, 200)                                  AS CURR_SQL
FROM V$LOCK L
JOIN V$SESSIONS T ON L.TID = T.TRX_ID
WHERE L.STATUS = 'WAITING'
ORDER BY WAIT_SEC DESC;

-- ============================================================
-- §8-2  活跃长事务分析（带时长阈值）
-- 经验：达梦 UNDO 回滚段被长事务占用导致膨胀，类似 Oracle ORA-1555
-- ============================================================
PRINT '>>SECTION: 26. [RISK-DEEP] 活跃长事务（持续 > 5分钟，带风险判定）';
SELECT
    CASE
        WHEN DATEDIFF('MINUTE', START_TIME, SYSDATE) > 60 THEN '[CRITICAL]'
        WHEN DATEDIFF('MINUTE', START_TIME, SYSDATE) > 10 THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    TRX_ID,
    STATUS,
    CONN_ID,
    USER_NAME,
    TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS')                AS START_TIME,
    DATEDIFF('MINUTE', START_TIME, SYSDATE)                    AS TRX_MINUTES,
    UNDO_PAGES,
    ROUND(REDO_SIZE / 1048576, 2)                              AS REDO_MB,
    DTIME
FROM V$TRX
WHERE STATUS IN ('ACTIVE','IDLE')
  AND DATEDIFF('MINUTE', START_TIME, SYSDATE) > 5
ORDER BY TRX_MINUTES DESC;

-- ============================================================
-- ============================================================
-- §9  参数风险评估 (PARAMETER RISK) -- 来源: dameng_4types.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §9-1  内存池配置风险评估
-- 经验：BUFFER 过小导致命中率不足；MEMORY_POOL 过小导致内存分配失败
-- ============================================================
PRINT '>>SECTION: 27. [PARAMETER-RISK] 内存参数配置评估';
SELECT
    CASE
        WHEN PARA_NAME = 'BUFFER'
             AND TO_NUMBER(PARA_VALUE) < 1000 THEN '[WARNING]  缓冲区<1000MB，命中率可能不足'
        WHEN PARA_NAME = 'MEMORY_POOL'
             AND TO_NUMBER(PARA_VALUE) < 500  THEN '[WARNING]  内存池偏小，建议>=500MB'
        WHEN PARA_NAME = 'MAX_SESSIONS'
             AND TO_NUMBER(PARA_VALUE) < 200  THEN '[INFO]     会话数限制偏小'
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    PARA_NAME,
    PARA_VALUE                                                  AS CURRENT_VALUE,
    CASE PARA_NAME
        WHEN 'BUFFER'         THEN '数据缓冲区大小(MB)，建议物理内存50%以上'
        WHEN 'MEMORY_POOL'    THEN '内存池大小(MB)，内部内存分配基础'
        WHEN 'MAX_SESSIONS'   THEN '最大会话连接数'
        WHEN 'UNDO_RETENTION' THEN 'UNDO保留时间(s)，建议>=3600'
        WHEN 'RLOG_BUF_SIZE'  THEN 'Redo日志缓冲区大小，高并发建议加大'
        ELSE ''
    END                                                         AS REMARK
FROM V$DM_INI
WHERE PARA_NAME IN (
    'MEMORY_POOL','BUFFER','MAX_BUFFER',
    'RECYCLE','MAX_SESSIONS','MAX_ACTIVE_SESSIONS',
    'UNDO_RETENTION','RLOG_BUF_SIZE'
)
ORDER BY RISK_LEVEL;

-- ============================================================
-- §9-2  数据缓冲区命中率
-- 经验：达梦数据缓冲区命中率 < 95% 需扩大 BUFFER 参数
-- ============================================================
PRINT '>>SECTION: 28. [PARAMETER-RISK] 数据缓冲区命中率评估';
SELECT
    CASE
        WHEN HIT_RATE < 90 THEN '[CRITICAL] 命中率<90%，立即扩大BUFFER参数'
        WHEN HIT_RATE < 95 THEN '[WARNING]  命中率<95%，建议扩大BUFFER'
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    ROUND(HIT_RATE, 4)                                         AS BUFFER_HIT_RATE_PCT,
    TOTAL_READS,
    DISK_READS,
    '查看V$DM_INI中BUFFER参数，建议物理内存50%以上'            AS REMARK
FROM (
    SELECT
        (1 - DISK_READS::FLOAT / NULLIF(TOTAL_READS, 0)) * 100 AS HIT_RATE,
        TOTAL_READS,
        DISK_READS
    FROM (
        SELECT
            (SELECT STAT_VAL FROM V$SYSSTAT WHERE STAT_NAME='buffer total get') AS TOTAL_READS,
            (SELECT STAT_VAL FROM V$SYSSTAT WHERE STAT_NAME='buffer physical read') AS DISK_READS
        FROM DUAL
    )
);

-- ============================================================
-- §9-3  归档与安全参数检查
-- ============================================================
PRINT '>>SECTION: 29. [PARAMETER-RISK] 归档与安全参数检查';
SELECT
    CASE
        WHEN PARA_NAME = 'ARCH_INI'     AND PARA_VALUE = '0' THEN '[WARNING]  归档未启用，无法备份恢复'
        WHEN PARA_NAME = 'AUDIT_STATUS' AND PARA_VALUE = '0' THEN '[INFO]     审计未开启，建议生产环境开启'
        ELSE '[INFO]    '
    END                                                         AS RISK_LEVEL,
    PARA_NAME,
    PARA_VALUE,
    CASE PARA_NAME
        WHEN 'ARCH_INI'       THEN '1=归档模式，生产必须启用'
        WHEN 'AUDIT_STATUS'   THEN '1=开启审计，满足等保要求'
        WHEN 'ENABLE_ENCRYPT' THEN '1=数据加密，敏感场景使用'
        WHEN 'BAK_USE_AP'     THEN '备份并行度设置'
        ELSE ''
    END                                                         AS REMARK
FROM V$DM_INI
WHERE PARA_NAME IN ('ARCH_INI','AUDIT_STATUS','ENABLE_ENCRYPT','BAK_USE_AP','SOI_CHKPARAM')
ORDER BY RISK_LEVEL;

-- ============================================================
-- ============================================================
-- §10  HA 深度分析 (HA DEEP) -- 来源: dameng_4types.sql
-- ============================================================
-- ============================================================

-- ============================================================
-- §10-1  DMRG 守护组与端点状态（带风险判定）
-- 经验：DMRG 是达梦主备架构核心，端点状态异常=备库不可用
-- ============================================================
PRINT '>>SECTION: 30. [HA-DEEP] DMRG 守护组与端点状态（带风险判定）';
SELECT
    CASE
        WHEN EP_STATUS != 'OPEN'    THEN '[CRITICAL]'
        WHEN EP_MODE   != 'PRIMARY'
             AND EP_MODE != 'STANDBY' THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                        AS RISK_LEVEL,
    EP_NAME,
    EP_SEQNO,
    ADDR,
    PORT,
    EP_MODE,
    EP_STATUS,
    FLSN                                                       AS FLUSH_LSN,
    CLSN                                                       AS COMMIT_LSN,
    RLSN                                                       AS REDO_LSN,
    CASE
        WHEN EP_STATUS != 'OPEN' THEN '端点不可用，检查实例状态和网络连通性'
        ELSE '端点状态正常'
    END                                                        AS REMARK
FROM V$DMRG_EP_INFO
ORDER BY EP_SEQNO;

-- ============================================================
-- §10-2  DMRG 主备同步延迟（带风险判定）
-- 经验：同步延迟过大说明备库追不上主库写入速率
-- ============================================================
PRINT '>>SECTION: 31. [HA-DEEP] DMRG 主备同步延迟（带风险判定）';
SELECT
    CASE
        WHEN LOG_SYNC_STATUS != 'NORMAL' THEN '[CRITICAL]'
        WHEN NET_ERR_COUNT > 10          THEN '[WARNING] '
        ELSE '[INFO]    '
    END                                                        AS RISK_LEVEL,
    EP_NAME,
    LOG_SYNC_STATUS,
    LOG_SYNC_RATE,
    NET_ERR_COUNT,
    SEND_FAIL_COUNT,
    PKG_WAIT_TIMEOUT,
    CASE
        WHEN LOG_SYNC_STATUS != 'NORMAL' THEN '同步异常！检查网络和备库写入性能'
        WHEN NET_ERR_COUNT > 0           THEN '存在网络错误，检查专网连通性'
        ELSE '同步正常'
    END                                                        AS REMARK
FROM V$DMRG_SYNC_INFO;

-- ============================================================
-- §10-3  DSC 集群节点状态（带风险判定）
-- ============================================================
PRINT '>>SECTION: 32. [HA-DEEP] DSC 集群节点状态（如适用，带风险判定）';
SELECT
    CASE
        WHEN STATUS != 'OPEN'       THEN '[CRITICAL] DSC节点未OPEN，集群功能受损'
        WHEN MON_STATUS = 'OFFLINE' THEN '[WARNING]  监视器离线，集群仲裁受影响'
        ELSE '[INFO]    '
    END                                                        AS RISK_LEVEL,
    INST_ID,
    INST_NAME,
    HOST,
    PORT,
    STATUS,
    MON_STATUS
FROM V$DSC_INST_INFO
ORDER BY INST_ID;

-- ============================================================
-- §10-4  最近备份状态（带风险判定）
-- 经验：超过 24 小时无成功备份 = 数据丢失风险极高
-- ============================================================
PRINT '>>SECTION: 33. [HA-DEEP] 最近备份状态（近7天，带风险判定）';
SELECT
    CASE
        WHEN BKSTATUS != 'COMPLETED'    THEN '[WARNING]  备份未成功完成'
        WHEN SYSDATE - BK_END_TIME > 2  THEN '[WARNING]  超过2天无成功备份'
        ELSE '[INFO]    '
    END                                                        AS RISK_LEVEL,
    BKID,
    BKNAME,
    BKTYPE,
    BKSTATUS,
    TO_CHAR(BK_BEGIN_TIME,'YYYY-MM-DD HH24:MI:SS')            AS BK_BEGIN,
    TO_CHAR(BK_END_TIME,'YYYY-MM-DD HH24:MI:SS')              AS BK_END,
    ROUND((BK_END_TIME - BK_BEGIN_TIME) * 24 * 60, 1)         AS DURATION_MIN,
    ROUND(SIZE / 1073741824, 3)                                AS SIZE_GB,
    COMPRESSED,
    ENCRYPTED
FROM V$BACKUPSET
WHERE BK_BEGIN_TIME >= SYSDATE - 7
ORDER BY BK_BEGIN_TIME DESC;

PRINT '============================================================';
PRINT '达梦综合巡检完成 (inspect + 4types)';
PRINT '============================================================';
SELECT TO_CHAR(SYSDATE,'YYYY-MM-DD HH24:MI:SS') AS FINISH_TIME FROM DUAL;
