package com.dbops.sqlinsight.web;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * SQL 洞察「分析」接口：把 DI_SQL_STATS_MIN 的历史样本换成可直接回答问题的视图。
 * <pre>
 * GET /api/sql-insight/long-sql                 长时间执行 SQL：平均 / 最大 / P95 耗时、持续窗口数、等待事件、来源
 * GET /api/sql-insight/cpu-compare              CPU 历史同期对比：今日 vs 昨日 vs 上月，主机 CPU vs SQL CPU 时间，增量 Top SQL
 * GET /api/sql-insight/changes                  变化感知：新增 SQL、执行时段偏移、资源增量、与实例高峰重叠的冲突风险
 * GET /api/sql-insight/assets/{id}/profile      单条 SQL 画像：时段 / 频率 / 耗时 / CPU / IO / 连接跨层、计划数、绑定变量与解析质量
 * </pre>
 * 全部只读；时间窗口、阈值均在 SQL 里按已钳制的整数拼接（无用户字符串拼接）。
 */
@RestController
@RequestMapping("/api/sql-insight")
public class SqlInsightAnalysisController {

    /** 同一规范化 SQL 对应的原生 ID 个数：与规则 P-013 默认阈值一致 */
    private static final int BIND_POOR = 100;
    private static final int BIND_FAIR = 10;

    private final Db db;

    public SqlInsightAnalysisController(Db db) {
        this.db = db;
    }

    private static String nid(String alias) {
        return "(SELECT MAX(src.NATIVE_ID) KEEP (DENSE_RANK LAST ORDER BY src.LAST_SEEN) FROM DI_SQL_ASSET_SOURCE src "
                + "WHERE src.ASSET_ID = " + alias + ".ASSET_ID AND src.INSTANCE_ID = " + alias + ".INSTANCE_ID)";
    }

    private static double d(Object v) {
        Double x = Values.toDouble(v);
        return x == null ? 0 : x;
    }

    // ------------------------------------------------------------------ 长时间执行 SQL

    @GetMapping("/long-sql")
    public Map<String, Object> longSql(@RequestParam(required = false) Long instanceId,
                                       @RequestParam(required = false, defaultValue = "24") int hours,
                                       @RequestParam(required = false, defaultValue = "1000") double minAvgMs,
                                       @RequestParam(required = false, defaultValue = "50") int limit) {
        int h = Values.clamp(hours, 1, 24 * 7);
        int lim = Values.clamp(limit, 1, 200);
        List<Object> args = new ArrayList<>();
        String ic = "";
        if (instanceId != null) {
            ic = " AND s.INSTANCE_ID = ?";
            args.add(instanceId);
        }
        args.add(minAvgMs);
        String sql = "SELECT * FROM (SELECT t.*, " + nid("t") + " NATIVE_SQL_ID, "
                + "(SELECT MAX(p.RULE_CODE) KEEP (DENSE_RANK LAST ORDER BY p.LAST_SEEN) FROM DI_SQL_PROBLEM p WHERE p.ASSET_ID = t.ASSET_ID "
                + "AND p.INSTANCE_ID = t.INSTANCE_ID AND p.RULE_CODE IN ('P-001','P-002','P-010')) LAST_RT_RULE, "
                + "(SELECT MAX(x.WAIT_EVENT) KEEP (DENSE_RANK LAST ORDER BY x.SAMPLES) FROM DI_SQL_WAIT_SAMPLE x WHERE x.ASSET_ID = t.ASSET_ID "
                + "AND x.INSTANCE_ID = t.INSTANCE_ID) WAIT_EVENT, "
                + "(SELECT MAX(x.SAMPLES) KEEP (DENSE_RANK LAST ORDER BY x.SAMPLES) FROM DI_SQL_WAIT_SAMPLE x WHERE x.ASSET_ID = t.ASSET_ID "
                + "AND x.INSTANCE_ID = t.INSTANCE_ID) WAIT_SAMPLES, "
                + "(SELECT SUM(x.SAMPLES) FROM DI_SQL_WAIT_SAMPLE x WHERE x.ASSET_ID = t.ASSET_ID AND x.INSTANCE_ID = t.INSTANCE_ID) WAIT_TOTAL, "
                + "(SELECT MAX(w.CAPTURE_SOURCE) KEEP (DENSE_RANK LAST ORDER BY w.CAPTURE_TIME) FROM SQL_SLOW_SUMMARY w WHERE w.ASSET_ID = t.ASSET_ID "
                + "AND w.INSTANCE_ID = t.INSTANCE_ID) CAPTURE_SOURCE "
                + "FROM (SELECT s.INSTANCE_ID, s.ASSET_ID, MAX(i.INSTANCE_NAME) INSTANCE_NAME, MAX(a.SCHEMA_NAME) SCHEMA_NAME, MAX(a.STMT_TYPE) STMT_TYPE, "
                + "SUM(s.D_EXEC) EXECS, ROUND(SUM(s.D_ELAPSED_MS) / 1000, 1) DB_TIME_SEC, "
                + "ROUND(SUM(s.D_ELAPSED_MS) / NULLIF(SUM(s.D_EXEC), 0), 2) AVG_MS, ROUND(MAX(s.AVG_ELAPSED_MS), 2) MAX_WINDOW_AVG_MS, "
                + "ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY s.AVG_ELAPSED_MS), 2) P95_MS, COUNT(*) WINDOWS, "
                + "MIN(s.WINDOW_START) FIRST_WINDOW, MAX(s.WINDOW_START) LAST_WINDOW, "
                + "ROUND(SUM(s.D_CPU_MS) / NULLIF(SUM(s.D_EXEC), 0), 2) CPU_PER_EXEC_MS, "
                + "ROUND(SUM(s.D_LOGICAL_READS) / NULLIF(SUM(s.D_EXEC), 0), 0) LR_PER_EXEC, "
                + "ROUND(SUM(s.D_PHYSICAL_READS) / NULLIF(SUM(s.D_EXEC), 0), 0) PR_PER_EXEC, "
                + "MAX(DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 300, 1)) SQL_TEXT "
                + "FROM DI_SQL_STATS_MIN s JOIN DI_SQL_ASSET a ON a.ASSET_ID = s.ASSET_ID LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = s.INSTANCE_ID "
                + "WHERE s.WINDOW_START >= LOCALTIMESTAMP - NUMTODSINTERVAL(" + h + ", 'HOUR') AND s.D_EXEC > 0" + ic
                + " GROUP BY s.INSTANCE_ID, s.ASSET_ID HAVING SUM(s.D_ELAPSED_MS) / NULLIF(SUM(s.D_EXEC), 0) >= ? "
                + "ORDER BY P95_MS DESC NULLS LAST) t WHERE ROWNUM <= " + lim + ")";
        List<Map<String, Object>> rows = db.query(sql, args);
        for (Map<String, Object> r : rows) {
            double windows = d(r.get("WINDOWS"));
            r.put("PERSISTENT", windows >= 5);
        }
        return R.ok(R.map("hours", h, "minAvgMs", minAvgMs, "list", rows));
    }

    // ------------------------------------------------------------------ CPU 历史同期对比

    private static final String[] PERIOD_KEYS = {"today", "yesterday", "lastMonth"};
    private static final int[] PERIOD_SHIFT_DAYS = {0, 1, 30};

    @GetMapping("/cpu-compare")
    public Map<String, Object> cpuCompare(@RequestParam long instanceId,
                                          @RequestParam(required = false, defaultValue = "24") int hours) {
        int h = Values.clamp(hours, 1, 48);
        Map<String, Object> periods = new LinkedHashMap<>();
        Map<String, Double> sqlCpuSec = new LinkedHashMap<>();
        Map<String, Double> hostCpuAvg = new LinkedHashMap<>();
        Map<String, Object> coverage = new LinkedHashMap<>();
        for (int p = 0; p < PERIOD_KEYS.length; p++) {
            int shift = PERIOD_SHIFT_DAYS[p];
            // 取最近 h 个「整点小时」（不含当前未走完的小时），三个周期按同样的整点对齐
            String from = "(TRUNC(LOCALTIMESTAMP, 'HH24') - NUMTODSINTERVAL(" + h + ", 'HOUR') - NUMTODSINTERVAL(" + shift + ", 'DAY'))";
            String to = "(TRUNC(LOCALTIMESTAMP, 'HH24') - NUMTODSINTERVAL(" + shift + ", 'DAY'))";
            Map<Long, Map<String, Object>> byIdx = new TreeMap<>();
            int minuteHours = 0, rollupHours = 0;
            // 1) 分钟统计（精确）
            for (Map<String, Object> r : db.query("SELECT EXTRACT(DAY FROM (WINDOW_START - " + from + ")) * 24 + EXTRACT(HOUR FROM (WINDOW_START - " + from + ")) IDX, "
                    + "ROUND(SUM(D_CPU_MS) / 1000, 1) SQL_CPU_SEC, ROUND(SUM(D_ELAPSED_MS) / 1000, 1) DB_TIME_SEC, SUM(D_EXEC) EXECS "
                    + "FROM DI_SQL_STATS_MIN WHERE INSTANCE_ID = ? AND WINDOW_START >= " + from + " AND WINDOW_START < " + to
                    + " GROUP BY EXTRACT(DAY FROM (WINDOW_START - " + from + ")) * 24 + EXTRACT(HOUR FROM (WINDOW_START - " + from + "))", instanceId)) {
                long idx = Values.toLong(r.get("IDX"), -1);
                if (idx >= 0 && idx < h) {
                    byIdx.computeIfAbsent(idx, k -> new LinkedHashMap<>()).putAll(r);
                    minuteHours++;
                }
            }
            // 2) 小时汇总（分钟数据已过期的小时用它补，如上月同期）
            for (Map<String, Object> r : db.query("SELECT EXTRACT(DAY FROM (HOUR_START - " + from + ")) * 24 + EXTRACT(HOUR FROM (HOUR_START - " + from + ")) IDX, "
                    + "ROUND(SQL_CPU_MS / 1000, 1) SQL_CPU_SEC, ROUND(DB_TIME_MS / 1000, 1) DB_TIME_SEC, EXECS, HOST_CPU_PCT FROM DI_SQL_STATS_HOUR "
                    + "WHERE INSTANCE_ID = ? AND HOUR_START >= " + from + " AND HOUR_START < " + to, instanceId)) {
                long idx = Values.toLong(r.get("IDX"), -1);
                if (idx < 0 || idx >= h) {
                    continue;
                }
                Map<String, Object> cur = byIdx.get(idx);
                if (cur == null && r.get("SQL_CPU_SEC") != null) {
                    cur = new LinkedHashMap<>(r);
                    byIdx.put(idx, cur);
                    rollupHours++;
                } else if (cur == null) {
                    cur = new LinkedHashMap<>();
                    byIdx.put(idx, cur);
                }
                if (r.get("HOST_CPU_PCT") != null) {
                    cur.put("HOST_CPU_PCT", r.get("HOST_CPU_PCT"));
                }
            }
            // 3) 主机 CPU：监控采样（精确，优先于汇总）
            for (Map<String, Object> r : db.query("SELECT EXTRACT(DAY FROM (COLLECTED_AT - " + from + ")) * 24 + EXTRACT(HOUR FROM (COLLECTED_AT - " + from + ")) IDX, "
                    + "ROUND(AVG(METRIC_CPU), 1) HOST_CPU_PCT FROM MONITOR_METRIC_SAMPLE WHERE INSTANCE_ID = ? AND REACHABLE = 1 AND METRIC_CPU IS NOT NULL "
                    + "AND COLLECTED_AT >= " + from + " AND COLLECTED_AT < " + to
                    + " GROUP BY EXTRACT(DAY FROM (COLLECTED_AT - " + from + ")) * 24 + EXTRACT(HOUR FROM (COLLECTED_AT - " + from + "))", instanceId)) {
                long idx = Values.toLong(r.get("IDX"), -1);
                if (idx >= 0 && idx < h) {
                    byIdx.computeIfAbsent(idx, k -> new LinkedHashMap<>()).put("HOST_CPU_PCT", r.get("HOST_CPU_PCT"));
                }
            }
            List<Map<String, Object>> series = new ArrayList<>();
            double cpuSum = 0, hostSum = 0;
            int hostN = 0;
            for (Map.Entry<Long, Map<String, Object>> e : byIdx.entrySet()) {
                Map<String, Object> pt = new LinkedHashMap<>();
                pt.put("idx", e.getKey());
                pt.put("sqlCpuSec", e.getValue().get("SQL_CPU_SEC"));
                pt.put("dbTimeSec", e.getValue().get("DB_TIME_SEC"));
                pt.put("execs", e.getValue().get("EXECS"));
                pt.put("hostCpuPct", e.getValue().get("HOST_CPU_PCT"));
                series.add(pt);
                cpuSum += d(e.getValue().get("SQL_CPU_SEC"));
                if (e.getValue().get("HOST_CPU_PCT") != null) {
                    hostSum += d(e.getValue().get("HOST_CPU_PCT"));
                    hostN++;
                }
            }
            sqlCpuSec.put(PERIOD_KEYS[p], Values.round(cpuSum, 1));
            hostCpuAvg.put(PERIOD_KEYS[p], hostN == 0 ? null : Values.round(hostSum / hostN, 1));
            periods.put(PERIOD_KEYS[p], series);
            coverage.put(PERIOD_KEYS[p], R.map("hours", minuteHours + rollupHours, "minuteHours", minuteHours, "rollupHours", rollupHours, "wanted", h));
        }
        Map<String, Object> verdict = verdict(sqlCpuSec, hostCpuAvg, coverage, h);

        // 增量 Top SQL：当前窗口 vs 昨日同时段
        String cur = "(s.WINDOW_START >= TRUNC(LOCALTIMESTAMP, 'HH24') - NUMTODSINTERVAL(" + h + ", 'HOUR') AND s.WINDOW_START < TRUNC(LOCALTIMESTAMP, 'HH24'))";
        String prev = "(s.WINDOW_START >= TRUNC(LOCALTIMESTAMP, 'HH24') - NUMTODSINTERVAL(" + h + ", 'HOUR') - INTERVAL '1' DAY AND s.WINDOW_START < TRUNC(LOCALTIMESTAMP, 'HH24') - INTERVAL '1' DAY)";
        List<Map<String, Object>> top = db.query("SELECT * FROM (SELECT t.*, ROUND(t.CUR_CPU_SEC - t.PREV_CPU_SEC, 1) DELTA_CPU_SEC, " + nid("t") + " NATIVE_SQL_ID "
                + "FROM (SELECT s.INSTANCE_ID, s.ASSET_ID, "
                + "ROUND(SUM(CASE WHEN " + cur + " THEN s.D_CPU_MS ELSE 0 END) / 1000, 1) CUR_CPU_SEC, "
                + "ROUND(SUM(CASE WHEN " + prev + " THEN s.D_CPU_MS ELSE 0 END) / 1000, 1) PREV_CPU_SEC, "
                + "SUM(CASE WHEN " + cur + " THEN s.D_EXEC ELSE 0 END) CUR_EXECS, SUM(CASE WHEN " + prev + " THEN s.D_EXEC ELSE 0 END) PREV_EXECS, "
                + "MAX(DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 200, 1)) SQL_TEXT FROM DI_SQL_STATS_MIN s JOIN DI_SQL_ASSET a ON a.ASSET_ID = s.ASSET_ID "
                + "WHERE s.INSTANCE_ID = ? AND (" + cur + " OR " + prev + ") GROUP BY s.INSTANCE_ID, s.ASSET_ID) t "
                + "ORDER BY (t.CUR_CPU_SEC - t.PREV_CPU_SEC) DESC) WHERE ROWNUM <= 10", instanceId);
        double curTotal = sqlCpuSec.get("today");
        for (Map<String, Object> r : top) {
            r.put("SHARE", curTotal > 0 ? Values.round(d(r.get("CUR_CPU_SEC")) / curTotal, 4) : null);
        }
        return R.ok(R.map("hours", h, "periods", periods, "summary", R.map("sqlCpuSec", sqlCpuSec, "hostCpuAvg", hostCpuAvg),
                "coverage", coverage, "verdict", verdict, "topDelta", top));
    }

    /** 当前窗口与（昨日、上月）同期比较：两个参照都存在才下结论，ratio≥1.5 视为偏离常态 */
    static Map<String, Object> verdict(Map<String, Double> sqlCpuSec, Map<String, Double> hostCpuAvg, Map<String, Object> coverage, int wanted) {
        double t = sqlCpuSec.get("today"), y = sqlCpuSec.get("yesterday"), m = sqlCpuSec.get("lastMonth");
        // 参照期覆盖的小时数不足一半，视为无同期数据（避免拿几个小时的合计去比整段）
        if (coverage != null && coverage.get("yesterday") instanceof Map<?, ?> cy && Values.toLong(cy.get("hours"), 0) * 2 < wanted) {
            y = 0;
        }
        if (coverage != null && coverage.get("lastMonth") instanceof Map<?, ?> cm && Values.toLong(cm.get("hours"), 0) * 2 < wanted) {
            m = 0;
        }
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("vsYesterday", y > 0 ? Values.round(t / y, 2) : null);
        v.put("vsLastMonth", m > 0 ? Values.round(t / m, 2) : null);
        Double hy = hostCpuAvg.get("yesterday");
        Double hm = hostCpuAvg.get("lastMonth");
        Double ht = hostCpuAvg.get("today");
        v.put("hostVsYesterday", ht != null && hy != null && hy > 0 ? Values.round(ht / hy, 2) : null);
        v.put("hostVsLastMonth", ht != null && hm != null && hm > 0 ? Values.round(ht / hm, 2) : null);
        String level;
        String text;
        if (y <= 0 && m <= 0) {
            level = "UNKNOWN";
            text = "昨日 / 上月同期的 SQL CPU 样本不足（覆盖不到所选小时数的一半；上月同期来自小时汇总，系统上线满 30 天后可用，且需 CPU 计数器可用），无法判断是否偏离常态";
        } else {
            double ref = y > 0 && m > 0 ? (y + m) / 2 : Math.max(y, m);
            double ratio = ref > 0 ? t / ref : 0;
            if (ratio >= 1.5) {
                level = "ABNORMAL";
                text = String.format("当前窗口 SQL CPU 时间是同期参照的 %.1f 倍，偏离常态", ratio);
            } else if (ratio <= 0.67) {
                level = "LOW";
                text = String.format("当前窗口 SQL CPU 时间仅为同期参照的 %.1f 倍，低于常态", ratio);
            } else {
                level = "NORMAL";
                text = "当前窗口 SQL CPU 时间与同期参照接近，属于常态波动";
            }
            if (!(y > 0 && m > 0)) {
                text += y > 0 ? "（仅有昨日参照，缺上月同期）" : "（仅有上月参照，缺昨日同期）";
            }
        }
        v.put("level", level);
        v.put("text", text);
        return v;
    }

    // ------------------------------------------------------------------ 变化感知

    @GetMapping("/changes")
    public Map<String, Object> changes(@RequestParam(required = false) Long instanceId,
                                       @RequestParam(required = false, defaultValue = "24") int hours) {
        int h = Values.clamp(hours, 1, 24 * 7);
        List<Object> ia = new ArrayList<>();
        String sic = "";
        if (instanceId != null) {
            sic = " AND s.INSTANCE_ID = ?";
            ia.add(instanceId);
        }
        String cur = "s.WINDOW_START >= LOCALTIMESTAMP - NUMTODSINTERVAL(" + h + ", 'HOUR')";

        // 实例高峰小时（近 7 天按小时的 DB Time 前 3）
        Map<Long, List<Integer>> busy = new HashMap<>();
        Map<Long, Map<Integer, Double>> hourLoad = new HashMap<>();
        for (Map<String, Object> r : db.query("SELECT s.INSTANCE_ID, TO_NUMBER(TO_CHAR(s.WINDOW_START, 'HH24')) HR, SUM(s.D_ELAPSED_MS) / 1000 SEC "
                + "FROM DI_SQL_STATS_MIN s WHERE s.WINDOW_START >= LOCALTIMESTAMP - INTERVAL '7' DAY" + sic
                + " GROUP BY s.INSTANCE_ID, TO_NUMBER(TO_CHAR(s.WINDOW_START, 'HH24'))", ia)) {
            hourLoad.computeIfAbsent(Values.toLong(r.get("INSTANCE_ID"), 0), k -> new HashMap<>())
                    .put((int) Values.toLong(r.get("HR"), 0), d(r.get("SEC")));
        }
        for (Map.Entry<Long, Map<Integer, Double>> e : hourLoad.entrySet()) {
            List<Map.Entry<Integer, Double>> l = new ArrayList<>(e.getValue().entrySet());
            l.sort((a, b) -> Double.compare(b.getValue(), a.getValue()));
            List<Integer> top = new ArrayList<>();
            for (int i = 0; i < Math.min(3, l.size()); i++) {
                top.add(l.get(i).getKey());
            }
            busy.put(e.getKey(), top);
        }

        // 1) 新增 SQL：窗口内首次出现，且该实例在窗口之前已有采集数据（否则只是刚接入）
        List<Map<String, Object>> newSql = db.query("SELECT * FROM (SELECT a.ASSET_ID, src.INSTANCE_ID, i.INSTANCE_NAME, a.SCHEMA_NAME, a.STMT_TYPE, a.FIRST_SEEN, "
                + "a.STATIC_RISK, src.NATIVE_ID NATIVE_SQL_ID, DBMS_LOB.SUBSTR(a.SAMPLE_SQL, 200, 1) SQL_TEXT, "
                + "(SELECT SUM(x.D_EXEC) FROM DI_SQL_STATS_MIN x WHERE x.ASSET_ID = a.ASSET_ID AND x.INSTANCE_ID = src.INSTANCE_ID) EXECS, "
                + "(SELECT ROUND(SUM(x.D_ELAPSED_MS) / 1000, 1) FROM DI_SQL_STATS_MIN x WHERE x.ASSET_ID = a.ASSET_ID AND x.INSTANCE_ID = src.INSTANCE_ID) DB_TIME_SEC "
                + "FROM DI_SQL_ASSET a JOIN DI_SQL_ASSET_SOURCE src ON src.ASSET_ID = a.ASSET_ID "
                + "LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = src.INSTANCE_ID "
                + "WHERE a.FIRST_SEEN >= SYSTIMESTAMP - NUMTODSINTERVAL(" + h + ", 'HOUR') "
                + "AND EXISTS (SELECT 1 FROM DI_SQL_STATS_MIN o WHERE o.INSTANCE_ID = src.INSTANCE_ID AND o.WINDOW_START < LOCALTIMESTAMP - NUMTODSINTERVAL(" + h + ", 'HOUR'))"
                + sic.replace("s.INSTANCE_ID", "src.INSTANCE_ID")
                + " ORDER BY a.FIRST_SEEN DESC) WHERE ROWNUM <= 50", ia);

        // 2) 执行时段偏移 + 当前窗口的各 SQL 峰值小时（供冲突判断）
        Map<String, int[]> curExec = new HashMap<>();     // key=inst|asset → 24 小时执行次数
        Map<String, int[]> prevExec = new HashMap<>();
        Map<String, double[]> curSec = new HashMap<>();
        for (Map<String, Object> r : db.query("SELECT s.INSTANCE_ID, s.ASSET_ID, TO_NUMBER(TO_CHAR(s.WINDOW_START, 'HH24')) HR, "
                + "CASE WHEN " + cur + " THEN 'C' ELSE 'P' END PER, SUM(s.D_EXEC) EXECS, SUM(s.D_ELAPSED_MS) / 1000 SEC FROM DI_SQL_STATS_MIN s "
                + "WHERE s.WINDOW_START >= LOCALTIMESTAMP - NUMTODSINTERVAL(" + h + ", 'HOUR') - INTERVAL '7' DAY" + sic
                + " GROUP BY s.INSTANCE_ID, s.ASSET_ID, TO_NUMBER(TO_CHAR(s.WINDOW_START, 'HH24')), CASE WHEN " + cur + " THEN 'C' ELSE 'P' END", ia)) {
            String k = r.get("INSTANCE_ID") + "|" + r.get("ASSET_ID");
            int hr = (int) Values.toLong(r.get("HR"), 0);
            long ex = Values.toLong(r.get("EXECS"), 0);
            if ("C".equals(String.valueOf(r.get("PER")))) {
                curExec.computeIfAbsent(k, x -> new int[24])[hr] += (int) Math.min(ex, Integer.MAX_VALUE / 2);
                curSec.computeIfAbsent(k, x -> new double[24])[hr] += d(r.get("SEC"));
            } else {
                prevExec.computeIfAbsent(k, x -> new int[24])[hr] += (int) Math.min(ex, Integer.MAX_VALUE / 2);
            }
        }
        List<Map<String, Object>> shifts = new ArrayList<>();
        for (Map.Entry<String, int[]> e : curExec.entrySet()) {
            int[] p = prevExec.get(e.getKey());
            if (p == null) {
                continue;
            }
            int cp = peak(e.getValue()), pp = peak(p);
            long cs = sum(e.getValue()), ps = sum(p);
            int diff = Math.abs(cp - pp);
            diff = Math.min(diff, 24 - diff);
            if (diff >= 3 && cs >= 10 && ps >= 50) {
                Map<String, Object> m = new LinkedHashMap<>();
                String[] ids = e.getKey().split("\\|");
                m.put("INSTANCE_ID", Long.parseLong(ids[0]));
                m.put("ASSET_ID", Long.parseLong(ids[1]));
                m.put("PREV_PEAK_HOUR", pp);
                m.put("CUR_PEAK_HOUR", cp);
                m.put("SHIFT_HOURS", diff);
                m.put("CUR_EXECS", cs);
                m.put("PREV_EXECS", ps);
                shifts.add(m);
            }
        }
        shifts.sort((a, b) -> Integer.compare((int) b.get("SHIFT_HOURS"), (int) a.get("SHIFT_HOURS")));
        if (shifts.size() > 30) {
            shifts = new ArrayList<>(shifts.subList(0, 30));
        }
        enrich(shifts);

        // 3) 资源增量：当前窗口 DB Time 相对紧邻的前一个同长度窗口增长 ≥ 50% 且增量 ≥ 10 秒
        String prev = "(s.WINDOW_START >= LOCALTIMESTAMP - NUMTODSINTERVAL(" + (2 * h) + ", 'HOUR') AND s.WINDOW_START < LOCALTIMESTAMP - NUMTODSINTERVAL(" + h + ", 'HOUR'))";
        List<Map<String, Object>> growth = db.query("SELECT * FROM (SELECT t.*, ROUND(t.CUR_SEC - t.PREV_SEC, 1) DELTA_SEC, "
                + "ROUND(t.CUR_SEC / NULLIF(t.PREV_SEC, 0), 2) RATIO FROM (SELECT s.INSTANCE_ID, s.ASSET_ID, "
                + "ROUND(SUM(CASE WHEN " + cur + " THEN s.D_ELAPSED_MS ELSE 0 END) / 1000, 1) CUR_SEC, "
                + "ROUND(SUM(CASE WHEN " + prev + " THEN s.D_ELAPSED_MS ELSE 0 END) / 1000, 1) PREV_SEC, "
                + "SUM(CASE WHEN " + cur + " THEN s.D_EXEC ELSE 0 END) CUR_EXECS, SUM(CASE WHEN " + prev + " THEN s.D_EXEC ELSE 0 END) PREV_EXECS "
                + "FROM DI_SQL_STATS_MIN s WHERE (" + cur + " OR " + prev + ")" + sic + " GROUP BY s.INSTANCE_ID, s.ASSET_ID) t "
                + "WHERE t.CUR_SEC - t.PREV_SEC >= 10 AND t.CUR_SEC >= t.PREV_SEC * 1.5 ORDER BY (t.CUR_SEC - t.PREV_SEC) DESC) WHERE ROWNUM <= 30", ia);
        enrich(growth);

        // 4) 冲突风险：新增 / 偏移 / 增长的 SQL，其当前窗口峰值小时落在该实例高峰小时内
        List<Map<String, Object>> conflicts = new ArrayList<>();
        addConflicts(conflicts, "NEW_SQL", newSql, busy, curSec);
        addConflicts(conflicts, "TIME_SHIFT", shifts, busy, curSec);
        addConflicts(conflicts, "RESOURCE_GROWTH", growth, busy, curSec);
        return R.ok(R.map("hours", h, "newSql", newSql, "timeShift", shifts, "resourceGrowth", growth, "conflicts", conflicts, "busyHours", busy));
    }

    private void addConflicts(List<Map<String, Object>> out, String kind, List<Map<String, Object>> src,
                              Map<Long, List<Integer>> busy, Map<String, double[]> curSec) {
        for (Map<String, Object> r : src) {
            long inst = Values.toLong(r.get("INSTANCE_ID"), 0);
            double[] sec = curSec.get(inst + "|" + r.get("ASSET_ID"));
            List<Integer> bh = busy.get(inst);
            if (sec == null || bh == null) {
                continue;
            }
            int pk = 0;
            for (int i = 1; i < 24; i++) {
                if (sec[i] > sec[pk]) {
                    pk = i;
                }
            }
            if (sec[pk] > 0 && bh.contains(pk)) {
                Map<String, Object> c = new LinkedHashMap<>();
                c.put("KIND", kind);
                c.put("INSTANCE_ID", inst);
                c.put("INSTANCE_NAME", r.get("INSTANCE_NAME"));
                c.put("ASSET_ID", r.get("ASSET_ID"));
                c.put("NATIVE_SQL_ID", r.get("NATIVE_SQL_ID"));
                c.put("SQL_TEXT", r.get("SQL_TEXT"));
                c.put("PEAK_HOUR", pk);
                c.put("PEAK_SEC", Values.round(sec[pk], 1));
                c.put("BUSY_HOURS", bh);
                out.add(c);
            }
        }
    }

    /** 补实例名 / sql_id / SQL 文本 */
    private void enrich(List<Map<String, Object>> rows) {
        for (Map<String, Object> r : rows) {
            Map<String, Object> a = db.one("SELECT i.INSTANCE_NAME, " + nid("x") + " NATIVE_SQL_ID, DBMS_LOB.SUBSTR(s.SAMPLE_SQL, 200, 1) SQL_TEXT, s.STMT_TYPE, s.SCHEMA_NAME "
                    + "FROM (SELECT ? ASSET_ID, ? INSTANCE_ID FROM DUAL) x JOIN DI_SQL_ASSET s ON s.ASSET_ID = x.ASSET_ID "
                    + "LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = x.INSTANCE_ID", r.get("ASSET_ID"), r.get("INSTANCE_ID"));
            if (a != null) {
                r.putAll(a);
            }
        }
    }

    private static int peak(int[] v) {
        int p = 0;
        for (int i = 1; i < v.length; i++) {
            if (v[i] > v[p]) {
                p = i;
            }
        }
        return p;
    }

    private static long sum(int[] v) {
        long s = 0;
        for (int x : v) {
            s += x;
        }
        return s;
    }

    // ------------------------------------------------------------------ 单条 SQL 画像

    @GetMapping("/assets/{id}/profile")
    public Map<String, Object> profile(@PathVariable long id, @RequestParam long instanceId,
                                       @RequestParam(required = false, defaultValue = "7") int days) {
        int dd = Values.clamp(days, 1, 28);
        String since = "LOCALTIMESTAMP - NUMTODSINTERVAL(" + dd + ", 'DAY')";
        Map<String, Object> asset = db.one("SELECT ASSET_ID, DB_TYPE, SCHEMA_NAME, STMT_TYPE, PARSE_STATUS, STATIC_RISK, IS_CORE, BIZ_TYPE, SCENE, APP_VERSION, "
                + "QUALITY_TAG, LIFECYCLE, FIRST_SEEN, LAST_SEEN FROM DI_SQL_ASSET WHERE ASSET_ID = ?", id);
        if (asset == null) {
            return R.notFound("SQL 资产不存在");
        }
        List<Map<String, Object>> hourly = db.query("SELECT TO_NUMBER(TO_CHAR(WINDOW_START, 'HH24')) HR, SUM(D_EXEC) EXECS, "
                + "ROUND(SUM(D_ELAPSED_MS) / NULLIF(SUM(D_EXEC), 0), 2) AVG_MS, ROUND(SUM(D_CPU_MS) / NULLIF(SUM(D_EXEC), 0), 2) CPU_PER_EXEC_MS, "
                + "ROUND(SUM(D_LOGICAL_READS) / NULLIF(SUM(D_EXEC), 0), 0) LR_PER_EXEC, ROUND(SUM(D_PHYSICAL_READS) / NULLIF(SUM(D_EXEC), 0), 0) PR_PER_EXEC, "
                + "NVL(SUM(D_ERRORS), 0) ERRORS FROM DI_SQL_STATS_MIN WHERE ASSET_ID = ? AND INSTANCE_ID = ? AND WINDOW_START >= " + since
                + " GROUP BY TO_NUMBER(TO_CHAR(WINDOW_START, 'HH24')) ORDER BY HR", id, instanceId);
        List<Map<String, Object>> instHourly = db.query("SELECT TO_NUMBER(TO_CHAR(COLLECTED_AT, 'HH24')) HR, ROUND(AVG(METRIC_CPU), 1) HOST_CPU_PCT, "
                + "ROUND(AVG(METRIC_CONN), 1) CONNECTIONS FROM MONITOR_METRIC_SAMPLE WHERE INSTANCE_ID = ? AND REACHABLE = 1 AND COLLECTED_AT >= " + since
                + " GROUP BY TO_NUMBER(TO_CHAR(COLLECTED_AT, 'HH24')) ORDER BY HR", instanceId);
        List<Map<String, Object>> plans = db.query("SELECT PLAN_HASH, SUM(D_EXEC) EXECS, ROUND(SUM(D_ELAPSED_MS) / NULLIF(SUM(D_EXEC), 0), 2) AVG_MS, "
                + "ROUND(SUM(D_LOGICAL_READS) / NULLIF(SUM(D_EXEC), 0), 0) LR_PER_EXEC, MIN(WINDOW_START) FIRST_SEEN, MAX(WINDOW_START) LAST_SEEN "
                + "FROM DI_SQL_STATS_MIN WHERE ASSET_ID = ? AND INSTANCE_ID = ? AND WINDOW_START >= " + since + " GROUP BY PLAN_HASH ORDER BY EXECS DESC", id, instanceId);
        Map<String, Object> tot = db.one("SELECT SUM(D_EXEC) EXECS, ROUND(SUM(D_ELAPSED_MS) / 1000, 1) DB_TIME_SEC, COUNT(*) WINDOWS, "
                + "ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY AVG_ELAPSED_MS), 2) P95_MS, ROUND(MAX(AVG_ELAPSED_MS), 2) MAX_WINDOW_AVG_MS "
                + "FROM DI_SQL_STATS_MIN WHERE ASSET_ID = ? AND INSTANCE_ID = ? AND WINDOW_START >= " + since + " AND D_EXEC > 0", id, instanceId);
        List<Map<String, Object>> waits = db.query("SELECT WAIT_EVENT, SAMPLES, ROUND(WAIT_SEC, 1) WAIT_SEC, LAST_SEEN FROM DI_SQL_WAIT_SAMPLE "
                + "WHERE ASSET_ID = ? AND INSTANCE_ID = ? ORDER BY SAMPLES DESC FETCH FIRST 10 ROWS ONLY", id, instanceId);
        double waitTotal = 0;
        for (Map<String, Object> w : waits) {
            waitTotal += d(w.get("SAMPLES"));
        }
        for (Map<String, Object> w : waits) {
            w.put("SHARE", waitTotal > 0 ? Values.round(d(w.get("SAMPLES")) / waitTotal, 4) : null);
        }
        long nativeIds = db.count("SELECT COUNT(*) FROM DI_SQL_ASSET_SOURCE WHERE ASSET_ID = ? AND INSTANCE_ID = ?", id, instanceId);
        long allNative = db.count("SELECT COUNT(*) FROM DI_SQL_ASSET_SOURCE WHERE ASSET_ID = ?", id);
        String bind = allNative >= BIND_POOR ? "POOR" : allNative >= BIND_FAIR ? "FAIR" : "GOOD";
        Map<String, Object> quality = new LinkedHashMap<>();
        quality.put("nativeIdsOnInstance", nativeIds);
        quality.put("nativeIdsTotal", allNative);
        quality.put("bindQuality", bind);
        quality.put("bindText", "POOR".equals(bind) ? "同一 SQL 对应 " + allNative + " 个原生 SQL ID，疑似未使用绑定变量（硬解析多、共享池压力大）"
                : "FAIR".equals(bind) ? "同一 SQL 对应 " + allNative + " 个原生 SQL ID，建议核对是否有字面量拼接" : "原生 SQL ID 数量正常");
        quality.put("parseStatus", asset.get("PARSE_STATUS"));
        quality.put("parseText", "FALLBACK".equals(String.valueOf(asset.get("PARSE_STATUS"))) ? "语法树解析失败，指纹基于文本归一化，静态分析不可信" : "语法树解析成功");
        quality.put("planCount", plans.stream().filter(p -> !"NA".equals(String.valueOf(p.get("PLAN_HASH")))).count());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("asset", asset);
        out.put("days", dd);
        out.put("totals", tot);
        out.put("hourly", hourly);
        out.put("instanceHourly", instHourly);
        out.put("plans", plans);
        out.put("waits", waits);
        out.put("quality", quality);
        return R.ok(out);
    }
}
