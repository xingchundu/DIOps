package com.dbops.sqlinsight.rules;

import com.dbops.sqlinsight.collect.ActiveSession;
import com.dbops.sqlinsight.collect.Counter;
import com.dbops.sqlinsight.collect.SqlCounters;
import com.dbops.sqlinsight.collect.WindowRow;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RuntimeRuleEngineTest {

    static RuleConfigService.RuleSetting rule(String code, Map<String, Object> p) {
        return new RuleConfigService.RuleSetting(code, code, "RUNTIME", true, null, p);
    }

    static WindowRow row(long asset, double exec, double elapsed, double rowsEx, double rowsRet, double share) {
        double[] d = SqlCounters.empty();
        d[Counter.EXEC.ordinal()] = exec;
        d[Counter.ELAPSED_MS.ordinal()] = elapsed;
        d[Counter.ROWS_EXAMINED.ordinal()] = rowsEx;
        d[Counter.ROWS_RETURNED.ordinal()] = rowsRet;
        WindowRow r = new WindowRow(new SqlCounters("n" + asset, "P", "S", "x", SqlCounters.empty()), d, 1, "NORMAL");
        r.assetId = asset;
        r.computeMetrics(elapsed / share);
        return r;
    }

    static RuntimeRuleEngine.Ctx ctx(Set<Counter> supported, Map<String, Map<String, Object>> params, List<Double> prevShares) {
        return new RuntimeRuleEngine.Ctx((code, asset) -> rule(code, params.getOrDefault(code, Map.of())), supported::contains,
                a -> prevShares, a -> List.of(), a -> 1L);
    }

    @Test
    void slowSqlThresholdAndOverride() {
        Map<String, Map<String, Object>> p = new HashMap<>();
        p.put("P-003", Map.of("avgElapsedMs", 3000, "minExec", 1));
        RuntimeRuleEngine.Result r = RuntimeRuleEngine.evaluateWindow(List.of(row(1, 2, 8000, 0, 0, 0.1), row(2, 10, 1000, 0, 0, 0.1)),
                ctx(Set.of(Counter.EXEC, Counter.ELAPSED_MS), p, List.of()));
        assertEquals(1, r.hits().stream().filter(h -> h.code().equals("P-003")).count());
        assertEquals(1L, r.hits().get(0).assetId());
        // 批处理业务覆盖到 60 秒后不再命中
        p.put("P-003", Map.of("avgElapsedMs", 60000));
        RuntimeRuleEngine.Result r2 = RuntimeRuleEngine.evaluateWindow(List.of(row(1, 2, 8000, 0, 0, 0.1)),
                ctx(Set.of(Counter.EXEC, Counter.ELAPSED_MS), p, List.of()));
        assertFalse(r2.hits().stream().anyMatch(h -> h.code().equals("P-003")));
    }

    @Test
    void unsupportedMetricsAreSkippedNotPassed() {
        RuntimeRuleEngine.Result r = RuntimeRuleEngine.evaluateWindow(List.of(row(1, 2, 8000, 0, 0, 0.1)),
                ctx(Set.of(Counter.EXEC, Counter.ELAPSED_MS), Map.of(), List.of()));
        Set<String> skipped = Set.copyOf(r.skipped().stream().map(RuntimeRuleEngine.Skip::code).toList());
        assertTrue(skipped.contains("P-004"));   // CPU
        assertTrue(skipped.contains("P-008"));   // 扫描行数
        assertTrue(skipped.contains("P-011"));   // 错误数
        assertTrue(skipped.contains("P-009"));
        assertFalse(r.evaluatedCodes().contains("P-004"));
        assertTrue(r.evaluatedCodes().contains("P-003"));
    }

    @Test
    void dbTimeShareNeedsConsecutiveWindows() {
        Set<Counter> sup = Set.of(Counter.EXEC, Counter.ELAPSED_MS);
        RuntimeRuleEngine.Result once = RuntimeRuleEngine.evaluateWindow(List.of(row(1, 10, 100, 0, 0, 0.5)), ctx(sup, Map.of(), List.of(0.05, 0.5)));
        assertFalse(once.hits().stream().anyMatch(h -> h.code().equals("P-007")));
        RuntimeRuleEngine.Result three = RuntimeRuleEngine.evaluateWindow(List.of(row(1, 10, 100, 0, 0, 0.5)), ctx(sup, Map.of(), List.of(0.4, 0.3)));
        assertTrue(three.hits().stream().anyMatch(h -> h.code().equals("P-007")));
    }

    @Test
    void scanEfficiencyAndNoIndexApproximation() {
        Set<Counter> sup = Set.of(Counter.EXEC, Counter.ELAPSED_MS, Counter.ROWS_EXAMINED, Counter.ROWS_RETURNED);
        RuntimeRuleEngine.Result r = RuntimeRuleEngine.evaluateWindow(List.of(row(1, 10, 100, 2_000_000, 10, 0.1)), ctx(sup, Map.of(), List.of()));
        assertTrue(r.hits().stream().anyMatch(h -> h.code().equals("P-008")));
        assertTrue(r.hits().stream().anyMatch(h -> h.code().equals("P-009") && h.detail().contains("近似")));
    }

    @Test
    void sessionRulesRespectConsecutiveSamples() {
        ActiveSession s = new ActiveSession("12", "abc", "S", "select 1", 15, null, 0, false, null);
        Map<String, Integer> streak = new HashMap<>();
        List<RuntimeRuleEngine.SessionHit> first = RuntimeRuleEngine.evaluateSessions(List.of(s), x -> 5L,
                (c, a) -> rule(c, Map.of()), k -> streak.getOrDefault(k, 0));
        assertTrue(first.stream().noneMatch(h -> h.severity() != null));      // 第一次只计数
        for (RuntimeRuleEngine.SessionHit h : first) {
            streak.merge(h.code() + "|" + h.sessionKey(), 1, Integer::sum);
        }
        List<RuntimeRuleEngine.SessionHit> second = RuntimeRuleEngine.evaluateSessions(List.of(s), x -> 5L,
                (c, a) -> rule(c, Map.of()), k -> streak.getOrDefault(k, 0));
        assertTrue(second.stream().anyMatch(h -> h.code().equals("P-002") && "CRITICAL".equals(h.severity())));
        assertFalse(second.stream().anyMatch(h -> h.code().equals("P-001")));   // 命中 P-002 不再报 P-001
        ActiveSession lock = new ActiveSession("13", "def", "S", "update t", 30, "enq: TX - row lock contention", 25, true, "99");
        List<RuntimeRuleEngine.SessionHit> l = RuntimeRuleEngine.evaluateSessions(List.of(lock), x -> 6L, (c, a) -> rule(c, Map.of()), k -> 0);
        assertTrue(l.stream().anyMatch(h -> h.code().equals("P-010") && h.detail().contains("99")));
    }
}
