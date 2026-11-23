package com.dbops.sqlinsight.baseline;

import com.dbops.sqlinsight.collect.Metric;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RobustStatsTest {

    @Test
    void medianAndMadIgnoreOutliers() {
        double[] v = {10, 11, 9, 10, 12, 10, 1000};
        assertEquals(10.0, RobustStats.median(v));
        assertEquals(1.0, RobustStats.mad(v));
        assertEquals(10.5, RobustStats.median(new double[]{10, 11}));
        assertTrue(Double.isNaN(RobustStats.median(new double[]{})));
    }

    @Test
    void robustZWithFloors() {
        assertEquals(10 / (2 * RobustStats.MAD_K), RobustStats.robustZ(20, 10, 2, 0, 0), 1e-9);
        // MAD=0 时用 5% 中位数兜底
        assertEquals(10 / (0.5 * RobustStats.MAD_K), RobustStats.robustZ(20, 10, 0, 0.05, 0), 1e-9);
    }

    @Test
    void slowDegradationNeedsThreeRisingDays() {
        List<Double> d = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            d.add(100.0);
        }
        d.addAll(List.of(110.0, 120.0, 130.0, 140.0, 160.0, 170.0, 180.0));
        BaselineService.Degradation g = BaselineService.detectDegradation(1, Metric.AVG_ELAPSED_MS, d, 1.5);
        assertNotNull(g);
        assertEquals(170.0, g.recent());
        // 最近一天回落到阈值以下 → 不算
        List<Double> d2 = new ArrayList<>(d.subList(0, d.size() - 1));
        d2.add(120.0);
        assertNull(BaselineService.detectDegradation(1, Metric.AVG_ELAPSED_MS, d2, 1.5));
        // 历史不足
        assertNull(BaselineService.detectDegradation(1, Metric.AVG_ELAPSED_MS, List.of(1.0, 2.0, 3.0), 1.5));
    }

    @Test
    void slotQueryShape() {
        String q = BaselineService.slotQuery(true);
        assertTrue(q.contains("PARTITION BY DT, HR"));
        assertTrue(q.contains("MEDIAN(ABS(AVG_ELAPSED_MS - MD0))"));
        assertTrue(BaselineService.slotQuery(false).contains("'R24' DT"));
    }
}
