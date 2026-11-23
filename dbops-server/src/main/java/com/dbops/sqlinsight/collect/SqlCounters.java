package com.dbops.sqlinsight.collect;

import java.util.Arrays;

/** 一条 SQL（原生标识 + 计划）在某个时刻的累计计数器快照；不支持/缺失的计数器为 NaN */
public record SqlCounters(String nativeId, String planHash, String schema, String sqlText, double[] values) {

    public SqlCounters {
        if (values == null || values.length != Counter.SIZE) {
            double[] v = new double[Counter.SIZE];
            Arrays.fill(v, Double.NaN);
            if (values != null) {
                System.arraycopy(values, 0, v, 0, Math.min(values.length, v.length));
            }
            values = v;
        }
        planHash = planHash == null || planHash.isBlank() ? "NA" : planHash;
    }

    public double get(Counter c) {
        return values[c.ordinal()];
    }

    public String key() {
        return nativeId + "#" + planHash;
    }

    public static double[] empty() {
        double[] v = new double[Counter.SIZE];
        Arrays.fill(v, Double.NaN);
        return v;
    }
}
