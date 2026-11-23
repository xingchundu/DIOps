package com.dbops.common;

import java.io.Reader;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Clob;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.OffsetDateTime;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 把 JDBC 结果行转成 JSON 友好的 Map：
 * <ul>
 *   <li>列名统一大写（Oracle 本身是大写；MySQL/PG 返回小写，Node 版用 rowsUpper 做了同样处理）</li>
 *   <li>CLOB → String，BLOB/二进制 → 跳过，驱动私有类型 → toString()</li>
 *   <li>TIMESTAMP → java.sql.Timestamp（Jackson 输出 ISO-8601，与 Node Date 一致）</li>
 * </ul>
 */
public final class RowNormalizer {

    private static final int MAX_CLOB_CHARS = 8 * 1024 * 1024;

    private RowNormalizer() {
    }

    public static List<Map<String, Object>> readAll(ResultSet rs, int maxRows) throws SQLException {
        List<Map<String, Object>> out = new ArrayList<>();
        ResultSetMetaData md = rs.getMetaData();
        int n = md.getColumnCount();
        String[] names = new String[n];
        for (int i = 0; i < n; i++) {
            String label = md.getColumnLabel(i + 1);
            if (label == null || label.isEmpty()) {
                label = md.getColumnName(i + 1);
            }
            names[i] = label.toUpperCase(Locale.ROOT);
        }
        while (rs.next()) {
            Map<String, Object> row = new LinkedHashMap<>();
            for (int i = 0; i < n; i++) {
                row.put(names[i], normalize(rs.getObject(i + 1)));
            }
            out.add(row);
            if (maxRows > 0 && out.size() >= maxRows) {
                break;
            }
        }
        return out;
    }

    public static Map<String, Object> readRow(ResultSet rs) throws SQLException {
        ResultSetMetaData md = rs.getMetaData();
        Map<String, Object> row = new LinkedHashMap<>();
        for (int i = 1; i <= md.getColumnCount(); i++) {
            String label = md.getColumnLabel(i);
            if (label == null || label.isEmpty()) {
                label = md.getColumnName(i);
            }
            row.put(label.toUpperCase(Locale.ROOT), normalize(rs.getObject(i)));
        }
        return row;
    }

    public static Object normalize(Object v) throws SQLException {
        if (v == null) {
            return null;
        }
        if (v instanceof String || v instanceof Boolean || v instanceof Timestamp) {
            return v;
        }
        if (v instanceof BigDecimal bd) {
            // 整数值去掉多余小数位，避免前端看到 100.0000
            BigDecimal s = bd.stripTrailingZeros();
            return s.scale() < 0 ? s.setScale(0) : s;
        }
        if (v instanceof BigInteger || v instanceof Long || v instanceof Integer || v instanceof Short
                || v instanceof Byte || v instanceof Double || v instanceof Float) {
            if (v instanceof Double d && !Double.isFinite(d)) {
                return null;
            }
            if (v instanceof Float f && !Float.isFinite(f)) {
                return null;
            }
            return v;
        }
        if (v instanceof Clob clob) {
            return clobToString(clob);
        }
        if (v instanceof java.sql.Date d) {
            return new Timestamp(d.getTime());
        }
        if (v instanceof java.util.Date d) {
            return new Timestamp(d.getTime());
        }
        if (v instanceof LocalDateTime ldt) {
            return Timestamp.valueOf(ldt);
        }
        if (v instanceof OffsetDateTime odt) {
            return Timestamp.from(odt.toInstant());
        }
        if (v instanceof java.sql.Blob || v instanceof byte[]) {
            if (v instanceof byte[] b && b.length <= 64) {
                return toHex(b);
            }
            return null;
        }
        if (v instanceof java.sql.Array arr) {
            Object a = arr.getArray();
            return a instanceof Object[] oa ? List.of(oa) : String.valueOf(a);
        }
        // oracle.sql.*、PGobject、DateTimeOffset 等驱动私有类型
        return String.valueOf(v);
    }

    public static String clobToString(Clob clob) throws SQLException {
        long len = clob.length();
        if (len <= 0) {
            return "";
        }
        if (len <= MAX_CLOB_CHARS) {
            return clob.getSubString(1, (int) len);
        }
        StringBuilder sb = new StringBuilder();
        try (Reader r = clob.getCharacterStream()) {
            char[] buf = new char[8192];
            int k;
            while ((k = r.read(buf)) > 0 && sb.length() < MAX_CLOB_CHARS) {
                sb.append(buf, 0, k);
            }
        } catch (java.io.IOException e) {
            throw new SQLException(e);
        }
        return sb.toString();
    }

    private static String toHex(byte[] b) {
        StringBuilder sb = new StringBuilder("0x");
        for (byte x : b) {
            sb.append(String.format("%02X", x));
        }
        return sb.toString();
    }
}
