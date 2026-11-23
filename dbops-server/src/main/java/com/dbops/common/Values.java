package com.dbops.common;

import java.math.BigDecimal;
import java.util.Map;

/**
 * 弱类型取值工具（请求体 Map / 查询结果 Map 中的值可能是 String、Number、Boolean、null）。
 * 语义尽量贴近 Node 版 Number()/String() 的用法，但不会产生 NaN 字符串拼接这类问题。
 */
public final class Values {

    private Values() {
    }

    public static boolean isBlank(Object v) {
        return v == null || String.valueOf(v).trim().isEmpty();
    }

    /** 去空白后的字符串；null/空串 → null */
    public static String str(Object v) {
        if (v == null) {
            return null;
        }
        String s = String.valueOf(v).trim();
        return s.isEmpty() ? null : s;
    }

    public static String str(Object v, String def) {
        String s = str(v);
        return s == null ? def : s;
    }

    /** 保留原样（不 trim）的字符串，用于密码等字段；null → null */
    public static String raw(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    public static Double toDouble(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof Number n) {
            double d = n.doubleValue();
            return Double.isFinite(d) ? d : null;
        }
        if (v instanceof Boolean b) {
            return b ? 1.0 : 0.0;
        }
        String s = String.valueOf(v).trim();
        if (s.isEmpty()) {
            return null;
        }
        try {
            double d = Double.parseDouble(s);
            return Double.isFinite(d) ? d : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public static Long toLong(Object v) {
        Double d = toDouble(v);
        if (d == null) {
            return null;
        }
        return d.longValue();
    }

    /** 严格整数：小数或非法字符串返回 null（对应 Node Number.isInteger 校验） */
    public static Long toStrictLong(Object v) {
        Double d = toDouble(v);
        if (d == null || d != Math.rint(d)) {
            return null;
        }
        return d.longValue();
    }

    public static long toLong(Object v, long def) {
        Long l = toLong(v);
        return l == null ? def : l;
    }

    public static Integer toInt(Object v) {
        Long l = toLong(v);
        return l == null ? null : (int) Math.max(Integer.MIN_VALUE, Math.min(Integer.MAX_VALUE, l));
    }

    public static int toInt(Object v, int def) {
        Integer i = toInt(v);
        return i == null ? def : i;
    }

    public static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    /** JS 真值语义：true/1/"1"/"true"/"yes"/"y" → true */
    public static boolean truthy(Object v) {
        if (v == null) {
            return false;
        }
        if (v instanceof Boolean b) {
            return b;
        }
        if (v instanceof Number n) {
            return n.doubleValue() != 0;
        }
        String s = String.valueOf(v).trim().toLowerCase();
        return s.equals("1") || s.equals("true") || s.equals("yes") || s.equals("y") || s.equals("on");
    }

    public static Object get(Map<String, ?> m, String key) {
        return m == null ? null : m.get(key);
    }

    /** 数值相等比较（Oracle NUMBER 返回 BigDecimal，请求参数可能是 String） */
    public static boolean numEq(Object a, Object b) {
        Double x = toDouble(a);
        Double y = toDouble(b);
        return x != null && y != null && Math.abs(x - y) < 1e-9;
    }

    public static double round(double v, int scale) {
        return BigDecimal.valueOf(v).setScale(scale, java.math.RoundingMode.HALF_UP).doubleValue();
    }

    public static String truncate(String s, int max) {
        if (s == null) {
            return null;
        }
        return s.length() <= max ? s : s.substring(0, max);
    }
}
