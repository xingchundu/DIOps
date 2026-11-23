package com.dbops.sqlinsight.collect;

import com.dbops.common.Values;
import com.dbops.monitor.DbType;
import com.dbops.monitor.TargetDb;

import java.sql.PreparedStatement;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 各库 SQL 累计统计视图的“声明式”描述 + 自适应取数。
 * <p>
 * 先用 {@code SELECT * FROM 视图 WHERE 1=0} 读取实际列名（能力探测），每个计数器在候选列中取第一个存在的；
 * 不存在的计数器记为 UNSUPPORTED，不会按 0 处理。版本差异（PG13 total_exec_time / 旧版 total_time、
 * MySQL 8.0.28 SUM_CPU_TIME、磐维/达梦字段待实测）都用候选列吸收，不需要写分支代码。
 */
public final class StatsSource {

    /** 候选列：expr 为 SQL 表达式，requires 为它依赖的列（全部存在才可用），divisor 为单位换算除数 */
    public record Col(String expr, Set<String> requires, double divisor) {
        static Col c(String column) {
            return new Col(column, Set.of(column.toUpperCase(Locale.ROOT)), 1);
        }

        static Col c(String column, double divisor) {
            return new Col(column, Set.of(column.toUpperCase(Locale.ROOT)), divisor);
        }

        static Col expr(String expr, double divisor, String... requires) {
            Set<String> r = new HashSet<>();
            for (String s : requires) {
                r.add(s.toUpperCase(Locale.ROOT));
            }
            return new Col(expr, r, divisor);
        }

        boolean available(Set<String> cols) {
            return cols.containsAll(requires);
        }
    }

    /** 过滤条件：requires 不满足时整条跳过 */
    public record Filter(String sql, Set<String> requires) {
        static Filter f(String sql, String... requires) {
            Set<String> r = new HashSet<>();
            for (String s : requires) {
                r.add(s.toUpperCase(Locale.ROOT));
            }
            return new Filter(sql, r);
        }
    }

    public enum LimitStyle { ROWNUM, LIMIT, TOP }

    public record Spec(String dbType, String sourceName, String from, List<String> idCols, List<String> optionalIdCols,
                       List<Col> text, List<Col> schema, List<Col> plan, Map<Counter, List<Col>> counters,
                       List<Filter> filters, Filter activity, LimitStyle limit) {
    }

    /** 探测结果：选中的列 + 能力矩阵 */
    public record Probe(Spec spec, boolean ok, String error, List<String> ids, Col text, Col schema, Col plan,
                        Map<Counter, Col> counters, List<String> filters, String activity) {

        public Map<String, Boolean> capability() {
            Map<String, Boolean> m = new LinkedHashMap<>();
            for (Counter c : Counter.values()) {
                m.put(c.capability(), ok && counters.containsKey(c));
            }
            m.put("plan_hash", ok && plan != null);
            return m;
        }

        public boolean supports(Counter c) {
            return ok && counters.containsKey(c);
        }

        public boolean activityFiltered() {
            return activity != null;
        }
    }

    private StatsSource() {
    }

    /** 探测失败时的能力矩阵：全部不支持 */
    public static Map<String, Boolean> noneCapability() {
        Map<String, Boolean> m = new LinkedHashMap<>();
        for (Counter c : Counter.values()) {
            m.put(c.capability(), false);
        }
        m.put("plan_hash", false);
        return m;
    }

    // ------------------------------------------------------------------ 各库声明

    public static Spec spec(String platformType, double panweiTimeDivisor, double damengTimeDivisor) {
        String t = DbType.normalize(platformType);
        return switch (t) {
            case DbType.ORACLE -> oracle();
            case DbType.MYSQL, DbType.GOLDENDB -> mysql(t);
            case DbType.POSTGRESQL -> postgres();
            case DbType.PANWEI -> panwei(panweiTimeDivisor);
            case DbType.DAMENG -> dameng(damengTimeDivisor);
            case DbType.SQLSERVER -> sqlserver();
            default -> null;
        };
    }

    static Spec oracle() {
        Map<Counter, List<Col>> m = new EnumMap<>(Counter.class);
        m.put(Counter.EXEC, List.of(Col.c("EXECUTIONS")));
        m.put(Counter.ELAPSED_MS, List.of(Col.c("ELAPSED_TIME", 1000)));
        m.put(Counter.CPU_MS, List.of(Col.c("CPU_TIME", 1000)));
        m.put(Counter.LOGICAL_READS, List.of(Col.c("BUFFER_GETS")));
        m.put(Counter.PHYSICAL_READS, List.of(Col.c("DISK_READS")));
        m.put(Counter.ROWS_RETURNED, List.of(Col.c("ROWS_PROCESSED")));
        m.put(Counter.TMP_DISK, List.of(Col.c("DIRECT_WRITES")));
        return new Spec(DbType.ORACLE, "V$SQLAREA_PLAN_HASH", "V$SQLAREA_PLAN_HASH", List.of("SQL_ID"), List.of(),
                List.of(Col.c("SQL_TEXT")), List.of(Col.c("PARSING_SCHEMA_NAME")), List.of(Col.c("PLAN_HASH_VALUE")), m,
                List.of(Filter.f("PARSING_SCHEMA_NAME NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','XDB','AUDSYS','GSMADMIN_INTERNAL','ORDS_METADATA','MDSYS','CTXSYS','WMSYS','OUTLN')", "PARSING_SCHEMA_NAME"),
                        Filter.f("COMMAND_TYPE IN (2, 3, 6, 7, 189)", "COMMAND_TYPE")),
                Filter.f("LAST_ACTIVE_TIME >= SYSDATE - 2/1440", "LAST_ACTIVE_TIME"), LimitStyle.ROWNUM);
    }

    static Spec mysql(String t) {
        Map<Counter, List<Col>> m = new EnumMap<>(Counter.class);
        m.put(Counter.EXEC, List.of(Col.c("COUNT_STAR")));
        m.put(Counter.ELAPSED_MS, List.of(Col.c("SUM_TIMER_WAIT", 1e9)));      // 皮秒 → 毫秒
        m.put(Counter.CPU_MS, List.of(Col.c("SUM_CPU_TIME", 1e9)));            // 8.0.28+
        m.put(Counter.ROWS_EXAMINED, List.of(Col.c("SUM_ROWS_EXAMINED")));
        m.put(Counter.ROWS_RETURNED, List.of(Col.c("SUM_ROWS_SENT")));
        m.put(Counter.ERRORS, List.of(Col.c("SUM_ERRORS")));
        m.put(Counter.TMP_DISK, List.of(Col.c("SUM_CREATED_TMP_DISK_TABLES")));
        m.put(Counter.NO_INDEX, List.of(Col.expr("SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED", 1, "SUM_NO_INDEX_USED", "SUM_NO_GOOD_INDEX_USED"),
                Col.c("SUM_NO_INDEX_USED")));
        return new Spec(t, "performance_schema.events_statements_summary_by_digest",
                "performance_schema.events_statements_summary_by_digest", List.of("SCHEMA_NAME", "DIGEST"), List.of(),
                List.of(Col.c("DIGEST_TEXT")), List.of(Col.c("SCHEMA_NAME")), List.of(), m,
                List.of(Filter.f("DIGEST IS NOT NULL", "DIGEST"),
                        Filter.f("(SCHEMA_NAME IS NULL OR SCHEMA_NAME NOT IN ('mysql','performance_schema','information_schema','sys'))", "SCHEMA_NAME")),
                Filter.f("LAST_SEEN >= NOW() - INTERVAL 2 MINUTE", "LAST_SEEN"), LimitStyle.LIMIT);
    }

    static Spec postgres() {
        Map<Counter, List<Col>> m = new EnumMap<>(Counter.class);
        m.put(Counter.EXEC, List.of(Col.c("CALLS")));
        m.put(Counter.ELAPSED_MS, List.of(Col.c("TOTAL_EXEC_TIME"), Col.c("TOTAL_TIME")));  // PG13+ / 旧版，单位 ms
        m.put(Counter.LOGICAL_READS, List.of(Col.expr("SHARED_BLKS_HIT + SHARED_BLKS_READ", 1, "SHARED_BLKS_HIT", "SHARED_BLKS_READ")));
        m.put(Counter.PHYSICAL_READS, List.of(Col.c("SHARED_BLKS_READ")));
        m.put(Counter.ROWS_RETURNED, List.of(Col.c("ROWS")));
        m.put(Counter.TMP_DISK, List.of(Col.c("TEMP_BLKS_WRITTEN")));
        return new Spec(DbType.POSTGRESQL, "pg_stat_statements",
                "(SELECT s.*, d.datname AS dbname FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid) t",
                List.of("USERID", "DBID", "QUERYID"), List.of("TOPLEVEL"),
                List.of(Col.c("QUERY")), List.of(Col.c("DBNAME")), List.of(), m,
                List.of(Filter.f("QUERYID IS NOT NULL", "QUERYID")), null, LimitStyle.LIMIT);
    }

    static Spec panwei(double divisor) {
        double d = divisor > 0 ? divisor : 1000;
        Map<Counter, List<Col>> m = new EnumMap<>(Counter.class);
        m.put(Counter.EXEC, List.of(Col.c("N_CALLS")));
        m.put(Counter.ELAPSED_MS, List.of(Col.c("TOTAL_ELAPSE_TIME", d)));
        m.put(Counter.CPU_MS, List.of(Col.c("CPU_TIME", d)));
        m.put(Counter.LOGICAL_READS, List.of(Col.c("N_BLOCKS_FETCHED")));
        m.put(Counter.PHYSICAL_READS, List.of(Col.expr("N_BLOCKS_FETCHED - N_BLOCKS_HIT", 1, "N_BLOCKS_FETCHED", "N_BLOCKS_HIT")));
        m.put(Counter.ROWS_EXAMINED, List.of(Col.expr("N_TUPLES_FETCHED + N_TUPLES_RETURNED", 1, "N_TUPLES_FETCHED", "N_TUPLES_RETURNED")));
        m.put(Counter.ROWS_RETURNED, List.of(Col.c("N_RETURNED_ROWS")));
        return new Spec(DbType.PANWEI, "dbe_perf.statement", "dbe_perf.statement", List.of("UNIQUE_SQL_ID", "USER_ID"),
                List.of("NODE_ID"), List.of(Col.c("QUERY")), List.of(Col.c("USER_NAME")), List.of(), m,
                List.of(Filter.f("N_CALLS > 0", "N_CALLS")),
                Filter.f("LAST_UPDATED >= NOW() - INTERVAL '2 minutes'", "LAST_UPDATED"), LimitStyle.LIMIT);
    }

    /** 达梦 V$SQL_STAT（需 ENABLE_MONITOR=1）：字段名随版本不同，候选列覆盖已知写法，未命中则记 UNSUPPORTED */
    static Spec dameng(double divisor) {
        double d = divisor > 0 ? divisor : 1;
        Map<Counter, List<Col>> m = new EnumMap<>(Counter.class);
        m.put(Counter.EXEC, List.of(
                Col.c("EXEC_TIMES"), Col.c("EXECUTE_TIMES"), Col.c("EXEC_COUNT"),
                Col.expr("SEL_SQL_CNT + DEL_SQL_CNT + DDL_SQL_CNT", 1,
                        "SEL_SQL_CNT", "DEL_SQL_CNT", "DDL_SQL_CNT"),
                Col.expr("SEL_SQL_CNT + DEL_SQL_CNT + DDL_SQL_CNT + DYN_EXEC_CNT", 1,
                        "SEL_SQL_CNT", "DEL_SQL_CNT", "DDL_SQL_CNT", "DYN_EXEC_CNT"),
                Col.c("DYN_EXEC_CNT")));
        m.put(Counter.ELAPSED_MS, List.of(
                Col.c("TOTAL_EXEC_TIME", d), Col.c("EXEC_TIME", d), Col.c("TIME_USED", d),
                Col.expr("EXEC_TIME + PARSE_TIME + HARD_PARSE_TIME + IO_WAIT_TIME", d,
                        "EXEC_TIME", "PARSE_TIME", "HARD_PARSE_TIME", "IO_WAIT_TIME")));
        m.put(Counter.CPU_MS, List.of(Col.c("CPU_TIME", d), Col.c("EXEC_CPU", d)));
        m.put(Counter.LOGICAL_READS, List.of(
                Col.c("LOGIC_READ_CNT"), Col.c("LOGIC_READS"),
                Col.expr("HBUF_LOGIC_READ_CNT + RECYCLE_LOGIC_READ_CNT", 1,
                        "HBUF_LOGIC_READ_CNT", "RECYCLE_LOGIC_READ_CNT"),
                Col.c("HBUF_LOGIC_READ_CNT"), Col.c("RECYCLE_LOGIC_READ_CNT")));
        m.put(Counter.PHYSICAL_READS, List.of(Col.c("PHY_READ_CNT"), Col.c("PHY_READS"), Col.c("HBUF_PHY_READ_CNT")));
        m.put(Counter.ROWS_RETURNED, List.of(Col.c("ROW_COUNT"), Col.c("ROWS_PROCESSED"), Col.c("VIS_RECS_CNT")));
        return new Spec(DbType.DAMENG, "V$SQL_STAT", "V$SQL_STAT", List.of("SQL_ID"), List.of(),
                List.of(Col.c("SQL_TXT"), Col.c("SQL_TEXT")), List.of(Col.c("CURR_SCH"), Col.c("SCH_NAME")), List.of(), m,
                List.of(), null, LimitStyle.ROWNUM);
    }

    static Spec sqlserver() {
        String from = "(SELECT CONVERT(VARCHAR(64), qs.query_hash, 1) AS QHASH, CONVERT(VARCHAR(64), qs.query_plan_hash, 1) AS PHASH, "
                + "DB_NAME(st.dbid) AS DBNAME, "
                + "MAX(SUBSTRING(st.text, qs.statement_start_offset / 2 + 1, ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) "
                + "ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2) + 1)) AS STMT, "
                + "SUM(qs.execution_count) AS EXECS, SUM(qs.total_elapsed_time) AS ELAPSED_US, SUM(qs.total_worker_time) AS CPU_US, "
                + "SUM(qs.total_logical_reads) AS LR, SUM(qs.total_physical_reads) AS PR, SUM(qs.total_rows) AS ROWS_RET, "
                + "MAX(qs.last_execution_time) AS LAST_EXEC, MAX(qs.max_elapsed_time) AS MAX_US "
                + "FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st "
                + "GROUP BY qs.query_hash, qs.query_plan_hash, st.dbid) t";
        Map<Counter, List<Col>> m = new EnumMap<>(Counter.class);
        m.put(Counter.EXEC, List.of(Col.c("EXECS")));
        m.put(Counter.ELAPSED_MS, List.of(Col.c("ELAPSED_US", 1000)));
        m.put(Counter.CPU_MS, List.of(Col.c("CPU_US", 1000)));
        m.put(Counter.LOGICAL_READS, List.of(Col.c("LR")));
        m.put(Counter.PHYSICAL_READS, List.of(Col.c("PR")));
        m.put(Counter.ROWS_RETURNED, List.of(Col.c("ROWS_RET")));
        return new Spec(DbType.SQLSERVER, "sys.dm_exec_query_stats", from, List.of("QHASH"), List.of(),
                List.of(Col.c("STMT")), List.of(Col.c("DBNAME")), List.of(Col.c("PHASH")), m,
                List.of(Filter.f("DBNAME NOT IN ('master','msdb','tempdb','model')", "DBNAME")),
                Filter.f("LAST_EXEC >= DATEADD(MINUTE, -2, GETDATE())", "LAST_EXEC"), LimitStyle.TOP);
    }

    // ------------------------------------------------------------------ 探测 / 取数

    public static Probe probe(TargetDb db, Spec spec) {
        try {
            return resolve(spec, columns(db, spec.from()));
        } catch (SQLException e) {
            return new Probe(spec, false, Values.truncate(e.getMessage(), 900), List.of(), null, null, null, Map.of(), List.of(), null);
        }
    }

    /** 视图/子查询的实际列名（大写） */
    public static Set<String> columns(TargetDb db, String from) throws SQLException {
        Set<String> cols = new HashSet<>();
        try (PreparedStatement ps = db.connection().prepareStatement("SELECT * FROM " + from + " WHERE 1=0")) {
            ps.setQueryTimeout(15);
            ResultSetMetaData md = ps.executeQuery().getMetaData();
            for (int i = 1; i <= md.getColumnCount(); i++) {
                cols.add(md.getColumnLabel(i).toUpperCase(Locale.ROOT));
            }
        }
        return cols;
    }

    /** 纯函数：按实际列名选择候选列（单测可直接调用） */
    public static Probe resolve(Spec spec, Set<String> cols) {
        List<String> ids = new ArrayList<>();
        for (String id : spec.idCols()) {
            if (!cols.contains(id)) {
                return new Probe(spec, false, spec.sourceName() + " 缺少标识列 " + id, List.of(), null, null, null, Map.of(), List.of(), null);
            }
            ids.add(id);
        }
        for (String id : spec.optionalIdCols()) {
            if (cols.contains(id)) {
                ids.add(id);
            }
        }
        Map<Counter, Col> chosen = new EnumMap<>(Counter.class);
        for (Map.Entry<Counter, List<Col>> e : spec.counters().entrySet()) {
            Col c = first(e.getValue(), cols);
            if (c != null) {
                chosen.put(e.getKey(), c);
            }
        }
        if (!chosen.containsKey(Counter.EXEC) || !chosen.containsKey(Counter.ELAPSED_MS)) {
            return new Probe(spec, false, spec.sourceName() + " 缺少执行次数/耗时列（实际列：" + Values.truncate(String.join(",", cols), 600) + "）",
                    ids, null, null, null, Map.of(), List.of(), null);
        }
        List<String> filters = new ArrayList<>();
        for (Filter f : spec.filters()) {
            if (cols.containsAll(f.requires())) {
                filters.add(f.sql());
            }
        }
        String activity = spec.activity() != null && cols.containsAll(spec.activity().requires()) ? spec.activity().sql() : null;
        return new Probe(spec, true, null, ids, first(spec.text(), cols), first(spec.schema(), cols), first(spec.plan(), cols),
                chosen, filters, activity);
    }

    private static Col first(List<Col> list, Set<String> cols) {
        for (Col c : list) {
            if (c.available(cols)) {
                return c;
            }
        }
        return null;
    }

    /** 生成取数 SQL（纯函数，便于单测） */
    public static String buildQuery(Probe p, int topN) {
        StringBuilder sel = new StringBuilder();
        for (int i = 0; i < p.ids().size(); i++) {
            sel.append(i == 0 ? "" : ", ").append(p.ids().get(i)).append(" AS NID").append(i);
        }
        sel.append(", ").append(p.text() == null ? "NULL" : p.text().expr()).append(" AS TXT");
        sel.append(", ").append(p.schema() == null ? "NULL" : p.schema().expr()).append(" AS SCH");
        sel.append(", ").append(p.plan() == null ? "NULL" : p.plan().expr()).append(" AS PLN");
        for (Map.Entry<Counter, Col> e : p.counters().entrySet()) {
            sel.append(", ").append(e.getValue().expr()).append(" AS C_").append(e.getKey().name());
        }
        List<String> where = new ArrayList<>(p.filters());
        if (p.activity() != null) {
            where.add(p.activity());
        }
        String w = where.isEmpty() ? "" : " WHERE " + String.join(" AND ", where);
        String order = " ORDER BY " + p.counters().get(Counter.ELAPSED_MS).expr() + " DESC";
        int n = Math.max(1, topN);
        return switch (p.spec().limit()) {
            case ROWNUM -> "SELECT * FROM (SELECT " + sel + " FROM " + p.spec().from() + w + order + ") WHERE ROWNUM <= " + n;
            case TOP -> "SELECT TOP " + n + " " + sel + " FROM " + p.spec().from() + w + order;
            case LIMIT -> "SELECT " + sel + " FROM " + p.spec().from() + w + order + " LIMIT " + n;
        };
    }

    public static List<SqlCounters> snapshot(TargetDb db, Probe p, int topN) throws SQLException {
        List<Map<String, Object>> rows = db.queryMax(topN, buildQuery(p, topN));
        List<SqlCounters> out = new ArrayList<>(rows.size());
        for (Map<String, Object> r : rows) {
            out.add(toCounters(p, r));
        }
        return out;
    }

    static SqlCounters toCounters(Probe p, Map<String, Object> r) {
        StringBuilder nid = new StringBuilder();
        for (int i = 0; i < p.ids().size(); i++) {
            if (i > 0) {
                nid.append('|');
            }
            nid.append(Values.str(r.get("NID" + i), "null"));
        }
        double[] v = SqlCounters.empty();
        for (Map.Entry<Counter, Col> e : p.counters().entrySet()) {
            Double d = Values.toDouble(r.get("C_" + e.getKey().name()));
            if (d != null) {
                v[e.getKey().ordinal()] = d / e.getValue().divisor();
            }
        }
        return new SqlCounters(Values.truncate(nid.toString(), 160), Values.str(r.get("PLN")), Values.str(r.get("SCH")),
                Values.str(r.get("TXT")), v);
    }
}
