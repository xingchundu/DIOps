package com.dbops.sqlinsight.store;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.sqlinsight.collect.Counter;
import com.dbops.sqlinsight.collect.Metric;
import com.dbops.sqlinsight.collect.WindowRow;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 分钟统计、能力矩阵、变更窗口的读写。分钟统计按 (实例, 资产, 计划, 窗口起点) 幂等 —— 重复执行/补采不会产生重复行。
 * 数据量大时可把本类换成 ClickHouse 实现，接口不变。
 */
@Component
public class StatsRepo {

    private static final String[] VALUE_COLS = {"WINDOW_MINUTES", "BATCH_ID", "DATA_QUALITY",
            "EXCLUDE_BASELINE", "ANOMALY_FLAGS", "D_EXEC", "D_ELAPSED_MS", "D_CPU_MS", "D_LOGICAL_READS", "D_PHYSICAL_READS", "D_ROWS_EXAMINED",
            "D_ROWS_RETURNED", "D_ERRORS", "D_TMP_DISK", "D_NO_INDEX", "AVG_ELAPSED_MS", "CPU_PER_EXEC_MS", "LOGICAL_READS_PER_EXEC",
            "PHYSICAL_READS_PER_EXEC", "ROWS_EXAMINED_PER_EXEC", "SCAN_RATIO", "EXEC_PER_MIN", "DB_TIME_SHARE", "ERROR_RATE"};

    /**
     * 同一窗口重复写入（采集重试 / 两个节点同时采集）时以最新一次为准。
     * 原来只有 WHEN NOT MATCHED：重试时新数据被静默丢弃，返回的“写入行数”却照样计数。
     */
    static final String MERGE_STATS = buildMerge();

    private static String buildMerge() {
        StringBuilder using = new StringBuilder("SELECT ? AS I, ? AS A, ? AS P, ? AS W");
        StringBuilder set = new StringBuilder();
        StringBuilder cols = new StringBuilder("INSTANCE_ID, ASSET_ID, PLAN_HASH, WINDOW_START");
        StringBuilder vals = new StringBuilder("s.I, s.A, s.P, s.W");
        for (String c : VALUE_COLS) {
            using.append(", ? AS ").append(c);
            set.append(set.length() == 0 ? "" : ", ").append("t.").append(c).append(" = s.").append(c);
            cols.append(", ").append(c);
            vals.append(", s.").append(c);
        }
        return "MERGE INTO DI_SQL_STATS_MIN t USING (" + using + " FROM DUAL) s "
                + "ON (t.INSTANCE_ID = s.I AND t.ASSET_ID = s.A AND t.PLAN_HASH = s.P AND t.WINDOW_START = s.W) "
                + "WHEN MATCHED THEN UPDATE SET " + set + " "
                + "WHEN NOT MATCHED THEN INSERT (" + cols + ") VALUES (" + vals + ")";
    }

    private final Db db;

    public StatsRepo(Db db) {
        this.db = db;
    }

    public int insertWindow(long instanceId, Timestamp windowStart, String batchId, List<WindowRow> rows) {
        if (rows.isEmpty()) {
            return 0;
        }
        List<Object[]> batch = new ArrayList<>(rows.size());
        for (WindowRow r : rows) {
            List<Object> a = new ArrayList<>(32);
            a.add(instanceId);
            a.add(r.assetId);
            a.add(Values.truncate(r.cur.planHash(), 64));
            a.add(windowStart);
            a.add(Values.round(r.minutes, 2));
            a.add(batchId);
            a.add(r.quality);
            a.add(r.excludeBaseline ? 1 : 0);
            a.add(r.anomalyFlags);
            for (Counter c : Counter.values()) {
                a.add(num(r.d(c)));
            }
            for (Metric m : Metric.values()) {
                a.add(num(r.m(m)));
            }
            batch.add(a.toArray());
        }
        int[] res = db.jdbc().batchUpdate(MERGE_STATS, batch);
        int n = 0;
        for (int x : res) {
            n += Math.max(x, 0) > 0 || x == java.sql.Statement.SUCCESS_NO_INFO ? 1 : 0;
        }
        return n;
    }

    static Object num(Double v) {
        return v == null || v.isNaN() || v.isInfinite() ? null : Values.round(v, 6);
    }

    static Object num(double v) {
        return Double.isNaN(v) || Double.isInfinite(v) ? null : Values.round(v, 6);
    }

    // ------------------------------------------------------------------ 能力矩阵

    public void saveCapability(long instanceId, Map<String, Boolean> caps, String source, String detail) {
        List<Object[]> batch = new ArrayList<>();
        for (Map.Entry<String, Boolean> e : caps.entrySet()) {
            batch.add(new Object[]{instanceId, e.getKey(), e.getValue() ? 1 : 0, source, Values.truncate(detail, 1000)});
        }
        batch.add(new Object[]{instanceId, "_source", detail == null ? 1 : 0, source, Values.truncate(detail, 1000)});
        db.jdbc().batchUpdate("MERGE INTO DI_SQL_CAPABILITY t USING (SELECT ? AS I, ? AS M, ? AS S, ? AS SRC, ? AS D FROM DUAL) s "
                + "ON (t.INSTANCE_ID = s.I AND t.METRIC = s.M) "
                + "WHEN MATCHED THEN UPDATE SET SUPPORTED = s.S, SOURCE = s.SRC, DETAIL = s.D, PROBED_AT = SYSTIMESTAMP "
                + "WHEN NOT MATCHED THEN INSERT (INSTANCE_ID, METRIC, SUPPORTED, SOURCE, DETAIL) VALUES (s.I, s.M, s.S, s.SRC, s.D)", batch);
    }

    public void saveCapability(long instanceId, String metric, boolean supported, String source, String detail) {
        saveCapability(instanceId, Map.of(metric, supported), source, detail);
    }

    public Map<String, Boolean> capability(long instanceId) {
        Map<String, Boolean> m = new HashMap<>();
        for (Map<String, Object> r : db.query("SELECT METRIC, SUPPORTED FROM DI_SQL_CAPABILITY WHERE INSTANCE_ID=?", instanceId)) {
            m.put(Values.str(r.get("METRIC")), Values.toInt(r.get("SUPPORTED"), 0) == 1);
        }
        return m;
    }

    // ------------------------------------------------------------------ 变更窗口

    /** 当前是否处于变更窗口（实例级或全局） */
    public Map<String, Object> activeChangeWindow(long instanceId) {
        return db.one("SELECT WINDOW_ID, WINDOW_TYPE, TITLE, START_TIME, END_TIME FROM DI_CHANGE_WINDOW "
                + "WHERE (INSTANCE_ID = ? OR INSTANCE_ID IS NULL) AND SYSTIMESTAMP BETWEEN START_TIME AND END_TIME "
                + "ORDER BY START_TIME DESC FETCH FIRST 1 ROWS ONLY", instanceId);
    }

    public List<Map<String, Object>> recentChangeWindows(long instanceId, int hours) {
        return db.query("SELECT WINDOW_ID, WINDOW_TYPE, TITLE, START_TIME, END_TIME, SOURCE, REF_ID FROM DI_CHANGE_WINDOW "
                + "WHERE (INSTANCE_ID = ? OR INSTANCE_ID IS NULL) AND END_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(?, 'HOUR') "
                + "AND START_TIME <= SYSTIMESTAMP ORDER BY START_TIME DESC", instanceId, hours);
    }

    // ------------------------------------------------------------------ 历史

    /** 最近 n 个窗口内命中“四项判定”的位图：assetId → 每个窗口的 flags（新→旧） */
    public Map<Long, List<Integer>> recentFlags(long instanceId, Timestamp since) {
        Map<Long, List<Integer>> m = new HashMap<>();
        // 同一资产同一窗口的多个计划行写入的是同一份资产级 flags，取 MAX 即可
        for (Map<String, Object> r : db.query("SELECT ASSET_ID, WINDOW_START, MAX(ANOMALY_FLAGS) AS F FROM DI_SQL_STATS_MIN WHERE INSTANCE_ID=? "
                + "AND WINDOW_START >= ? GROUP BY ASSET_ID, WINDOW_START ORDER BY WINDOW_START DESC", instanceId, since)) {
            m.computeIfAbsent(Values.toLong(r.get("ASSET_ID"), 0), k -> new ArrayList<>()).add(Values.toInt(r.get("F"), 0));
        }
        return m;
    }

    /** P-007/P-012 连续性判断：资产最近各窗口某列的合计（新→旧，按窗口汇总多个计划） */
    public Map<Long, List<Double>> recentColumn(long instanceId, String column, Timestamp since) {
        if (!column.matches("[A-Z_]+")) {
            throw new IllegalArgumentException(column);
        }
        Map<Long, List<Double>> m = new HashMap<>();
        for (Map<String, Object> r : db.query("SELECT ASSET_ID, WINDOW_START, SUM(" + column + ") AS V FROM DI_SQL_STATS_MIN WHERE INSTANCE_ID=? "
                + "AND WINDOW_START >= ? GROUP BY ASSET_ID, WINDOW_START ORDER BY WINDOW_START DESC", instanceId, since)) {
            Double v = Values.toDouble(r.get("V"));
            m.computeIfAbsent(Values.toLong(r.get("ASSET_ID"), 0), k -> new ArrayList<>()).add(v == null ? Double.NaN : v);
        }
        return m;
    }

    /** P-013：资产在实例上的原生 SQL ID 个数 */
    public Map<Long, Long> nativeIdCounts(long instanceId, List<Long> assetIds) {
        Map<Long, Long> m = new HashMap<>();
        for (int i = 0; i < assetIds.size(); i += 500) {
            List<Long> part = assetIds.subList(i, Math.min(assetIds.size(), i + 500));
            List<Object> args = new ArrayList<>();
            args.add(instanceId);
            args.addAll(part);
            for (Map<String, Object> r : db.query("SELECT ASSET_ID, COUNT(*) AS C FROM DI_SQL_ASSET_SOURCE WHERE INSTANCE_ID=? AND ASSET_ID IN ("
                    + Db.placeholders(part.size()) + ") GROUP BY ASSET_ID", args)) {
                m.put(Values.toLong(r.get("ASSET_ID"), 0), Values.toLong(r.get("C"), 0));
            }
        }
        return m;
    }

    /**
     * 把最近 hoursBack 小时的分钟统计汇总为实例级小时行（SQL CPU / DB Time / 执行次数 + 主机 CPU 均值）。
     * 分钟数据只保留 sqlinsight.retention.stats_days（默认 35 天），小时汇总单独保留（默认 400 天），
     * 「今日 vs 昨日 vs 上月」同期对比不再依赖分钟数据是否还在。幂等（MERGE）。
     */
    public int rollupHours(int hoursBack) {
        int h = Math.max(1, Math.min(hoursBack, 24 * 60));
        int n = db.update("MERGE INTO DI_SQL_STATS_HOUR t USING (SELECT INSTANCE_ID, TRUNC(WINDOW_START, 'HH24') HS, SUM(D_CPU_MS) CPU, "
                + "SUM(D_ELAPSED_MS) ET, SUM(D_EXEC) EX FROM DI_SQL_STATS_MIN WHERE WINDOW_START >= TRUNC(LOCALTIMESTAMP, 'HH24') - NUMTODSINTERVAL(?, 'HOUR') "
                + "GROUP BY INSTANCE_ID, TRUNC(WINDOW_START, 'HH24')) s ON (t.INSTANCE_ID = s.INSTANCE_ID AND t.HOUR_START = s.HS) "
                + "WHEN MATCHED THEN UPDATE SET t.SQL_CPU_MS = s.CPU, t.DB_TIME_MS = s.ET, t.EXECS = s.EX, t.UPDATED_AT = SYSTIMESTAMP "
                + "WHEN NOT MATCHED THEN INSERT (INSTANCE_ID, HOUR_START, SQL_CPU_MS, DB_TIME_MS, EXECS) VALUES (s.INSTANCE_ID, s.HS, s.CPU, s.ET, s.EX)", h);
        // 主机 CPU：来自监控采样；没有 SQL 行的小时（实例无采集）也补一行，便于单看主机 CPU
        db.updateQuietly("MERGE INTO DI_SQL_STATS_HOUR t USING (SELECT INSTANCE_ID, TRUNC(COLLECTED_AT, 'HH24') HS, AVG(METRIC_CPU) CPU "
                + "FROM MONITOR_METRIC_SAMPLE WHERE REACHABLE = 1 AND METRIC_CPU IS NOT NULL AND COLLECTED_AT >= TRUNC(LOCALTIMESTAMP, 'HH24') - NUMTODSINTERVAL(?, 'HOUR') "
                + "GROUP BY INSTANCE_ID, TRUNC(COLLECTED_AT, 'HH24')) s ON (t.INSTANCE_ID = s.INSTANCE_ID AND t.HOUR_START = s.HS) "
                + "WHEN MATCHED THEN UPDATE SET t.HOST_CPU_PCT = ROUND(s.CPU, 1) "
                + "WHEN NOT MATCHED THEN INSERT (INSTANCE_ID, HOUR_START, HOST_CPU_PCT) VALUES (s.INSTANCE_ID, s.HS, ROUND(s.CPU, 1))", h);
        return n;
    }

    public int purgeRollup(int keepDays) {
        return db.update("DELETE FROM DI_SQL_STATS_HOUR WHERE HOUR_START < LOCALTIMESTAMP - NUMTODSINTERVAL(?, 'DAY')", keepDays);
    }

    /**
     * 活动会话的等待事件累计（所有活动会话都记，不只命中规则的）。
     * @param byAsset assetId → (等待事件 → {命中采样次数, 已等待秒数累计})
     */
    public void saveWaits(long instanceId, Map<Long, Map<String, double[]>> byAsset) {
        List<Object[]> batch = new ArrayList<>();
        for (Map.Entry<Long, Map<String, double[]>> a : byAsset.entrySet()) {
            if (a.getKey() == null || a.getKey() <= 0) {
                continue;
            }
            for (Map.Entry<String, double[]> e : a.getValue().entrySet()) {
                batch.add(new Object[]{instanceId, a.getKey(), Values.truncate(e.getKey(), 128), e.getValue()[0], e.getValue()[1], e.getValue()[0], e.getValue()[1]});
            }
        }
        if (batch.isEmpty()) {
            return;
        }
        db.jdbc().batchUpdate("MERGE INTO DI_SQL_WAIT_SAMPLE t USING (SELECT ? AS I, ? AS A, ? AS E FROM DUAL) s "
                + "ON (t.INSTANCE_ID = s.I AND t.ASSET_ID = s.A AND t.WAIT_EVENT = s.E) "
                + "WHEN MATCHED THEN UPDATE SET t.SAMPLES = NVL(t.SAMPLES, 0) + ?, t.WAIT_SEC = NVL(t.WAIT_SEC, 0) + ?, t.LAST_SEEN = SYSTIMESTAMP "
                + "WHEN NOT MATCHED THEN INSERT (INSTANCE_ID, ASSET_ID, WAIT_EVENT, SAMPLES, WAIT_SEC) VALUES (s.I, s.A, s.E, ?, ?)", batch);
    }

    /** 过期数据清理（分批删除，避免长事务） */
    public int purge(int keepDays) {
        int total = 0;
        for (int i = 0; i < 200; i++) {
            int n = db.update("DELETE FROM DI_SQL_STATS_MIN WHERE WINDOW_START < LOCALTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND ROWNUM <= 20000", keepDays);
            total += n;
            if (n < 20000) {
                break;
            }
        }
        db.updateQuietly("DELETE FROM DI_SQL_ASSET_SOURCE WHERE LAST_SEEN < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY')", keepDays);
        db.updateQuietly("DELETE FROM DI_SQL_PROBLEM WHERE STATUS='RESOLVED' AND RESOLVED_AT < SYSTIMESTAMP - INTERVAL '90' DAY");
        db.updateQuietly("DELETE FROM DI_SQL_WAIT_SAMPLE WHERE LAST_SEEN < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY')", keepDays);
        db.updateQuietly("DELETE FROM DI_SQL_PLAN_TEXT WHERE CAPTURED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'DAY') AND NOT EXISTS "
                + "(SELECT 1 FROM DI_SQL_RETEST r WHERE r.INSTANCE_ID = DI_SQL_PLAN_TEXT.INSTANCE_ID AND r.ASSET_ID = DI_SQL_PLAN_TEXT.ASSET_ID)", Math.max(keepDays, 90));
        return total;
    }
}
