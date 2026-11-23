package com.dbops.monitor;

import java.util.List;
import java.util.Locale;

/**
 * 数据库类型归一化（同 Node monitorTargetConn.normalizeDbType / isPgFamily / isSqlServer）。
 */
public final class DbType {

    public static final String ORACLE = "ORACLE";
    public static final String MYSQL = "MYSQL";
    public static final String GOLDENDB = "GOLDENDB";
    public static final String POSTGRESQL = "POSTGRESQL";
    public static final String PANWEI = "PANWEI";
    public static final String DAMENG = "DAMENG";
    public static final String SQLSERVER = "SQLSERVER";

    /** 支持监控采集的类型 */
    public static final List<String> MONITORED = List.of(ORACLE, MYSQL, POSTGRESQL, DAMENG, GOLDENDB, PANWEI, SQLSERVER);

    private DbType() {
    }

    public static String normalize(Object raw) {
        String t = raw == null ? "" : String.valueOf(raw).trim().toUpperCase(Locale.ROOT);
        if (t.equals("MSSQL")) {
            return SQLSERVER;
        }
        if (t.equals("POSTGRES") || t.equals("PG")) {
            return POSTGRESQL;
        }
        if (t.equals("DM") || t.equals("DM8")) {
            return DAMENG;
        }
        return t;
    }

    public static boolean isMonitored(String t) {
        return MONITORED.contains(normalize(t));
    }

    public static boolean isMysqlFamily(String t) {
        String u = normalize(t);
        return u.equals(MYSQL) || u.equals(GOLDENDB);
    }

    public static boolean isPgFamily(String t) {
        String u = normalize(t);
        return u.equals(POSTGRESQL) || u.equals(PANWEI);
    }

    public static boolean isSqlServer(String t) {
        return normalize(t).equals(SQLSERVER);
    }

    /** 健康评分 / 趋势使用的“指标引擎”：GoldenDB 按 MySQL，磐维按 PostgreSQL */
    public static String metricEngine(String t) {
        String u = normalize(t);
        if (u.equals(GOLDENDB)) {
            return MYSQL;
        }
        if (u.equals(PANWEI)) {
            return POSTGRESQL;
        }
        return u;
    }

    public static int defaultPort(String t) {
        String u = normalize(t);
        return switch (u) {
            case MYSQL, GOLDENDB -> 3306;
            case POSTGRESQL, PANWEI -> 5432;
            case SQLSERVER -> 1433;
            case DAMENG -> 5236;
            default -> 1521;
        };
    }

    public static String defaultCharset(String t) {
        String u = normalize(t);
        return switch (u) {
            case MYSQL, GOLDENDB -> "utf8mb4";
            case POSTGRESQL, PANWEI -> "UTF8";
            case SQLSERVER, DAMENG -> "UTF-8";
            case ORACLE -> "AL32UTF8";
            default -> "";
        };
    }

    /** 新建实例的初始状态：可采集类型为 UNKNOWN（首轮采集后变 RUNNING/ERROR），其余 UNMONITORED */
    public static String initialStatus(String t) {
        return isMonitored(t) ? "UNKNOWN" : "UNMONITORED";
    }
}
