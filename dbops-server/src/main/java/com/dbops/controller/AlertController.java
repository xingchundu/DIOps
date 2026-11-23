package com.dbops.controller;

import com.dbops.alert.AlertPolicyService;
import com.dbops.alert.CronWindow;
import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.security.CurrentUser;
import com.dbops.service.AuditService;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/**
 * /api/alerts（同 Node routes/alerts.js）
 */
@RestController
@RequestMapping("/api/alerts")
public class AlertController {

    private static final List<String> OPERATORS = List.of("gt", "lt", "gte", "lte", "eq", "ne", "neq");
    private static final List<String> SEVERITIES = List.of("P1", "P2", "P3", "P4");
    private static final List<String> SUPPRESSION_TYPES = List.of("TOPOLOGY", "CLUSTER", "SEVERITY", "INSTANCE");

    private final Db db;
    private final AlertPolicyService policies;
    private final AuditService audit;

    public AlertController(Db db, AlertPolicyService policies, AuditService audit) {
        this.db = db;
        this.policies = policies;
        this.audit = audit;
    }

    // ============================ 告警记录 ============================

    @GetMapping
    public Map<String, Object> list(@RequestParam(required = false) String status,
                                    @RequestParam(required = false) String severity,
                                    @RequestParam(required = false) String instanceId,
                                    @RequestParam(required = false, defaultValue = "1") String page,
                                    @RequestParam(required = false, defaultValue = "20") String size,
                                    @RequestParam(required = false) String skipPolicies) {
        if (!"1".equals(skipPolicies)) {
            policies.applyIfStale();
        }
        List<String> where = new ArrayList<>(List.of("1=1"));
        List<Object> args = new ArrayList<>();
        if (!Values.isBlank(status)) {
            where.add("STATUS=?");
            args.add(status.trim());
        }
        if (!Values.isBlank(severity)) {
            where.add("SEVERITY=?");
            args.add(severity.trim());
        }
        if (!Values.isBlank(instanceId)) {
            where.add("INSTANCE_ID=?");
            args.add(Values.toLong(instanceId));
        }
        return R.ok(db.queryPage("SELECT * FROM ALERT_RECORD WHERE " + String.join(" AND ", where) + " ORDER BY TRIGGER_TIME DESC", args, page, size));
    }

    @GetMapping("/stats")
    public Map<String, Object> stats() {
        return R.ok(R.map(
                "byStatus", db.query("SELECT STATUS, COUNT(*) CNT FROM ALERT_RECORD GROUP BY STATUS"),
                "bySeverity", db.query("SELECT SEVERITY, COUNT(*) CNT FROM ALERT_RECORD WHERE STATUS='OPEN' GROUP BY SEVERITY"),
                "trend", db.query("SELECT TO_CHAR(TRIGGER_TIME,'YYYY-MM-DD') DT, COUNT(*) CNT FROM ALERT_RECORD WHERE TRIGGER_TIME >= SYSDATE-7 "
                        + "GROUP BY TO_CHAR(TRIGGER_TIME,'YYYY-MM-DD') ORDER BY DT")));
    }

    @PostMapping("/{id}/ack")
    public Map<String, Object> ack(CurrentUser u, @PathVariable("id") long id) {
        u.require("ADMIN", "DBA", "OPS");
        Map<String, Object> a = db.one("SELECT STATUS FROM ALERT_RECORD WHERE ALERT_ID=?", id);
        if (a == null) {
            return R.notFound("告警不存在");
        }
        if ("RESOLVED".equals(a.get("STATUS"))) {
            return R.badRequest("告警已解决，无需确认");
        }
        db.update("UPDATE ALERT_RECORD SET STATUS='ACKNOWLEDGED', ACK_TIME=SYSTIMESTAMP, ACK_BY=? WHERE ALERT_ID=? AND STATUS<>'RESOLVED'",
                u.username(), id);
        return R.msg("告警已确认");
    }

    @PostMapping("/{id}/resolve")
    public Map<String, Object> resolve(CurrentUser u, @PathVariable("id") long id) {
        u.require("ADMIN", "DBA", "OPS");
        if (db.one("SELECT STATUS FROM ALERT_RECORD WHERE ALERT_ID=?", id) == null) {
            return R.notFound("告警不存在");
        }
        db.update("UPDATE ALERT_RECORD SET STATUS='RESOLVED', RESOLVE_TIME=SYSTIMESTAMP, RESOLVE_BY=? WHERE ALERT_ID=? AND STATUS<>'RESOLVED'",
                u.username(), id);
        policies.releaseSuppressedChildren(id);
        return R.msg("告警已解决");
    }

    // ============================ 告警规则 ============================

    @GetMapping("/rules")
    public Map<String, Object> rules() {
        return R.ok(db.query("SELECT * FROM ALERT_RULE ORDER BY RULE_ID"));
    }

    @PostMapping("/rules")
    public Map<String, Object> createRule(CurrentUser u, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        String name = Values.str(Values.get(b, "ruleName"));
        String metric = Values.str(Values.get(b, "metric"));
        if (name == null || metric == null) {
            return R.badRequest("规则名称和监控指标不能为空");
        }
        String op = Values.str(Values.get(b, "operator"), "gt");
        if (!OPERATORS.contains(op)) {
            return R.badRequest("运算符无效");
        }
        Object th = Values.get(b, "threshold");
        if (!Values.isBlank(th) && Values.toDouble(th) == null) {
            return R.badRequest("阈值必须为数字");
        }
        String sev = Values.str(Values.get(b, "severity"), "P3");
        if (!SEVERITIES.contains(sev)) {
            return R.badRequest("告警级别无效（P1~P4）");
        }
        Long duration = Values.toLong(Values.get(b, "duration"));
        db.update("INSERT INTO ALERT_RULE(RULE_NAME,RULE_TYPE,METRIC,OPERATOR,THRESHOLD,DURATION,SEVERITY,DB_TYPE,INSTANCE_ID,TABLESPACE_NAME,TARGET_HOST_IP,PROMQL,NOTIFY_CHAN,NOTIFY_TO,CREATED_BY) "
                        + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                name, Values.str(Values.get(b, "ruleType"), "THRESHOLD"), metric, op, Values.toDouble(th),
                duration == null ? 5 : Math.max(0, duration), sev, Values.str(Values.get(b, "dbType")), Values.toLong(Values.get(b, "instanceId")),
                normalizeTablespaces(Values.get(b, "tablespaceName")), Values.str(Values.get(b, "targetHostIp")),
                Values.str(Values.get(b, "promql")), Values.str(Values.get(b, "notifyChan")), Values.str(Values.get(b, "notifyTo")), u.userId());
        audit.log(u, "CREATE_ALERT_RULE", name, null, "SUCCESS", metric + " " + op + " " + th);
        return R.msg("告警规则创建成功");
    }

    @DeleteMapping("/rules/{id}")
    public Map<String, Object> deleteRule(CurrentUser u, @PathVariable("id") long id) {
        u.require("ADMIN", "DBA");
        if (db.update("DELETE FROM ALERT_RULE WHERE RULE_ID=?", id) == 0) {
            return R.notFound("规则不存在");
        }
        audit.log(u, "DELETE_ALERT_RULE", String.valueOf(id), String.valueOf(id), "SUCCESS", null);
        return R.msg("规则已删除");
    }

    @PutMapping("/rules/{id}")
    public Map<String, Object> updateRule(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        String op = Values.str(Values.get(b, "operator"));
        if (op != null && !OPERATORS.contains(op)) {
            return R.badRequest("运算符无效");
        }
        Object th = Values.get(b, "threshold");
        if (!Values.isBlank(th) && Values.toDouble(th) == null) {
            return R.badRequest("阈值必须为数字");
        }
        String sev = Values.str(Values.get(b, "severity"));
        if (sev != null && !SEVERITIES.contains(sev)) {
            return R.badRequest("告警级别无效（P1~P4）");
        }
        Object enabled = Values.get(b, "enabled");
        // [fix] 原实现只更新 9 个字段：前端「适用DB类型」保存后值不变（静默失败），
        //       INSTANCE_ID / TABLESPACE_NAME / TARGET_HOST_IP / RULE_TYPE / PROMQL 也无法修改。
        //       改为按「请求体是否带该字段」动态拼 SET：带空值=明确清空，未带=保持原值，
        //       这样「只切换启用开关」不会把通知配置、实例与表空间维度清掉。
        StringBuilder setSql = new StringBuilder("UPDATE ALERT_RULE SET ");
        List<Object> args = new ArrayList<>();
        appendSet(setSql, args, "RULE_NAME", Values.str(Values.get(b, "ruleName")), has(b, "ruleName") == 1);
        appendSet(setSql, args, "OPERATOR", op, has(b, "operator") == 1);
        appendSet(setSql, args, "THRESHOLD", Values.toDouble(th), has(b, "threshold") == 1);
        appendSet(setSql, args, "DURATION", Values.toLong(Values.get(b, "duration")), has(b, "duration") == 1);
        appendSet(setSql, args, "SEVERITY", sev, has(b, "severity") == 1);
        appendSet(setSql, args, "ENABLED", enabled == null ? null : (Values.truthy(enabled) ? 1 : 0), has(b, "enabled") == 1);
        appendSet(setSql, args, "METRIC", Values.str(Values.get(b, "metric")), has(b, "metric") == 1);
        appendSet(setSql, args, "DB_TYPE", Values.str(Values.get(b, "dbType")), has(b, "dbType") == 1);
        appendSet(setSql, args, "INSTANCE_ID", Values.toLong(Values.get(b, "instanceId")), has(b, "instanceId") == 1);
        appendSet(setSql, args, "TABLESPACE_NAME", normalizeTablespaces(Values.get(b, "tablespaceName")), has(b, "tablespaceName") == 1);
        appendSet(setSql, args, "TARGET_HOST_IP", Values.str(Values.get(b, "targetHostIp")), has(b, "targetHostIp") == 1);
        appendSet(setSql, args, "RULE_TYPE", Values.str(Values.get(b, "ruleType")), has(b, "ruleType") == 1);
        appendSet(setSql, args, "PROMQL", Values.str(Values.get(b, "promql")), has(b, "promql") == 1);
        appendSet(setSql, args, "NOTIFY_CHAN", Values.str(Values.get(b, "notifyChan")), has(b, "notifyChan") == 1);
        appendSet(setSql, args, "NOTIFY_TO", Values.str(Values.get(b, "notifyTo")), has(b, "notifyTo") == 1);
        if (args.isEmpty()) {
            return R.badRequest("没有可更新的字段");
        }
        setSql.append(" WHERE RULE_ID=?");
        args.add(id);
        int n = db.update(setSql.toString(), args);
        if (n == 0) {
            return R.notFound("规则不存在");
        }
        return R.msg("更新成功");
    }

    private static void appendSet(StringBuilder sql, List<Object> args, String column, Object value, boolean present) {
        if (!present) {
            return;
        }
        if (!args.isEmpty()) {
            sql.append(", ");
        }
        sql.append(column).append("=?");
        args.add(value);
    }

    /** 统一表空间名：去空白、大写、逗号分隔、去重、限长；空串视为「全部表空间」= NULL */
    private static String normalizeTablespaces(Object raw) {
        String v = Values.str(raw);
        if (v == null) {
            return null;
        }
        LinkedHashSet<String> names = new LinkedHashSet<>();
        for (String part : v.split("[,，;；\\s]+")) {
            String n = part.trim().toUpperCase(java.util.Locale.ROOT);
            if (!n.isEmpty()) {
                names.add(n);
            }
        }
        if (names.isEmpty()) {
            return null;
        }
        return Values.truncate(String.join(",", names), 256);
    }

    // ============================ 抑制规则 ============================

    @GetMapping("/suppression-rules")
    public Map<String, Object> suppressionRules() {
        return R.ok(db.query("SELECT r.*, (SELECT COUNT(*) FROM ALERT_SUPPRESSION s WHERE s.RULE_ID = r.RULE_ID AND s.STATUS = 'ACTIVE') AS ACTIVE_COUNT "
                + "FROM ALERT_SUPPRESSION_RULE r ORDER BY r.RULE_ID"));
    }

    @PostMapping("/suppression-rules")
    public Map<String, Object> createSuppressionRule(CurrentUser u, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        String name = Values.str(Values.get(b, "ruleName"));
        String type = Values.str(Values.get(b, "ruleType"));
        if (name == null || type == null) {
            return R.badRequest("规则名称和类型不能为空");
        }
        if (!SUPPRESSION_TYPES.contains(type)) {
            return R.badRequest("规则类型无效（TOPOLOGY/CLUSTER/SEVERITY/INSTANCE）");
        }
        Object ar = Values.get(b, "autoRelease");
        db.update("INSERT INTO ALERT_SUPPRESSION_RULE (RULE_NAME, RULE_TYPE, DESCRIPTION, PARENT_LEVELS, CHILD_LEVELS, SUPPRESS_WINDOW, AUTO_RELEASE, CREATED_BY) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                name, type, Values.str(Values.get(b, "description")), Values.str(Values.get(b, "parentLevels"), "P1,P2"),
                Values.str(Values.get(b, "childLevels"), "P2,P3,P4"), Values.toInt(Values.get(b, "suppressWindow"), 60),
                ar == null ? 1 : (Values.truthy(ar) ? 1 : 0), u.username());
        return R.msg("创建成功");
    }

    @PutMapping("/suppression-rules/{id}")
    public Map<String, Object> updateSuppressionRule(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        Object enabled = Values.get(b, "enabled");
        Object ar = Values.get(b, "autoRelease");
        db.update("UPDATE ALERT_SUPPRESSION_RULE SET RULE_NAME=NVL(?,RULE_NAME), DESCRIPTION=?, PARENT_LEVELS=NVL(?,PARENT_LEVELS), "
                        + "CHILD_LEVELS=NVL(?,CHILD_LEVELS), SUPPRESS_WINDOW=NVL(?,SUPPRESS_WINDOW), AUTO_RELEASE=NVL(?,AUTO_RELEASE), "
                        + "ENABLED=NVL(?,ENABLED), UPDATED_AT=SYSTIMESTAMP WHERE RULE_ID=?",
                Values.str(Values.get(b, "ruleName")), Values.str(Values.get(b, "description")), Values.str(Values.get(b, "parentLevels")),
                Values.str(Values.get(b, "childLevels")), Values.toInt(Values.get(b, "suppressWindow")),
                ar == null ? null : (Values.truthy(ar) ? 1 : 0), enabled == null ? null : (Values.truthy(enabled) ? 1 : 0), id);
        return R.msg("更新成功");
    }

    @DeleteMapping("/suppression-rules/{id}")
    public Map<String, Object> deleteSuppressionRule(CurrentUser u, @PathVariable("id") long id) {
        u.require("ADMIN", "DBA");
        // [fix] ALERT_SUPPRESSION.RULE_ID 外键引用规则，Node 版直接删规则会 ORA-02292
        db.inTx(() -> {
            db.update("UPDATE ALERT_SUPPRESSION SET RULE_ID = NULL WHERE RULE_ID = ?", id);
            db.update("DELETE FROM ALERT_SUPPRESSION_RULE WHERE RULE_ID = ?", id);
        });
        return R.msg("删除成功");
    }

    // ============================ 策略 / 抑制操作 ============================

    @PostMapping("/apply-policies")
    public Map<String, Object> applyPolicies(CurrentUser u) {
        u.require("ADMIN", "DBA", "OPS");   // 会批量改告警状态（静默/抑制/合并），只读角色不可调用
        Map<String, Object> r = policies.applyOpenAlertPolicies();
        return R.ok(r, "策略应用完成: 静默 " + r.get("silenced") + "，抑制 " + r.get("suppressed") + "，合并 " + r.get("aggregated") + " 条");
    }

    @PostMapping("/check-suppression")
    public Map<String, Object> checkSuppression(CurrentUser u, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");   // 会批量改告警状态（静默/抑制/合并），只读角色不可调用
        Long id = Values.toLong(Values.get(b, "alertId"));
        if (id == null) {
            return R.badRequest("alertId 不能为空");
        }
        policies.checkSuppression(id);
        return R.msg("抑制检查完成");
    }

    @PostMapping("/batch-check-suppression")
    public Map<String, Object> batchCheckSuppression(CurrentUser u) {
        u.require("ADMIN", "DBA", "OPS");   // 会批量改告警状态（静默/抑制/合并），只读角色不可调用
        Map<String, Object> r = policies.applyOpenAlertPolicies();
        return R.ok(R.map("checked", r.get("checked"), "suppressed", r.get("suppressed"), "silenced", r.get("silenced")),
                "批量检查完成: 抑制 " + r.get("suppressed") + "/" + r.get("checked") + " 条");
    }

    @GetMapping("/{id}/suppressed-by")
    public Map<String, Object> suppressedBy(@PathVariable("id") long id) {
        return R.ok(db.query("SELECT s.*, ar.RULE_NAME AS PARENT_RULE_NAME, ar.SEVERITY AS PARENT_SEVERITY, ar.CONTENT AS PARENT_CONTENT, "
                + "ar.INSTANCE_NAME AS PARENT_INSTANCE, ar.STATUS AS PARENT_STATUS, ar.TRIGGER_TIME AS PARENT_TRIGGER_TIME "
                + "FROM ALERT_SUPPRESSION s JOIN ALERT_RECORD ar ON s.PARENT_ALERT_ID = ar.ALERT_ID "
                + "WHERE s.CHILD_ALERT_ID = ? AND s.STATUS = 'ACTIVE'", id));
    }

    @GetMapping("/{id}/suppressing")
    public Map<String, Object> suppressing(@PathVariable("id") long id) {
        return R.ok(db.query("SELECT s.*, ar.RULE_NAME AS CHILD_RULE_NAME, ar.SEVERITY AS CHILD_SEVERITY, ar.CONTENT AS CHILD_CONTENT, "
                + "ar.INSTANCE_NAME AS CHILD_INSTANCE, ar.STATUS AS CHILD_STATUS, ar.TRIGGER_TIME AS CHILD_TRIGGER_TIME "
                + "FROM ALERT_SUPPRESSION s JOIN ALERT_RECORD ar ON s.CHILD_ALERT_ID = ar.ALERT_ID "
                + "WHERE s.PARENT_ALERT_ID = ? AND s.STATUS = 'ACTIVE'", id));
    }

    @PostMapping("/{id}/unsuppress")
    public Map<String, Object> unsuppress(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        Map<String, Object> a = db.one("SELECT STATUS FROM ALERT_RECORD WHERE ALERT_ID = ?", id);
        if (a == null) {
            return R.notFound("告警不存在");
        }
        if (!"SUPPRESSED".equals(a.get("STATUS"))) {
            return R.badRequest("该告警未被抑制");
        }
        String reason = Values.str(Values.get(b, "reason"), "手动解除");
        db.inTx(() -> {
            db.update("UPDATE ALERT_RECORD SET STATUS='OPEN', SUPPRESSED_BY_ID=NULL, SUPPRESSED_AT=NULL, SUPPRESSION_RULE=NULL WHERE ALERT_ID=?", id);
            db.update("UPDATE ALERT_SUPPRESSION SET STATUS='RELEASED', RELEASED_AT=SYSTIMESTAMP, RELEASED_BY=?, RELEASE_REASON=? "
                    + "WHERE CHILD_ALERT_ID=? AND STATUS='ACTIVE'", u.username(), Values.truncate(reason, 256), id);
        });
        return R.msg("抑制已解除");
    }

    @GetMapping("/suppression-stats")
    public Map<String, Object> suppressionStats() {
        return R.ok(R.map(
                "activeSuppressions", db.count("SELECT COUNT(*) AS CNT FROM ALERT_SUPPRESSION WHERE STATUS = 'ACTIVE'"),
                "releasedSuppressions", db.count("SELECT COUNT(*) AS CNT FROM ALERT_SUPPRESSION WHERE STATUS = 'RELEASED'"),
                "byType", db.query("SELECT SUPPRESSION_TYPE, COUNT(*) AS CNT FROM ALERT_SUPPRESSION WHERE STATUS = 'ACTIVE' GROUP BY SUPPRESSION_TYPE"),
                "topParents", db.query("SELECT s.PARENT_ALERT_ID, ar.RULE_NAME, ar.SEVERITY, ar.INSTANCE_NAME, ar.CONTENT, COUNT(*) AS CHILD_COUNT "
                        + "FROM ALERT_SUPPRESSION s JOIN ALERT_RECORD ar ON s.PARENT_ALERT_ID = ar.ALERT_ID WHERE s.STATUS = 'ACTIVE' "
                        + "GROUP BY s.PARENT_ALERT_ID, ar.RULE_NAME, ar.SEVERITY, ar.INSTANCE_NAME, ar.CONTENT ORDER BY CHILD_COUNT DESC FETCH FIRST 5 ROWS ONLY")));
    }

    // ============================ 智能优先级 ============================

    /**
     * 严重度(40%) + 业务影响(20%) + 持续时长(20%) + 实例健康分(10%) + 依赖影响(10%)
     * [fix] Node 版 HEALTH_SCORE 为 0 时 `|| 100` 把 0 分当成 100 分（宕机实例反而优先级最低）
     */
    @GetMapping("/smart-priority")
    public Map<String, Object> smartPriority(@RequestParam(required = false) String alertIds) {
        List<Map<String, Object>> alerts;
        if (!Values.isBlank(alertIds)) {
            List<Long> ids = new ArrayList<>();
            for (String s : alertIds.split(",")) {
                Long l = Values.toLong(s);
                if (l != null && l > 0) {
                    ids.add(l);
                }
            }
            if (ids.isEmpty()) {
                return R.badRequest("alertIds 格式错误");
            }
            if (ids.size() > 500) {
                ids = ids.subList(0, 500);
            }
            alerts = db.query("SELECT ALERT_ID, INSTANCE_ID, SEVERITY, STATUS, TRIGGER_TIME, RULE_NAME, CONTENT FROM ALERT_RECORD WHERE ALERT_ID IN ("
                    + Db.placeholders(ids.size()) + ")", ids);
        } else {
            alerts = db.query("SELECT ALERT_ID, INSTANCE_ID, SEVERITY, STATUS, TRIGGER_TIME, RULE_NAME, CONTENT FROM ALERT_RECORD "
                    + "WHERE STATUS IN ('OPEN', 'ACKNOWLEDGED', 'SUPPRESSED') ORDER BY TRIGGER_TIME DESC FETCH FIRST 50 ROWS ONLY");
        }
        long now = System.currentTimeMillis();
        List<Map<String, Object>> results = new ArrayList<>();
        for (Map<String, Object> a : alerts) {
            Map<String, Object> factors = new LinkedHashMap<>();
            double score = 0;
            String sev = Values.str(a.get("SEVERITY"), "");
            int sevScore = switch (sev) {
                case "P1" -> 100;
                case "P2" -> 75;
                case "P3" -> 50;
                case "P4" -> 25;
                default -> 30;
            };
            score += sevScore * 0.4;
            factors.put("severity", R.map("score", sevScore, "weight", "40%", "level", sev));
            Object instId = a.get("INSTANCE_ID");
            int biz = 50;
            if (instId != null) {
                try {
                    List<String> tags = new ArrayList<>();
                    for (Map<String, Object> t : db.query("SELECT t.TAG_NAME FROM CMDB_INSTANCE_TAG it JOIN CMDB_TAG t ON it.TAG_ID = t.TAG_ID "
                            + "WHERE it.INSTANCE_ID = ?", instId)) {
                        tags.add(Values.str(t.get("TAG_NAME"), ""));
                    }
                    if (tags.contains("核心")) {
                        biz = 100;
                    } else if (tags.contains("重要")) {
                        biz = 75;
                    } else if (tags.contains("一般")) {
                        biz = 30;
                    }
                    factors.put("businessTags", tags);
                } catch (Exception ignore) {
                    // 标签表可能不存在
                }
            }
            score += biz * 0.2;
            factors.put("business", R.map("score", biz, "weight", "20%"));
            int dur = 50;
            if (a.get("TRIGGER_TIME") instanceof Timestamp ts) {
                double minutes = (now - ts.getTime()) / 60000.0;
                dur = minutes > 120 ? 100 : minutes > 60 ? 80 : minutes > 30 ? 60 : minutes > 10 ? 40 : 20;
                factors.put("durationMinutes", Math.round(minutes));
            }
            score += dur * 0.2;
            factors.put("duration", R.map("score", dur, "weight", "20%"));
            int health = 50;
            int impact = 30;
            if (instId != null) {
                Map<String, Object> inst = db.one("SELECT HEALTH_SCORE FROM CMDB_INSTANCE WHERE INSTANCE_ID = ?", instId);
                if (inst != null) {
                    Long hs = Values.toLong(inst.get("HEALTH_SCORE"));
                    long h = hs == null ? 100 : hs;
                    health = (int) Math.max(0, 100 - h);
                    factors.put("instanceHealth", h);
                }
                try {
                    long apps = db.count("SELECT COUNT(DISTINCT APP_ID) AS APP_COUNT FROM CMDB_APP_DB_RELATION WHERE INSTANCE_ID = ?", instId);
                    impact = (int) Math.min(100, 30 + apps * 15);
                    factors.put("affectedApps", apps);
                } catch (Exception ignore) {
                    // 关系表可能不存在
                }
            }
            score += health * 0.1;
            factors.put("health", R.map("score", health, "weight", "10%"));
            score += impact * 0.1;
            factors.put("impact", R.map("score", impact, "weight", "10%"));
            long fin = Math.round(score);
            String level = fin >= 80 ? "CRITICAL" : fin >= 60 ? "HIGH" : fin >= 40 ? "MEDIUM" : "LOW";
            results.add(R.map("ALERT_ID", a.get("ALERT_ID"), "INSTANCE_ID", instId, "SEVERITY", sev, "STATUS", a.get("STATUS"),
                    "RULE_NAME", a.get("RULE_NAME"), "CONTENT", a.get("CONTENT"), "TRIGGER_TIME", a.get("TRIGGER_TIME"),
                    "PRIORITY_SCORE", fin, "PRIORITY_LEVEL", level, "FACTORS", factors));
        }
        results.sort(Comparator.comparingLong((Map<String, Object> m) -> Values.toLong(m.get("PRIORITY_SCORE"), 0)).reversed());
        return R.ok(results);
    }

    // ============================ 聚合 ============================

    @PostMapping("/aggregate")
    public Map<String, Object> aggregate(CurrentUser u, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");
        Integer w = Values.toInt(Values.get(b, "windowMinutes"));
        Map<String, Object> r = policies.aggregate(w == null || w <= 0 ? 10 : w);
        return R.ok(r, "聚合完成: 新建 " + r.get("groups") + " 组, 合并 " + r.get("merged") + " 条");
    }

    @GetMapping("/aggregation-groups")
    public Map<String, Object> aggGroups(@RequestParam(required = false) String status,
                                         @RequestParam(required = false) String severity,
                                         @RequestParam(required = false) String instanceId,
                                         @RequestParam(required = false, defaultValue = "1") String page,
                                         @RequestParam(required = false, defaultValue = "20") String size) {
        List<String> where = new ArrayList<>(List.of("1=1"));
        List<Object> args = new ArrayList<>();
        if (!Values.isBlank(status)) {
            where.add("a.STATUS=?");
            args.add(status.trim());
        }
        if (!Values.isBlank(severity)) {
            where.add("a.SEVERITY=?");
            args.add(severity.trim());
        }
        if (!Values.isBlank(instanceId)) {
            where.add("a.INSTANCE_ID=?");
            args.add(Values.toLong(instanceId));
        }
        try {
            return R.ok(db.queryPage("SELECT a.*, (SELECT CONTENT FROM ALERT_RECORD WHERE ALERT_ID = a.REPRESENTATIVE_ID) AS REPR_CONTENT, "
                    + "(SELECT TRIGGER_TIME FROM ALERT_RECORD WHERE ALERT_ID = a.REPRESENTATIVE_ID) AS REPR_TRIGGER_TIME "
                    + "FROM ALERT_AGGREGATION a WHERE " + String.join(" AND ", where) + " ORDER BY a.LAST_TRIGGER DESC", args, page, size));
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                // [fix] Node 版缺表时返回 {rows:[]}，与正常结构 {list:[]} 不一致，前端取不到 list
                return R.ok(R.map("list", List.of(), "total", 0, "page", 1, "size", 20));
            }
            throw e;
        }
    }

    @GetMapping("/aggregation-groups/stats")
    public Map<String, Object> aggGroupStats() {
        try {
            return R.ok(R.map(
                    "activeGroups", db.count("SELECT COUNT(*) AS CNT FROM ALERT_AGGREGATION WHERE STATUS = 'ACTIVE'"),
                    "totalMerged", db.count("SELECT COUNT(*) AS CNT FROM ALERT_RECORD WHERE IS_MERGED = 1"),
                    "bySeverity", db.query("SELECT SEVERITY, COUNT(*) AS CNT, SUM(ALERT_COUNT) AS TOTAL_ALERTS FROM ALERT_AGGREGATION "
                            + "WHERE STATUS = 'ACTIVE' GROUP BY SEVERITY"),
                    "topGroups", db.query("SELECT AGG_ID, AGG_KEY, RULE_NAME, INSTANCE_NAME, SEVERITY, ALERT_COUNT, LAST_TRIGGER FROM ALERT_AGGREGATION "
                            + "WHERE STATUS = 'ACTIVE' ORDER BY ALERT_COUNT DESC FETCH FIRST 5 ROWS ONLY")));
        } catch (Exception e) {
            if (Db.isMissingTable(e) || Db.isMissingColumn(e)) {
                return R.ok(R.map("activeGroups", 0, "totalMerged", 0, "bySeverity", List.of(), "topGroups", List.of()));
            }
            throw e;
        }
    }

    @GetMapping("/aggregation-groups/{id}")
    public Map<String, Object> aggGroup(@PathVariable("id") long id) {
        Map<String, Object> agg = db.one("SELECT * FROM ALERT_AGGREGATION WHERE AGG_ID = ?", id);
        if (agg == null) {
            return R.notFound("聚合组不存在");
        }
        List<Long> ids = AlertPolicyService.parseIds(agg.get("ALERT_IDS"));
        List<Map<String, Object>> members = new ArrayList<>();
        // 防御：超大 IN 列表（Oracle 上限 1000）
        for (int i = 0; i < ids.size(); i += 900) {
            List<Long> part = ids.subList(i, Math.min(ids.size(), i + 900));
            members.addAll(db.query("SELECT ALERT_ID, RULE_NAME, INSTANCE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME, IS_MERGED, AGG_GROUP_ID "
                    + "FROM ALERT_RECORD WHERE ALERT_ID IN (" + Db.placeholders(part.size()) + ") ORDER BY TRIGGER_TIME ASC", part));
        }
        Map<String, Object> out = new LinkedHashMap<>(agg);
        out.put("members", members);
        return R.ok(out);
    }

    @PostMapping("/aggregation-groups/{id}/resolve")
    public Map<String, Object> aggGroupResolve(CurrentUser u, @PathVariable("id") long id) {
        u.require("ADMIN", "DBA", "OPS");
        Map<String, Object> agg = db.one("SELECT ALERT_IDS FROM ALERT_AGGREGATION WHERE AGG_ID = ?", id);
        if (agg == null) {
            return R.notFound("聚合组不存在");
        }
        List<Long> ids = AlertPolicyService.parseIds(agg.get("ALERT_IDS"));
        db.inTx(() -> {
            for (int i = 0; i < ids.size(); i += 900) {
                List<Long> part = ids.subList(i, Math.min(ids.size(), i + 900));
                List<Object> args = new ArrayList<>();
                args.add(u.username());
                args.addAll(part);
                db.update("UPDATE ALERT_RECORD SET STATUS='RESOLVED', RESOLVE_TIME=SYSTIMESTAMP, RESOLVE_BY=? WHERE ALERT_ID IN ("
                        + Db.placeholders(part.size()) + ") AND STATUS <> 'RESOLVED'", args);
            }
            db.update("UPDATE ALERT_AGGREGATION SET STATUS='RESOLVED', UPDATED_AT=SYSTIMESTAMP WHERE AGG_ID=?", id);
        });
        for (Long aid : ids) {
            policies.releaseSuppressedChildren(aid);
        }
        return R.msg("已解决 " + ids.size() + " 条告警");
    }

    @PostMapping("/aggregation-groups/{id}/split")
    public Map<String, Object> aggGroupSplit(CurrentUser u, @PathVariable("id") long id) {
        u.require("ADMIN", "DBA");
        try {
            policies.splitAggregation(id);
        } catch (IllegalArgumentException e) {
            return R.fail(500, e.getMessage());
        }
        return R.msg("聚合组已解散");
    }

    // ============================ 静默 ============================

    /** 前端传 ISO 字符串（toISOString）。[fix] Node 版把字符串直接绑定到 TIMESTAMP 列，受 NLS 格式影响报 ORA-01861 */
    static Timestamp parseTime(Object v, String tz) {
        String s = Values.str(v);
        if (s == null) {
            return null;
        }
        try {
            return Timestamp.from(Instant.parse(s));
        } catch (Exception ignore) {
            // fallthrough
        }
        try {
            return Timestamp.from(OffsetDateTime.parse(s).toInstant());
        } catch (Exception ignore) {
            // fallthrough
        }
        ZoneId zone;
        try {
            zone = ZoneId.of(tz == null ? "Asia/Shanghai" : tz);
        } catch (Exception e) {
            zone = ZoneId.of("Asia/Shanghai");
        }
        for (String p : new String[]{"yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"}) {
            try {
                return Timestamp.from(LocalDateTime.parse(s, DateTimeFormatter.ofPattern(p)).atZone(zone).toInstant());
            } catch (Exception ignore) {
                // try next
            }
        }
        throw new IllegalArgumentException("时间格式无法识别: " + s);
    }

    private String validateSilence(String type, Timestamp start, Timestamp end, String cron, Integer dur) {
        if ("ONCE".equals(type)) {
            if (start == null || end == null) {
                return "一次性静默需要开始和结束时间";
            }
            if (!end.after(start)) {
                return "结束时间必须晚于开始时间";
            }
        } else if ("RECURRING".equals(type)) {
            if (cron == null || dur == null || dur <= 0) {
                return "周期性静默需要 cron 表达式和持续时长";
            }
            String err = CronWindow.validate(cron);
            if (err != null) {
                return "cron 表达式无效: " + err;
            }
        } else {
            return "静默类型无效（ONCE/RECURRING）";
        }
        return null;
    }

    @GetMapping("/silence-rules")
    public Map<String, Object> silenceRules() {
        try {
            return R.ok(db.query("SELECT r.*, (SELECT COUNT(*) FROM ALERT_SILENCE_LOG l WHERE l.RULE_ID = r.RULE_ID) AS SILENCED_COUNT, "
                    + "CASE WHEN r.SILENCE_TYPE = 'ONCE' AND r.END_TIME < SYSTIMESTAMP THEN 1 ELSE 0 END AS EXPIRED "
                    + "FROM ALERT_SILENCE_RULE r ORDER BY r.CREATED_AT DESC"));
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return R.ok(List.of());
            }
            throw e;
        }
    }

    @PostMapping("/silence-rules")
    public Map<String, Object> createSilenceRule(CurrentUser u, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        String name = Values.str(Values.get(b, "ruleName"));
        if (name == null) {
            return R.badRequest("规则名称必填");
        }
        String type = Values.str(Values.get(b, "silenceType"), "ONCE");
        String tz = Values.str(Values.get(b, "timezone"), "Asia/Shanghai");
        Timestamp start;
        Timestamp end;
        try {
            start = parseTime(Values.get(b, "startTime"), tz);
            end = parseTime(Values.get(b, "endTime"), tz);
        } catch (IllegalArgumentException e) {
            return R.badRequest(e.getMessage());
        }
        String cron = Values.str(Values.get(b, "cronExpr"));
        Integer dur = Values.toInt(Values.get(b, "durationMin"));
        String err = validateSilence(type, start, end, cron, dur);
        if (err != null) {
            return R.badRequest(err);
        }
        Long id = db.insertReturningId("INSERT INTO ALERT_SILENCE_RULE (RULE_NAME, DESCRIPTION, INSTANCE_ID, SEVERITY, RULE_NAME_MATCH, SILENCE_TYPE, "
                        + "START_TIME, END_TIME, CRON_EXPR, DURATION_MIN, TIMEZONE, CREATED_BY) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", "RULE_ID",
                name, Values.str(Values.get(b, "description")), Values.toLong(Values.get(b, "instanceId")), Values.str(Values.get(b, "severity")),
                Values.str(Values.get(b, "ruleNameMatch")), type, start, end, cron, dur, tz, u.username());
        return R.ok(R.map("ruleId", id), "创建成功");
    }

    @PutMapping("/silence-rules/{id}")
    public Map<String, Object> updateSilenceRule(CurrentUser u, @PathVariable("id") long id, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA");
        Map<String, Object> old = db.one("SELECT SILENCE_TYPE, TIMEZONE, DESCRIPTION, INSTANCE_ID, SEVERITY, RULE_NAME_MATCH, START_TIME, END_TIME, "
                + "CRON_EXPR, DURATION_MIN FROM ALERT_SILENCE_RULE WHERE RULE_ID=?", id);
        if (old == null) {
            return R.notFound("规则不存在");
        }
        Object enabled = Values.get(b, "enabled");
        boolean onlyToggle = b != null && b.size() == 1 && b.containsKey("enabled");
        if (onlyToggle) {
            db.update("UPDATE ALERT_SILENCE_RULE SET ENABLED=?, UPDATED_AT=SYSTIMESTAMP WHERE RULE_ID=?", Values.truthy(enabled) ? 1 : 0, id);
            return R.msg("更新成功");
        }
        // 部分更新：请求里没带的字段沿用库里的旧值（原来没带的字段会被写成 NULL，例如只改名称就把静默时间窗清空）
        String type = Values.str(Values.get(b, "silenceType"), Values.str(old.get("SILENCE_TYPE"), "ONCE"));
        String tz = Values.str(Values.get(b, "timezone"), Values.str(old.get("TIMEZONE"), "Asia/Shanghai"));
        Timestamp start;
        Timestamp end;
        try {
            start = has(b, "startTime") == 1 ? parseTime(Values.get(b, "startTime"), tz) : (Timestamp) old.get("START_TIME");
            end = has(b, "endTime") == 1 ? parseTime(Values.get(b, "endTime"), tz) : (Timestamp) old.get("END_TIME");
        } catch (IllegalArgumentException | ClassCastException e) {
            return R.badRequest(e.getMessage());
        }
        String cron = has(b, "cronExpr") == 1 ? Values.str(Values.get(b, "cronExpr")) : Values.str(old.get("CRON_EXPR"));
        Integer dur = has(b, "durationMin") == 1 ? Values.toInt(Values.get(b, "durationMin")) : Values.toInt(old.get("DURATION_MIN"));
        String err = validateSilence(type, start, end, cron, dur);
        if (err != null) {
            return R.badRequest(err);
        }
        db.update("UPDATE ALERT_SILENCE_RULE SET RULE_NAME=NVL(?,RULE_NAME), DESCRIPTION=?, INSTANCE_ID=?, SEVERITY=?, RULE_NAME_MATCH=?, "
                        + "SILENCE_TYPE=?, START_TIME=?, END_TIME=?, CRON_EXPR=?, DURATION_MIN=?, TIMEZONE=?, ENABLED=NVL(?,ENABLED), "
                        + "UPDATED_AT=SYSTIMESTAMP WHERE RULE_ID=?",
                Values.str(Values.get(b, "ruleName")),
                has(b, "description") == 1 ? Values.str(Values.get(b, "description")) : Values.str(old.get("DESCRIPTION")),
                has(b, "instanceId") == 1 ? Values.toLong(Values.get(b, "instanceId")) : Values.toLong(old.get("INSTANCE_ID")),
                has(b, "severity") == 1 ? Values.str(Values.get(b, "severity")) : Values.str(old.get("SEVERITY")),
                has(b, "ruleNameMatch") == 1 ? Values.str(Values.get(b, "ruleNameMatch")) : Values.str(old.get("RULE_NAME_MATCH")),
                type, start, end, cron, dur, tz,
                enabled == null ? null : (Values.truthy(enabled) ? 1 : 0), id);
        return R.msg("更新成功");
    }

    /** 请求体是否带了该字段（带了但值为空 = 明确清空） */
    private static int has(Map<String, Object> b, String key) {
        return b != null && b.containsKey(key) ? 1 : 0;
    }

    @DeleteMapping("/silence-rules/{id}")
    public Map<String, Object> deleteSilenceRule(CurrentUser u, @PathVariable("id") long id) {
        u.require("ADMIN", "DBA");
        db.inTx(() -> {
            db.update("DELETE FROM ALERT_SILENCE_LOG WHERE RULE_ID = ?", id);
            db.update("DELETE FROM ALERT_SILENCE_RULE WHERE RULE_ID = ?", id);
        });
        return R.msg("删除成功");
    }

    @PostMapping("/check-silence")
    public Map<String, Object> checkSilence(CurrentUser u, @RequestBody(required = false) Map<String, Object> b) {
        u.require("ADMIN", "DBA", "OPS");   // 会批量改告警状态（静默/抑制/合并），只读角色不可调用
        Long id = Values.toLong(Values.get(b, "alertId"));
        if (id == null) {
            return R.badRequest("alertId 不能为空");
        }
        Map<String, Object> alert = policies.loadAlert(id);
        if (alert == null) {
            return R.notFound("告警不存在");
        }
        Map<String, Object> rule = policies.checkSilence(alert);
        if (rule == null) {
            return R.ok(R.map("silenced", false));
        }
        policies.applySilence(alert, rule);
        return R.ok(R.map("silenced", true, "rule", rule));
    }

    @PostMapping("/batch-check-silence")
    public Map<String, Object> batchCheckSilence(CurrentUser u) {
        u.require("ADMIN", "DBA", "OPS");   // 会批量改告警状态（静默/抑制/合并），只读角色不可调用
        Map<String, Object> r = policies.applyOpenAlertPolicies();
        return R.ok(R.map("checked", r.get("checked"), "silenced", r.get("silenced")),
                "静默检查完成: " + r.get("silenced") + "/" + r.get("checked") + " 条被静默");
    }

    @PostMapping("/{id}/unsilence")
    public Map<String, Object> unsilence(CurrentUser u, @PathVariable("id") long id) {
        u.require("ADMIN", "DBA");
        Map<String, Object> a = db.one("SELECT STATUS FROM ALERT_RECORD WHERE ALERT_ID = ?", id);
        if (a == null) {
            return R.notFound("告警不存在");
        }
        if (!"SILENCED".equals(a.get("STATUS"))) {
            return R.badRequest("该告警未被静默");
        }
        db.update("UPDATE ALERT_RECORD SET STATUS='OPEN', SILENCE_RULE_ID=NULL, SILENCED_AT=NULL WHERE ALERT_ID=?", id);
        return R.msg("静默已解除");
    }

    @GetMapping("/silence-stats")
    public Map<String, Object> silenceStats() {
        try {
            List<Map<String, Object>> recent;
            try {
                recent = db.query("SELECT l.LOG_ID, l.ALERT_ID, l.SILENCED_AT, l.SILENCE_REASON, ar.CONTENT, ar.INSTANCE_NAME, ar.SEVERITY "
                        + "FROM ALERT_SILENCE_LOG l JOIN ALERT_RECORD ar ON l.ALERT_ID = ar.ALERT_ID ORDER BY l.SILENCED_AT DESC FETCH FIRST 10 ROWS ONLY");
            } catch (Exception e) {
                recent = List.of();
            }
            return R.ok(R.map(
                    "activeRules", db.count("SELECT COUNT(*) AS CNT FROM ALERT_SILENCE_RULE WHERE ENABLED = 1"),
                    "silencedAlerts", db.count("SELECT COUNT(*) AS CNT FROM ALERT_RECORD WHERE STATUS = 'SILENCED'"),
                    "byRule", db.query("SELECT r.RULE_NAME, r.SILENCE_TYPE, COUNT(l.LOG_ID) AS CNT FROM ALERT_SILENCE_RULE r "
                            + "LEFT JOIN ALERT_SILENCE_LOG l ON r.RULE_ID = l.RULE_ID GROUP BY r.RULE_NAME, r.SILENCE_TYPE ORDER BY CNT DESC FETCH FIRST 5 ROWS ONLY"),
                    "recentLogs", recent));
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return R.ok(R.map("activeRules", 0, "silencedAlerts", 0, "byRule", List.of(), "recentLogs", List.of()));
            }
            throw e;
        }
    }
}
