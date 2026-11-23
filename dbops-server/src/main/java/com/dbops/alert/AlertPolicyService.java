package com.dbops.alert;

import com.dbops.common.Db;
import com.dbops.common.R;
import com.dbops.common.Values;
import com.dbops.service.SystemConfigService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 告警策略：静默 → 抑制 → 聚合（对应 Node routes/alerts.js 中的同名函数）。
 * <p>
 * 相对 Node 版的修正：
 * <ul>
 *   <li>[fix] 抑制关系 / 静默日志的 INSERT…WHERE NOT EXISTS 用了重复位置占位符（NJS-098），异常被吞，记录从未写入，
 *       父告警解决时 releaseSuppressedChildren 查不到关系，子告警永远停在 SUPPRESSED</li>
 *   <li>[fix] CLUSTER 抑制查询同样因 :1 重复绑定而每次报错，集群抑制从未生效</li>
 *   <li>[fix] 聚合：IS_MERGED 为 NULL 的告警 UPDATE 条件 IS_MERGED=0 不命中却仍计数；已有聚合组时新一批里最早的告警
 *       被当成“代表”而不合并，导致组内同时存在多条未合并告警</li>
 *   <li>[改进] 列表接口每次 GET 都全量跑一遍策略（N+1 查询且在 GET 里改数据）；改为新告警产生时即时处理 + 采集轮次后批量处理，
 *       GET 仅在距上次执行超过 30s 时补跑</li>
 * </ul>
 */
@Service
public class AlertPolicyService {

    private static final Logger log = LoggerFactory.getLogger(AlertPolicyService.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    public static final List<String> ACTIVE_STATUSES = List.of("OPEN", "ACKNOWLEDGED", "SILENCED", "SUPPRESSED");

    private final Db db;
    private final SystemConfigService cfg;
    private final AtomicLong lastPolicyRun = new AtomicLong(0);

    public AlertPolicyService(Db db, SystemConfigService cfg) {
        this.db = db;
        this.cfg = cfg;
    }

    // ============================ 静默 ============================

    public Map<String, Object> checkSilence(Map<String, Object> alert) {
        List<Map<String, Object>> rules;
        try {
            rules = db.query("SELECT * FROM ALERT_SILENCE_RULE WHERE ENABLED = 1");
        } catch (Exception e) {
            if (!Db.isMissingTable(e)) {
                log.warn("[alert-silence] load rules: {}", e.getMessage());
            }
            return null;
        }
        long now = System.currentTimeMillis();
        for (Map<String, Object> rule : rules) {
            boolean inTime = false;
            String type = Values.str(rule.get("SILENCE_TYPE"), "ONCE");
            if ("ONCE".equals(type)) {
                if (rule.get("START_TIME") instanceof Timestamp st && rule.get("END_TIME") instanceof Timestamp et) {
                    inTime = now >= st.getTime() && now <= et.getTime();
                }
            } else if ("RECURRING".equals(type)) {
                String cron = Values.str(rule.get("CRON_EXPR"));
                int dur = Values.toInt(rule.get("DURATION_MIN"), 0);
                if (cron != null && dur > 0) {
                    inTime = CronWindow.inWindow(cron, dur, Values.str(rule.get("TIMEZONE")), ZonedDateTime.now());
                }
            }
            if (!inTime) {
                continue;
            }
            if (rule.get("INSTANCE_ID") != null && !Values.numEq(rule.get("INSTANCE_ID"), alert.get("INSTANCE_ID"))) {
                continue;
            }
            String sev = Values.str(rule.get("SEVERITY"));
            if (sev != null) {
                List<String> allowed = splitCsv(sev);
                if (!allowed.contains(Values.str(alert.get("SEVERITY"), ""))) {
                    continue;
                }
            }
            String nameMatch = Values.str(rule.get("RULE_NAME_MATCH"));
            if (nameMatch != null && !nameMatch.equals(Values.str(alert.get("RULE_NAME")))) {
                continue;
            }
            return rule;
        }
        return null;
    }

    public void applySilence(Map<String, Object> alert, Map<String, Object> rule) {
        Object alertId = alert.get("ALERT_ID");
        Object ruleId = rule.get("RULE_ID");
        db.update("UPDATE ALERT_RECORD SET STATUS='SILENCED', SILENCE_RULE_ID=?, SILENCED_AT=SYSTIMESTAMP WHERE ALERT_ID=? AND STATUS='OPEN'",
                ruleId, alertId);
        db.updateQuietly("INSERT INTO ALERT_SILENCE_LOG (RULE_ID, ALERT_ID, SILENCE_REASON) SELECT ?, ?, ? FROM DUAL "
                        + "WHERE NOT EXISTS (SELECT 1 FROM ALERT_SILENCE_LOG WHERE RULE_ID=? AND ALERT_ID=?)",
                ruleId, alertId, Values.truncate("匹配规则: " + rule.get("RULE_NAME"), 256), ruleId, alertId);
    }

    public boolean applySilenceById(long alertId) {
        Map<String, Object> alert = loadAlert(alertId);
        if (alert == null || !"OPEN".equals(alert.get("STATUS"))) {
            return false;
        }
        Map<String, Object> rule = checkSilence(alert);
        if (rule == null) {
            return false;
        }
        applySilence(alert, rule);
        return true;
    }

    // ============================ 抑制 ============================

    /**
     * @return true 表示该告警被抑制
     */
    public boolean checkSuppression(long alertId) {
        try {
            Map<String, Object> alert = loadAlert(alertId);
            if (alert == null || alert.get("INSTANCE_ID") == null) {
                return false;
            }
            Object instId = alert.get("INSTANCE_ID");
            Map<String, Object> inst = db.one("SELECT HOST_IP, HOST_ID FROM CMDB_INSTANCE WHERE INSTANCE_ID = ?", instId);
            if (inst == null) {
                return false;
            }
            List<Map<String, Object>> rules = db.query("SELECT * FROM ALERT_SUPPRESSION_RULE WHERE ENABLED = 1 ORDER BY RULE_ID");
            int defaultWindow = (int) cfg.getNumber("alert.suppression.default_window_min", 60);
            String sev = Values.str(alert.get("SEVERITY"), "");
            for (Map<String, Object> rule : rules) {
                List<String> parents = splitCsv(Values.str(rule.get("PARENT_LEVELS"), ""));
                List<String> children = splitCsv(Values.str(rule.get("CHILD_LEVELS"), ""));
                if (!children.contains(sev) || parents.isEmpty()) {
                    continue;
                }
                int window = Values.toInt(rule.get("SUPPRESS_WINDOW"), 0);
                if (window <= 0) {
                    window = defaultWindow;
                }
                String in = Db.placeholders(parents.size());
                String type = Values.str(rule.get("RULE_TYPE"), "");
                List<Map<String, Object>> parentAlerts = new ArrayList<>();
                String activeCond = " AND STATUS IN ('OPEN','ACKNOWLEDGED','SUPPRESSED')";
                switch (type) {
                    case "TOPOLOGY" -> {
                        List<Object> a = new ArrayList<>(List.of(inst.get("HOST_IP"), instId, alertId));
                        a.addAll(parents);
                        a.add(window);
                        parentAlerts = db.query("SELECT ALERT_ID, SEVERITY, CONTENT, INSTANCE_NAME FROM ALERT_RECORD "
                                + "WHERE INSTANCE_ID IN (SELECT INSTANCE_ID FROM CMDB_INSTANCE WHERE HOST_IP = ? AND INSTANCE_ID <> ?) "
                                + "AND ALERT_ID <> ?" + activeCond + " AND SEVERITY IN (" + in + ") "
                                + "AND TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(?, 'MINUTE') ORDER BY TRIGGER_TIME DESC", a);
                        if (parentAlerts.isEmpty()) {
                            List<Object> b = new ArrayList<>(List.of(instId));
                            b.addAll(parents);
                            b.add(window);
                            b.add(alertId);
                            try {
                                parentAlerts = db.query("SELECT ar.ALERT_ID, ar.SEVERITY, ar.CONTENT, ar.INSTANCE_NAME "
                                        + "FROM CMDB_APP_DB_RELATION rel_self JOIN CMDB_APP_DB_RELATION rel_peer "
                                        + "ON rel_peer.APP_ID = rel_self.APP_ID AND rel_peer.INSTANCE_ID <> rel_self.INSTANCE_ID "
                                        + "JOIN ALERT_RECORD ar ON ar.INSTANCE_ID = rel_peer.INSTANCE_ID WHERE rel_self.INSTANCE_ID = ? "
                                        + "AND ar.STATUS IN ('OPEN','ACKNOWLEDGED','SUPPRESSED') AND ar.SEVERITY IN (" + in + ") "
                                        + "AND ar.TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(?, 'MINUTE') AND ar.ALERT_ID <> ? "
                                        + "ORDER BY ar.TRIGGER_TIME DESC", b);
                            } catch (Exception e) {
                                if (!Db.isMissingTable(e)) {
                                    throw e;
                                }
                            }
                        }
                    }
                    case "CLUSTER" -> {
                        List<Object> a = new ArrayList<>(List.of(instId, instId));
                        a.addAll(parents);
                        a.add(window);
                        a.add(alertId);
                        parentAlerts = db.query("SELECT ar.ALERT_ID, ar.SEVERITY, ar.CONTENT, ar.INSTANCE_NAME FROM CMDB_CLUSTER_MEMBER cm1 "
                                + "JOIN CMDB_CLUSTER_MEMBER cm2 ON cm1.CLUSTER_ID = cm2.CLUSTER_ID "
                                + "JOIN ALERT_RECORD ar ON ar.INSTANCE_ID = cm2.INSTANCE_ID "
                                + "WHERE cm1.INSTANCE_ID = ? AND cm2.NODE_ROLE = 'PRIMARY' AND cm2.INSTANCE_ID <> ? "
                                + "AND ar.STATUS IN ('OPEN','ACKNOWLEDGED','SUPPRESSED') AND ar.SEVERITY IN (" + in + ") "
                                + "AND ar.TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(?, 'MINUTE') AND ar.ALERT_ID <> ? "
                                + "ORDER BY ar.TRIGGER_TIME DESC", a);
                    }
                    case "SEVERITY", "INSTANCE" -> {
                        List<Object> a = new ArrayList<>(List.of(instId, alertId));
                        a.addAll(parents);
                        a.add(window);
                        parentAlerts = db.query("SELECT ALERT_ID, SEVERITY, CONTENT, INSTANCE_NAME FROM ALERT_RECORD "
                                + "WHERE INSTANCE_ID = ? AND ALERT_ID <> ?" + activeCond + " AND SEVERITY IN (" + in + ") "
                                + "AND TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(?, 'MINUTE') ORDER BY TRIGGER_TIME DESC", a);
                        if ("SEVERITY".equals(type)) {
                            // 级别抑制：父告警必须严格比子告警级别高（P1 > P2 > ...），否则同级互相抑制
                            parentAlerts.removeIf(p -> severityRank(Values.str(p.get("SEVERITY"), "")) >= severityRank(sev));
                        }
                    }
                    default -> {
                    }
                }
                if (!parentAlerts.isEmpty()) {
                    Object parentId = parentAlerts.get(0).get("ALERT_ID");
                    db.update("UPDATE ALERT_RECORD SET STATUS='SUPPRESSED', SUPPRESSED_BY_ID=?, SUPPRESSED_AT=SYSTIMESTAMP, SUPPRESSION_RULE=? "
                            + "WHERE ALERT_ID=? AND STATUS NOT IN ('RESOLVED')", parentId, Values.truncate(Values.str(rule.get("RULE_NAME")), 128), alertId);
                    db.updateQuietly("INSERT INTO ALERT_SUPPRESSION (PARENT_ALERT_ID, CHILD_ALERT_ID, RULE_ID, SUPPRESSION_TYPE) "
                                    + "SELECT ?, ?, ?, ? FROM DUAL WHERE NOT EXISTS "
                                    + "(SELECT 1 FROM ALERT_SUPPRESSION WHERE PARENT_ALERT_ID=? AND CHILD_ALERT_ID=? AND STATUS='ACTIVE')",
                            parentId, alertId, rule.get("RULE_ID"), type, parentId, alertId);
                    return true;
                }
            }
        } catch (Exception e) {
            if (!Db.isMissingTable(e)) {
                log.error("[alert-suppression] checkSuppression error: {}", e.getMessage());
            }
        }
        return false;
    }

    /** 父告警解决后自动解除被其抑制的子告警（遵循规则 AUTO_RELEASE） */
    public void releaseSuppressedChildren(Object parentAlertId) {
        try {
            List<Map<String, Object>> rows = db.query("SELECT s.ID, s.CHILD_ALERT_ID, s.RULE_ID, NVL(r.AUTO_RELEASE, 1) AS AUTO_RELEASE "
                    + "FROM ALERT_SUPPRESSION s LEFT JOIN ALERT_SUPPRESSION_RULE r ON r.RULE_ID = s.RULE_ID "
                    + "WHERE s.PARENT_ALERT_ID = ? AND s.STATUS = 'ACTIVE'", parentAlertId);
            for (Map<String, Object> sup : rows) {
                if (Values.toInt(sup.get("AUTO_RELEASE"), 1) == 0) {
                    continue;
                }
                long others = db.count("SELECT COUNT(*) AS CNT FROM ALERT_SUPPRESSION WHERE CHILD_ALERT_ID = ? AND STATUS = 'ACTIVE' "
                        + "AND PARENT_ALERT_ID <> ?", sup.get("CHILD_ALERT_ID"), parentAlertId);
                if (others == 0) {
                    db.update("UPDATE ALERT_RECORD SET STATUS='OPEN', SUPPRESSED_BY_ID=NULL, SUPPRESSED_AT=NULL, SUPPRESSION_RULE=NULL "
                            + "WHERE ALERT_ID=? AND STATUS='SUPPRESSED'", sup.get("CHILD_ALERT_ID"));
                }
                db.update("UPDATE ALERT_SUPPRESSION SET STATUS='RELEASED', RELEASED_AT=SYSTIMESTAMP, RELEASED_BY='SYSTEM', "
                        + "RELEASE_REASON='父告警已解决' WHERE ID=?", sup.get("ID"));
            }
        } catch (Exception e) {
            if (!Db.isMissingTable(e)) {
                log.error("[alert-suppression] releaseSuppressedChildren error: {}", e.getMessage());
            }
        }
    }

    // ============================ 聚合 ============================

    public Map<String, Object> aggregate(Integer windowMinutes) {
        int window = windowMinutes == null || windowMinutes <= 0
                ? (int) cfg.getNumber("alert.aggregation.window_min", 10) : windowMinutes;
        List<Map<String, Object>> candidates;
        try {
            candidates = db.query("SELECT ALERT_ID, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, SEVERITY, TRIGGER_TIME, CONTENT FROM ALERT_RECORD "
                    + "WHERE STATUS IN ('OPEN', 'ACKNOWLEDGED') AND NVL(IS_MERGED, 0) = 0 "
                    + "AND TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(?, 'MINUTE') "
                    + "ORDER BY RULE_NAME, INSTANCE_ID, SEVERITY, TRIGGER_TIME ASC", window);
        } catch (Exception e) {
            if (Db.isMissingColumn(e) || Db.isMissingTable(e)) {
                return R.map("groups", 0, "merged", 0, "totalCandidates", 0);
            }
            throw e;
        }
        Map<String, List<Map<String, Object>>> groups = new LinkedHashMap<>();
        for (Map<String, Object> a : candidates) {
            String key = Values.str(a.get("RULE_NAME"), "") + "|" + Values.toLong(a.get("INSTANCE_ID"), 0) + "|"
                    + Values.str(a.get("SEVERITY"), "");
            groups.computeIfAbsent(key, k -> new ArrayList<>()).add(a);
        }
        int created = 0;
        int merged = 0;
        for (Map.Entry<String, List<Map<String, Object>>> g : groups.entrySet()) {
            List<Map<String, Object>> alerts = g.getValue();
            Map<String, Object> existing;
            try {
                existing = db.one("SELECT AGG_ID, ALERT_IDS, REPRESENTATIVE_ID FROM ALERT_AGGREGATION WHERE AGG_KEY = ? AND STATUS = 'ACTIVE'", g.getKey());
            } catch (Exception e) {
                if (Db.isMissingTable(e)) {
                    return R.map("groups", 0, "merged", 0, "totalCandidates", candidates.size());
                }
                throw e;
            }
            if (existing == null && alerts.size() < 2) {
                continue;
            }
            List<Long> ids = new ArrayList<>();
            for (Map<String, Object> a : alerts) {
                ids.add(Values.toLong(a.get("ALERT_ID")));
            }
            Object lastTrigger = alerts.get(alerts.size() - 1).get("TRIGGER_TIME");
            Long aggId;
            Long representativeId;
            if (existing != null) {
                aggId = Values.toLong(existing.get("AGG_ID"));
                representativeId = Values.toLong(existing.get("REPRESENTATIVE_ID"));
                Set<Long> all = new LinkedHashSet<>(parseIds(existing.get("ALERT_IDS")));
                all.addAll(ids);
                db.update("UPDATE ALERT_AGGREGATION SET ALERT_COUNT = ?, ALERT_IDS = ?, LAST_TRIGGER = ?, UPDATED_AT = SYSTIMESTAMP WHERE AGG_ID = ?",
                        all.size(), toJson(all), lastTrigger, aggId);
            } else {
                Map<String, Object> rep = alerts.get(0);
                representativeId = Values.toLong(rep.get("ALERT_ID"));
                aggId = db.insertReturningId("INSERT INTO ALERT_AGGREGATION (AGG_KEY, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, SEVERITY, "
                                + "REPRESENTATIVE_ID, ALERT_COUNT, ALERT_IDS, WINDOW_MINUTES, FIRST_TRIGGER, LAST_TRIGGER) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        "AGG_ID", g.getKey(), rep.get("RULE_NAME"), rep.get("INSTANCE_ID"), rep.get("INSTANCE_NAME"), rep.get("SEVERITY"),
                        representativeId, ids.size(), toJson(ids), window, rep.get("TRIGGER_TIME"), lastTrigger);
                created++;
            }
            for (Long id : ids) {
                if (id == null || id.equals(representativeId)) {
                    continue;
                }
                merged += db.update("UPDATE ALERT_RECORD SET IS_MERGED = 1, AGG_GROUP_ID = ? WHERE ALERT_ID = ? AND NVL(IS_MERGED, 0) = 0", aggId, id);
            }
            db.update("UPDATE ALERT_RECORD SET AGG_GROUP_ID = ? WHERE ALERT_ID = ? AND AGG_GROUP_ID IS NULL", aggId, representativeId);
        }
        return R.map("groups", created, "merged", merged, "totalCandidates", candidates.size());
    }

    public void splitAggregation(long aggId) {
        if (db.one("SELECT AGG_ID FROM ALERT_AGGREGATION WHERE AGG_ID = ?", aggId) == null) {
            throw new IllegalArgumentException("聚合组不存在");
        }
        db.inTx(() -> {
            db.update("UPDATE ALERT_RECORD SET IS_MERGED = 0, AGG_GROUP_ID = NULL WHERE AGG_GROUP_ID = ?", aggId);
            db.update("UPDATE ALERT_AGGREGATION SET STATUS = 'EXPIRED', UPDATED_AT = SYSTIMESTAMP WHERE AGG_ID = ?", aggId);
        });
    }

    // ============================ 组合 ============================

    /** 新告警产生后立即：静默 → 抑制 */
    public void applyForNewAlert(long alertId) {
        try {
            if (!applySilenceById(alertId)) {
                checkSuppression(alertId);
            }
        } catch (Exception e) {
            log.warn("[alert-policy] new alert {}: {}", alertId, e.getMessage());
        }
    }

    public synchronized Map<String, Object> applyOpenAlertPolicies() {
        lastPolicyRun.set(System.currentTimeMillis());
        List<Map<String, Object>> open = db.query("SELECT ALERT_ID, INSTANCE_ID, INSTANCE_NAME, SEVERITY, RULE_NAME, TRIGGER_TIME, STATUS "
                + "FROM ALERT_RECORD WHERE STATUS = 'OPEN' ORDER BY TRIGGER_TIME ASC");
        int silenced = 0;
        int suppressed = 0;
        for (Map<String, Object> a : open) {
            Map<String, Object> rule = checkSilence(a);
            if (rule != null) {
                applySilence(a, rule);
                silenced++;
                continue;
            }
            if (checkSuppression(Values.toLong(a.get("ALERT_ID"), 0))) {
                suppressed++;
            }
        }
        Map<String, Object> agg = aggregate(null);
        return R.map("checked", open.size(), "silenced", silenced, "suppressed", suppressed,
                "aggregated", agg.getOrDefault("merged", 0), "aggGroups", agg.getOrDefault("groups", 0));
    }

    /** 列表接口调用：距上次执行不足 30s 则跳过 */
    public void applyIfStale() {
        if (System.currentTimeMillis() - lastPolicyRun.get() < 30_000) {
            return;
        }
        try {
            applyOpenAlertPolicies();
        } catch (Exception e) {
            log.warn("[alerts] applyOpenAlertPolicies: {}", e.getMessage());
        }
    }

    // ============================ 工具 ============================

    public Map<String, Object> loadAlert(long alertId) {
        return db.one("SELECT ALERT_ID, INSTANCE_ID, INSTANCE_NAME, SEVERITY, RULE_NAME, TRIGGER_TIME, STATUS FROM ALERT_RECORD WHERE ALERT_ID = ?", alertId);
    }

    static List<String> splitCsv(String s) {
        List<String> out = new ArrayList<>();
        if (s == null) {
            return out;
        }
        Arrays.stream(s.split(",")).map(String::trim).filter(x -> !x.isEmpty()).forEach(out::add);
        return out;
    }

    static int severityRank(String sev) {
        return switch (sev) {
            case "P1" -> 1;
            case "P2" -> 2;
            case "P3" -> 3;
            case "P4" -> 4;
            default -> 9;
        };
    }

    public static List<Long> parseIds(Object json) {
        if (json == null) {
            return new ArrayList<>();
        }
        try {
            List<Object> raw = MAPPER.readValue(String.valueOf(json), new TypeReference<List<Object>>() {
            });
            List<Long> out = new ArrayList<>();
            for (Object o : raw) {
                Long l = Values.toLong(o);
                if (l != null) {
                    out.add(l);
                }
            }
            return out;
        } catch (Exception e) {
            return new ArrayList<>();
        }
    }

    static String toJson(Iterable<Long> ids) {
        try {
            return MAPPER.writeValueAsString(ids);
        } catch (Exception e) {
            return "[]";
        }
    }
}
