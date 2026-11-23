package com.dbops.sqlinsight.anomaly;

import com.dbops.sqlinsight.baseline.Baseline;
import com.dbops.sqlinsight.collect.Metric;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AnomalyDetectorTest {

    static final AnomalyDetector.Params P = AnomalyDetector.Params.DEFAULTS;
    static final AnomalyDetector.Spec ELAPSED = AnomalyDetector.SPECS.get(0);

    static AnomalyDetector.Spec spec(Metric m, AnomalyDetector.Direction d) {
        return AnomalyDetector.SPECS.stream().filter(s -> s.metric() == m && s.direction() == d).findFirst().orElseThrow();
    }

    @Test
    void allFiveChecksMustPass() {
        Baseline b = new Baseline(100, 10, 200, "WD-9");
        assertTrue(AnomalyDetector.check(ELAPSED, 400.0, b, 50, true, P).hit());
        // 1 样本不足
        assertFalse(AnomalyDetector.check(ELAPSED, 400.0, new Baseline(100, 10, 10, "WD-9"), 50, true, P).hit());
        // 2 倍率不足
        assertEquals("倍率不足", AnomalyDetector.check(ELAPSED, 180.0, b, 50, true, P).reason());
        // 4 绝对变化量不足：2ms → 6ms
        assertFalse(AnomalyDetector.check(ELAPSED, 6.0, new Baseline(2, 0.5, 200, "R24"), 50, true, P).hit());
        assertEquals("绝对变化量不足", AnomalyDetector.check(ELAPSED, 60.0, new Baseline(12, 0.5, 200, "R24"), 50, true, P).reason());
        // 5 执行次数不足 / 数据质量
        assertFalse(AnomalyDetector.check(ELAPSED, 400.0, b, 2, true, P).hit());
        assertFalse(AnomalyDetector.check(ELAPSED, 400.0, b, 50, false, P).hit());
    }

    @Test
    void zScoreGuardsNoisySql() {
        // 基线波动大（MAD 很大）时 2.5 倍也不算异常
        assertEquals("Z 分数不足", AnomalyDetector.check(ELAPSED, 250.0, new Baseline(100, 80, 200, "WD-9"), 50, true, P).reason());
    }

    @Test
    void zeroMadDoesNotExplode() {
        AnomalyDetector.Check c = AnomalyDetector.check(ELAPSED, 400.0, new Baseline(100, 0, 200, "WD-9"), 50, true, P);
        assertTrue(c.hit());
        assertTrue(Double.isFinite(c.z()));
    }

    @Test
    void execDropDirection() {
        AnomalyDetector.Spec down = spec(Metric.EXEC_PER_MIN, AnomalyDetector.Direction.DOWN);
        assertTrue(AnomalyDetector.check(down, 50.0, new Baseline(1000, 50, 200, "WD-9"), 50, true, P).hit());
        assertFalse(AnomalyDetector.check(down, 900.0, new Baseline(1000, 50, 200, "WD-9"), 900, true, P).hit());
        assertFalse(AnomalyDetector.bit(down) == AnomalyDetector.bit(spec(Metric.EXEC_PER_MIN, AnomalyDetector.Direction.UP)));
    }

    @Test
    void sustainedIsThreeOfFive() {
        int bit = AnomalyDetector.bit(ELAPSED);
        assertTrue(AnomalyDetector.sustained(List.of(bit, 0, bit, bit, 0), bit, P));
        assertFalse(AnomalyDetector.sustained(List.of(bit, 0, 0, bit, 0, bit), bit, P));
        assertFalse(AnomalyDetector.sustained(null, bit, P));
    }

    @Test
    void recoveryAndSeverity() {
        Baseline b = new Baseline(100, 10, 200, "WD-9");
        assertTrue(AnomalyDetector.stillElevated(ELAPSED, 160.0, b, P));
        assertFalse(AnomalyDetector.stillElevated(ELAPSED, 140.0, b, P));
        assertEquals("CRITICAL", AnomalyDetector.severity(6, 0.01));
        assertEquals("CRITICAL", AnomalyDetector.severity(2.5, 0.3));
        assertEquals("WARNING", AnomalyDetector.severity(2.5, 0.05));
    }

    @Test
    void zeroMedianRatioIsCappedNotInfinite() {
        AnomalyDetector.Check c = AnomalyDetector.check(ELAPSED, 400.0, new Baseline(0, 0, 200, "WD-9"), 50, true, P);
        assertTrue(Double.isFinite(c.ratio()));
        assertEquals(AnomalyDetector.RATIO_CAP, c.ratio());
    }
}
