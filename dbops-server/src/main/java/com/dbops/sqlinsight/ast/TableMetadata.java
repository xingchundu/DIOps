package com.dbops.sqlinsight.ast;

import java.util.Set;

/**
 * 静态规则 S-005 / S-006 需要的元数据（索引列、字段类型）。返回 null 表示未知。
 */
public interface TableMetadata {

    /** 表上所有索引包含的列（大写）；表不存在或无权限时返回 null */
    Set<String> indexedColumns(String schema, String table);

    /** 字段类型族：CHAR / NUMBER / DATE / OTHER；未知返回 null */
    String columnTypeFamily(String schema, String table, String column);

    /** 各索引的列（按索引内顺序，大写）；未知返回 null。索引建议用来判断是否已有可用索引 */
    default java.util.List<java.util.List<String>> indexes(String schema, String table) {
        return null;
    }

    /** 表的全部列（按定义顺序，大写）；未知返回 null。SELECT * 展开用 */
    default java.util.List<String> columns(String schema, String table) {
        return null;
    }

    /** 列是否 NOT NULL；未知返回 null。NOT IN → NOT EXISTS 只有两侧列都非空时才等价 */
    default Boolean notNull(String schema, String table, String column) {
        return null;
    }

    /** 表的估算行数（统计信息）；未知返回 null。小表不建议加索引 */
    default Long rowCount(String schema, String table) {
        return null;
    }

    TableMetadata NONE = new TableMetadata() {
        @Override
        public Set<String> indexedColumns(String schema, String table) {
            return null;
        }

        @Override
        public String columnTypeFamily(String schema, String table, String column) {
            return null;
        }
    };
}
