package com.dbops.sqlinsight.collect;

import java.util.Locale;

/** 源库累计计数器（采集口径统一后的 10 个字段）。capability() 即 DI_SQL_CAPABILITY.METRIC 的取值。 */
public enum Counter {
    EXEC, ELAPSED_MS, CPU_MS, LOGICAL_READS, PHYSICAL_READS, ROWS_EXAMINED, ROWS_RETURNED, ERRORS, TMP_DISK, NO_INDEX;

    public String capability() {
        return switch (this) {
            case ELAPSED_MS -> "elapsed";
            case CPU_MS -> "cpu";
            default -> name().toLowerCase(Locale.ROOT);
        };
    }

    public static final int SIZE = values().length;
}
