package com.dbops.sqlinsight.ast;

import com.alibaba.druid.DbType;

import java.util.List;

/**
 * 平台数据库类型 → Druid 方言。
 * 磐维（openGauss 体系）用 gaussdb 方言；达梦用 dm 方言（Oracle 兼容语法）。
 */
public final class SqlDialect {

    private SqlDialect() {
    }

    public static DbType of(String platformType) {
        String t = com.dbops.monitor.DbType.normalize(platformType);
        return switch (t) {
            case "ORACLE" -> DbType.oracle;
            case "MYSQL" -> DbType.mysql;
            case "GOLDENDB" -> DbType.mysql;
            case "POSTGRESQL" -> DbType.postgresql;
            case "PANWEI" -> DbType.gaussdb;
            case "DAMENG" -> DbType.dm;
            case "SQLSERVER" -> DbType.sqlserver;
            default -> null;
        };
    }

    /** 不知道库类型时（如离线审核）依次尝试的方言 */
    public static List<DbType> guessOrder() {
        return List.of(DbType.oracle, DbType.mysql, DbType.postgresql, DbType.sqlserver);
    }

    /** 指纹里使用的方言族：同族库之间同一 SQL 视为同一资产 */
    public static String family(String platformType) {
        String t = com.dbops.monitor.DbType.normalize(platformType);
        return switch (t) {
            case "GOLDENDB" -> "MYSQL";
            case "" -> "GENERIC";
            default -> t;
        };
    }
}
