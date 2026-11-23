package com.dbops.sqlinsight.audit;

import com.dbops.common.Values;
import com.dbops.monitor.DbType;
import com.dbops.monitor.TargetDb;
import com.dbops.sqlinsight.ast.TableMetadata;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * 从目标库数据字典读取索引列与字段类型（静态规则 S-005 / S-006 用）。单次审核内缓存；查询失败按“未知”处理。
 */
public final class TargetMetadata implements TableMetadata {

    private final TargetDb db;
    private final String type;
    private final Map<String, Optional<Set<String>>> idx = new HashMap<>();
    private final Map<String, Optional<Map<String, String>>> cols = new HashMap<>();
    private final Map<String, Optional<List<String>>> colOrder = new HashMap<>();
    private final Map<String, Optional<List<List<String>>>> idxList = new HashMap<>();
    private final Map<String, Optional<Long>> rows = new HashMap<>();
    private final Map<String, Set<String>> notNullCols = new HashMap<>();

    public TargetMetadata(TargetDb db, String platformType) {
        this.db = db;
        this.type = DbType.normalize(platformType);
    }

    @Override
    public Set<String> indexedColumns(String schema, String table) {
        String k = schema + "." + table;
        return idx.computeIfAbsent(k, x -> Optional.ofNullable(loadIndexed(schema, table))).orElse(null);
    }

    @Override
    public String columnTypeFamily(String schema, String table, String column) {
        Map<String, String> m = cols.computeIfAbsent(schema + "." + table, x -> Optional.ofNullable(loadColumns(schema, table))).orElse(null);
        return m == null ? null : m.get(column.toUpperCase(Locale.ROOT));
    }

    private Set<String> loadIndexed(String schema, String table) {
        if (columnsOrNull(schema, table) == null) {
            return null;      // 表不存在 / 无权限：未知
        }
        String q = switch (type) {
            case DbType.ORACLE, DbType.DAMENG -> "SELECT COLUMN_NAME AS C FROM ALL_IND_COLUMNS WHERE TABLE_OWNER = NVL(?, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) "
                    + "AND TABLE_NAME = ?";
            case DbType.MYSQL, DbType.GOLDENDB -> "SELECT COLUMN_NAME AS C FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = IFNULL(?, DATABASE()) "
                    + "AND UPPER(TABLE_NAME) = UPPER(?)";
            case DbType.POSTGRESQL, DbType.PANWEI -> "SELECT a.attname AS C FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid "
                    + "JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey) "
                    + "WHERE n.nspname = COALESCE(LOWER(?), current_schema()) AND c.relname = LOWER(?)";
            case DbType.SQLSERVER -> "SELECT c.name AS C FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                    + "JOIN sys.tables t ON t.object_id = ic.object_id WHERE SCHEMA_NAME(t.schema_id) = ISNULL(?, 'dbo') AND t.name = ?";
            default -> null;
        };
        if (q == null) {
            return null;
        }
        Set<String> out = new HashSet<>();
        for (Map<String, Object> r : db.queryOrEmpty(q, schema, table)) {
            out.add(Values.str(r.get("C"), "").toUpperCase(Locale.ROOT));
        }
        return out;
    }

    private Map<String, String> columnsOrNull(String schema, String table) {
        return cols.computeIfAbsent(schema + "." + table, x -> Optional.ofNullable(loadColumns(schema, table))).orElse(null);
    }

    private Map<String, String> loadColumns(String schema, String table) {
        String q = switch (type) {
            case DbType.ORACLE, DbType.DAMENG -> "SELECT COLUMN_NAME AS C, DATA_TYPE AS T, NULLABLE AS N FROM ALL_TAB_COLUMNS WHERE OWNER = NVL(?, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) "
                    + "AND TABLE_NAME = ? ORDER BY COLUMN_ID";
            case DbType.MYSQL, DbType.GOLDENDB -> "SELECT COLUMN_NAME AS C, DATA_TYPE AS T, IS_NULLABLE AS N FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = IFNULL(?, DATABASE()) "
                    + "AND UPPER(TABLE_NAME) = UPPER(?) ORDER BY ORDINAL_POSITION";
            case DbType.POSTGRESQL, DbType.PANWEI -> "SELECT column_name AS C, data_type AS T, is_nullable AS N FROM information_schema.columns "
                    + "WHERE table_schema = COALESCE(LOWER(?), current_schema()) AND table_name = LOWER(?) ORDER BY ordinal_position";
            case DbType.SQLSERVER -> "SELECT COLUMN_NAME AS C, DATA_TYPE AS T, IS_NULLABLE AS N FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ISNULL(?, 'dbo') AND TABLE_NAME = ? "
                    + "ORDER BY ORDINAL_POSITION";
            default -> null;
        };
        if (q == null) {
            return null;
        }
        List<Map<String, Object>> rows = db.queryOrEmpty(q, schema, table);
        if (rows.isEmpty()) {
            return null;
        }
        Map<String, String> m = new HashMap<>();
        List<String> order = new java.util.ArrayList<>();
        Set<String> nn = new java.util.HashSet<>();
        for (Map<String, Object> r : rows) {
            String c = Values.str(r.get("C"), "").toUpperCase(Locale.ROOT);
            m.put(c, family(Values.str(r.get("T"), "")));
            order.add(c);
            String n = Values.str(r.get("N"), "").toUpperCase(Locale.ROOT);
            if (n.equals("N") || n.equals("NO")) {
                nn.add(c);
            }
        }
        colOrder.put(schema + "." + table, Optional.of(order));
        notNullCols.put(schema + "." + table, nn);
        return m;
    }

    @Override
    public Boolean notNull(String schema, String table, String column) {
        if (columnsOrNull(schema, table) == null || column == null) {
            return null;
        }
        Set<String> nn = notNullCols.get(schema + "." + table);
        return nn != null && nn.contains(column.toUpperCase(Locale.ROOT));
    }

    @Override
    public List<String> columns(String schema, String table) {
        String k = schema + "." + table;
        if (!colOrder.containsKey(k)) {
            columnsOrNull(schema, table);
        }
        return colOrder.getOrDefault(k, Optional.empty()).orElse(null);
    }

    @Override
    public List<List<String>> indexes(String schema, String table) {
        return idxList.computeIfAbsent(schema + "." + table, x -> Optional.ofNullable(loadIndexes(schema, table))).orElse(null);
    }

    @Override
    public Long rowCount(String schema, String table) {
        return rows.computeIfAbsent(schema + "." + table, x -> Optional.ofNullable(loadRows(schema, table))).orElse(null);
    }

    private List<List<String>> loadIndexes(String schema, String table) {
        if (columnsOrNull(schema, table) == null) {
            return null;
        }
        String q = switch (type) {
            case DbType.ORACLE, DbType.DAMENG -> "SELECT INDEX_NAME AS I, COLUMN_NAME AS C FROM ALL_IND_COLUMNS WHERE TABLE_OWNER = NVL(?, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) "
                    + "AND TABLE_NAME = ? ORDER BY INDEX_NAME, COLUMN_POSITION";
            case DbType.MYSQL, DbType.GOLDENDB -> "SELECT INDEX_NAME AS I, COLUMN_NAME AS C FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = IFNULL(?, DATABASE()) "
                    + "AND UPPER(TABLE_NAME) = UPPER(?) ORDER BY INDEX_NAME, SEQ_IN_INDEX";
            // PG / 磐维：解析 pg_get_indexdef，避免依赖 unnest WITH ORDINALITY（磐维版本差异）
            case DbType.POSTGRESQL, DbType.PANWEI -> "SELECT i.relname AS I, pg_get_indexdef(x.indexrelid) AS D FROM pg_index x "
                    + "JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace "
                    + "WHERE n.nspname = COALESCE(LOWER(?), current_schema()) AND t.relname = LOWER(?)";
            case DbType.SQLSERVER -> "SELECT ix.name AS I, c.name AS C FROM sys.indexes ix JOIN sys.index_columns ic ON ic.object_id = ix.object_id AND ic.index_id = ix.index_id "
                    + "JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id JOIN sys.tables t ON t.object_id = ix.object_id "
                    + "WHERE SCHEMA_NAME(t.schema_id) = ISNULL(?, 'dbo') AND t.name = ? AND ic.is_included_column = 0 ORDER BY ix.name, ic.key_ordinal";
            default -> null;
        };
        if (q == null) {
            return null;
        }
        Map<String, List<String>> byIdx = new java.util.LinkedHashMap<>();
        for (Map<String, Object> r : db.queryOrEmpty(q, schema, table)) {
            String name = Values.str(r.get("I"), "");
            if (r.containsKey("D")) {
                byIdx.put(name, parseIndexDef(Values.str(r.get("D"), "")));
            } else {
                byIdx.computeIfAbsent(name, k -> new java.util.ArrayList<>()).add(Values.str(r.get("C"), "").toUpperCase(Locale.ROOT));
            }
        }
        return new java.util.ArrayList<>(byIdx.values());
    }

    /** CREATE [UNIQUE] INDEX x ON s.t USING btree (a, lower(b), c) → [A, LOWER(B), C] */
    static List<String> parseIndexDef(String def) {
        int open = def.indexOf('(');
        int close = def.lastIndexOf(')');
        List<String> out = new java.util.ArrayList<>();
        if (open < 0 || close <= open) {
            return out;
        }
        String inner = def.substring(open + 1, close);
        int depth = 0;
        StringBuilder cur = new StringBuilder();
        for (char ch : inner.toCharArray()) {
            if (ch == '(') {
                depth++;
            } else if (ch == ')') {
                depth--;
            }
            if (ch == ',' && depth == 0) {
                out.add(cur.toString().trim().replace("\"", "").toUpperCase(Locale.ROOT));
                cur.setLength(0);
            } else {
                cur.append(ch);
            }
        }
        if (cur.length() > 0) {
            out.add(cur.toString().trim().replace("\"", "").toUpperCase(Locale.ROOT));
        }
        // 去掉排序/opclass 修饰：“a DESC”“a text_pattern_ops”
        List<String> clean = new java.util.ArrayList<>();
        for (String c : out) {
            clean.add(c.contains("(") ? c : c.split("\\s+")[0]);
        }
        return clean;
    }

    private Long loadRows(String schema, String table) {
        String q = switch (type) {
            case DbType.ORACLE, DbType.DAMENG -> "SELECT NUM_ROWS AS N FROM ALL_TABLES WHERE OWNER = NVL(?, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND TABLE_NAME = ?";
            case DbType.MYSQL, DbType.GOLDENDB -> "SELECT TABLE_ROWS AS N FROM information_schema.TABLES WHERE TABLE_SCHEMA = IFNULL(?, DATABASE()) AND UPPER(TABLE_NAME) = UPPER(?)";
            case DbType.POSTGRESQL, DbType.PANWEI -> "SELECT CAST(c.reltuples AS BIGINT) AS N FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                    + "WHERE n.nspname = COALESCE(LOWER(?), current_schema()) AND c.relname = LOWER(?)";
            case DbType.SQLSERVER -> "SELECT SUM(p.rows) AS N FROM sys.partitions p JOIN sys.tables t ON t.object_id = p.object_id "
                    + "WHERE SCHEMA_NAME(t.schema_id) = ISNULL(?, 'dbo') AND t.name = ? AND p.index_id IN (0, 1)";
            default -> null;
        };
        if (q == null) {
            return null;
        }
        List<Map<String, Object>> r = db.queryOrEmpty(q, schema, table);
        return r.isEmpty() ? null : Values.toLong(r.get(0).get("N"));
    }

    static String family(String dataType) {
        String t = dataType.toUpperCase(Locale.ROOT);
        if (t.contains("CHAR") || t.contains("TEXT") || t.contains("CLOB") || t.equals("STRING")) {
            return "CHAR";
        }
        if (t.contains("INT") || t.contains("NUM") || t.contains("DEC") || t.contains("FLOAT") || t.contains("DOUBLE")
                || t.contains("REAL") || t.contains("MONEY") || t.equals("BIT")) {
            return "NUMBER";
        }
        if (t.contains("DATE") || t.contains("TIME")) {
            return "DATE";
        }
        return "OTHER";
    }
}
