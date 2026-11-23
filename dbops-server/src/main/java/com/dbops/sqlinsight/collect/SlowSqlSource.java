package com.dbops.sqlinsight.collect;

import com.dbops.common.Values;
import com.dbops.monitor.DbType;
import com.dbops.monitor.TargetDb;

import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 慢 SQL 快照采集（“SQL优化 → 立即采集慢SQL”与定时采集共用）。
 * <p>
 * 与分钟统计（{@link StatsSource} + {@link DeltaEngine}）不同：这里直接取源库统计视图中
 * “截至采集时刻、单次平均耗时 ≥ 阈值”的 SQL，按采集时间整批写入 SQL_SLOW_SUMMARY，第一次点击就有结果。
 * <ul>
 *   <li>Oracle：V$SQLAREA_PLAN_HASH（按 SQL_ID + 计划），全文取 SQL_FULLTEXT；全表扫描由 V$SQL_PLAN 判定</li>
 *   <li>磐维（PanWeiDB / openGauss）：dbe_perf.statement，含单次最大耗时 max_elapse_time</li>
 *   <li>达梦 DM8：优先 V$LONG_EXEC_SQLS（每条超时执行一行，按 SQL 文本汇总，含最大耗时）；不可用时退回 V$SQL_STAT</li>
 *   <li>MySQL / GoldenDB / PostgreSQL / SQL Server：同分钟统计的视图，附带各自的最大耗时列</li>
 * </ul>
 * 统计视图里字段随版本不同，仍走“探测实际列名 → 候选列”的方式，缺失的字段写空值，不写 0。
 */
public final class SlowSqlSource {

    public record SlowRow(String nativeId, String schema, String sqlText, String planHash, Double execs, Double totalMs,
                          Double avgMs, Double maxMs, Double cpuMs, Double logicalReads, Double physicalReads, Double rows,
                          Timestamp lastActive, boolean fullScan) {
    }

    public record Result(String source, List<SlowRow> rows) {
    }

    /** 慢 SQL 采集额外需要的列：全文、单次最大耗时、最近执行时间 */
    record Extras(List<StatsSource.Col> fullText, List<StatsSource.Col> maxElapsed, List<StatsSource.Col> lastActive) {
    }

    private SlowSqlSource() {
    }

    static Extras extras(String platformType, double panweiDiv, double damengDiv) {
        double pd = panweiDiv > 0 ? panweiDiv : 1000;
        double dd = damengDiv > 0 ? damengDiv : 1;
        return switch (DbType.normalize(platformType)) {
            case DbType.ORACLE -> new Extras(List.of(StatsSource.Col.expr("DBMS_LOB.SUBSTR(SQL_FULLTEXT, 2000, 1)", 1, "SQL_FULLTEXT")),
                    List.of(), List.of(StatsSource.Col.c("LAST_ACTIVE_TIME")));
            case DbType.MYSQL, DbType.GOLDENDB -> new Extras(List.of(StatsSource.Col.c("QUERY_SAMPLE_TEXT")),
                    List.of(StatsSource.Col.c("MAX_TIMER_WAIT", 1e9)), List.of(StatsSource.Col.c("LAST_SEEN")));
            case DbType.POSTGRESQL -> new Extras(List.of(),
                    List.of(StatsSource.Col.c("MAX_EXEC_TIME"), StatsSource.Col.c("MAX_TIME")), List.of());
            case DbType.PANWEI -> new Extras(List.of(), List.of(StatsSource.Col.c("MAX_ELAPSE_TIME", pd)),
                    List.of(StatsSource.Col.c("LAST_UPDATED")));
            case DbType.DAMENG -> new Extras(List.of(), List.of(StatsSource.Col.c("MAX_EXEC_TIME", dd)), List.of(StatsSource.Col.c("LAST_EXEC_TIME")));
            case DbType.SQLSERVER -> new Extras(List.of(), List.of(StatsSource.Col.c("MAX_US", 1000)), List.of(StatsSource.Col.c("LAST_EXEC")));
            default -> new Extras(List.of(), List.of(), List.of());
        };
    }

    private static StatsSource.Col first(List<StatsSource.Col> list, Set<String> cols) {
        for (StatsSource.Col c : list) {
            if (c.available(cols)) {
                return c;
            }
        }
        return null;
    }

    private static String num(double v) {
        if (v == Math.rint(v) && Math.abs(v) < 1e15) {
            return String.valueOf((long) v);
        }
        return String.valueOf(v);
    }

    /**
     * 通用慢 SQL 查询（纯函数，单测可直接调用）：单次平均耗时 ≥ minAvgMs，按平均耗时倒序取前 topN。
     * 条件写成 “总耗时 ≥ 阈值 × 执行次数”，避免除法和除零。
     */
    static String buildQuery(StatsSource.Probe p, Set<String> cols, Extras ex, int topN, double minAvgMs) {
        StatsSource.Col exec = p.counters().get(Counter.EXEC);
        StatsSource.Col ela = p.counters().get(Counter.ELAPSED_MS);
        StatsSource.Col text = first(ex.fullText(), cols);
        if (text == null) {
            text = p.text();
        }
        StatsSource.Col max = first(ex.maxElapsed(), cols);
        StatsSource.Col last = first(ex.lastActive(), cols);
        StringBuilder sel = new StringBuilder();
        for (int i = 0; i < p.ids().size(); i++) {
            sel.append(i == 0 ? "" : ", ").append(p.ids().get(i)).append(" AS NID").append(i);
        }
        sel.append(", ").append(text == null ? "NULL" : text.expr()).append(" AS TXT");
        sel.append(", ").append(p.schema() == null ? "NULL" : p.schema().expr()).append(" AS SCH");
        sel.append(", ").append(p.plan() == null ? "NULL" : p.plan().expr()).append(" AS PLN");
        for (Map.Entry<Counter, StatsSource.Col> e : p.counters().entrySet()) {
            sel.append(", ").append(e.getValue().expr()).append(" AS C_").append(e.getKey().name());
        }
        sel.append(", ").append(max == null ? "NULL" : max.expr()).append(" AS MAXV");
        sel.append(", ").append(max == null ? "1" : num(max.divisor())).append(" AS MAXD");
        sel.append(", ").append(last == null ? "NULL" : last.expr()).append(" AS LASTV");
        String avg = "(" + ela.expr() + ") / NULLIF(" + exec.expr() + ", 0)";
        sel.append(", ").append(avg).append(" AS AVGV");
        List<String> where = new ArrayList<>(p.filters());
        where.add(exec.expr() + " > 0");
        where.add("(" + ela.expr() + ") >= " + num(Math.max(0, minAvgMs) * ela.divisor()) + " * (" + exec.expr() + ")");
        String w = " WHERE " + String.join(" AND ", where);
        String order = " ORDER BY " + avg + " DESC";
        int n = Math.max(1, topN);
        return switch (p.spec().limit()) {
            case ROWNUM -> "SELECT * FROM (SELECT " + sel + " FROM " + p.spec().from() + w + order + ") WHERE ROWNUM <= " + n;
            case TOP -> "SELECT TOP " + n + " " + sel + " FROM " + p.spec().from() + w + order;
            case LIMIT -> "SELECT " + sel + " FROM " + p.spec().from() + w + order + " LIMIT " + n;
        };
    }

    /** 达梦 V$LONG_EXEC_SQLS：每行一次超时执行，按 SQL 文本汇总（纯函数） */
    static String damengLongExecQuery(Set<String> cols, int topN, double minAvgMs, double divisor) {
        if (!cols.contains("SQL_TEXT") || !cols.contains("EXEC_TIME")) {
            return null;
        }
        double d = divisor > 0 ? divisor : 1;
        String t = "SUBSTR(SQL_TEXT, 1, 2000)";
        String last = cols.contains("FINISH_TIME") ? "MAX(FINISH_TIME)" : "NULL";
        String nid = cols.contains("SQL_ID") ? "MAX(SQL_ID)" : "NULL";
        return "SELECT * FROM (SELECT " + nid + " AS NID0, " + t + " AS TXT, NULL AS SCH, NULL AS PLN, COUNT(*) AS C_EXEC, "
                + "SUM(EXEC_TIME) / " + num(d) + " AS C_ELAPSED_MS, MAX(EXEC_TIME) AS MAXV, " + num(d) + " AS MAXD, " + last + " AS LASTV, "
                + "AVG(EXEC_TIME) / " + num(d) + " AS AVGV FROM V$LONG_EXEC_SQLS WHERE EXEC_TIME >= " + num(Math.max(0, minAvgMs) * d)
                + " GROUP BY " + t + " ORDER BY AVGV DESC) WHERE ROWNUM <= " + Math.max(1, topN);
    }

    public static Result capture(TargetDb db, String platformType, int topN, double minAvgMs, double panweiDiv, double damengDiv)
            throws SQLException {
        String t = DbType.normalize(platformType);
        if (DbType.DAMENG.equals(t)) {
            try {
                Set<String> cols = StatsSource.columns(db, "V$LONG_EXEC_SQLS");
                String q = damengLongExecQuery(cols, topN, minAvgMs, damengDiv);
                if (q != null) {
                    return new Result("V$LONG_EXEC_SQLS", map(db.queryMax(topN, q), null, true));
                }
            } catch (SQLException ignore) {
                // 未开启 / 无权限：退回 V$SQL_STAT
            }
        }
        StatsSource.Spec spec = StatsSource.spec(t, panweiDiv, damengDiv);
        if (spec == null) {
            throw new SQLException("不支持的数据库类型: " + platformType);
        }
        Set<String> cols = StatsSource.columns(db, spec.from());
        StatsSource.Probe p = StatsSource.resolve(spec, cols);
        if (!p.ok()) {
            throw new SQLException(p.error());
        }
        String q = buildQuery(p, cols, extras(t, panweiDiv, damengDiv), topN, minAvgMs);
        List<SlowRow> rows = map(db.queryMax(topN, q), p, false);
        if (DbType.ORACLE.equals(t)) {
            rows = markOracleFullScan(db, rows);
        }
        return new Result(spec.sourceName(), rows);
    }

    static List<SlowRow> map(List<Map<String, Object>> raw, StatsSource.Probe p, boolean longExec) {
        List<SlowRow> out = new ArrayList<>(raw.size());
        for (Map<String, Object> r : raw) {
            String text = Values.str(r.get("TXT"));
            if (text == null || text.isBlank()) {
                continue;
            }
            StringBuilder nid = new StringBuilder();
            int n = p == null ? 1 : p.ids().size();
            for (int i = 0; i < n; i++) {
                if (i > 0) {
                    nid.append('|');
                }
                nid.append(Values.str(r.get("NID" + i), ""));
            }
            String nativeId = nid.toString().replaceAll("^\\|+|\\|+$", "");
            if (nativeId.isBlank()) {
                nativeId = "TXT:" + Integer.toHexString(text.hashCode());
            }
            Double maxRaw = Values.toDouble(r.get("MAXV"));
            Double maxD = Values.toDouble(r.get("MAXD"));
            Double noIdx = p == null ? null : div(r.get("C_NO_INDEX"), p, Counter.NO_INDEX);
            out.add(new SlowRow(Values.truncate(nativeId, 160), Values.str(r.get("SCH")), text, Values.str(r.get("PLN")),
                    p == null ? Values.toDouble(r.get("C_EXEC")) : div(r.get("C_EXEC"), p, Counter.EXEC),
                    p == null ? Values.toDouble(r.get("C_ELAPSED_MS")) : div(r.get("C_ELAPSED_MS"), p, Counter.ELAPSED_MS),
                    longExec ? Values.toDouble(r.get("AVGV")) : avg(r, p),
                    maxRaw == null ? null : maxRaw / (maxD == null || maxD == 0 ? 1 : maxD),
                    p == null ? null : div(r.get("C_CPU_MS"), p, Counter.CPU_MS),
                    p == null ? null : div(r.get("C_LOGICAL_READS"), p, Counter.LOGICAL_READS),
                    p == null ? null : div(r.get("C_PHYSICAL_READS"), p, Counter.PHYSICAL_READS),
                    p == null ? null : div(r.get("C_ROWS_RETURNED"), p, Counter.ROWS_RETURNED),
                    ts(r.get("LASTV")), noIdx != null && noIdx > 0));
        }
        return out;
    }

    private static Double avg(Map<String, Object> r, StatsSource.Probe p) {
        Double e = div(r.get("C_ELAPSED_MS"), p, Counter.ELAPSED_MS);
        Double x = div(r.get("C_EXEC"), p, Counter.EXEC);
        return e == null || x == null || x == 0 ? null : e / x;
    }

    private static Double div(Object v, StatsSource.Probe p, Counter c) {
        Double d = Values.toDouble(v);
        StatsSource.Col col = p.counters().get(c);
        if (d == null || col == null) {
            return null;
        }
        return d / col.divisor();
    }

    static Timestamp ts(Object v) {
        if (v instanceof Timestamp t) {
            return t;
        }
        if (v instanceof java.util.Date d) {
            return new Timestamp(d.getTime());
        }
        if (v instanceof java.time.LocalDateTime l) {
            return Timestamp.valueOf(l);
        }
        if (v instanceof java.time.OffsetDateTime o) {
            return Timestamp.from(o.toInstant());
        }
        return null;
    }

    /** Oracle：执行计划中含 TABLE ACCESS FULL 的 SQL 标记全表扫描（查询失败不影响采集结果） */
    static List<SlowRow> markOracleFullScan(TargetDb db, List<SlowRow> rows) {
        if (rows.isEmpty()) {
            return rows;
        }
        List<String> ids = new ArrayList<>();
        for (SlowRow r : rows) {
            if (r.nativeId().matches("[0-9a-z]{13}")) {
                ids.add(r.nativeId());
            }
        }
        if (ids.isEmpty()) {
            return rows;
        }
        Set<String> full = new HashSet<>();
        StringBuilder ph = new StringBuilder();
        for (int i = 0; i < ids.size(); i++) {
            ph.append(i == 0 ? "?" : ", ?");
        }
        for (Map<String, Object> m : db.queryOrEmpty("SELECT DISTINCT SQL_ID FROM V$SQL_PLAN WHERE SQL_ID IN (" + ph
                + ") AND OPERATION = 'TABLE ACCESS' AND OPTIONS LIKE '%FULL%'", ids.toArray())) {
            full.add(Values.str(m.get("SQL_ID")));
        }
        List<SlowRow> out = new ArrayList<>(rows.size());
        for (SlowRow r : rows) {
            out.add(full.contains(r.nativeId()) == r.fullScan() ? r : new SlowRow(r.nativeId(), r.schema(), r.sqlText(), r.planHash(),
                    r.execs(), r.totalMs(), r.avgMs(), r.maxMs(), r.cpuMs(), r.logicalReads(), r.physicalReads(), r.rows(),
                    r.lastActive(), r.fullScan() || full.contains(r.nativeId())));
        }
        return out;
    }
}
