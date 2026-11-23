package com.dbops.monitor;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class CounterTrackerTest {

    @Test
    void deltaAndRate() {
        CounterTracker t = new CounterTracker();
        CounterTracker.Delta d0 = t.observe(1, "batch", 1000.0, 0);
        assertNull(d0.delta());
        CounterTracker.Delta d1 = t.observe(1, "batch", 1900.0, 90_000);
        assertEquals(900.0, d1.delta());
        assertEquals(10.0, d1.ratePerSec());
        // 计数器重置（实例重启）
        assertNull(t.observe(1, "batch", 5.0, 180_000).delta());
        // 间隔过短：沿用上次结果
        t.observe(2, "q", 10.0, 0);
        t.observe(2, "q", 20.0, 10_000);
        assertEquals(1.0, t.observe(2, "q", 30.0, 10_100).ratePerSec());
    }

    @Test
    void seed() {
        CounterTracker t = new CounterTracker();
        t.seedIfAbsent(3, "slow", 100.0, 0);
        assertEquals(5.0, t.observe(3, "slow", 105.0, 60_000).delta());
    }
}
