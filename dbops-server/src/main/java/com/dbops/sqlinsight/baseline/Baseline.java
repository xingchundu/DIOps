package com.dbops.sqlinsight.baseline;

/** 某资产某指标在当前时段的基线（中位数 + MAD）；slot 为 WD-9 / WE-14 / R24 */
public record Baseline(double median, double mad, long samples, String slot) {
}
