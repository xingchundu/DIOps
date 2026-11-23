package com.dbops.monitor;

import com.dbops.common.Db;
import com.dbops.common.Values;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * 控制台：回答“现在有什么需要我处理”。
 * <ul>
 *   <li>实例健康分布与需要关注的实例（严重 / 离线 / 关注 / 数据过期），附最主要的问题</li>
 *   <li>告警：未处理按级别、近 24 小时新增与已解决、近 7 天按级别的趋势、最新未处理告警、告警最多的实例</li>
 *   <li>容量风险：表空间、文件系统、连接数接近上限的实例</li>
 *   <li>SQL：未关闭问题、未恢复波动、近 24 小时慢 SQL、新执行计划</li>
 *   <li>待办：待审 SQL 工单、待处理服务工单、近 24 小时失败的备份</li>
 * </ul>
 * 每块单独容错：某张表未初始化时该块返回空，不影响其它块。
 */
@Service
public class DashboardService {

    private final Db db;
    private final MonitorBoardService board;

    public DashboardService(Db db, MonitorBoardService board) {
        this.db = db;
        this.board = board;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> summary() {
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> b = board.board();
        Map<String, Object> sum = (Map<String, Object>) b.get("summary");
        List<Map<String, Object>> items = (List<Map<String, Object>>) b.get("items");
        out.put("instances", sum);

        // 需要关注的实例（board 已按严重程度排序）
        List<Map<String, Object>> attention = new ArrayList<>();
        for (Map<String, Object> it : items) {
            String g = String.valueOf(it.get("grade"));
            String st = String.valueOf(it.get("status"));
            if (g.equals("CRITICAL") || g.equals("OFFLINE") || g.equals("ATTENTION") || st.equals("STALE")) {
                Map<String, Object> m = new LinkedHashMap<>();
                for (String k : List.of("id", "name", "dbType", "env", "grade", "status", "score", "error", "alerts", "ageSec")) {
                    m.put(k, it.get(k));
                }
                Object issues = it.get("issues");
                m.put("issue", issues instanceof List<?> l && !l.isEmpty() ? ((Map<String, Object>) l.get(0)).get("text") : null);
                m.put("issueCount", it.get("issueCount"));
                attention.add(m);
            }
        }
        out.put("attention", attention.size() > 10 ? attention.subList(0, 10) : attention);
        out.put("attentionTotal", attention.size());

        // 按库类型：总数 / 有问题数
        Map<String, Map<String, Object>> byType = new LinkedHashMap<>();
        for (Map<String, Object> it : items) {
            String t = String.valueOf(it.get("dbType"));
            Map<String, Object> m = byType.computeIfAbsent(t, k -> new LinkedHashMap<>(Map.of("dbType", k, "total", 0, "problem", 0)));
            m.put("total", (int) m.get("total") + 1);
            String g = String.valueOf(it.get("grade"));
            if (!g.equals("HEALTHY") && !g.equals("UNKNOWN")) {
                m.put("problem", (int) m.get("problem") + 1);
            }
        }
        out.put("byType", new ArrayList<>(byType.values()));

        // 容量风险
        List<Map<String, Object>> risks = new ArrayList<>();
        for (Map<String, Object> it : items) {
            if (!(it.get("keyMetrics") instanceof Map<?, ?> km) || !"ONLINE".equals(it.get("status"))) {
                continue;
            }
            risk(risks, it, "表空间", km.get("tsMax"), 85);
            risk(risks, it, "文件系统", km.get("fsMax"), 85);
            risk(risks, it, "连接数", km.get("connPct"), 80);
        }
        risks.sort((x, y) -> Double.compare((double) y.get("value"), (double) x.get("value")));
        out.put("capacity", risks.size() > 8 ? risks.subList(0, 8) : risks);

        // 告警
        Map<String, Object> al = new LinkedHashMap<>();
        al.put("open", safe(() -> db.query("SELECT SEVERITY, COUNT(*) CNT FROM ALERT_RECORD WHERE STATUS IN ('OPEN','ACKNOWLEDGED') GROUP BY SEVERITY")));
        al.put("last24h", safe(() -> db.one("SELECT COUNT(*) NEW_CNT, SUM(CASE WHEN STATUS = 'RESOLVED' THEN 1 ELSE 0 END) RESOLVED_CNT "
                + "FROM ALERT_RECORD WHERE TRIGGER_TIME >= SYSTIMESTAMP - INTERVAL '1' DAY")));
        al.put("trend", safe(() -> db.query("SELECT TO_CHAR(TRIGGER_TIME, 'YYYY-MM-DD') DT, SEVERITY, COUNT(*) CNT FROM ALERT_RECORD "
                + "WHERE TRIGGER_TIME >= TRUNC(SYSDATE) - 6 GROUP BY TO_CHAR(TRIGGER_TIME, 'YYYY-MM-DD'), SEVERITY ORDER BY DT")));
        al.put("latest", safe(() -> db.query("SELECT ALERT_ID, INSTANCE_ID, INSTANCE_NAME, SEVERITY, RULE_NAME, CONTENT, STATUS, TRIGGER_TIME FROM ALERT_RECORD "
                + "WHERE STATUS IN ('OPEN','ACKNOWLEDGED') ORDER BY DECODE(SEVERITY, 'P1', 0, 'P2', 1, 2), TRIGGER_TIME DESC FETCH FIRST 8 ROWS ONLY")));
        al.put("topInstances", safe(() -> db.query("SELECT INSTANCE_ID, MAX(INSTANCE_NAME) INSTANCE_NAME, COUNT(*) CNT FROM ALERT_RECORD "
                + "WHERE TRIGGER_TIME >= SYSTIMESTAMP - INTERVAL '7' DAY AND INSTANCE_ID IS NOT NULL GROUP BY INSTANCE_ID ORDER BY CNT DESC FETCH FIRST 5 ROWS ONLY")));
        out.put("alerts", al);

        // SQL
        Map<String, Object> sql = new LinkedHashMap<>();
        sql.put("problems", count("SELECT COUNT(*) CNT FROM DI_SQL_PROBLEM WHERE STATUS = 'OPEN'"));
        sql.put("criticalProblems", count("SELECT COUNT(*) CNT FROM DI_SQL_PROBLEM WHERE STATUS = 'OPEN' AND SEVERITY = 'CRITICAL'"));
        sql.put("anomalies", count("SELECT COUNT(*) CNT FROM DI_SQL_ANOMALY WHERE STATUS = 'OPEN'"));
        sql.put("slow24h", count("SELECT COUNT(DISTINCT NVL(TO_CHAR(ASSET_ID), SQL_HASH)) CNT FROM SQL_SLOW_SUMMARY WHERE CAPTURE_TIME >= SYSTIMESTAMP - INTERVAL '1' DAY"));
        out.put("sql", sql);

        // 待办
        Map<String, Object> todo = new LinkedHashMap<>();
        todo.put("sqlReview", count("SELECT COUNT(*) CNT FROM SQL_REVIEW_TICKET WHERE STATUS IN ('PENDING','IN_REVIEW')"));
        todo.put("serviceOrders", count("SELECT COUNT(*) CNT FROM OPS_SERVICE_ORDER WHERE STATUS IN ('OPEN','IN_PROGRESS')"));
        todo.put("backupFailed24h", count("SELECT COUNT(*) CNT FROM BACKUP_RECORD_PRO WHERE STATUS = 'FAILED' AND CREATED_AT >= SYSTIMESTAMP - INTERVAL '1' DAY"));
        out.put("todo", todo);
        return out;
    }

    private static void risk(List<Map<String, Object>> out, Map<String, Object> it, String kind, Object v, double threshold) {
        Double d = Values.toDouble(v);
        if (d != null && d >= threshold) {
            out.add(new LinkedHashMap<>(Map.of("id", it.get("id"), "name", it.get("name"), "dbType", it.get("dbType"), "kind", kind, "value", d)));
        }
    }

    private long count(String sql) {
        try {
            Map<String, Object> r = db.one(sql);
            return r == null ? 0 : Values.toLong(r.get("CNT"), 0);
        } catch (Exception e) {
            return 0;
        }
    }

    private static Object safe(Supplier<Object> s) {
        try {
            return s.get();
        } catch (Exception e) {
            return List.of();
        }
    }
}
