package com.dbops.sqlinsight.diagnosis;

import com.dbops.sqlinsight.collect.Metric;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 设计方案 6.2 原因分类表 */
class CauseClassifierTest {

    static final double NA = Double.NaN;

    static CauseClassifier.Evidence ev(Map<Metric, Double> r, boolean planSupported, boolean newPlan, boolean lock, double cpu, double io,
                                       int concurrent, boolean inst) {
        return new CauseClassifier.Evidence(r, planSupported, newPlan, newPlan ? "14:02 出现新 plan_hash 1234，异常窗口中占比 96%" : null,
                lock, lock ? "会话 101 被 88 阻塞 30 秒" : null, cpu, io, concurrent, inst, List.of("发布：v2.3（14:00）"));
    }

    static List<String> codes(CauseClassifier.Evidence e) {
        return CauseClassifier.classify(e).stream().map(CauseClassifier.Cause::code).toList();
    }

    @Test
    void planRegressionFirstAndReleaseIsEvidenceNotCause() {
        List<CauseClassifier.Cause> c = CauseClassifier.classify(ev(Map.of(Metric.AVG_ELAPSED_MS, 50.0, Metric.LOGICAL_READS_PER_EXEC, 6.0),
                true, true, false, NA, NA, 0, false));
        assertEquals("PLAN_REGRESSION", c.get(0).code());
        assertTrue(c.get(0).evidence().get(0).contains("plan_hash 1234"));
        assertFalse(c.stream().anyMatch(x -> x.code().contains("RELEASE")));
    }

    @Test
    void noPlanRegressionWhenPlanNotSupported() {
        List<String> c = codes(ev(Map.of(Metric.AVG_ELAPSED_MS, 5.0, Metric.LOGICAL_READS_PER_EXEC, 6.0), false, true, false, NA, NA, 0, false));
        assertFalse(c.contains("PLAN_REGRESSION"));
    }

    @Test
    void lockWaitNeedsStableCpuAndReads() {
        assertEquals("LOCK_WAIT", codes(ev(Map.of(Metric.AVG_ELAPSED_MS, 5.0, Metric.LOGICAL_READS_PER_EXEC, 1.0, Metric.CPU_PER_EXEC_MS, 1.1),
                true, false, true, NA, NA, 0, false)).get(0));
        // CPU 未采集（NaN）不算“稳定”，不下锁等待结论
        assertFalse(codes(ev(Map.of(Metric.AVG_ELAPSED_MS, 5.0, Metric.LOGICAL_READS_PER_EXEC, 1.0), true, false, true, NA, NA, 0, false))
                .contains("LOCK_WAIT"));
    }

    @Test
    void thresholdsAreOneFiveAndOneTwo() {
        assertEquals("DATA_GROWTH_OR_SKEW", codes(ev(Map.of(Metric.ROWS_EXAMINED_PER_EXEC, 1.5), true, false, false, NA, NA, 0, false)).get(0));
        assertEquals("UNKNOWN", codes(ev(Map.of(Metric.ROWS_EXAMINED_PER_EXEC, 1.49), true, false, false, NA, NA, 0, false)).get(0));
        assertEquals("TRAFFIC_SURGE", codes(ev(Map.of(Metric.AVG_ELAPSED_MS, 1.19, Metric.EXEC_PER_MIN, 3.0), true, false, false, NA, NA, 0, false)).get(0));
        assertFalse(codes(ev(Map.of(Metric.AVG_ELAPSED_MS, 1.2, Metric.EXEC_PER_MIN, 3.0), true, false, false, NA, NA, 0, false)).contains("TRAFFIC_SURGE"));
    }

    @Test
    void cacheResourceErrorAndUnknown() {
        assertEquals("CACHE_OR_IO", codes(ev(Map.of(Metric.PHYSICAL_READS_PER_EXEC, 4.0, Metric.LOGICAL_READS_PER_EXEC, 1.0),
                true, false, false, NA, NA, 0, false)).get(0));
        assertEquals("CACHE_OR_IO", codes(ev(Map.of(), true, false, false, NA, 2.0, 0, false)).get(0));
        assertEquals("RESOURCE_CONTENTION", codes(ev(Map.of(Metric.LOGICAL_READS_PER_EXEC, 1.0), true, false, false, 1.8, NA, 3, false)).get(0));
        assertEquals("RESOURCE_CONTENTION", codes(ev(Map.of(), true, false, false, 2.0, NA, 8, true)).get(0));
        assertEquals("ERROR_SURGE", codes(ev(Map.of(Metric.ERROR_RATE, 10.0), true, false, false, NA, NA, 0, false)).get(0));
        assertEquals(List.of("UNKNOWN"), codes(ev(Map.of(), true, false, false, NA, NA, 0, false)));
    }

    @Test
    void multipleCausesInPriorityOrder() {
        List<String> c = codes(ev(Map.of(Metric.AVG_ELAPSED_MS, 3.0, Metric.LOGICAL_READS_PER_EXEC, 3.0, Metric.ERROR_RATE, 2.0),
                true, true, false, NA, NA, 0, false));
        assertEquals(List.of("PLAN_REGRESSION", "ERROR_SURGE"), c);
    }
}
