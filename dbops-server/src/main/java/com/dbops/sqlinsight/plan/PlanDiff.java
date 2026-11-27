package com.dbops.sqlinsight.plan;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 执行计划文本 → 访问路径 / 连接方式，并比较两份计划（纯函数，无外部依赖，便于单测）。
 * 支持 Oracle / 达梦（DBMS_XPLAN 表格）、PostgreSQL / 磐维（EXPLAIN TEXT）、MySQL / GoldenDB（EXPLAIN 表格）。
 * 解析不出任何节点时返回空列表，调用方应提示「计划格式无法解析，请直接对比原文」，而不是当作“无变化”。
 */
public final class PlanDiff {

    private PlanDiff() {
    }

    /** kind：访问方式（TABLE ACCESS FULL / INDEX RANGE SCAN / Seq Scan …），object：表或索引名 */
    public record Node(String kind, String object, boolean fullScan) {
        public String label() {
            return object == null || object.isBlank() ? kind : kind + " (" + object + ")";
        }
    }

    public record Parsed(List<Node> access, List<String> joins) {
    }

    private static final Pattern ORA_ROW = Pattern.compile("^\\|\\s*\\*?\\s*(\\d+)\\s*\\|([^|]*)\\|([^|]*)\\|");
    private static final Pattern PG_NODE = Pattern.compile("(Seq Scan|Index Only Scan|Index Scan|Bitmap Heap Scan|Bitmap Index Scan|Tid Scan|Foreign Scan)"
            + "(?: Backward)?(?: using (\\S+))?(?: on (\\S+))?");
    private static final Pattern PG_JOIN = Pattern.compile("\\b(Hash Join|Nested Loop|Merge Join|Hash Semi Join|Hash Anti Join)\\b");

    public static Parsed parse(String plan) {
        List<Node> access = new ArrayList<>();
        List<String> joins = new ArrayList<>();
        if (plan == null || plan.isBlank()) {
            return new Parsed(access, joins);
        }
        String[] lines = plan.split("\\r?\\n");
        int myType = -1, myTable = -1, myKey = -1;
        for (String line : lines) {
            Matcher m = ORA_ROW.matcher(line);
            if (m.find()) {
                String op = m.group(2).trim().toUpperCase(Locale.ROOT);
                String name = m.group(3).trim();
                if (op.startsWith("TABLE ACCESS") || op.startsWith("INDEX") || op.startsWith("MAT_VIEW ACCESS") || op.startsWith("BITMAP INDEX")
                        || op.contains("CLUSTERED") || op.contains("TABLE SCAN") || op.contains("RANGE SCAN") || op.contains("FULL SCAN")) {
                    access.add(new Node(op, name, op.contains("TABLE ACCESS FULL") || op.equals("FULL TABLE SCAN") || op.contains("TABLE SCAN") && !op.contains("INDEX")));
                } else if (op.contains("JOIN") || op.startsWith("NESTED LOOPS")) {
                    joins.add(op);
                }
                continue;
            }
            Matcher pg = PG_NODE.matcher(line);
            if (pg.find()) {
                String kind = pg.group(1);
                String obj = pg.group(2) != null ? pg.group(2) : pg.group(3);
                access.add(new Node(kind, pg.group(2) != null && pg.group(3) != null ? pg.group(2) + " on " + pg.group(3) : obj, "Seq Scan".equals(kind)));
                continue;
            }
            Matcher pj = PG_JOIN.matcher(line);
            if (pj.find()) {
                joins.add(pj.group(1).toUpperCase(Locale.ROOT));
                continue;
            }
            // MySQL EXPLAIN 表格：id | select_type | table | partitions | type | possible_keys | key | ...
            if (line.contains(" | ")) {
                String[] c = line.split("\\s\\|\\s", -1);
                for (int i = 0; i < c.length; i++) {
                    String h = c[i].trim().toLowerCase(Locale.ROOT);
                    if (h.equals("select_type")) {
                        myType = -2;
                    }
                }
                if (myType == -2) {
                    myType = -1;
                    for (int i = 0; i < c.length; i++) {
                        switch (c[i].trim().toLowerCase(Locale.ROOT)) {
                            case "type" -> myType = i;
                            case "table" -> myTable = i;
                            case "key" -> myKey = i;
                            default -> {
                            }
                        }
                    }
                    continue;
                }
                if (myType >= 0 && c.length > Math.max(myType, Math.max(myTable, myKey)) && myTable >= 0) {
                    String type = c[myType].trim();
                    if (!type.isEmpty() && !type.equals("NULL") && !line.startsWith("---")) {
                        String key = myKey >= 0 ? c[myKey].trim() : "";
                        boolean full = "ALL".equalsIgnoreCase(type);
                        String obj = c[myTable].trim() + ("NULL".equals(key) || key.isEmpty() ? "" : " via " + key);
                        access.add(new Node("type=" + type, obj, full));
                    }
                }
            }
        }
        return new Parsed(access, joins);
    }

    private static List<String> labels(Parsed p) {
        List<String> l = new ArrayList<>();
        for (Node n : p.access()) {
            l.add(n.label());
        }
        return l;
    }

    /** 多重集差：a 中有、b 中没有（相同标签按出现次数抵消） */
    static List<String> minus(List<String> a, List<String> b) {
        List<String> rest = new ArrayList<>(b);
        List<String> out = new ArrayList<>();
        for (String x : a) {
            if (!rest.remove(x)) {
                out.add(x);
            }
        }
        return out;
    }

    public static Map<String, Object> compare(String oldPlan, String newPlan) {
        Parsed o = parse(oldPlan), n = parse(newPlan);
        Map<String, Object> r = new LinkedHashMap<>();
        boolean parsedOk = !(o.access().isEmpty() && o.joins().isEmpty()) && !(n.access().isEmpty() && n.joins().isEmpty());
        List<String> ol = labels(o), nl = labels(n);
        List<String> removed = minus(ol, nl), added = minus(nl, ol);
        boolean oFull = o.access().stream().anyMatch(Node::fullScan), nFull = n.access().stream().anyMatch(Node::fullScan);
        List<String> joinRemoved = minus(o.joins(), n.joins()), joinAdded = minus(n.joins(), o.joins());
        r.put("parsed", parsedOk);
        r.put("oldAccess", ol);
        r.put("newAccess", nl);
        r.put("removed", removed);
        r.put("added", added);
        r.put("oldJoins", o.joins());
        r.put("newJoins", n.joins());
        r.put("joinRemoved", joinRemoved);
        r.put("joinAdded", joinAdded);
        r.put("oldFullScan", oFull);
        r.put("newFullScan", nFull);
        boolean changed = !removed.isEmpty() || !added.isEmpty() || !joinRemoved.isEmpty() || !joinAdded.isEmpty();
        r.put("changed", parsedOk && changed);
        StringBuilder sb = new StringBuilder();
        if (!parsedOk) {
            sb.append("计划文本无法解析出访问路径，请直接对比原文");
        } else if (!changed) {
            sb.append("访问路径与连接方式一致");
        } else {
            if (!removed.isEmpty() || !added.isEmpty()) {
                sb.append("访问路径：").append(removed.isEmpty() ? "（无）" : String.join("、", removed)).append(" → ")
                        .append(added.isEmpty() ? "（无）" : String.join("、", added)).append("。");
            }
            if (!joinRemoved.isEmpty() || !joinAdded.isEmpty()) {
                sb.append("连接方式：").append(joinRemoved.isEmpty() ? "（无）" : String.join("、", joinRemoved)).append(" → ")
                        .append(joinAdded.isEmpty() ? "（无）" : String.join("、", joinAdded)).append("。");
            }
            if (!oFull && nFull) {
                sb.append("新计划出现全表扫描（风险）。");
            } else if (oFull && !nFull) {
                sb.append("新计划消除了全表扫描。");
            }
        }
        r.put("summary", sb.toString());
        return r;
    }
}
