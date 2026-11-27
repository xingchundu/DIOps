package com.dbops.sqlinsight.plan;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 优化复测结论（纯函数）：同一 SQL 优化上线前后的分钟窗口指标比较。
 * 以平均耗时为主判据（≤0.8 倍改善，≥1.25 倍退化），并附单次 CPU / 逻辑读 / 物理读变化；
 * 优化后样本不足（执行 < 5 次或窗口 < 3 个）时给 NO_DATA，绝不在样本不足时下“改善”结论。
 */
public final class RetestVerdict {

    public static final int MIN_EXECS = 5;
    public static final int MIN_WINDOWS = 3;

    private RetestVerdict() {
    }

    private static Double d(Map<String, Object> m, String k) {
        Object v = m == null ? null : m.get(k);
        if (v instanceof Number n) {
            return n.doubleValue();
        }
        if (v != null) {
            try {
                return Double.parseDouble(String.valueOf(v));
            } catch (NumberFormatException ignore) {
                return null;
            }
        }
        return null;
    }

    private static String ratioText(String name, String unit, Double b, Double a) {
        if (b == null || a == null) {
            return null;
        }
        if (b <= 0) {
            return name + " " + fmt(b) + unit + " → " + fmt(a) + unit;
        }
        return name + " " + fmt(b) + unit + " → " + fmt(a) + unit + "（" + String.format("%.2f", a / b) + "x）";
    }

    private static String fmt(Double v) {
        return Math.abs(v) >= 100 ? String.format("%.0f", v) : String.format("%.2f", v).replaceAll("\\.?0+$", "");
    }

    public static Map<String, Object> evaluate(Map<String, Object> before, Map<String, Object> after) {
        Map<String, Object> r = new LinkedHashMap<>();
        Double bAvg = d(before, "AVG_MS"), aAvg = d(after, "AVG_MS");
        double aExecs = d(after, "EXECS") == null ? 0 : d(after, "EXECS");
        double aWin = d(after, "WINDOWS") == null ? 0 : d(after, "WINDOWS");
        String verdict;
        String text;
        if (bAvg == null || bAvg <= 0) {
            verdict = "NO_DATA";
            text = "优化前没有可用的耗时样本，无法对比";
        } else if (aAvg == null || aExecs < MIN_EXECS || aWin < MIN_WINDOWS) {
            verdict = "NO_DATA";
            text = "优化后样本不足（需要执行 ≥ " + MIN_EXECS + " 次且 ≥ " + MIN_WINDOWS + " 个采集窗口，当前 " + (int) aExecs + " 次 / " + (int) aWin + " 个窗口），继续观察";
        } else {
            double ratio = aAvg / bAvg;
            r.put("ratio", Math.round(ratio * 100) / 100.0);
            if (ratio <= 0.8) {
                verdict = "IMPROVED";
            } else if (ratio >= 1.25) {
                verdict = "REGRESSION";
            } else {
                verdict = "SIMILAR";
            }
            StringBuilder sb = new StringBuilder(switch (verdict) {
                case "IMPROVED" -> "优化有效：";
                case "REGRESSION" -> "优化后变慢：";
                default -> "变化不明显：";
            });
            String[] parts = {ratioText("平均耗时", "ms", bAvg, aAvg), ratioText("P95", "ms", d(before, "P95_MS"), d(after, "P95_MS")),
                    ratioText("单次CPU", "ms", d(before, "CPU_MS"), d(after, "CPU_MS")), ratioText("单次逻辑读", "", d(before, "LR"), d(after, "LR")),
                    ratioText("单次物理读", "", d(before, "PR"), d(after, "PR"))};
            boolean first = true;
            for (String p : parts) {
                if (p != null) {
                    sb.append(first ? "" : "；").append(p);
                    first = false;
                }
            }
            text = sb.toString();
        }
        r.put("verdict", verdict);
        r.put("text", text);
        return r;
    }
}
