package com.dbops.sqlinsight.collect;

import java.util.List;

/**
 * 9 个窗口指标（设计方案 3.3）。column 为 DI_SQL_STATS_MIN 列名；needs 为依赖的计数器，任何一个不支持则该指标不支持。
 */
public enum Metric {
    AVG_ELAPSED_MS("avg_elapsed_ms", "AVG_ELAPSED_MS", "平均耗时(ms)", List.of(Counter.ELAPSED_MS)),
    CPU_PER_EXEC_MS("cpu_per_exec_ms", "CPU_PER_EXEC_MS", "单次CPU(ms)", List.of(Counter.CPU_MS)),
    LOGICAL_READS_PER_EXEC("logical_reads_per_exec", "LOGICAL_READS_PER_EXEC", "单次逻辑读", List.of(Counter.LOGICAL_READS)),
    PHYSICAL_READS_PER_EXEC("physical_reads_per_exec", "PHYSICAL_READS_PER_EXEC", "单次物理读", List.of(Counter.PHYSICAL_READS)),
    ROWS_EXAMINED_PER_EXEC("rows_examined_per_exec", "ROWS_EXAMINED_PER_EXEC", "单次扫描行数", List.of(Counter.ROWS_EXAMINED)),
    SCAN_RATIO("scan_ratio", "SCAN_RATIO", "扫描/返回比", List.of(Counter.ROWS_EXAMINED, Counter.ROWS_RETURNED)),
    EXEC_PER_MIN("exec_per_min", "EXEC_PER_MIN", "每分钟执行次数", List.of(Counter.EXEC)),
    DB_TIME_SHARE("db_time_share", "DB_TIME_SHARE", "DB Time 占比", List.of(Counter.ELAPSED_MS)),
    ERROR_RATE("error_rate", "ERROR_RATE", "错误率", List.of(Counter.ERRORS));

    public final String key;
    public final String column;
    public final String label;
    public final List<Counter> needs;

    Metric(String key, String column, String label, List<Counter> needs) {
        this.key = key;
        this.column = column;
        this.label = label;
        this.needs = needs;
    }

    public int bit() {
        return 1 << ordinal();
    }

    public static Metric byKey(String k) {
        for (Metric m : values()) {
            if (m.key.equalsIgnoreCase(k) || m.name().equalsIgnoreCase(k) || m.column.equalsIgnoreCase(k)) {
                return m;
            }
        }
        return null;
    }
}
