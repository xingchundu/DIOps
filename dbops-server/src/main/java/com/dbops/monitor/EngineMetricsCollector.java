package com.dbops.monitor;

import com.dbops.alert.AlertEvaluator;
import com.dbops.common.R;
import com.dbops.common.Values;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Oracle / 磐维 深度指标（阶段1 + 阶段2，对应 Node monitorEngineMetrics.js + monitorEngineMetricsPhase2.js）。
 * <p>
 * [改进] Node 版一次采集要对同一实例建 3~4 条连接（exporter / phase1 / 表空间 / phase2）；这里复用采集主连接。
 * [fix] 告警日志统计、TOP 等待等累计型指标在名字上保留，但新增 *_delta 供告警使用（见 CollectService）。
 */
@Component
public class EngineMetricsCollector {

    private final ExporterCollector exporter;

    public EngineMetricsCollector(ExporterCollector exporter) {
        this.exporter = exporter;
    }

    public record Result(List<Map<String, Object>> engineMetrics, Map<String, Object> phase2Summary) {
    }

    public Result collect(TargetDb t, CmdbInstance inst, List<Map<String, Object>> exporterMetrics) {
        List<Map<String, Object>> base = new ArrayList<>();
        Map<String, Object> summary = null;
        String type = inst.dbType();
        if (DbType.ORACLE.equals(type)) {
            try {
                oraclePhase1(t, inst, base);
            } catch (Exception e) {
                Metrics.push(base, "oracle_instance_up", 0, "");
                base.add(Metrics.internal("_engine_error", "", Values.truncate(String.valueOf(e.getMessage()), 200)));
            }
            summary = safePhase2(() -> oraclePhase2(t, base), "ORACLE", base);
            Metrics.push(base, "oracle_buffer_cache_hit_pct", Metrics.exporterValue(exporterMetrics, "Buffer Cache Hit Ratio"), "%");
        } else if (DbType.PANWEI.equals(type)) {
            try {
                panweiPhase1(t, base);
            } catch (Exception e) {
                Metrics.push(base, "panwei_instance_up", 0, "");
                base.add(Metrics.internal("_engine_error", "", Values.truncate(String.valueOf(e.getMessage()), 200)));
            }
            summary = safePhase2(() -> panweiPhase2(t, base), "PANWEI", base);
            Metrics.push(base, "panwei_buffer_hit_pct", Metrics.exporterValue(exporterMetrics, "pg_buffer_cache_hit_ratio"), "%");
        }
        return new Result(base, summary);
    }

    private interface Phase2 {
        Map<String, Object> run() throws Exception;
    }

    private static Map<String, Object> safePhase2(Phase2 p, String engine, List<Map<String, Object>> base) {
        try {
            return p.run();
        } catch (Exception e) {
            String err = Values.truncate(String.valueOf(e.getMessage()), 200);
            base.add(Metrics.internal("_phase2_error", "", err));
            return R.map("engine", engine, "error", err);
        }
    }

    // ----------------------------- Oracle -----------------------------

    private void oraclePhase1(TargetDb t, CmdbInstance inst, List<Map<String, Object>> out) throws Exception {
        Map<String, Object> st = t.one("SELECT STATUS, STARTUP_TIME FROM V$INSTANCE");
        if (st != null) {
            Metrics.push(out, "oracle_instance_up", "OPEN".equalsIgnoreCase(Values.str(st.get("STATUS"), "")) ? 1 : 0, "");
            if (st.get("STARTUP_TIME") instanceof Timestamp ts) {
                Metrics.push(out, "oracle_uptime_hours", (System.currentTimeMillis() - ts.getTime()) / 3_600_000.0, "h");
            }
        }
        List<Map<String, Object>> rl = t.queryQuietly("SELECT RESOURCE_NAME, CURRENT_UTILIZATION, LIMIT_VALUE FROM V$RESOURCE_LIMIT "
                + "WHERE RESOURCE_NAME IN ('sessions','processes') AND TRIM(LIMIT_VALUE) NOT IN ('UNLIMITED','0')");
        if (rl != null) {
            for (Map<String, Object> r : rl) {
                Double cur = Values.toDouble(r.get("CURRENT_UTILIZATION"));
                Double lim = Values.toDouble(r.get("LIMIT_VALUE"));
                if (cur == null || lim == null || lim <= 0) {
                    continue;
                }
                String name = Values.str(r.get("RESOURCE_NAME"), "").toLowerCase();
                Metrics.push(out, "sessions".equals(name) ? "oracle_sessions_used_pct" : "oracle_processes_used_pct", cur / lim * 100, "%");
            }
        }
        try {
            Double maxPct = null;
            for (Map<String, Object> r : exporter.tablespaces(t, inst)) {
                Double p = Values.toDouble(r.get("USED_PCT"));
                if (p != null) {
                    maxPct = maxPct == null ? p : Math.max(maxPct, p);
                }
                // [v6] 每个表空间单独产出一条带维度的指标，供告警规则「指定监测表空间」使用。
                //      原来只取 Math.max，导致无法只盯某个业务表空间（如 10.120.23.139 的 JDV2）。
                String ts = Values.str(r.get("TABLESPACE_NAME"));
                if (ts != null && p != null) {
                    Metrics.push(out, AlertEvaluator.TABLESPACE_METRIC_PREFIX + ts.trim().toUpperCase(), p, "%");
                }
            }
            Metrics.push(out, "oracle_tablespace_max_used_pct", maxPct, "%");
        } catch (Exception ignore) {
            // 无 DBA_DATA_FILES 权限
        }
        Map<String, Object> fra = t.oneQuietly("SELECT ROUND(SPACE_USED / NULLIF(SPACE_LIMIT,0) * 100, 2) AS PCT FROM V$RECOVERY_FILE_DEST");
        if (fra != null) {
            Metrics.push(out, "oracle_fra_used_pct", fra.get("PCT"), "%");
        }
    }

    private Map<String, Object> oraclePhase2(TargetDb t, List<Map<String, Object>> metrics) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("engine", "ORACLE");
        List<Map<String, Object>> topWaits = new ArrayList<>();
        List<String> alertHits = new ArrayList<>();
        List<Map<String, Object>> topSql = new ArrayList<>();
        summary.put("topWaits", topWaits);
        summary.put("alertHits", alertHits);
        summary.put("topSql", topSql);

        Map<String, Object> b = t.oneQuietly("SELECT MAX(SECONDS_IN_WAIT) AS MAX_SEC, "
                + "SUM(CASE WHEN SECONDS_IN_WAIT > 60 THEN 1 ELSE 0 END) AS CNT_60 FROM V$SESSION WHERE BLOCKING_SESSION IS NOT NULL");
        if (b != null) {
            // 无阻塞时 MAX 为 NULL：按 0 记录，便于告警规则恢复
            Metrics.push(metrics, "oracle_blocking_session_max_sec", b.get("MAX_SEC") == null ? 0 : b.get("MAX_SEC"), "s");
            Metrics.push(metrics, "oracle_blocking_session_over_60s", b.get("CNT_60") == null ? 0 : b.get("CNT_60"), "");
        }
        Map<String, Object> a = t.oneQuietly("SELECT SUM(CASE WHEN MESSAGE_TEXT LIKE '%ORA-00060%' THEN 1 ELSE 0 END) AS ORA_60, "
                + "SUM(CASE WHEN MESSAGE_TEXT LIKE '%ORA-04031%' THEN 1 ELSE 0 END) AS ORA_4031, "
                + "SUM(CASE WHEN LOWER(MESSAGE_TEXT) LIKE '%checkpoint not complete%' THEN 1 ELSE 0 END) AS CKPT "
                + "FROM V$DIAG_ALERT_EXT WHERE ORIGINATING_TIMESTAMP >= SYSTIMESTAMP - INTERVAL '1' DAY");
        if (a != null) {
            Metrics.push(metrics, "oracle_alert_ora_00060_24h", nz(a.get("ORA_60")), "");
            Metrics.push(metrics, "oracle_alert_ora_4031_24h", nz(a.get("ORA_4031")), "");
            Metrics.push(metrics, "oracle_alert_checkpoint_incomplete_24h", nz(a.get("CKPT")), "");
            if (Values.toLong(a.get("ORA_60"), 0) > 0) {
                alertHits.add("ORA-00060");
            }
            if (Values.toLong(a.get("ORA_4031"), 0) > 0) {
                alertHits.add("ORA-04031");
            }
        }
        Map<String, Object> lfs = t.oneQuietly("SELECT ROUND(VALUE, 2) AS VAL FROM V$SYSMETRIC WHERE GROUP_ID = 2 AND METRIC_NAME = 'Log File Sync Time'");
        if (lfs == null) {
            // 常见版本里没有该 V$SYSMETRIC 项，按 V$SYSTEM_EVENT 平均等待毫秒近似
            lfs = t.oneQuietly("SELECT ROUND(TIME_WAITED_MICRO/NULLIF(TOTAL_WAITS,0)/1000, 2) AS VAL FROM V$SYSTEM_EVENT WHERE EVENT = 'log file sync'");
        }
        if (lfs != null) {
            Metrics.push(metrics, "oracle_log_file_sync_ms", lfs.get("VAL"), "ms");
        }
        List<Map<String, Object>> w = t.queryQuietly("SELECT EVENT, WAIT_CLASS, TIME_WAITED_MICRO FROM V$SYSTEM_EVENT "
                + "WHERE WAIT_CLASS <> 'Idle' AND TIME_WAITED_MICRO > 0 ORDER BY TIME_WAITED_MICRO DESC FETCH FIRST 5 ROWS ONLY");
        if (w != null) {
            for (Map<String, Object> r : w) {
                topWaits.add(R.map("event", r.get("EVENT"), "waitClass", r.get("WAIT_CLASS"),
                        "timeWaitedMicro", Values.toDouble(r.get("TIME_WAITED_MICRO"))));
            }
            if (!topWaits.isEmpty()) {
                Metrics.push(metrics, "oracle_top_wait_time_micro", topWaits.get(0).get("timeWaitedMicro"), "us");
            }
        }
        List<Map<String, Object>> s = t.queryQuietly("SELECT SQL_ID, ROUND(ELAPSED_TIME/1e6, 2) AS ELAPSED_SEC, EXECUTIONS FROM V$SQLSTATS "
                + "WHERE EXECUTIONS > 0 ORDER BY ELAPSED_TIME DESC FETCH FIRST 5 ROWS ONLY");
        if (s != null) {
            for (Map<String, Object> r : s) {
                topSql.add(R.map("sqlId", r.get("SQL_ID"), "elapsedSec", Values.toDouble(r.get("ELAPSED_SEC")),
                        "executions", Values.toDouble(r.get("EXECUTIONS"))));
            }
        }
        Map<String, Object> dg = t.oneQuietly("SELECT DATABASE_ROLE, LOG_MODE FROM V$DATABASE");
        if (dg != null) {
            String role = Values.str(dg.get("DATABASE_ROLE"), "").toUpperCase();
            summary.put("databaseRole", role);
            summary.put("logMode", dg.get("LOG_MODE"));
            Metrics.push(metrics, "oracle_is_primary_role", "PRIMARY".equals(role) ? 1 : 0, "");
            Metrics.push(metrics, "oracle_is_archivelog", Values.str(dg.get("LOG_MODE"), "").contains("ARCHIVE") ? 1 : 0, "");
        }
        // [fix] Node 版只认 'DB FULL'/'DATABASE FULL'；增量 0 级（DB INCR）也是完整基线备份
        Map<String, Object> rman = t.oneQuietly("SELECT MIN(SYSDATE - END_TIME) * 24 AS HOURS_AGO FROM V$RMAN_BACKUP_JOB_DETAILS "
                + "WHERE STATUS IN ('COMPLETED','COMPLETED WITH WARNINGS') AND INPUT_TYPE IN ('DB FULL','DB INCR')");
        if (rman != null && rman.get("HOURS_AGO") != null) {
            Metrics.push(metrics, "oracle_rman_full_backup_hours_ago", rman.get("HOURS_AGO"), "h");
        }
        return summary;
    }

    // ----------------------------- PanWei -----------------------------

    private void panweiPhase1(TargetDb t, List<Map<String, Object>> out) throws Exception {
        Map<String, Object> r1 = t.one("SELECT count(*)::float AS cnt, (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn "
                + "FROM pg_stat_activity");
        if (r1 != null) {
            Double cnt = Values.toDouble(r1.get("CNT"));
            Double max = Values.toDouble(r1.get("MAX_CONN"));
            if (cnt != null && max != null && max > 0) {
                Metrics.push(out, "panwei_conn_used_pct", cnt / max * 100, "%");
            }
        }
        Map<String, Object> r2 = t.oneQuietly("SELECT pg_postmaster_start_time() AS st");
        if (r2 != null && r2.get("ST") instanceof Timestamp ts) {
            Metrics.push(out, "panwei_uptime_hours", (System.currentTimeMillis() - ts.getTime()) / 3_600_000.0, "h");
        }
        // 能执行到这里说明实例可连可查
        Metrics.push(out, "panwei_instance_up", 1, "");
        Map<String, Object> lag = t.oneQuietly("SELECT COALESCE(MAX(pg_wal_lsn_diff(sent_lsn, replay_lsn)), 0) AS lag FROM pg_stat_replication");
        if (lag == null) {
            lag = t.oneQuietly("SELECT COALESCE(MAX(pg_xlog_location_diff(sender_sent_location, receiver_replay_location)), 0) AS lag FROM pg_stat_replication");
        }
        Metrics.push(out, "panwei_replication_lag_bytes", lag == null ? 0 : nz(lag.get("LAG")), "bytes");
        Map<String, Object> r4 = t.oneQuietly("SELECT ROUND(sum(pg_database_size(datname)) / 1024.0 / 1024 / 1024, 2) AS gb FROM pg_database WHERE datallowconn");
        if (r4 != null) {
            Metrics.push(out, "panwei_database_total_gb", r4.get("GB"), "GB");
        }
    }

    private Map<String, Object> panweiPhase2(TargetDb t, List<Map<String, Object>> metrics) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("engine", "PANWEI");
        List<Map<String, Object>> topSql = new ArrayList<>();
        summary.put("topSql", topSql);
        summary.put("replication", new ArrayList<>());

        Map<String, Object> idle = t.oneQuietly("SELECT count(*)::int AS cnt FROM pg_stat_activity WHERE state = 'idle in transaction' "
                + "AND now() - state_change > interval '5 minutes'");
        if (idle != null) {
            Metrics.push(metrics, "panwei_idle_in_txn_over_5min", idle.get("CNT"), "");
        }
        Map<String, Object> lk = t.oneQuietly("SELECT count(*)::int AS cnt FROM pg_locks WHERE NOT granted");
        if (lk != null) {
            Metrics.push(metrics, "panwei_lock_wait_count", lk.get("CNT"), "");
        }
        Map<String, Object> dl = t.oneQuietly("SELECT COALESCE(sum(deadlocks), 0)::bigint AS cnt FROM pg_stat_database");
        if (dl != null) {
            Metrics.push(metrics, "panwei_deadlocks_total", dl.get("CNT"), "");
        }
        List<Map<String, Object>> rep = t.queryQuietly("SELECT client_addr::text AS addr, state, sync_state FROM pg_stat_replication");
        if (rep != null) {
            List<Map<String, Object>> lower = new ArrayList<>();
            int bad = 0;
            for (Map<String, Object> r : rep) {
                lower.add(R.map("addr", r.get("ADDR"), "state", r.get("STATE"), "sync_state", r.get("SYNC_STATE")));
                if (!"streaming".equalsIgnoreCase(Values.str(r.get("STATE"), ""))) {
                    bad++;
                }
            }
            summary.put("replication", lower);
            Metrics.push(metrics, "panwei_replication_not_streaming_count", bad, "");
        } else {
            Metrics.push(metrics, "panwei_replication_not_streaming_count", 0, "");
        }
        Map<String, Object> wal = t.oneQuietly("SELECT count(*)::int AS wal_files FROM pg_ls_waldir()");
        if (wal != null) {
            Metrics.push(metrics, "panwei_wal_file_count", wal.get("WAL_FILES"), "");
        }
        List<Map<String, Object>> top = t.queryQuietly("SELECT unique_sql_id AS queryid, n_calls AS calls, "
                + "CASE WHEN n_calls > 0 THEN total_elapse_time / n_calls / 1000.0 END AS mean_time, total_elapse_time AS total_elapsed_time "
                + "FROM dbe_perf.statement ORDER BY total_elapse_time DESC NULLS LAST LIMIT 5");
        if (top == null) {
            top = t.queryQuietly("SELECT queryid, calls, mean_exec_time AS mean_time, total_exec_time AS total_elapsed_time "
                    + "FROM pg_stat_statements ORDER BY total_exec_time DESC NULLS LAST LIMIT 5");
        }
        if (top != null) {
            for (Map<String, Object> r : top) {
                topSql.add(R.map("queryId", r.get("QUERYID"), "calls", r.get("CALLS"), "meanTimeMs", r.get("MEAN_TIME"),
                        "totalElapsed", r.get("TOTAL_ELAPSED_TIME")));
            }
            if (!topSql.isEmpty()) {
                Metrics.push(metrics, "panwei_top_sql_mean_ms", topSql.get(0).get("meanTimeMs"), "ms");
            }
        }
        Map<String, Object> bloat = t.oneQuietly("SELECT count(*)::int AS cnt FROM pg_stat_user_tables WHERE n_live_tup > 0 AND n_dead_tup > n_live_tup * 0.2");
        if (bloat != null) {
            Metrics.push(metrics, "panwei_tables_high_dead_tup", bloat.get("CNT"), "");
        }
        return summary;
    }

    private static Object nz(Object v) {
        return v == null ? 0 : v;
    }
}
