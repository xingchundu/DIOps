package com.dbops.sqlinsight.diagnosis;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.sqlinsight.baseline.Baseline;
import com.dbops.sqlinsight.baseline.BaselineService;
import com.dbops.sqlinsight.collect.Metric;
import com.dbops.sqlinsight.store.Json;
import com.dbops.sqlinsight.store.StatsRepo;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * 原因诊断（设计方案第 6 节）：收集证据 → CauseClassifier 分类 → 写 DI_SQL_ANOMALY_DIAGNOSIS。
 * 异步执行（有界队列，满了丢弃，下次波动会再触发），不阻塞采集线程。
 */
@Service
public class DiagnosisService {

    private static final Logger log = LoggerFactory.getLogger(DiagnosisService.class);

    private final Db db;
    private final BaselineService baselines;
    private final StatsRepo stats;
    private final Set<Long> inFlight = ConcurrentHashMap.newKeySet();
    private final ThreadPoolExecutor pool = new ThreadPoolExecutor(1, 2, 60, TimeUnit.SECONDS, new ArrayBlockingQueue<>(200), r -> {
        Thread t = new Thread(r, "sqlinsight-diagnosis");
        t.setDaemon(true);
        return t;
    }, new ThreadPoolExecutor.AbortPolicy());

    public DiagnosisService(Db db, BaselineService baselines, StatsRepo stats) {
        this.db = db;
        this.baselines = baselines;
        this.stats = stats;
    }

    @PreDestroy
    public void stop() {
        pool.shutdownNow();
    }

    public void diagnoseAsync(long anomalyId) {
        if (!inFlight.add(anomalyId)) {
            return;
        }
        Runnable task = () -> {
            try {
                diagnose(anomalyId);
            } catch (Exception e) {
                log.warn("[sqlinsight] diagnose {} failed: {}", anomalyId, e.getMessage());
                db.updateQuietly("INSERT INTO DI_SQL_ANOMALY_DIAGNOSIS (ANOMALY_ID, STATUS, ERROR_MSG) VALUES (?, 'FAILED', ?)",
                        anomalyId, Values.truncate(e.getMessage(), 1000));
            } finally {
                inFlight.remove(anomalyId);
            }
        };
        // 原来用 DiscardPolicy：队列满时任务被静默丢弃，finally 不执行 → 该事件永远留在 inFlight，之后再也不会被诊断
        try {
            pool.execute(task);
        } catch (java.util.concurrent.RejectedExecutionException e) {
            inFlight.remove(anomalyId);
            log.debug("[sqlinsight] diagnosis queue full, skip {}", anomalyId);
        }
    }

    public Map<String, Object> diagnose(long anomalyId) {
        Map<String, Object> ev = db.one("SELECT * FROM DI_SQL_ANOMALY WHERE ANOMALY_ID=?", anomalyId);
        if (ev == null) {
            throw com.dbops.common.BizException.notFound("事件不存在");
        }
        long inst = Values.toLong(ev.get("INSTANCE_ID"), 0);
        Long asset = Values.toLong(ev.get("ASSET_ID"));
        boolean instanceScope = "INSTANCE".equals(ev.get("SCOPE"));
        Map<String, Object> snapshot = new LinkedHashMap<>();

        // 1) 当前（最近 15 分钟）vs 基线
        Map<Metric, Double> ratios = new EnumMap<>(Metric.class);
        if (asset != null) {
            Map<String, Object> cur = db.one("SELECT SUM(D_EXEC) E, SUM(D_ELAPSED_MS) EL, SUM(D_CPU_MS) C, SUM(D_LOGICAL_READS) LR, "
                    + "SUM(D_PHYSICAL_READS) PR, SUM(D_ROWS_EXAMINED) RX, SUM(D_ROWS_RETURNED) RR, SUM(D_ERRORS) ER, "
                    + "SUM(WINDOW_MINUTES) MI, AVG(DB_TIME_SHARE) SH FROM DI_SQL_STATS_MIN WHERE INSTANCE_ID=? AND ASSET_ID=? "
                    + "AND WINDOW_START >= LOCALTIMESTAMP - INTERVAL '15' MINUTE", inst, asset);
            Map<Metric, Double> now = currentMetrics(cur);
            Map<Metric, Baseline> bl = baselines.current(inst, LocalDateTime.now()).getOrDefault(asset, Map.of());
            List<Map<String, Object>> cmp = new ArrayList<>();
            for (Metric m : Metric.values()) {
                Double v = now.get(m);
                Baseline b = bl.get(m);
                if (v != null && b != null && b.median() > 0) {
                    ratios.put(m, v / b.median());
                }
                if (v != null || b != null) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("metric", m.key);
                    row.put("label", m.label);
                    row.put("current", v == null ? null : Values.round(v, 4));
                    row.put("baseline", b == null ? null : Values.round(b.median(), 4));
                    row.put("slot", b == null ? null : b.slot());
                    row.put("ratio", ratios.containsKey(m) ? Values.round(ratios.get(m), 2) : null);
                    cmp.add(row);
                }
            }
            snapshot.put("metrics", cmp);
        }

        // 2) 执行计划：最近 15 分钟主计划 vs 最近 7 天（1 小时前）主计划
        String curPlan = null;
        String prevPlan = null;
        if (asset != null) {
            curPlan = dominantPlan(inst, asset, "WINDOW_START >= LOCALTIMESTAMP - INTERVAL '15' MINUTE");
            prevPlan = dominantPlan(inst, asset, "WINDOW_START BETWEEN LOCALTIMESTAMP - INTERVAL '7' DAY AND LOCALTIMESTAMP - INTERVAL '1' HOUR");
            snapshot.put("plans", db.query("SELECT PLAN_HASH, SUM(D_EXEC) EXECS, ROUND(SUM(D_ELAPSED_MS) / NULLIF(SUM(D_EXEC), 0), 2) AVG_MS, "
                    + "MIN(WINDOW_START) FIRST_SEEN, MAX(WINDOW_START) LAST_SEEN FROM DI_SQL_STATS_MIN WHERE INSTANCE_ID=? AND ASSET_ID=? "
                    + "AND WINDOW_START >= LOCALTIMESTAMP - INTERVAL '7' DAY GROUP BY PLAN_HASH ORDER BY LAST_SEEN DESC", inst, asset));
        }
        // 方案 9：MySQL/PG/磐维/达梦 统计视图没有计划标识（PLAN_HASH=NA），不下 PLAN_REGRESSION 结论
        boolean planSupported = curPlan != null && !"NA".equals(curPlan);
        String newPlanDetail = null;
        boolean newPlan = false;
        if (planSupported && asset != null) {
            Timestamp start = ev.get("START_TIME") instanceof Timestamp t ? t : new Timestamp(System.currentTimeMillis() - 15 * 60_000L);
            Map<String, Object> np = db.one("SELECT * FROM (SELECT s.PLAN_HASH, MIN(s.WINDOW_START) FIRST_SEEN, SUM(s.D_EXEC) E, "
                    + "SUM(SUM(s.D_EXEC)) OVER () TOTAL FROM DI_SQL_STATS_MIN s WHERE s.INSTANCE_ID=? AND s.ASSET_ID=? AND s.WINDOW_START >= ? "
                    + "AND NOT EXISTS (SELECT 1 FROM DI_SQL_STATS_MIN o WHERE o.INSTANCE_ID=s.INSTANCE_ID AND o.ASSET_ID=s.ASSET_ID AND o.PLAN_HASH=s.PLAN_HASH "
                    + "AND o.WINDOW_START < ? AND o.WINDOW_START >= ? - INTERVAL '7' DAY) GROUP BY s.PLAN_HASH ORDER BY E DESC NULLS LAST) WHERE ROWNUM = 1",
                    inst, asset, new Timestamp(start.getTime() - 30 * 60_000L), start, start);
            if (np != null && np.get("PLAN_HASH") != null) {
                newPlan = true;
                double e = Values.toDouble(np.get("E")) == null ? 0 : Values.toDouble(np.get("E"));
                double total = Values.toDouble(np.get("TOTAL")) == null ? 0 : Values.toDouble(np.get("TOTAL"));
                newPlanDetail = String.format("%s 出现新 plan_hash %s，异常窗口中占比 %.0f%%", hhmm(np.get("FIRST_SEEN")), np.get("PLAN_HASH"),
                        total > 0 ? e * 100 / total : 0);
            }
        }
        snapshot.put("planSupported", planSupported);
        snapshot.put("newPlan", newPlanDetail);

        // 3) 锁等待（会话采样 P-010）
        List<Map<String, Object>> locks = db.query("SELECT RULE_CODE, DETAIL, LAST_SEEN FROM DI_SQL_PROBLEM WHERE INSTANCE_ID=? AND RULE_CODE='P-010' "
                + "AND LAST_SEEN >= SYSTIMESTAMP - INTERVAL '15' MINUTE AND (ASSET_ID IS NULL OR ASSET_ID=? OR ?=0) ORDER BY LAST_SEEN DESC "
                + "FETCH FIRST 5 ROWS ONLY", inst, asset == null ? 0 : asset, asset == null ? 0 : 1);
        snapshot.put("lockWaits", locks);

        // 4) 发布 / 变更
        List<Map<String, Object>> windows = stats.recentChangeWindows(inst, 2);
        List<Map<String, Object>> anchors = asset == null ? List.of()
                : db.query("SELECT REASON, ANCHOR_TIME, OPERATOR, NOTE FROM DI_SQL_BASELINE_ANCHOR WHERE ASSET_ID=? AND REASON='PUBLISH' "
                + "AND ANCHOR_TIME >= SYSTIMESTAMP - INTERVAL '1' DAY ORDER BY ANCHOR_TIME DESC", asset);
        snapshot.put("changeWindows", windows);
        snapshot.put("publishAnchors", anchors);
        List<String> changes = new ArrayList<>();
        for (Map<String, Object> w : windows) {
            changes.add(Values.str(w.get("WINDOW_TYPE"), "") + "：" + Values.str(w.get("TITLE"), "") + "（" + hhmm(w.get("START_TIME")) + " 起）");
        }
        for (Map<String, Object> an : anchors) {
            changes.add("发布：" + Values.str(an.get("NOTE"), "") + "（" + hhmm(an.get("ANCHOR_TIME")) + "）");
        }

        // 4.1) 实例资源（监控采集的 CPU）：最近 15 分钟均值 / 过去 7 天同一小时的中位数
        double cpuRatio = Double.NaN;
        try {
            Map<String, Object> cpu = db.one("SELECT (SELECT AVG(METRIC_CPU) FROM MONITOR_METRIC_SAMPLE WHERE INSTANCE_ID=? AND COLLECTED_AT >= SYSTIMESTAMP - INTERVAL '15' MINUTE) CUR, "
                    + "(SELECT MEDIAN(METRIC_CPU) FROM MONITOR_METRIC_SAMPLE WHERE INSTANCE_ID=? AND COLLECTED_AT >= SYSTIMESTAMP - INTERVAL '7' DAY "
                    + "AND COLLECTED_AT < SYSTIMESTAMP - INTERVAL '1' HOUR AND TO_CHAR(COLLECTED_AT, 'HH24') = TO_CHAR(SYSTIMESTAMP, 'HH24')) BASE FROM DUAL", inst, inst);
            Double c = cpu == null ? null : Values.toDouble(cpu.get("CUR"));
            Double b = cpu == null ? null : Values.toDouble(cpu.get("BASE"));
            if (c != null && b != null && b > 0) {
                cpuRatio = c / b;
            }
            snapshot.put("instanceCpu", cpu);
        } catch (Exception ignore) {
            // 监控表不可用：按 NaN 处理
        }

        // 5) 同实例并发波动
        int concurrent = (int) db.count("SELECT COUNT(DISTINCT ASSET_ID) FROM DI_SQL_ANOMALY WHERE INSTANCE_ID=? AND STATUS='OPEN' AND SCOPE='SQL' "
                + "AND ANOMALY_TYPE='SUSTAINED' AND NVL(ASSET_ID, -1) <> ?", inst, asset == null ? -1 : asset);
        snapshot.put("concurrentAnomalies", concurrent);

        // 6) 静态问题（AST）
        if (asset != null) {
            Map<String, Object> a = db.one("SELECT STATIC_RESULT, STATIC_RISK, DBMS_LOB.SUBSTR(SAMPLE_SQL, 2000, 1) AS SAMPLE FROM DI_SQL_ASSET WHERE ASSET_ID=?", asset);
            if (a != null) {
                snapshot.put("staticResult", Json.any(Values.str(a.get("STATIC_RESULT"))));
                snapshot.put("sql", a.get("SAMPLE"));
            }
        }

        CauseClassifier.Evidence evd = new CauseClassifier.Evidence(ratios, planSupported, newPlan, newPlanDetail, !locks.isEmpty(),
                locks.isEmpty() ? null : Values.str(locks.get(0).get("DETAIL")), cpuRatio, Double.NaN, concurrent, instanceScope, changes);
        List<CauseClassifier.Cause> causes = CauseClassifier.classify(evd);
        List<String> codes = causes.stream().map(CauseClassifier.Cause::code).toList();
        List<Map<String, Object>> suggestions = new ArrayList<>();
        String report = report(ev, causes, changes, planSupported);
        for (CauseClassifier.Cause c : causes) {
            suggestions.add(Map.of("cause", c.code(), "title", c.title(), "items", c.suggestions()));
        }
        Map<String, Object> evidenceJson = new LinkedHashMap<>();
        evidenceJson.put("ratios", ratios.entrySet().stream().collect(LinkedHashMap::new,
                (m, e) -> m.put(e.getKey().key, Values.round(e.getValue(), 2)), Map::putAll));
        evidenceJson.put("planSupported", planSupported);
        evidenceJson.put("newPlan", newPlanDetail);
        evidenceJson.put("currentPlan", curPlan);
        evidenceJson.put("previousPlan", prevPlan);
        evidenceJson.put("lockWait", !locks.isEmpty());
        evidenceJson.put("instanceCpuRatio", Double.isNaN(cpuRatio) ? null : Values.round(cpuRatio, 2));
        evidenceJson.put("changes", changes);
        evidenceJson.put("concurrentAnomalies", concurrent);
        evidenceJson.put("causes", causes);

        Long id = db.insertReturningId("INSERT INTO DI_SQL_ANOMALY_DIAGNOSIS (ANOMALY_ID, PRIMARY_CAUSE, CAUSES, EVIDENCE, SNAPSHOT, SUGGESTIONS, REPORT_TEXT, STATUS) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, 'DONE')", "DIAG_ID", anomalyId, codes.get(0), Values.truncate(String.join(",", codes), 512),
                Json.write(evidenceJson), Json.write(snapshot), Json.write(suggestions), report);
        db.update("UPDATE DI_SQL_ANOMALY SET DIAGNOSED=1 WHERE ANOMALY_ID=?", anomalyId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("diagId", id);
        out.put("primaryCause", codes.get(0));
        out.put("causes", causes);
        out.put("snapshot", snapshot);
        out.put("report", report);
        return out;
    }

    private String dominantPlan(long inst, long asset, String timeCond) {
        Map<String, Object> r = db.one("SELECT PLAN_HASH FROM (SELECT PLAN_HASH, SUM(D_EXEC) E FROM DI_SQL_STATS_MIN WHERE INSTANCE_ID=? AND ASSET_ID=? AND "
                + timeCond + " GROUP BY PLAN_HASH ORDER BY E DESC NULLS LAST) WHERE ROWNUM = 1", inst, asset);
        return r == null ? null : Values.str(r.get("PLAN_HASH"));
    }

    static Map<Metric, Double> currentMetrics(Map<String, Object> r) {
        Map<Metric, Double> m = new EnumMap<>(Metric.class);
        if (r == null) {
            return m;
        }
        Double e = Values.toDouble(r.get("E"));
        if (e == null || e <= 0) {
            return m;
        }
        put(m, Metric.AVG_ELAPSED_MS, div(r.get("EL"), e));
        put(m, Metric.CPU_PER_EXEC_MS, div(r.get("C"), e));
        put(m, Metric.LOGICAL_READS_PER_EXEC, div(r.get("LR"), e));
        put(m, Metric.PHYSICAL_READS_PER_EXEC, div(r.get("PR"), e));
        put(m, Metric.ROWS_EXAMINED_PER_EXEC, div(r.get("RX"), e));
        Double rr = Values.toDouble(r.get("RR"));
        Double rx = Values.toDouble(r.get("RX"));
        if (rr != null && rx != null) {
            put(m, Metric.SCAN_RATIO, rx / Math.max(1, rr));
        }
        Double mi = Values.toDouble(r.get("MI"));
        if (mi != null && mi > 0) {
            put(m, Metric.EXEC_PER_MIN, e / mi);
        }
        put(m, Metric.DB_TIME_SHARE, Values.toDouble(r.get("SH")));
        put(m, Metric.ERROR_RATE, div(r.get("ER"), e));
        return m;
    }

    private static Double div(Object a, double b) {
        Double v = Values.toDouble(a);
        return v == null ? null : v / b;
    }

    private static void put(Map<Metric, Double> m, Metric k, Double v) {
        if (v != null && !v.isNaN() && !v.isInfinite()) {
            m.put(k, v);
        }
    }

    public List<Map<String, Object>> list(long anomalyId) {
        List<Map<String, Object>> rows = db.query("SELECT * FROM DI_SQL_ANOMALY_DIAGNOSIS WHERE ANOMALY_ID=? ORDER BY CREATED_AT DESC", anomalyId);
        for (Map<String, Object> r : rows) {
            for (String k : List.of("EVIDENCE", "SNAPSHOT", "SUGGESTIONS")) {
                r.put(k, Json.any(Values.str(r.get(k))));
            }
        }
        return rows;
    }

    /**
     * 方案 6.3 的输出格式：
     * 异常：avg_elapsed_ms 从 100ms 升至 5000ms，幅度 50 倍，持续 18 分钟
     * 可能原因：PLAN_REGRESSION
     * 证据：1. … 2. …
     * 建议：1. … 2. …
     */
    static String report(Map<String, Object> ev, List<CauseClassifier.Cause> causes, List<String> changes, boolean planSupported) {
        StringBuilder sb = new StringBuilder();
        String metric = Values.str(ev.get("METRIC"), "");
        if ("INSTANCE".equals(ev.get("SCOPE"))) {
            sb.append("异常：实例级，").append(Values.str(ev.get("DETAIL"), ""));
        } else {
            Double b = Values.toDouble(ev.get("BASELINE_VALUE"));
            Double c = Values.toDouble(ev.get("CURRENT_VALUE"));
            Double r = Values.toDouble(ev.get("RATIO"));
            sb.append("异常：").append(metric).append(" 从 ").append(fmt(b, metric)).append(" ").append("DOWN".equals(ev.get("DIRECTION")) ? "降至 " : "升至 ")
                    .append(fmt(c, metric));
            if (r != null) {
                sb.append("，幅度 ").append(String.format("%.1f", r)).append(" 倍");
            }
        }
        if (ev.get("START_TIME") instanceof Timestamp st) {
            Timestamp last = ev.get("LAST_TIME") instanceof Timestamp lt ? lt : new Timestamp(System.currentTimeMillis());
            sb.append("，持续 ").append(Math.max(1, (last.getTime() - st.getTime()) / 60000 + 1)).append(" 分钟");
        }
        sb.append("\n可能原因：").append(String.join("、", causes.stream().map(CauseClassifier.Cause::code).toList())).append("\n证据：\n");
        int i = 1;
        for (CauseClassifier.Cause c : causes) {
            for (String e : c.evidence()) {
                sb.append(i++).append(". ").append(e).append("\n");
            }
        }
        if (!planSupported) {
            sb.append(i++).append(". 该库统计视图无计划标识，未判断计划变化\n");
        }
        for (String ch : changes) {
            sb.append(i++).append(". 同时段变更：").append(ch).append("\n");
        }
        sb.append("建议：\n");
        int j = 1;
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (CauseClassifier.Cause c : causes) {
            seen.addAll(c.suggestions());
        }
        seen.add("任何优化动作须在测试环境验证并经人工确认后执行");
        for (String s2 : seen) {
            sb.append(j++).append(". ").append(s2).append("\n");
        }
        return sb.toString();
    }

    static String fmt(Double v, String metric) {
        if (v == null) {
            return "-";
        }
        String unit = metric.endsWith("_ms") ? "ms" : metric.endsWith("share") || metric.endsWith("rate") ? "" : "";
        if (metric.endsWith("share") || metric.endsWith("rate")) {
            return String.format("%.1f%%", v * 100);
        }
        return (Math.abs(v) >= 100 ? String.format("%.0f", v) : String.format("%.2f", v)) + unit;
    }

    static String hhmm(Object t) {
        if (t instanceof Timestamp ts) {
            return new java.text.SimpleDateFormat("MM-dd HH:mm").format(ts);
        }
        return String.valueOf(t);
    }

    static Timestamp now() {
        return new Timestamp(System.currentTimeMillis());
    }
}
