package com.dbops.sqlinsight.optimize;

import com.dbops.monitor.DbType;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 执行计划文本分析（规则）：全表扫描的表、笛卡尔积、索引全扫描、排序/临时表、估算代价。
 * 输入为 ExplainService 返回的计划文本（Oracle/达梦 DBMS_XPLAN 或 DM 原生、MySQL 表格、PG/磐维文本、SQL Server SHOWPLAN_TEXT）。纯函数。
 */
public final class PlanAnalyzer {

    public record PlanFinding(String code, String severity, String title, String detail, List<String> tables) {
    }

    private static final Pattern ORA_FULL = Pattern.compile("TABLE ACCESS (?:STORAGE |INMEMORY )?FULL\\s*\\|\\s*([A-Za-z0-9_$#.\"]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern ORA_IDX_FULL = Pattern.compile("INDEX (?:FAST )?FULL SCAN\\s*\\|\\s*([A-Za-z0-9_$#.\"]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern DM_FULL = Pattern.compile("CSCN2?\\s*:[^;\\n]*;\\s*[A-Za-z0-9_$#]+\\(([A-Za-z0-9_$#.\"]+)\\)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PG_FULL = Pattern.compile("Seq Scan on\\s+([A-Za-z0-9_$.\"]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PG_COST = Pattern.compile("cost=([0-9.]+)\\.\\.([0-9.]+)");
    private static final Pattern MS_SCAN = Pattern.compile("(Table Scan|Clustered Index Scan)\\(OBJECT:\\(\\[?[^\\]]*\\]?\\.?\\[?[^\\]]*\\]?\\.\\[([^\\]]+)\\]", Pattern.CASE_INSENSITIVE);

    private PlanAnalyzer() {
    }

    public static Set<String> fullScanTables(String plan, String platformType) {
        Set<String> out = new LinkedHashSet<>();
        if (plan == null) {
            return out;
        }
        String t = DbType.normalize(platformType);
        switch (t) {
            case DbType.ORACLE -> collect(ORA_FULL, plan, out);
            case DbType.DAMENG -> {
                collect(ORA_FULL, plan, out);
                collect(DM_FULL, plan, out);
            }
            case DbType.POSTGRESQL, DbType.PANWEI -> collect(PG_FULL, plan, out);
            case DbType.MYSQL, DbType.GOLDENDB -> out.addAll(mysqlTablesWithType(plan, "ALL"));
            case DbType.SQLSERVER -> {
                Matcher m = MS_SCAN.matcher(plan);
                while (m.find()) {
                    out.add(clean(m.group(2)));
                }
            }
            default -> {
                collect(ORA_FULL, plan, out);
                collect(PG_FULL, plan, out);
            }
        }
        return out;
    }

    public static List<PlanFinding> analyze(String plan, String platformType) {
        List<PlanFinding> out = new ArrayList<>();
        if (plan == null || plan.isBlank()) {
            return out;
        }
        String t = DbType.normalize(platformType);
        String up = plan.toUpperCase(Locale.ROOT);
        Set<String> full = fullScanTables(plan, t);
        if (!full.isEmpty()) {
            out.add(new PlanFinding("X-001", "WARNING", "全表扫描", "执行计划对 " + String.join("、", full) + " 做全表扫描",
                    new ArrayList<>(full)));
        }
        if (up.contains("CARTESIAN") || (t.equals(DbType.MYSQL) || t.equals(DbType.GOLDENDB)) && up.contains("USING JOIN BUFFER (BLOCK NESTED LOOP)")) {
            out.add(new PlanFinding("X-002", "CRITICAL", "笛卡尔积 / 无连接条件", "计划中出现 CARTESIAN 或无索引的块嵌套循环连接，检查连接条件是否缺失", List.of()));
        }
        if (DbType.ORACLE.equals(t) || DbType.DAMENG.equals(t)) {
            Set<String> idxFull = new LinkedHashSet<>();
            collect(ORA_IDX_FULL, plan, idxFull);
            if (!idxFull.isEmpty()) {
                out.add(new PlanFinding("X-003", "INFO", "索引全扫描", "使用 " + String.join("、", idxFull) + " 做索引全扫描（没有用到索引的前导列过滤）",
                        List.of()));
            }
            if (up.contains("TEMPSPC")) {
                out.add(new PlanFinding("X-004", "WARNING", "排序/哈希可能溢出到临时表空间", "计划中出现 TempSpc 估算，排序或哈希连接数据量较大", List.of()));
            }
        }
        if (DbType.MYSQL.equals(t) || DbType.GOLDENDB.equals(t)) {
            if (up.contains("USING FILESORT")) {
                out.add(new PlanFinding("X-005", "INFO", "Using filesort", "排序没有利用索引顺序，数据量大时代价高；可考虑 (过滤列, 排序列) 复合索引", List.of()));
            }
            if (up.contains("USING TEMPORARY")) {
                out.add(new PlanFinding("X-006", "WARNING", "Using temporary", "GROUP BY / DISTINCT / UNION 使用了临时表", List.of()));
            }
        }
        if ((DbType.POSTGRESQL.equals(t) || DbType.PANWEI.equals(t)) && up.contains("NESTED LOOP") && !full.isEmpty()) {
            out.add(new PlanFinding("X-007", "WARNING", "嵌套循环 + 全表扫描", "嵌套循环的内表为全表扫描时，外表每一行都会扫描一遍内表", List.of()));
        }
        if (DbType.SQLSERVER.equals(t) && up.contains("|--SORT(")) {
            out.add(new PlanFinding("X-005", "INFO", "显式排序", "计划包含 Sort 算子，可考虑让索引提供顺序", List.of()));
        }
        return out;
    }

    /** 估算代价：Oracle 取 Id=0 行的 Cost；PG 取首行 cost=a..b 的 b；MySQL 取各行 rows 之积（行数估算）；其它返回 null */
    public static Double cost(String plan, String platformType) {
        if (plan == null || plan.isBlank()) {
            return null;
        }
        String t = DbType.normalize(platformType);
        if (DbType.ORACLE.equals(t) || DbType.DAMENG.equals(t)) {
            return oracleCost(plan);
        }
        if (DbType.POSTGRESQL.equals(t) || DbType.PANWEI.equals(t)) {
            Matcher m = PG_COST.matcher(plan);
            return m.find() ? Double.valueOf(m.group(2)) : null;
        }
        if (DbType.MYSQL.equals(t) || DbType.GOLDENDB.equals(t)) {
            List<String[]> rows = mysqlRows(plan);
            if (rows.isEmpty()) {
                return null;
            }
            int idx = mysqlCol(plan, "rows");
            if (idx < 0) {
                return null;
            }
            double prod = 1;
            for (String[] r : rows) {
                if (idx < r.length) {
                    try {
                        prod *= Math.max(1, Double.parseDouble(r[idx].trim()));
                    } catch (NumberFormatException ignore) {
                        // NULL
                    }
                }
            }
            return prod;
        }
        return null;
    }

    static Double oracleCost(String plan) {
        String[] lines = plan.split("\n");
        int costIdx = -1;
        for (String l : lines) {
            if (l.contains("Operation") && l.contains("Cost")) {
                String[] cells = l.split("\\|");
                for (int i = 0; i < cells.length; i++) {
                    if (cells[i].contains("Cost")) {
                        costIdx = i;
                    }
                }
                continue;
            }
            if (costIdx > 0 && l.matches("^\\|\\*?\\s*0\\s*\\|.*")) {
                String[] cells = l.split("\\|");
                if (costIdx < cells.length) {
                    Matcher m = Pattern.compile("([0-9]+(?:\\.[0-9]+)?)([KMG]?)").matcher(cells[costIdx]);
                    if (m.find()) {
                        double v = Double.parseDouble(m.group(1));
                        return switch (m.group(2)) {
                            case "K" -> v * 1e3;
                            case "M" -> v * 1e6;
                            case "G" -> v * 1e9;
                            default -> v;
                        };
                    }
                }
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ MySQL 表格

    private static int mysqlCol(String plan, String name) {
        for (String l : plan.split("\n")) {
            if (l.contains("select_type") || l.toLowerCase(Locale.ROOT).contains(" | table | ")) {
                String[] h = l.split("\\|");
                for (int i = 0; i < h.length; i++) {
                    if (h[i].trim().equalsIgnoreCase(name)) {
                        return i;
                    }
                }
            }
        }
        return -1;
    }

    private static List<String[]> mysqlRows(String plan) {
        List<String[]> out = new ArrayList<>();
        boolean header = false;
        for (String l : plan.split("\n")) {
            if (l.contains("select_type")) {
                header = true;
                continue;
            }
            if (!header || l.startsWith("-") || !l.contains("|")) {
                continue;
            }
            out.add(l.split("\\|"));
        }
        return out;
    }

    static List<String> mysqlTablesWithType(String plan, String type) {
        List<String> out = new ArrayList<>();
        int ti = mysqlCol(plan, "table");
        int ty = mysqlCol(plan, "type");
        if (ti < 0 || ty < 0) {
            return out;
        }
        for (String[] r : mysqlRows(plan)) {
            if (Math.max(ti, ty) < r.length && r[ty].trim().equalsIgnoreCase(type)) {
                out.add(clean(r[ti]));
            }
        }
        return out;
    }

    private static void collect(Pattern p, String plan, Set<String> out) {
        Matcher m = p.matcher(plan);
        while (m.find()) {
            out.add(clean(m.group(1)));
        }
    }

    private static String clean(String s) {
        String x = s.trim().replace("\"", "").replace("`", "");
        int dot = x.lastIndexOf('.');
        return (dot >= 0 ? x.substring(dot + 1) : x).toUpperCase(Locale.ROOT);
    }
}
