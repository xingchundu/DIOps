package com.dbops.sqlinsight.rules;

import com.dbops.common.Values;
import com.dbops.sqlinsight.collect.ActiveSession;
import com.dbops.sqlinsight.collect.Counter;
import com.dbops.sqlinsight.collect.Metric;
import com.dbops.sqlinsight.collect.WindowRow;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * 运行态规则 P-001 ~ P-013（设计方案第 4 节）。纯函数，依赖通过 {@link Ctx} 注入，便于单测。
 * <p>
 * 依赖的指标不受支持时输出 SKIPPED（带原因），不会把“不支持”当作“没问题”。
 */
public final class RuntimeRuleEngine {

    public record Hit(String code, String severity, long assetId, double value, double threshold, String detail,
                      Map<String, Object> evidence) {
    }

    public record Skip(String code, String reason) {
    }

    public record Result(List<Hit> hits, List<Skip> skipped, List<String> evaluatedCodes) {
    }

    /**
     * @param rule         (规则编码, 资产ID) → 生效配置
     * @param supports     计数器是否受支持
     * @param prevShares   资产此前窗口的 DB_TIME_SHARE（新→旧，不含本窗口）
     * @param prevTmpDisk  资产此前窗口的 D_TMP_DISK（新→旧，不含本窗口）
     * @param nativeCount  资产在本实例的原生 SQL ID 数
     */
    public record Ctx(BiFunction<String, Long, RuleConfigService.RuleSetting> rule, Predicate<Counter> supports,
                      Function<Long, List<Double>> prevShares, Function<Long, List<Double>> prevTmpDisk,
                      Function<Long, Long> nativeCount) {
    }

    public static final List<String> WINDOW_RULES = List.of("P-003", "P-004", "P-005", "P-006", "P-007", "P-008", "P-009", "P-011", "P-012", "P-013");
    public static final List<String> SESSION_RULES = List.of("P-001", "P-002", "P-010");

    private RuntimeRuleEngine() {
    }

    public static Result evaluateWindow(List<WindowRow> rows, Ctx ctx) {
        List<Hit> hits = new ArrayList<>();
        Map<String, Skip> skipped = new LinkedHashMap<>();
        List<String> evaluated = new ArrayList<>();
        // 能力判断（实例级，一条规则一个 SKIPPED）
        Map<String, String> unsupported = new LinkedHashMap<>();
        need(unsupported, ctx, "P-003", Counter.ELAPSED_MS);
        need(unsupported, ctx, "P-004", Counter.CPU_MS);
        need(unsupported, ctx, "P-005", Counter.LOGICAL_READS);
        need(unsupported, ctx, "P-007", Counter.ELAPSED_MS);
        need(unsupported, ctx, "P-008", Counter.ROWS_EXAMINED, Counter.ROWS_RETURNED);
        need(unsupported, ctx, "P-011", Counter.ERRORS);
        need(unsupported, ctx, "P-012", Counter.TMP_DISK);
        if (!ctx.supports().test(Counter.NO_INDEX) && !ctx.supports().test(Counter.LOGICAL_READS)
                && !ctx.supports().test(Counter.ROWS_EXAMINED)) {
            unsupported.put("P-009", "源库不提供无索引标记、扫描行数或逻辑读");
        }
        for (String code : WINDOW_RULES) {
            if (!ctx.rule().apply(code, null).enabled()) {
                continue;
            }
            if (unsupported.containsKey(code)) {
                skipped.put(code, new Skip(code, unsupported.get(code)));
            } else {
                evaluated.add(code);
            }
        }
        for (WindowRow r : rows) {
            long a = r.assetId;
            double exec = r.d(Counter.EXEC);
            for (String code : evaluated) {
                RuleConfigService.RuleSetting s = ctx.rule().apply(code, a);
                if (!s.enabled()) {
                    continue;
                }
                String sev = s.severity() == null ? "WARNING" : s.severity();
                switch (code) {
                    case "P-003" -> threshold(hits, s, sev, r, Metric.AVG_ELAPSED_MS, "avgElapsedMs", 3000, exec,
                            "窗口平均耗时 %.0f ms ≥ %.0f ms");
                    case "P-004" -> threshold(hits, s, sev, r, Metric.CPU_PER_EXEC_MS, "cpuPerExecMs", 2000, exec,
                            "单次 CPU %.0f ms ≥ %.0f ms");
                    case "P-005" -> threshold(hits, s, sev, r, Metric.LOGICAL_READS_PER_EXEC, "logicalReadsPerExec", 100000, exec,
                            "单次逻辑读 %.0f ≥ %.0f");
                    case "P-006" -> {
                        Double v = r.m(Metric.EXEC_PER_MIN);
                        double th = s.p("execPerMin", 10000);
                        if (v != null && v >= th) {
                            hits.add(new Hit(code, sev, a, v, th, String.format("每分钟执行 %.0f 次 ≥ %.0f", v, th), ev(r)));
                        }
                    }
                    case "P-007" -> {
                        Double v = r.m(Metric.DB_TIME_SHARE);
                        double th = s.p("dbTimeShare", 0.2);
                        int need = (int) s.p("consecutive", 3);
                        if (v != null && v >= th && consecutive(ctx.prevShares().apply(a), th, need - 1)) {
                            hits.add(new Hit(code, sev, a, v, th, String.format("DB Time 占比 %.1f%% ≥ %.0f%%，连续 %d 个窗口", v * 100, th * 100, need), ev(r)));
                        }
                    }
                    case "P-008" -> {
                        Double ratio = r.m(Metric.SCAN_RATIO);
                        Double rows1 = r.m(Metric.ROWS_EXAMINED_PER_EXEC);
                        double thR = s.p("scanRatio", 1000);
                        double thRows = s.p("rowsExaminedPerExec", 10000);
                        if (ratio != null && rows1 != null && ratio >= thR && rows1 >= thRows) {
                            hits.add(new Hit(code, sev, a, ratio, thR, String.format("扫描/返回比 %.0f ≥ %.0f，单次扫描 %.0f 行", ratio, thR, rows1), ev(r)));
                        }
                    }
                    case "P-009" -> noIndex(hits, s, sev, r, ctx);
                    case "P-011" -> {
                        Double rate = r.m(Metric.ERROR_RATE);
                        double errs = r.d(Counter.ERRORS);
                        double th = s.p("errorRate", 0.05);
                        double minErr = s.p("minErrors", 5);
                        if (rate != null && rate >= th && errs >= minErr) {
                            hits.add(new Hit(code, sev, a, rate, th, String.format("错误率 %.1f%%（%.0f 次）≥ %.0f%%", rate * 100, errs, th * 100), ev(r)));
                        }
                    }
                    case "P-012" -> {
                        double tmp = r.d(Counter.TMP_DISK);
                        int need = (int) s.p("consecutive", 2);
                        if (tmp > 0 && consecutive(ctx.prevTmpDisk().apply(a), 1e-9, need - 1)) {
                            hits.add(new Hit(code, sev, a, tmp, 0, String.format("连续 %d 个窗口产生磁盘临时表/临时写（本窗口 %.0f）", need, tmp), ev(r)));
                        }
                    }
                    case "P-013" -> {
                        Long n = ctx.nativeCount().apply(a);
                        double th = s.p("nativeIds", 100);
                        if (n != null && n >= th) {
                            hits.add(new Hit(code, sev, a, n, th, String.format("同一规范化 SQL 对应 %d 个原生 SQL ID（未使用绑定变量）", n), ev(r)));
                        }
                    }
                    default -> {
                    }
                }
            }
        }
        return new Result(hits, new ArrayList<>(skipped.values()), evaluated);
    }

    private static void need(Map<String, String> out, Ctx ctx, String code, Counter... counters) {
        for (Counter c : counters) {
            if (!ctx.supports().test(c)) {
                out.put(code, "源库不提供 " + c.capability() + " 统计");
                return;
            }
        }
    }

    private static void threshold(List<Hit> hits, RuleConfigService.RuleSetting s, String sev, WindowRow r, Metric m, String key,
                                  double def, double exec, String fmt) {
        Double v = r.m(m);
        double th = s.p(key, def);
        if (v != null && v >= th && exec >= s.p("minExec", 1)) {
            hits.add(new Hit(s.code(), sev, r.assetId, v, th, String.format(fmt, v, th), ev(r)));
        }
    }

    private static void noIndex(List<Hit> hits, RuleConfigService.RuleSetting s, String sev, WindowRow r, Ctx ctx) {
        double th = s.p("rowsPerExec", 10000);
        double noIdx = r.d(Counter.NO_INDEX);
        Double rowsPer = r.m(Metric.ROWS_EXAMINED_PER_EXEC);
        if (ctx.supports().test(Counter.NO_INDEX)) {
            if (noIdx > 0 && rowsPer != null && rowsPer >= th) {
                hits.add(new Hit("P-009", sev, r.assetId, rowsPer, th, String.format("未使用索引执行 %.0f 次，单次扫描 %.0f 行", noIdx, rowsPer), ev(r)));
            }
            return;
        }
        // 无“无索引标记”的库（Oracle/PG/达梦/SQLServer）：以单次扫描行数或单次逻辑读近似
        Double lr = r.m(Metric.LOGICAL_READS_PER_EXEC);
        Double v = rowsPer != null ? rowsPer : lr;
        if (v != null && v >= th) {
            hits.add(new Hit("P-009", sev, r.assetId, v, th, String.format("疑似未走索引：单次%s %.0f ≥ %.0f（近似判断，以执行计划为准）",
                    rowsPer != null ? "扫描行数" : "逻辑读", v, th), ev(r)));
        }
    }

    /** prev（新→旧）的前 n 个都 ≥ th */
    static boolean consecutive(List<Double> prev, double th, int n) {
        if (n <= 0) {
            return true;
        }
        if (prev == null || prev.size() < n) {
            return false;
        }
        for (int i = 0; i < n; i++) {
            Double v = prev.get(i);
            if (v == null || v.isNaN() || v < th) {
                return false;
            }
        }
        return true;
    }

    private static Map<String, Object> ev(WindowRow r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("planHash", r.cur.planHash());
        m.put("nativeId", r.cur.nativeId());
        m.put("exec", r.d(Counter.EXEC));
        for (Map.Entry<Metric, Double> e : r.metrics.entrySet()) {
            m.put(e.getKey().key, Values.round(e.getValue(), 4));
        }
        return m;
    }

    // ------------------------------------------------------------------ 活动会话规则

    /** 会话命中：key 用于“连续 N 次采样”判断（同一会话同一 SQL） */
    public record SessionHit(String code, String severity, long assetId, String sessionKey, double value, double threshold,
                             String detail, Map<String, Object> evidence) {
    }

    /**
     * @param assetOf     会话 → 资产 ID（无法识别 SQL 时返回 0）
     * @param consecutive (规则编码|会话键) → 本次之前已连续命中的次数（调用方维护）
     */
    public static List<SessionHit> evaluateSessions(List<ActiveSession> sessions, Function<ActiveSession, Long> assetOf,
                                                    BiFunction<String, Long, RuleConfigService.RuleSetting> rule,
                                                    Function<String, Integer> consecutive) {
        List<SessionHit> out = new ArrayList<>();
        for (ActiveSession s : sessions) {
            long a = assetOf.apply(s);
            String sk = s.sessionId() + "|" + (s.nativeId() != null ? s.nativeId() : String.valueOf(a));
            Map<String, Object> ev = new LinkedHashMap<>();
            ev.put("session", s.sessionId());
            ev.put("runSec", Values.round(s.runSec(), 1));
            ev.put("waitEvent", s.waitEvent());
            ev.put("waitSec", Values.round(s.waitSec(), 1));
            ev.put("blocker", s.blockingSession());
            ev.put("sql", Values.truncate(s.sqlText(), 300));
            // P-002 先判，命中 P-002 不再报 P-001
            boolean longHit = false;
            RuleConfigService.RuleSetting p2 = rule.apply("P-002", a);
            if (p2.enabled()) {
                double th = p2.p("runSec", 10);
                int need = (int) p2.p("consecutive", 2);
                if (s.runSec() >= th && consecutive.apply("P-002|" + sk) + 1 >= need) {
                    out.add(new SessionHit("P-002", sevOr(p2, "CRITICAL"), a, sk, s.runSec(), th,
                            String.format("会话 %s 运行 %.0f 秒 ≥ %.0f 秒", s.sessionId(), s.runSec(), th), ev));
                    longHit = true;
                } else if (s.runSec() >= th) {
                    out.add(new SessionHit("P-002", null, a, sk, s.runSec(), th, null, ev));   // 计数用，不落问题
                }
            }
            RuleConfigService.RuleSetting p1 = rule.apply("P-001", a);
            if (p1.enabled() && !longHit) {
                double th = p1.p("runSec", 3);
                int need = (int) p1.p("consecutive", 2);
                if (s.runSec() >= th) {
                    boolean ok = consecutive.apply("P-001|" + sk) + 1 >= need;
                    out.add(new SessionHit("P-001", ok ? sevOr(p1, "WARNING") : null, a, sk, s.runSec(), th,
                            ok ? String.format("会话 %s 运行 %.0f 秒 ≥ %.0f 秒", s.sessionId(), s.runSec(), th) : null, ev));
                }
            }
            RuleConfigService.RuleSetting p10 = rule.apply("P-010", a);
            if (p10.enabled() && s.lockWait()) {
                double th = p10.p("waitSec", 10);
                if (s.waitSec() >= th || s.blockingSession() != null && s.runSec() >= th) {
                    out.add(new SessionHit("P-010", sevOr(p10, "CRITICAL"), a, sk, Math.max(s.waitSec(), s.runSec()), th,
                            String.format("会话 %s 锁等待 %.0f 秒%s", s.sessionId(), Math.max(s.waitSec(), s.runSec()),
                                    s.blockingSession() != null ? "，阻塞者 " + s.blockingSession() : ""), ev));
                }
            }
        }
        return out;
    }

    private static String sevOr(RuleConfigService.RuleSetting s, String def) {
        return s.severity() == null ? def : s.severity();
    }
}
