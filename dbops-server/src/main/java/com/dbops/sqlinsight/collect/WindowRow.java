package com.dbops.sqlinsight.collect;

import java.util.EnumMap;
import java.util.Map;

/**
 * 一条 SQL 在一个采集窗口内的增量与窗口指标（对应 DI_SQL_STATS_MIN 一行）。
 * deltas 中 NaN 表示该计数器不支持；metrics 只包含可计算的指标。
 */
public final class WindowRow {
    public final SqlCounters cur;
    public final double[] deltas;
    public final double minutes;
    public final String quality;
    public final Map<Metric, Double> metrics = new EnumMap<>(Metric.class);
    public long assetId;
    public int anomalyFlags;
    public boolean excludeBaseline;

    public WindowRow(SqlCounters cur, double[] deltas, double minutes, String quality) {
        this.cur = cur;
        this.deltas = deltas;
        this.minutes = minutes;
        this.quality = quality;
    }

    public double d(Counter c) {
        return deltas[c.ordinal()];
    }

    public Double m(Metric m) {
        return metrics.get(m);
    }

    /** 计算 9 个窗口指标；DB_TIME_SHARE 需要实例总耗时，单独传入 */
    public void computeMetrics(double instanceElapsedMs) {
        double exec = d(Counter.EXEC);
        if (!(exec > 0)) {
            return;
        }
        put(Metric.AVG_ELAPSED_MS, d(Counter.ELAPSED_MS) / exec);
        put(Metric.CPU_PER_EXEC_MS, d(Counter.CPU_MS) / exec);
        put(Metric.LOGICAL_READS_PER_EXEC, d(Counter.LOGICAL_READS) / exec);
        put(Metric.PHYSICAL_READS_PER_EXEC, d(Counter.PHYSICAL_READS) / exec);
        put(Metric.ROWS_EXAMINED_PER_EXEC, d(Counter.ROWS_EXAMINED) / exec);
        double ret = d(Counter.ROWS_RETURNED);
        put(Metric.SCAN_RATIO, d(Counter.ROWS_EXAMINED) / Math.max(1, Double.isNaN(ret) ? Double.NaN : ret));
        put(Metric.EXEC_PER_MIN, exec / Math.max(minutes, 0.01));
        if (instanceElapsedMs > 0) {
            put(Metric.DB_TIME_SHARE, d(Counter.ELAPSED_MS) / instanceElapsedMs);
        }
        put(Metric.ERROR_RATE, d(Counter.ERRORS) / exec);
    }

    /**
     * 合并多行（同一资产的多个原生 ID / 多个执行计划）：增量相加后重算指标。
     * 返回行的 cur 取执行次数最多的那一行（用于展示计划/原生 ID）。
     */
    public static WindowRow merge(java.util.List<WindowRow> rows, double instanceElapsedMs) {
        if (rows.size() == 1) {
            return rows.get(0);
        }
        double[] d = new double[Counter.SIZE];
        java.util.Arrays.fill(d, 0);
        boolean[] nan = new boolean[Counter.SIZE];
        WindowRow top = rows.get(0);
        boolean partial = false;
        double minutes = 0;
        for (WindowRow r : rows) {
            for (Counter c : Counter.values()) {
                double v = r.d(c);
                if (Double.isNaN(v)) {
                    nan[c.ordinal()] = true;
                } else {
                    d[c.ordinal()] += v;
                }
            }
            if (r.d(Counter.EXEC) > top.d(Counter.EXEC)) {
                top = r;
            }
            partial |= !DeltaEngine.NORMAL.equals(r.quality);
            minutes = Math.max(minutes, r.minutes);
        }
        for (Counter c : Counter.values()) {
            if (nan[c.ordinal()]) {
                d[c.ordinal()] = Double.NaN;
            }
        }
        WindowRow m = new WindowRow(top.cur, d, minutes, partial ? DeltaEngine.PARTIAL : DeltaEngine.NORMAL);
        m.assetId = top.assetId;
        m.excludeBaseline = top.excludeBaseline;
        m.computeMetrics(instanceElapsedMs);
        return m;
    }

    private void put(Metric m, double v) {
        if (!Double.isNaN(v) && !Double.isInfinite(v)) {
            metrics.put(m, v);
        }
    }
}
