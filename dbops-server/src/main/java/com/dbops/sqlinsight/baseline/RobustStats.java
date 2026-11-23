package com.dbops.sqlinsight.baseline;

import java.util.Arrays;
import java.util.List;

/** 中位数 / MAD / 稳健 Z 分数（设计方案 5.2）。纯函数。 */
public final class RobustStats {

    /** MAD → 标准差的一致性系数（正态分布下） */
    public static final double MAD_K = 1.4826;

    private RobustStats() {
    }

    public static double median(double[] v) {
        double[] a = Arrays.stream(v).filter(x -> !Double.isNaN(x)).sorted().toArray();
        if (a.length == 0) {
            return Double.NaN;
        }
        int n = a.length;
        return n % 2 == 1 ? a[n / 2] : (a[n / 2 - 1] + a[n / 2]) / 2.0;
    }

    public static double median(List<Double> v) {
        return median(v.stream().mapToDouble(d -> d == null ? Double.NaN : d).toArray());
    }

    public static double mad(double[] v) {
        double m = median(v);
        if (Double.isNaN(m)) {
            return Double.NaN;
        }
        double[] dev = Arrays.stream(v).filter(x -> !Double.isNaN(x)).map(x -> Math.abs(x - m)).toArray();
        return median(dev);
    }

    /**
     * 稳健 Z：|x - median| / (1.4826 × MAD)。MAD 为 0（数据几乎恒定）时用 max(MAD, 中位数×floorRatio, absFloor) 兜底，
     * 避免任何微小波动都得到无穷大的 Z。
     */
    public static double robustZ(double x, double median, double mad, double floorRatio, double absFloor) {
        double scale = Math.max(Math.max(mad, Math.abs(median) * floorRatio), absFloor) * MAD_K;
        if (scale <= 0) {
            return x == median ? 0 : Double.POSITIVE_INFINITY;
        }
        return Math.abs(x - median) / scale;
    }
}
