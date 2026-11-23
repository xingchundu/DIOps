package com.dbops.sqlinsight.collect;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DeltaEngineTest {

    static SqlCounters c(String id, double exec, double elapsed, double rowsEx) {
        double[] v = SqlCounters.empty();
        v[Counter.EXEC.ordinal()] = exec;
        v[Counter.ELAPSED_MS.ordinal()] = elapsed;
        v[Counter.ROWS_EXAMINED.ordinal()] = rowsEx;
        return new SqlCounters(id, "P1", "S", "select 1", v);
    }

    @Test
    void firstSnapshotIsBaselineThenNormal() {
        DeltaEngine d = new DeltaEngine();
        DeltaEngine.Result r1 = d.compute(1, List.of(c("a", 100, 1000, 500)), 0 + 1000, 60_000, true);
        assertEquals(1, r1.baseline());
        assertEquals(0, r1.rows().size());
        DeltaEngine.Result r2 = d.compute(1, List.of(c("a", 110, 1500, 600)), 61_000, 60_000, true);
        assertEquals(1, r2.rows().size());
        WindowRow w = r2.rows().get(0);
        assertEquals(DeltaEngine.NORMAL, w.quality);
        assertEquals(10.0, w.d(Counter.EXEC));
        assertEquals(50.0, w.m(Metric.AVG_ELAPSED_MS));
        assertEquals(10.0, w.m(Metric.ROWS_EXAMINED_PER_EXEC));
        assertEquals(1.0, w.m(Metric.DB_TIME_SHARE));
        assertEquals(10.0, w.m(Metric.EXEC_PER_MIN));
    }

    @Test
    void counterDecreaseIsReset() {
        DeltaEngine d = new DeltaEngine();
        d.compute(1, List.of(c("a", 100, 1000, 0)), 1000, 60_000, true);
        DeltaEngine.Result r = d.compute(1, List.of(c("a", 5, 20, 0)), 61_000, 60_000, true);
        assertEquals(1, r.reset());
        assertEquals(0, r.rows().size());
        // 下一窗口以重置后的值为起点恢复正常
        DeltaEngine.Result r3 = d.compute(1, List.of(c("a", 15, 120, 0)), 121_000, 60_000, true);
        assertEquals(1, r3.rows().size());
    }

    @Test
    void collectionGapIsDropped() {
        DeltaEngine d = new DeltaEngine();
        d.compute(1, List.of(c("a", 100, 1000, 0)), 1000, 60_000, true);
        DeltaEngine.Result r = d.compute(1, List.of(c("a", 200, 2000, 0)), 1000 + 5 * 60_000, 60_000, true);
        assertEquals(1, r.gap());
        assertEquals(0, r.rows().size());
    }

    @Test
    void idleSqlNotStoredAndPartialFlagged() {
        DeltaEngine d = new DeltaEngine();
        double[] v = SqlCounters.empty();
        v[Counter.EXEC.ordinal()] = 10;
        v[Counter.ELAPSED_MS.ordinal()] = 10;
        d.compute(1, List.of(c("a", 10, 10, 0), new SqlCounters("b", "P", "S", "x", v)), 1000, 60_000, true);
        double[] v2 = SqlCounters.empty();
        v2[Counter.EXEC.ordinal()] = 20;
        v2[Counter.ELAPSED_MS.ordinal()] = 30;
        v2[Counter.ROWS_EXAMINED.ordinal()] = 5;     // 上次缺值 → PARTIAL
        DeltaEngine.Result r = d.compute(1, List.of(c("a", 10, 10, 0), new SqlCounters("b", "P", "S", "x", v2)), 61_000, 60_000, true);
        assertEquals(1, r.idle());
        assertEquals(1, r.rows().size());
        assertEquals(DeltaEngine.PARTIAL, r.rows().get(0).quality);
    }

    @Test
    void mergeSumsDeltasAcrossPlans() {
        DeltaEngine d = new DeltaEngine();
        d.compute(1, List.of(c("a", 0, 0, 0), new SqlCounters("a", "P2", "S", "x", c("a", 0, 0, 0).values())), 1000, 60_000, true);
        DeltaEngine.Result r = d.compute(1, List.of(c("a", 10, 100, 0), new SqlCounters("a", "P2", "S", "x", c("a", 30, 900, 0).values())),
                61_000, 60_000, true);
        assertEquals(2, r.rows().size());
        WindowRow m = WindowRow.merge(r.rows(), 1000);
        assertEquals(40.0, m.d(Counter.EXEC));
        assertEquals(25.0, m.m(Metric.AVG_ELAPSED_MS));
        assertEquals("P2", m.cur.planHash());
        assertTrue(m.m(Metric.DB_TIME_SHARE) > 0.99);
    }

    @Test
    void perRowMinutesWhenSqlReappearsAfterAWhile() {
        // 按“最近活跃”过滤的视图：SQL a 30 分钟后才再次出现，增量是 30 分钟累计的，每分钟执行次数应按 30 分钟算
        DeltaEngine d = new DeltaEngine();
        long t0 = 1000;
        d.compute(1, List.of(c("a", 100, 1000, 0), c("b", 0, 0, 0)), t0, 60_000, true);
        for (int i = 1; i < 30; i++) {
            d.compute(1, List.of(c("b", i, i, 0)), t0 + i * 60_000L, 60_000, true);
        }
        DeltaEngine.Result r = d.compute(1, List.of(c("a", 400, 4000, 0), c("b", 30, 30, 0)), t0 + 30 * 60_000L, 60_000, true);
        WindowRow a = r.rows().stream().filter(w -> w.cur.key().startsWith("a")).findFirst().orElseThrow();
        assertEquals(10.0, a.m(Metric.EXEC_PER_MIN), 1e-9);
        assertEquals(DeltaEngine.PARTIAL, a.quality);   // 跨多个周期的平均值不进基线
    }
}
