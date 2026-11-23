package com.dbops.monitor;

import com.dbops.common.Values;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 指标行构造与读取。
 * <ul>
 *   <li>exporter 指标：{METRIC_NAME, VALUE, METRIC_UNIT}（前端实例详情页直接展示）</li>
 *   <li>engine/host 指标：{key, value, unit[, labels, error]}（告警评估使用）</li>
 * </ul>
 */
public final class Metrics {

    private Metrics() {
    }

    public static void addExporter(List<Map<String, Object>> out, String name, Object value, String unit) {
        Double v = Values.toDouble(value);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("METRIC_NAME", name);
        m.put("VALUE", v);
        m.put("METRIC_UNIT", unit == null ? "" : unit);
        out.add(m);
    }

    /** 值为空时不加（对应 Node push() 中的 Number.isFinite 判断） */
    public static void addExporterIfPresent(List<Map<String, Object>> out, String name, Object value, String unit) {
        if (Values.toDouble(value) != null) {
            addExporter(out, name, value, unit);
        }
    }

    public static void push(List<Map<String, Object>> out, String key, Object value, String unit) {
        Double v = Values.toDouble(value);
        if (v == null) {
            return;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("key", key);
        m.put("value", v);
        m.put("unit", unit == null ? "" : unit);
        out.add(m);
    }

    public static Map<String, Object> internal(String key, String unit, String error) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("key", key);
        m.put("value", 0);
        m.put("unit", unit == null ? "" : unit);
        if (error != null) {
            m.put("error", error);
        }
        return m;
    }

    public static Double exporterValue(List<Map<String, Object>> metrics, String name) {
        if (metrics == null) {
            return null;
        }
        for (Map<String, Object> m : metrics) {
            if (name.equals(m.get("METRIC_NAME"))) {
                return Values.toDouble(m.get("VALUE"));
            }
        }
        return null;
    }

    public static Double keyValue(List<Map<String, Object>> metrics, String key) {
        if (metrics == null) {
            return null;
        }
        for (Map<String, Object> m : metrics) {
            if (key.equals(m.get("key"))) {
                return Values.toDouble(m.get("value"));
            }
        }
        return null;
    }

    public static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
