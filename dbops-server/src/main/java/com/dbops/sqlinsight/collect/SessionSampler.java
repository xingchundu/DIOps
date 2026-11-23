package com.dbops.sqlinsight.collect;

import com.dbops.common.Values;
import com.dbops.monitor.DbType;
import com.dbops.monitor.TargetDb;

import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 活动会话采样（设计方案 3.5：10~15 秒一次）。只取“正在执行用户 SQL”的会话。
 * 各库一条查询；查询失败时上层把 active_session 能力记为 UNSUPPORTED，P-001/P-002/P-010 记 SKIPPED。
 */
public final class SessionSampler {

    private SessionSampler() {
    }

    public static String query(String platformType) {
        return switch (DbType.normalize(platformType)) {
            case DbType.ORACLE -> "SELECT TO_CHAR(s.SID) || ',' || TO_CHAR(s.SERIAL#) AS SID, s.SQL_ID AS NID, s.SCHEMANAME AS SCH, "
                    + "(SELECT SUBSTR(MAX(q.SQL_TEXT), 1, 1000) FROM V$SQLSTATS q WHERE q.SQL_ID = s.SQL_ID) AS TXT, "
                    + "s.LAST_CALL_ET AS RUN_SEC, s.EVENT AS WAIT_EVENT, "
                    + "s.SECONDS_IN_WAIT AS WAIT_SEC, s.WAIT_CLASS AS WAIT_CLASS, TO_CHAR(s.BLOCKING_SESSION) AS BLOCKER "
                    + "FROM V$SESSION s "
                    + "WHERE s.TYPE = 'USER' AND s.STATUS = 'ACTIVE' AND s.SQL_ID IS NOT NULL AND s.SID <> SYS_CONTEXT('USERENV','SID') "
                    + "AND NVL(s.WAIT_CLASS, 'x') <> 'Idle'";
            case DbType.MYSQL, DbType.GOLDENDB -> "SELECT p.ID AS SID, NULL AS NID, p.DB AS SCH, LEFT(p.INFO, 1000) AS TXT, p.TIME AS RUN_SEC, "
                    + "p.STATE AS WAIT_EVENT, CASE WHEN p.STATE LIKE '%lock%' THEN p.TIME ELSE 0 END AS WAIT_SEC, "
                    + "CASE WHEN p.STATE LIKE '%lock%' THEN 'Lock' ELSE NULL END AS WAIT_CLASS, NULL AS BLOCKER "
                    + "FROM information_schema.PROCESSLIST p WHERE p.COMMAND = 'Query' AND p.INFO IS NOT NULL AND p.ID <> CONNECTION_ID()";
            case DbType.POSTGRESQL, DbType.PANWEI -> "SELECT CAST(a.pid AS VARCHAR) AS SID, NULL AS NID, a.datname AS SCH, LEFT(a.query, 1000) AS TXT, "
                    + "EXTRACT(EPOCH FROM (now() - a.query_start)) AS RUN_SEC, a.wait_event AS WAIT_EVENT, "
                    + "CASE WHEN a.wait_event_type = 'Lock' THEN EXTRACT(EPOCH FROM (now() - a.state_change)) ELSE 0 END AS WAIT_SEC, "
                    + "a.wait_event_type AS WAIT_CLASS, NULL AS BLOCKER "
                    + "FROM pg_stat_activity a WHERE a.state = 'active' AND a.pid <> pg_backend_pid() AND a.query IS NOT NULL "
                    + "AND a.query_start IS NOT NULL";
            case DbType.DAMENG -> "SELECT CAST(s.SESS_ID AS VARCHAR(32)) AS SID, NULL AS NID, s.CURR_SCH AS SCH, SUBSTR(s.SQL_TEXT, 1, 1000) AS TXT, "
                    + "DATEDIFF(SS, s.LAST_RECV_TIME, SYSDATE) AS RUN_SEC, NULL AS WAIT_EVENT, 0 AS WAIT_SEC, NULL AS WAIT_CLASS, NULL AS BLOCKER "
                    + "FROM V$SESSIONS s WHERE s.STATE = 'ACTIVE' AND s.SQL_TEXT IS NOT NULL AND s.SESS_ID <> SESSID()";
            case DbType.SQLSERVER -> "SELECT CAST(r.session_id AS VARCHAR(16)) AS SID, CONVERT(VARCHAR(64), r.query_hash, 1) AS NID, "
                    + "DB_NAME(r.database_id) AS SCH, SUBSTRING(t.text, r.statement_start_offset / 2 + 1, 1000) AS TXT, "
                    + "r.total_elapsed_time / 1000.0 AS RUN_SEC, r.wait_type AS WAIT_EVENT, r.wait_time / 1000.0 AS WAIT_SEC, "
                    + "CASE WHEN r.wait_type LIKE 'LCK%' THEN 'Lock' ELSE NULL END AS WAIT_CLASS, "
                    + "CASE WHEN r.blocking_session_id > 0 THEN CAST(r.blocking_session_id AS VARCHAR(16)) END AS BLOCKER "
                    + "FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t "
                    + "WHERE r.session_id <> @@SPID AND r.session_id > 50";
            default -> null;
        };
    }

    /** PG 系补充阻塞者（pg_blocking_pids 在 9.6+ 可用；磐维可能没有，失败忽略） */
    private static final String PG_BLOCKERS = "SELECT CAST(pid AS VARCHAR) AS SID, CAST(pg_blocking_pids(pid) AS VARCHAR) AS B "
            + "FROM pg_stat_activity WHERE wait_event_type = 'Lock'";

    /**
     * MySQL 行锁等待：InnoDB 行锁等待时 PROCESSLIST.STATE 通常是 "updating"/"executing"，不含 lock 字样，
     * 原实现只看 STATE，行锁阻塞一律识别不到。sys.innodb_lock_waits（5.7+/8.0）优先，5.6/5.7 回退 information_schema。
     */
    private static final String MY_BLOCKERS = "SELECT CAST(waiting_pid AS CHAR) AS SID, CAST(blocking_pid AS CHAR) AS B FROM sys.innodb_lock_waits";
    private static final String MY_BLOCKERS_57 = "SELECT CAST(r.trx_mysql_thread_id AS CHAR) AS SID, CAST(b.trx_mysql_thread_id AS CHAR) AS B "
            + "FROM information_schema.innodb_lock_waits w "
            + "JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id "
            + "JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id";

    public static List<ActiveSession> sample(TargetDb db, String platformType, int maxRows) throws SQLException {
        String q = query(platformType);
        if (q == null) {
            return List.of();
        }
        List<Map<String, Object>> rows = db.queryMax(maxRows, q);
        Map<String, String> pgBlockers = Map.of();
        if (DbType.isPgFamily(DbType.normalize(platformType))) {
            pgBlockers = new java.util.HashMap<>();
            for (Map<String, Object> b : db.queryOrEmpty(PG_BLOCKERS)) {
                String v = Values.str(b.get("B"), "").replace("{", "").replace("}", "");
                if (!v.isBlank()) {
                    pgBlockers.put(Values.str(b.get("SID")), v);
                }
            }
        }
        String norm = DbType.normalize(platformType);
        if (DbType.MYSQL.equals(norm) || DbType.GOLDENDB.equals(norm)) {
            List<Map<String, Object>> w = db.queryQuietly(MY_BLOCKERS);
            if (w == null) {
                w = db.queryOrEmpty(MY_BLOCKERS_57);
            }
            pgBlockers = new java.util.HashMap<>();
            for (Map<String, Object> b : w) {
                String sid = Values.str(b.get("SID"));
                if (sid != null && Values.str(b.get("B")) != null) {
                    pgBlockers.merge(sid, Values.str(b.get("B")), (x, y) -> x + "," + y);
                }
            }
        }
        List<ActiveSession> out = new ArrayList<>(rows.size());
        for (Map<String, Object> r : rows) {
            String sid = Values.str(r.get("SID"));
            String waitClass = Values.str(r.get("WAIT_CLASS"), "");
            String blocker = Values.str(r.get("BLOCKER"));
            if (blocker == null) {
                blocker = pgBlockers.get(sid);
            }
            boolean lock = blocker != null || "Lock".equalsIgnoreCase(waitClass)
                    || ("Application".equalsIgnoreCase(waitClass) && Values.str(r.get("WAIT_EVENT"), "").startsWith("enq: TX"));
            out.add(new ActiveSession(sid, Values.str(r.get("NID")), Values.str(r.get("SCH")), Values.str(r.get("TXT")),
                    nz(r.get("RUN_SEC")), Values.str(r.get("WAIT_EVENT")), nz(r.get("WAIT_SEC")), lock, blocker));
        }
        return out;
    }

    private static double nz(Object v) {
        Double d = Values.toDouble(v);
        return d == null || d.isNaN() ? 0 : d;
    }
}
