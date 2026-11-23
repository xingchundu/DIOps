package com.dbops.monitor;

import com.dbops.common.BizException;
import com.dbops.common.Db;
import com.dbops.common.Values;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import java.util.stream.Collectors;

/**
 * 运行报告（日报 / 周报 / 月报 / 自定义时间段），可按环境或单个实例出报告。所有数字来自采集与业务表，不做估算以外的推断。
 * <pre>
 * 摘要       根据各节数据自动生成的结论（可用率、宕机、告警环比、容量与 SQL 风险）
 * 可用性     每个实例的可用率（可达样本 / 全部样本）、中断次数（可达→不可达的次数）、估算中断时长
 * 健康       期间平均分、最低分、当前等级
 * 告警       按级别与环比、MTTA（确认耗时）/ MTTR（解决耗时）、按天趋势、规则 Top、实例 Top
 * 容量       期初 / 期末的表空间、文件系统、连接数占比，以及期间变化
 * SQL        新增问题（按规则）、性能波动（按原因）、期间最慢的 SQL
 * 运维       备份成功 / 失败、巡检次数与平均分、SQL 审核工单、服务工单
 * </pre>
 */
@Service
public class ReportService {

    private final Db db;

    public ReportService(Db db) {
        this.db = db;
    }

    public record Scope(LocalDateTime from, LocalDateTime to, String env, Long instanceId) {
    }

    public Map<String, Object> build(Scope s) {
        if (!s.to().isAfter(s.from())) {
            throw new BizException(400, "结束时间必须晚于开始时间");
        }
        if (Duration.between(s.from(), s.to()).toDays() > 366) {
            throw new BizException(400, "报告时间段不能超过一年");
        }
        Timestamp from = Timestamp.valueOf(s.from());
        Timestamp to = Timestamp.valueOf(s.to());
        Duration span = Duration.between(s.from(), s.to());
        Timestamp prevFrom = Timestamp.valueOf(s.from().minus(span));

        List<Object> args = new ArrayList<>();
        StringBuilder where = new StringBuilder("1=1");
        if (s.env() != null && !s.env().isBlank()) {
            where.append(" AND ENVIRONMENT = ?");
            args.add(s.env());
        }
        if (s.instanceId() != null) {
            where.append(" AND INSTANCE_ID = ?");
            args.add(s.instanceId());
        }
        List<Map<String, Object>> insts = db.query("SELECT INSTANCE_ID, INSTANCE_NAME, DB_TYPE, ENVIRONMENT, BIZ_LINE, STATUS, HEALTH_SCORE FROM CMDB_INSTANCE WHERE "
                + where + " ORDER BY INSTANCE_NAME", args.toArray());
        String ids = insts.isEmpty() ? "-1" : insts.stream().map(i -> String.valueOf(Values.toLong(i.get("INSTANCE_ID")))).collect(Collectors.joining(","));
        String inIds = " INSTANCE_ID IN (" + ids + ")";
        boolean all = (s.env() == null || s.env().isBlank()) && s.instanceId() == null;

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", Map.of("from", s.from().toString(), "to", s.to().toString(), "env", s.env() == null ? "" : s.env(),
                "instanceId", s.instanceId() == null ? "" : s.instanceId(), "instances", insts.size()));

        // ---------------- 可用性 + 健康
        Map<Long, Map<String, Object>> avail = new HashMap<>();
        for (Map<String, Object> r : safeList(() -> db.query("SELECT INSTANCE_ID, COUNT(*) TOTAL, SUM(REACHABLE) UP, MIN(COLLECTED_AT) FIRST_AT, MAX(COLLECTED_AT) LAST_AT, "
                + "ROUND(AVG(CASE WHEN REACHABLE = 1 THEN HEALTH_SCORE END), 1) AVG_SCORE, MIN(CASE WHEN REACHABLE = 1 THEN HEALTH_SCORE END) MIN_SCORE "
                + "FROM MONITOR_METRIC_SAMPLE WHERE COLLECTED_AT >= ? AND COLLECTED_AT < ? AND" + inIds + " GROUP BY INSTANCE_ID", from, to))) {
            avail.put(Values.toLong(r.get("INSTANCE_ID")), r);
        }
        Map<Long, Long> outages = new HashMap<>();
        for (Map<String, Object> r : safeList(() -> db.query("SELECT INSTANCE_ID, SUM(CASE WHEN REACHABLE = 0 AND NVL(PREV, 1) = 1 THEN 1 ELSE 0 END) N FROM ("
                + "SELECT INSTANCE_ID, REACHABLE, LAG(REACHABLE) OVER (PARTITION BY INSTANCE_ID ORDER BY COLLECTED_AT) PREV FROM MONITOR_METRIC_SAMPLE "
                + "WHERE COLLECTED_AT >= ? AND COLLECTED_AT < ? AND" + inIds + ") GROUP BY INSTANCE_ID", from, to))) {
            outages.put(Values.toLong(r.get("INSTANCE_ID")), Values.toLong(r.get("N"), 0));
        }
        List<Map<String, Object>> availRows = new ArrayList<>();
        long sumTotal = 0;
        long sumUp = 0;
        double downMinutes = 0;
        int outageInstances = 0;
        for (Map<String, Object> i : insts) {
            long id = Values.toLong(i.get("INSTANCE_ID"));
            Map<String, Object> a = avail.get(id);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("INSTANCE_ID", id);
            row.put("INSTANCE_NAME", i.get("INSTANCE_NAME"));
            row.put("DB_TYPE", i.get("DB_TYPE"));
            row.put("ENVIRONMENT", i.get("ENVIRONMENT"));
            if (a == null) {
                row.put("SAMPLES", 0);
                availRows.add(row);
                continue;
            }
            long total = Values.toLong(a.get("TOTAL"), 0);
            long up = Values.toLong(a.get("UP"), 0);
            double pct = total == 0 ? 0 : up * 100.0 / total;
            double covered = a.get("FIRST_AT") instanceof Timestamp f && a.get("LAST_AT") instanceof Timestamp l ? (l.getTime() - f.getTime()) / 60000.0 : 0;
            double down = total == 0 ? 0 : (total - up) * 1.0 / total * covered;
            long n = outages.getOrDefault(id, 0L);
            row.put("SAMPLES", total);
            row.put("AVAILABILITY", Values.round(pct, 2));
            row.put("OUTAGES", n);
            row.put("DOWN_MINUTES", Math.round(down));
            row.put("AVG_SCORE", a.get("AVG_SCORE"));
            row.put("MIN_SCORE", a.get("MIN_SCORE"));
            row.put("CURRENT_GRADE", "ERROR".equals(i.get("STATUS")) ? "OFFLINE"
                    : HealthScorer.grade(Values.toLong(i.get("HEALTH_SCORE")) == null ? null : Values.toLong(i.get("HEALTH_SCORE")).intValue()));
            availRows.add(row);
            sumTotal += total;
            sumUp += up;
            downMinutes += down;
            if (n > 0) {
                outageInstances++;
            }
        }
        availRows.sort((x, y) -> Double.compare(d(x.get("AVAILABILITY"), 101), d(y.get("AVAILABILITY"), 101)));
        Map<String, Object> av = new LinkedHashMap<>();
        av.put("overall", sumTotal == 0 ? null : Values.round(sumUp * 100.0 / sumTotal, 3));
        av.put("downMinutes", Math.round(downMinutes));
        av.put("outageInstances", outageInstances);
        av.put("rows", availRows);
        out.put("availability", av);

        // ---------------- 告警
        String aWhere = all ? "" : " AND" + inIds;
        Map<String, Object> al = new LinkedHashMap<>();
        al.put("bySeverity", safeList(() -> db.query("SELECT SEVERITY, COUNT(*) CNT FROM ALERT_RECORD WHERE TRIGGER_TIME >= ? AND TRIGGER_TIME < ?" + aWhere
                + " GROUP BY SEVERITY ORDER BY SEVERITY", from, to)));
        Map<String, Object> cur = safeOne(() -> db.one("SELECT COUNT(*) TOTAL, SUM(CASE WHEN STATUS = 'RESOLVED' THEN 1 ELSE 0 END) RESOLVED, "
                + "ROUND(AVG(CASE WHEN ACK_TIME IS NOT NULL THEN (CAST(ACK_TIME AS DATE) - CAST(TRIGGER_TIME AS DATE)) * 1440 END), 1) MTTA_MIN, "
                + "ROUND(AVG(CASE WHEN RESOLVE_TIME IS NOT NULL THEN (CAST(RESOLVE_TIME AS DATE) - CAST(TRIGGER_TIME AS DATE)) * 1440 END), 1) MTTR_MIN "
                + "FROM ALERT_RECORD WHERE TRIGGER_TIME >= ? AND TRIGGER_TIME < ?" + aWhere, from, to));
        Map<String, Object> prev = safeOne(() -> db.one("SELECT COUNT(*) TOTAL FROM ALERT_RECORD WHERE TRIGGER_TIME >= ? AND TRIGGER_TIME < ?" + aWhere, prevFrom, from));
        al.put("summary", cur);
        al.put("previousTotal", prev.get("TOTAL"));
        al.put("trend", safeList(() -> db.query("SELECT TO_CHAR(TRIGGER_TIME, 'YYYY-MM-DD') DT, SEVERITY, COUNT(*) CNT FROM ALERT_RECORD "
                + "WHERE TRIGGER_TIME >= ? AND TRIGGER_TIME < ?" + aWhere + " GROUP BY TO_CHAR(TRIGGER_TIME, 'YYYY-MM-DD'), SEVERITY ORDER BY DT", from, to)));
        al.put("topRules", safeList(() -> db.query("SELECT NVL(RULE_NAME, '其他') RULE_NAME, COUNT(*) CNT, SUM(CASE WHEN STATUS = 'RESOLVED' THEN 1 ELSE 0 END) RESOLVED "
                + "FROM ALERT_RECORD WHERE TRIGGER_TIME >= ? AND TRIGGER_TIME < ?" + aWhere + " GROUP BY NVL(RULE_NAME, '其他') ORDER BY CNT DESC FETCH FIRST 10 ROWS ONLY", from, to)));
        al.put("topInstances", safeList(() -> db.query("SELECT INSTANCE_ID, MAX(INSTANCE_NAME) INSTANCE_NAME, COUNT(*) CNT, "
                + "SUM(CASE WHEN SEVERITY IN ('P1','CRITICAL') THEN 1 ELSE 0 END) P1 FROM ALERT_RECORD WHERE TRIGGER_TIME >= ? AND TRIGGER_TIME < ? "
                + "AND INSTANCE_ID IS NOT NULL" + aWhere + " GROUP BY INSTANCE_ID ORDER BY CNT DESC FETCH FIRST 10 ROWS ONLY", from, to)));
        out.put("alerts", al);

        // ---------------- 容量（期初 / 期末 keyMetrics）
        Map<Long, Map<String, Object>> first = new HashMap<>();
        Map<Long, Map<String, Object>> last = new HashMap<>();
        for (Map<String, Object> r : safeList(() -> db.query("SELECT INSTANCE_ID, HEALTH_DETAIL, RN_A, RN_D FROM (SELECT INSTANCE_ID, HEALTH_DETAIL, "
                + "ROW_NUMBER() OVER (PARTITION BY INSTANCE_ID ORDER BY COLLECTED_AT) RN_A, ROW_NUMBER() OVER (PARTITION BY INSTANCE_ID ORDER BY COLLECTED_AT DESC) RN_D "
                + "FROM MONITOR_METRIC_SAMPLE WHERE COLLECTED_AT >= ? AND COLLECTED_AT < ? AND REACHABLE = 1 AND" + inIds + ") WHERE RN_A = 1 OR RN_D = 1", from, to))) {
            Map<String, Object> d = MonitorBoardService.parse(r.get("HEALTH_DETAIL"));
            Object km = d == null ? null : d.get("keyMetrics");
            if (!(km instanceof Map<?, ?>)) {
                continue;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> k = (Map<String, Object>) km;
            long id = Values.toLong(r.get("INSTANCE_ID"));
            if (Values.toLong(r.get("RN_A"), 0) == 1) {
                first.put(id, k);
            }
            if (Values.toLong(r.get("RN_D"), 0) == 1) {
                last.put(id, k);
            }
        }
        List<Map<String, Object>> cap = new ArrayList<>();
        for (Map<String, Object> i : insts) {
            long id = Values.toLong(i.get("INSTANCE_ID"));
            Map<String, Object> l = last.get(id);
            if (l == null) {
                continue;
            }
            Map<String, Object> f = first.getOrDefault(id, Map.of());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("INSTANCE_ID", id);
            row.put("INSTANCE_NAME", i.get("INSTANCE_NAME"));
            row.put("DB_TYPE", i.get("DB_TYPE"));
            for (String key : List.of("tsMax", "fsMax", "connPct")) {
                Double end = Values.toDouble(l.get(key));
                Double start = Values.toDouble(f.get(key));
                row.put(key, end);
                row.put(key + "Delta", end != null && start != null ? Values.round(end - start, 2) : null);
            }
            cap.add(row);
        }
        cap.sort((x, y) -> Double.compare(maxOf(y), maxOf(x)));
        out.put("capacity", cap);

        // ---------------- SQL
        Map<String, Object> sql = new LinkedHashMap<>();
        sql.put("problemsByRule", safeList(() -> db.query("SELECT p.RULE_CODE, MAX(r.RULE_NAME) RULE_NAME, COUNT(*) CNT, "
                + "SUM(CASE WHEN p.STATUS = 'OPEN' THEN 1 ELSE 0 END) OPEN_CNT FROM DI_SQL_PROBLEM p LEFT JOIN DI_SQL_RULE r ON r.RULE_CODE = p.RULE_CODE AND r.SCOPE_TYPE = 'GLOBAL' "
                + "WHERE p.FIRST_SEEN >= ? AND p.FIRST_SEEN < ? AND p." + inIds.trim() + " GROUP BY p.RULE_CODE ORDER BY CNT DESC", from, to)));
        sql.put("anomaliesByCause", safeList(() -> db.query("SELECT NVL(c.PRIMARY_CAUSE, '未诊断') CAUSE, COUNT(*) CNT FROM DI_SQL_ANOMALY x LEFT JOIN ("
                + "SELECT ANOMALY_ID, MAX(PRIMARY_CAUSE) KEEP (DENSE_RANK LAST ORDER BY CREATED_AT) PRIMARY_CAUSE FROM DI_SQL_ANOMALY_DIAGNOSIS WHERE STATUS = 'DONE' GROUP BY ANOMALY_ID) c "
                + "ON c.ANOMALY_ID = x.ANOMALY_ID WHERE x.START_TIME >= ? AND x.START_TIME < ? AND x." + inIds.trim() + " GROUP BY NVL(c.PRIMARY_CAUSE, '未诊断') ORDER BY CNT DESC", from, to)));
        sql.put("slowTop", safeList(() -> db.query("SELECT * FROM (SELECT s.SQL_HASH, MAX(i.INSTANCE_NAME) INSTANCE_NAME, MAX(s.AVG_ELAPSED) AVG_MS, MAX(s.EXEC_COUNT) EXECS, "
                + "COUNT(*) TIMES, MAX(DBMS_LOB.SUBSTR(s.SQL_TEXT, 200, 1)) SQL_TEXT FROM SQL_SLOW_SUMMARY s LEFT JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = s.INSTANCE_ID "
                + "WHERE s.CAPTURE_TIME >= ? AND s.CAPTURE_TIME < ? AND s." + inIds.trim() + " GROUP BY s.SQL_HASH ORDER BY AVG_MS DESC NULLS LAST) WHERE ROWNUM <= 10", from, to)));
        out.put("sql", sql);

        // ---------------- 运维
        Map<String, Object> ops = new LinkedHashMap<>();
        ops.put("backup", safeOne(() -> db.one("SELECT COUNT(*) TOTAL, SUM(CASE WHEN STATUS = 'SUCCESS' THEN 1 ELSE 0 END) SUCCESS, "
                + "SUM(CASE WHEN STATUS = 'FAILED' THEN 1 ELSE 0 END) FAILED FROM BACKUP_RECORD_PRO WHERE CREATED_AT >= ? AND CREATED_AT < ? AND" + inIds, from, to)));
        ops.put("inspect", safeOne(() -> db.one("SELECT COUNT(*) TOTAL, ROUND(AVG(OVERALL_SCORE), 1) AVG_SCORE, "
                + "SUM(CASE WHEN OVERALL_STATUS = 'CRITICAL' THEN 1 ELSE 0 END) CRITICAL, SUM(CASE WHEN OVERALL_STATUS = 'WARNING' THEN 1 ELSE 0 END) WARNING "
                + "FROM INSPECT_REPORT WHERE EXECUTED_AT >= ? AND EXECUTED_AT < ? AND" + inIds, from, to)));
        ops.put("sqlReview", safeOne(() -> db.one("SELECT COUNT(*) TOTAL, SUM(CASE WHEN STATUS = 'APPROVED' THEN 1 ELSE 0 END) APPROVED, "
                + "SUM(CASE WHEN STATUS = 'REJECTED' THEN 1 ELSE 0 END) REJECTED, SUM(CASE WHEN STATUS IN ('PENDING','IN_REVIEW') THEN 1 ELSE 0 END) PENDING "
                + "FROM SQL_REVIEW_TICKET WHERE CREATED_AT >= ? AND CREATED_AT < ?" + (all ? "" : " AND" + inIds), from, to)));
        if (all) {
            ops.put("serviceOrders", safeOne(() -> db.one("SELECT COUNT(*) TOTAL, SUM(CASE WHEN STATUS IN ('CLOSED','RESOLVED') THEN 1 ELSE 0 END) DONE, "
                    + "SUM(CASE WHEN STATUS IN ('OPEN','IN_PROGRESS','PENDING_REVIEW') THEN 1 ELSE 0 END) PENDING FROM OPS_SERVICE_ORDER WHERE CREATED_AT >= ? AND CREATED_AT < ?", from, to)));
        }
        out.put("ops", ops);

        out.put("findings", findings(av, cur, prev, cap, sql, ops));
        return out;
    }

    /** 摘要：按严重程度列出结论 */
    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> findings(Map<String, Object> av, Map<String, Object> alertCur, Map<String, Object> alertPrev,
                                              List<Map<String, Object>> cap, Map<String, Object> sql, Map<String, Object> ops) {
        List<Map<String, Object>> f = new ArrayList<>();
        Double overall = Values.toDouble(av.get("overall"));
        if (overall == null) {
            f.add(finding("INFO", "期间没有采集数据，无法计算可用率"));
        } else {
            List<Map<String, Object>> rows = (List<Map<String, Object>>) av.get("rows");
            List<String> bad = rows.stream().filter(r -> Values.toLong(r.get("OUTAGES"), 0) > 0)
                    .map(r -> r.get("INSTANCE_NAME") + "（" + r.get("OUTAGES") + " 次，约 " + r.get("DOWN_MINUTES") + " 分钟）").toList();
            if (bad.isEmpty()) {
                f.add(finding("OK", String.format("整体可用率 %.2f%%，期间没有实例中断", overall)));
            } else {
                f.add(finding(overall < 99 ? "CRIT" : "WARN", String.format("整体可用率 %.2f%%；%d 个实例发生中断：%s", overall, bad.size(),
                        String.join("、", bad.size() > 5 ? bad.subList(0, 5) : bad) + (bad.size() > 5 ? " 等" : ""))));
            }
        }
        long total = Values.toLong(alertCur.get("TOTAL"), 0);
        long prevTotal = Values.toLong(alertPrev.get("TOTAL"), 0);
        String change = prevTotal == 0 ? (total == 0 ? "" : "（上一周期为 0）")
                : String.format("，较上一周期%s %d%%", total >= prevTotal ? "增加" : "减少", Math.round(Math.abs(total - prevTotal) * 100.0 / prevTotal));
        Object mttr = alertCur.get("MTTR_MIN");
        f.add(finding(total > prevTotal * 1.5 && total > 10 ? "WARN" : "INFO", "告警 " + total + " 条" + change
                + (mttr != null ? "；平均解决耗时 " + mttr + " 分钟" : "")));
        List<String> capRisk = new ArrayList<>();
        for (Map<String, Object> c : cap) {
            Double ts = Values.toDouble(c.get("tsMax"));
            Double fs = Values.toDouble(c.get("fsMax"));
            if (ts != null && ts >= 85) {
                capRisk.add(c.get("INSTANCE_NAME") + " 表空间 " + Math.round(ts) + "%");
            }
            if (fs != null && fs >= 85) {
                capRisk.add(c.get("INSTANCE_NAME") + " 文件系统 " + Math.round(fs) + "%");
            }
        }
        if (!capRisk.isEmpty()) {
            f.add(finding("WARN", "容量接近上限：" + String.join("、", capRisk.size() > 5 ? capRisk.subList(0, 5) : capRisk) + (capRisk.size() > 5 ? " 等" : "")));
        }
        long newProblems = ((List<Map<String, Object>>) sql.get("problemsByRule")).stream().mapToLong(r -> Values.toLong(r.get("CNT"), 0)).sum();
        long anomalies = ((List<Map<String, Object>>) sql.get("anomaliesByCause")).stream().mapToLong(r -> Values.toLong(r.get("CNT"), 0)).sum();
        if (newProblems + anomalies > 0) {
            f.add(finding("INFO", "新增 SQL 问题 " + newProblems + " 个、性能波动 " + anomalies + " 次"));
        }
        Map<String, Object> bk = (Map<String, Object>) ops.get("backup");
        long failed = Values.toLong(bk.get("FAILED"), 0);
        if (failed > 0) {
            f.add(finding("WARN", "备份失败 " + failed + " 次（共 " + Values.toLong(bk.get("TOTAL"), 0) + " 次）"));
        }
        f.sort((a, b) -> Integer.compare(order(String.valueOf(a.get("level"))), order(String.valueOf(b.get("level")))));
        return f;
    }

    private static int order(String l) {
        return switch (l) {
            case "CRIT" -> 0;
            case "WARN" -> 1;
            case "INFO" -> 2;
            default -> 3;
        };
    }

    private static Map<String, Object> finding(String level, String text) {
        return Map.of("level", level, "text", text);
    }

    private static double d(Object v, double dflt) {
        Double x = Values.toDouble(v);
        return x == null ? dflt : x;
    }

    private static double maxOf(Map<String, Object> r) {
        return Math.max(d(r.get("tsMax"), 0), Math.max(d(r.get("fsMax"), 0), d(r.get("connPct"), 0)));
    }

    private static List<Map<String, Object>> safeList(Supplier<List<Map<String, Object>>> s) {
        try {
            return s.get();
        } catch (Exception e) {
            return List.of();
        }
    }

    private static Map<String, Object> safeOne(Supplier<Map<String, Object>> s) {
        try {
            Map<String, Object> m = s.get();
            return m == null ? Map.of() : m;
        } catch (Exception e) {
            return Map.of();
        }
    }

    /** 报告类型 → 时间段（按北京时间整天）：DAY 昨天、WEEK 上周一~周日、MONTH 上个月；CUSTOM 用传入的日期 */
    public static LocalDateTime[] period(String type, LocalDate today, String from, String to) {
        return switch (type == null ? "WEEK" : type.toUpperCase()) {
            case "DAY" -> new LocalDateTime[]{today.minusDays(1).atStartOfDay(), today.atStartOfDay()};
            case "MONTH" -> new LocalDateTime[]{today.withDayOfMonth(1).minusMonths(1).atStartOfDay(), today.withDayOfMonth(1).atStartOfDay()};
            case "CUSTOM" -> {
                if (from == null || to == null) {
                    throw new BizException(400, "自定义报告需要开始和结束日期");
                }
                yield new LocalDateTime[]{LocalDate.parse(from.substring(0, 10)).atStartOfDay(), LocalDate.parse(to.substring(0, 10)).plusDays(1).atStartOfDay()};
            }
            default -> {
                LocalDate monday = today.minusDays(today.getDayOfWeek().getValue() - 1L);
                yield new LocalDateTime[]{monday.minusWeeks(1).atStartOfDay(), monday.atStartOfDay()};
            }
        };
    }
}
