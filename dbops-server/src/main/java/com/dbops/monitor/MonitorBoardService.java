package com.dbops.monitor;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 监控中心总览（实例卡片墙）与控制台共用的数据：每个实例的状态、健康等级、扣分项、关键指标、近 2 小时走势、未处理告警。
 * 一次查询全部实例（最新样本 + 2 小时样本 + 告警聚合），不逐实例查库。
 *
 * <pre>
 * 状态 status：ONLINE 在线 / OFFLINE 连接失败 / STALE 数据过期（超过 3 个采集周期没有新样本，至少 10 分钟）/ NEVER 未采集 / STOPPED 已停用
 * 等级 grade ：HEALTHY 健康（≥90）/ ATTENTION 关注（60~89）/ CRITICAL 严重（&lt;60）/ OFFLINE 离线 / UNKNOWN 无数据
 * </pre>
 */
@Service
public class MonitorBoardService {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int SPARK_POINTS = 24;

    private final Db db;
    private final CollectService collect;

    public MonitorBoardService(Db db, CollectService collect) {
        this.db = db;
        this.collect = collect;
    }

    public Map<String, Object> board() {
        List<Map<String, Object>> insts = db.query("SELECT INSTANCE_ID, INSTANCE_NAME, DB_TYPE, HOST_IP, PORT, STATUS, HEALTH_SCORE, ENVIRONMENT, "
                + "BIZ_LINE, ROLE, LAST_CHECK, COLLECT_INTERVAL_SEC FROM CMDB_INSTANCE ORDER BY INSTANCE_NAME");
        Map<Long, Map<String, Object>> latest = new HashMap<>();
        for (Map<String, Object> r : db.query("SELECT INSTANCE_ID, COLLECTED_AT, REACHABLE, HEALTH_SCORE, HEALTH_DETAIL, ERR_MSG FROM ("
                + "SELECT s.INSTANCE_ID, s.COLLECTED_AT, s.REACHABLE, s.HEALTH_SCORE, s.HEALTH_DETAIL, s.ERR_MSG, "
                + "ROW_NUMBER() OVER (PARTITION BY s.INSTANCE_ID ORDER BY s.COLLECTED_AT DESC) RN FROM MONITOR_METRIC_SAMPLE s "
                + "WHERE s.COLLECTED_AT >= SYSTIMESTAMP - INTERVAL '7' DAY) WHERE RN = 1")) {
            latest.put(Values.toLong(r.get("INSTANCE_ID")), r);
        }
        Map<Long, List<Map<String, Object>>> spark = new HashMap<>();
        for (Map<String, Object> r : db.query("SELECT INSTANCE_ID, COLLECTED_AT, HEALTH_SCORE, METRIC_CPU, METRIC_CONN, REACHABLE FROM MONITOR_METRIC_SAMPLE "
                + "WHERE COLLECTED_AT >= SYSTIMESTAMP - INTERVAL '2' HOUR ORDER BY INSTANCE_ID, COLLECTED_AT")) {
            spark.computeIfAbsent(Values.toLong(r.get("INSTANCE_ID")), k -> new ArrayList<>()).add(r);
        }
        Map<Long, Map<String, Object>> alerts = new HashMap<>();
        for (Map<String, Object> r : db.query("SELECT INSTANCE_ID, COUNT(*) TOTAL, SUM(CASE WHEN SEVERITY IN ('P1','CRITICAL') THEN 1 ELSE 0 END) P1, "
                + "SUM(CASE WHEN SEVERITY IN ('P2','WARNING') THEN 1 ELSE 0 END) P2 FROM ALERT_RECORD WHERE STATUS = 'OPEN' AND INSTANCE_ID IS NOT NULL "
                + "GROUP BY INSTANCE_ID")) {
            alerts.put(Values.toLong(r.get("INSTANCE_ID")), r);
        }

        long now = System.currentTimeMillis();
        long globalMs = collect.intervalMs();
        List<Map<String, Object>> items = new ArrayList<>();
        Map<String, Integer> byGrade = new LinkedHashMap<>();
        for (String g : List.of("HEALTHY", "ATTENTION", "CRITICAL", "OFFLINE", "UNKNOWN")) {
            byGrade.put(g, 0);
        }
        Map<String, Integer> byStatus = new LinkedHashMap<>();
        int p1 = 0;
        int p2 = 0;
        int alertTotal = 0;
        for (Map<String, Object> i : insts) {
            long id = Values.toLong(i.get("INSTANCE_ID"));
            Map<String, Object> s = latest.get(id);
            Map<String, Object> al = alerts.get(id);
            long perMs = Values.toLong(i.get("COLLECT_INTERVAL_SEC"), 0) > 0 ? Values.toLong(i.get("COLLECT_INTERVAL_SEC"), 0) * 1000 : globalMs;
            Item it = item(i, s, al, now, perMs);
            it.map.put("spark", spark(spark.get(id)));
            items.add(it.map);
            byGrade.merge(it.grade, 1, Integer::sum);
            byStatus.merge(it.status, 1, Integer::sum);
            if (al != null) {
                p1 += Values.toLong(al.get("P1"), 0);
                p2 += Values.toLong(al.get("P2"), 0);
                alertTotal += Values.toLong(al.get("TOTAL"), 0);
            }
        }
        // 排序：严重 → 离线 → 关注 → 无数据 → 健康；同级按分数升序，问题多的在前
        Map<String, Integer> rank = Map.of("CRITICAL", 0, "OFFLINE", 1, "ATTENTION", 2, "UNKNOWN", 3, "HEALTHY", 4);
        items.sort((a, b) -> {
            int c = Integer.compare(rank.get((String) a.get("grade")), rank.get((String) b.get("grade")));
            if (c != 0) {
                return c;
            }
            Integer sa = (Integer) a.get("score");
            Integer sb = (Integer) b.get("score");
            return Integer.compare(sa == null ? 101 : sa, sb == null ? 101 : sb);
        });
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("total", insts.size());
        summary.put("byGrade", byGrade);
        summary.put("byStatus", byStatus);
        summary.put("alerts", Map.of("total", alertTotal, "p1", p1, "p2", p2));
        summary.put("intervalSec", globalMs / 1000);
        return Map.of("summary", summary, "items", items);
    }

    record Item(Map<String, Object> map, String grade, String status) {
    }

    @SuppressWarnings("unchecked")
    static Item item(Map<String, Object> i, Map<String, Object> s, Map<String, Object> al, long now, long intervalMs) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", i.get("INSTANCE_ID"));
        m.put("name", i.get("INSTANCE_NAME"));
        m.put("dbType", i.get("DB_TYPE"));
        m.put("host", i.get("HOST_IP"));
        m.put("port", i.get("PORT"));
        m.put("env", i.get("ENVIRONMENT"));
        m.put("bizLine", i.get("BIZ_LINE"));
        m.put("role", i.get("ROLE"));
        m.put("alerts", Map.of("total", al == null ? 0 : Values.toLong(al.get("TOTAL"), 0),
                "p1", al == null ? 0 : Values.toLong(al.get("P1"), 0), "p2", al == null ? 0 : Values.toLong(al.get("P2"), 0)));

        String status;
        String grade;
        Integer score = null;
        if ("STOPPED".equals(i.get("STATUS"))) {
            status = "STOPPED";
            grade = "UNKNOWN";
        } else if (s == null) {
            status = "NEVER";
            grade = "UNKNOWN";
        } else {
            long at = s.get("COLLECTED_AT") instanceof Timestamp t ? t.getTime() : now;
            m.put("collectedAt", s.get("COLLECTED_AT"));
            m.put("ageSec", Math.max(0, (now - at) / 1000));
            boolean reachable = Values.toLong(s.get("REACHABLE"), 1) == 1;
            Map<String, Object> d = parse(s.get("HEALTH_DETAIL"));
            if (!reachable) {
                status = "OFFLINE";
                grade = "OFFLINE";
                m.put("error", friendlyError(Values.str(s.get("ERR_MSG"), "")));
            } else {
                score = Values.toLong(s.get("HEALTH_SCORE")) == null ? null : Values.toLong(s.get("HEALTH_SCORE")).intValue();
                grade = d != null && d.get("grade") != null ? String.valueOf(d.get("grade")) : HealthScorer.grade(score);
                status = now - at > Math.max(3 * intervalMs, 10 * 60_000L) ? "STALE" : "ONLINE";
                if (status.equals("STALE")) {
                    grade = "UNKNOWN";   // 数据过期时不给结论，避免用旧数据显示“健康”
                }
            }
            if (d != null) {
                Object issues = d.get("issues");
                if (issues instanceof List<?> l && d.get("version") != null) {
                    m.put("issues", l.size() > 3 ? l.subList(0, 3) : l);
                    m.put("issueCount", l.size());
                }
                m.put("checked", d.get("checked"));
                m.put("keyMetrics", d.get("keyMetrics"));
                if (d.get("categories") instanceof Map<?, ?> cats) {
                    m.put("categories", cats);
                }
            }
        }
        m.put("status", status);
        m.put("grade", grade);
        m.put("score", score);
        return new Item(m, grade, status);
    }

    /** 2 小时样本降采样到不超过 24 个点 */
    static Map<String, Object> spark(List<Map<String, Object>> rows) {
        List<Object> t = new ArrayList<>();
        List<Object> cpu = new ArrayList<>();
        List<Object> health = new ArrayList<>();
        List<Object> conn = new ArrayList<>();
        if (rows != null && !rows.isEmpty()) {
            int step = Math.max(1, (int) Math.ceil(rows.size() / (double) SPARK_POINTS));
            for (int k = 0; k < rows.size(); k += step) {
                Map<String, Object> r = rows.get(Math.min(rows.size() - 1, k + step - 1));
                t.add(r.get("COLLECTED_AT"));
                cpu.add(r.get("METRIC_CPU"));
                health.add(Values.toLong(r.get("REACHABLE"), 1) == 1 ? r.get("HEALTH_SCORE") : null);
                conn.add(r.get("METRIC_CONN"));
            }
        }
        return Map.of("t", t, "cpu", cpu, "health", health, "conn", conn);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> parse(Object json) {
        if (json == null) {
            return null;
        }
        try {
            Object o = MAPPER.readValue(String.valueOf(json), Object.class);
            return o instanceof Map ? (Map<String, Object>) o : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** 连接失败原因转成一句话（原始报错保留在实例详情里） */
    public static String friendlyError(String err) {
        String e = err == null ? "" : err;
        String u = e.toUpperCase();
        String hint;
        if (u.contains("ORA-01017") || u.contains("ACCESS DENIED") || u.contains("PASSWORD AUTHENTICATION FAILED") || u.contains("LOGIN FAILED")) {
            hint = "用户名或密码错误";
        } else if (u.contains("ORA-12541") || u.contains("CONNECTION REFUSED") || u.contains("拒绝连接")) {
            hint = "端口拒绝连接（数据库或监听未启动）";
        } else if (u.contains("ORA-12514") || u.contains("ORA-12505")) {
            hint = "监听中找不到服务名 / SID";
        } else if (u.contains("TIMED OUT") || u.contains("TIMEOUT") || u.contains("超时") || u.contains("ORA-12170")) {
            hint = "连接超时（网络不通或防火墙）";
        } else if (u.contains("UNKNOWN HOST") || u.contains("UNKNOWNHOST")) {
            hint = "主机名无法解析";
        } else if (u.contains("ORA-28000")) {
            hint = "账号已锁定";
        } else if (u.contains("ORA-01034") || u.contains("ORA-01033")) {
            hint = "数据库未启动或正在启动/关闭";
        } else {
            hint = "连接失败";
        }
        return hint;
    }
}
