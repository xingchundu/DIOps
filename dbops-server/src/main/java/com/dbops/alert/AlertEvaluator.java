package com.dbops.alert;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.monitor.DbType;
import com.dbops.service.SystemConfigService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 采集后告警评估：ALERT_RULE × 指标 → ALERT_RECORD（对应 Node services/monitorAlertEvaluator.js）。
 * <p>
 * 相对 Node 版的修正：
 * <ul>
 *   <li>[fix] 去重只看 STATUS='OPEN'：告警被确认/静默/抑制后，下一轮采集（90s）又插入一条新告警 → 告警风暴</li>
 *   <li>[fix] 只对 ORACLE/PANWEI 评估，MySQL/PG/达梦/SQL Server 配了规则也永远不触发；现在所有类型都评估，
 *       且所有 exporter 指标名（如 mysql_global_status_threads_connected）都可直接作为规则 METRIC</li>
 *   <li>[fix] 实例连不上时根本不评估，“数据库宕机”这种最重要的告警反而发不出来；现在不可达时 db_reachable=0 参与评估</li>
 *   <li>[fix] ALERT_RULE.DURATION（持续分钟数）被完全忽略，一次抖动就告警；现在需连续满足 DURATION 分钟才触发</li>
 *   <li>[fix] 指标恢复后告警永远不会自动关闭；现在条件不再满足时自动置 RESOLVED（RESOLVE_BY=SYSTEM），可用
 *       SYS_CONFIG alert.auto_resolve=0 关闭</li>
 *   <li>[fix] eq 比较浮点数用 ===；改为容差比较</li>
 * </ul>
 */
@Service
public class AlertEvaluator {

    private static final Logger log = LoggerFactory.getLogger(AlertEvaluator.class);

    private final Db db;
    private final AlertPolicyService policies;
    private final SystemConfigService cfg;
    /** ruleId|instanceId → 首次满足条件的时间 */
    private final Map<String, Long> pendingSince = new ConcurrentHashMap<>();

    public AlertEvaluator(Db db, AlertPolicyService policies, SystemConfigService cfg) {
        this.db = db;
        this.policies = policies;
        this.cfg = cfg;
    }

    /** 组装可供规则引用的指标值 */
    public static Map<String, Double> metricMap(List<Map<String, Object>> engineMetrics, List<Map<String, Object>> exporterMetrics,
                                                boolean reachable, Integer healthScore, String dbType) {
        Map<String, Double> m = new HashMap<>();
        if (exporterMetrics != null) {
            for (Map<String, Object> row : exporterMetrics) {
                String name = Values.str(row.get("METRIC_NAME"));
                Double v = Values.toDouble(row.get("VALUE"));
                if (name == null || v == null) {
                    continue;
                }
                m.put(name, v);
                // 兼容 Node 版的别名
                switch (name) {
                    case "Buffer Cache Hit Ratio" -> m.put("oracle_buffer_cache_hit_pct", v);
                    case "pg_buffer_cache_hit_ratio" -> m.put("panwei_buffer_hit_pct", v);
                    case "tablespace_usage_pct" -> m.put("oracle_tablespace_max_used_pct", v);
                    default -> {
                    }
                }
            }
        }
        if (engineMetrics != null) {
            for (Map<String, Object> row : engineMetrics) {
                String key = Values.str(row.get("key"));
                Double v = Values.toDouble(row.get("value"));
                // 忽略 _ 前缀的内部键（_host_skip/_engine_error 等）
                if (key == null || key.startsWith("_") || v == null) {
                    continue;
                }
                m.put(key, v);
            }
        }
        // [fix] init.sql 种子规则引用的指标名从未被采集产出（tablespace_usage_pct / db_active_sessions /
        //       oracle_buffer_cache_hit），默认规则永远不会触发；这里补上别名映射
        putIfAbsentFrom(m, "tablespace_usage_pct", "oracle_tablespace_max_used_pct", "db_tablespace_max_used_pct");
        putIfAbsentFrom(m, "oracle_buffer_cache_hit", "oracle_buffer_cache_hit_pct", "Buffer Cache Hit Ratio");
        putIfAbsentFrom(m, "db_active_sessions", "Active Sessions", "pg_stat_activity_active", "mssql_active_sessions",
                "mysql_global_status_threads_running");
        putIfAbsentFrom(m, "db_buffer_hit_pct", "Buffer Cache Hit Ratio", "mysql_innodb_buffer_pool_hit_ratio",
                "pg_buffer_cache_hit_ratio", "mssql_buffer_cache_hit_ratio");
        m.put("db_reachable", reachable ? 1.0 : 0.0);
        m.put("instance_up", reachable ? 1.0 : 0.0);
        if (!reachable) {
            String t = DbType.normalize(dbType);
            if (DbType.ORACLE.equals(t)) {
                m.put("oracle_instance_up", 0.0);
            } else if (DbType.PANWEI.equals(t)) {
                m.put("panwei_instance_up", 0.0);
            }
        }
        if (healthScore != null) {
            m.put("health_score", healthScore.doubleValue());
        }
        return m;
    }

    private static void putIfAbsentFrom(Map<String, Double> m, String alias, String... sources) {
        if (m.containsKey(alias)) {
            return;
        }
        for (String s : sources) {
            Double v = m.get(s);
            if (v != null) {
                m.put(alias, v);
                return;
            }
        }
    }

    public static boolean compare(String op, Double val, Object threshold) {
        Double th = Values.toDouble(threshold);
        if (val == null || th == null || op == null) {
            return false;
        }
        return switch (op.trim().toLowerCase()) {
            case "gt" -> val > th;
            case "gte" -> val >= th;
            case "lt" -> val < th;
            case "lte" -> val <= th;
            case "eq" -> Math.abs(val - th) < 1e-9;
            case "ne", "neq" -> Math.abs(val - th) >= 1e-9;
            default -> false;
        };
    }

    /** 采集端为每个表空间单独打的指标，key = TABLESPACE_METRIC_PREFIX + 大写表空间名 */
    public static final String TABLESPACE_METRIC_PREFIX = "tablespace_pct@";

    private static final String RULES_SQL_V6 = "SELECT RULE_ID, RULE_NAME, METRIC, OPERATOR, THRESHOLD, DURATION, SEVERITY, "
            + "DB_TYPE, INSTANCE_ID, TABLESPACE_NAME, TARGET_HOST_IP FROM ALERT_RULE "
            + "WHERE NVL(ENABLED, 1) = 1 AND NVL(RULE_TYPE, 'THRESHOLD') <> 'SQL_INSIGHT'";
    private static final String RULES_SQL_LEGACY = "SELECT RULE_ID, RULE_NAME, METRIC, OPERATOR, THRESHOLD, DURATION, SEVERITY, "
            + "DB_TYPE, INSTANCE_ID FROM ALERT_RULE "
            + "WHERE NVL(ENABLED, 1) = 1 AND NVL(RULE_TYPE, 'THRESHOLD') <> 'SQL_INSIGHT'";

    public List<String> evaluate(long instanceId, String instanceName, String dbType, Map<String, Double> values) {
        return evaluate(instanceId, instanceName, dbType, values, null);
    }

    /**
     * @param instanceIp 目标库 IP（CMDB_INSTANCE.HOST_IP），用于 TARGET_HOST_IP 维度过滤与告警内容展示
     */
    public List<String> evaluate(long instanceId, String instanceName, String dbType,
                                 Map<String, Double> values, String instanceIp) {
        List<Map<String, Object>> rules;
        try {
            rules = db.query(RULES_SQL_V6);
        } catch (Exception e) {
            // 未执行 migration_v6_tablespace_alert.sql 时降级为旧列，不影响既有规则
            log.warn("[alert-eval] ALERT_RULE 缺少 v6 维度列，按旧规则评估（{}）",
                    Values.truncate(String.valueOf(e.getMessage()), 120));
            rules = db.query(RULES_SQL_LEGACY);
        }
        boolean autoResolve = cfg.getBool("alert.auto_resolve", true);
        String dt = DbType.normalize(dbType);
        long now = System.currentTimeMillis();
        List<String> fired = new ArrayList<>();
        for (Map<String, Object> rule : rules) {
            String metric = Values.str(rule.get("METRIC"));
            if (metric == null || "cluster_reachable_member_count".equals(metric)) {
                continue;
            }
            String rDb = Values.str(rule.get("DB_TYPE"));
            if (rDb != null && !DbType.normalize(rDb).equals(dt)) {
                continue;
            }
            if (rule.get("INSTANCE_ID") != null && !Values.numEq(rule.get("INSTANCE_ID"), instanceId)) {
                continue;
            }
            String ruleHostIp = Values.str(rule.get("TARGET_HOST_IP"));
            if (ruleHostIp != null && (instanceIp == null || !ruleHostIp.equalsIgnoreCase(instanceIp.trim()))) {
                continue;
            }
            String tbsFilter = Values.str(rule.get("TABLESPACE_NAME"));
            long ruleId = Values.toLong(rule.get("RULE_ID"), 0);
            String pendKey = ruleId + "|" + instanceId + "|" + (tbsFilter == null ? "" : tbsFilter);
            Double val;
            String tbsHit = null;
            if (tbsFilter != null) {
                Map<String, Double> hit = matchTablespaceValues(values, tbsFilter);
                if (hit.isEmpty()) {
                    // 指定表空间本轮没采到：不能拿全局最大值代替，否则「只盯 jdv2」会被别的空间触发
                    pendingSince.remove(pendKey);
                    continue;
                }
                val = hit.values().stream().max(Double::compareTo).orElse(null);
                tbsHit = String.join(",", hit.keySet());
            } else {
                val = values.get(metric);
            }
            if (val == null) {
                // 本轮没有该指标（实例不可达 / 无权限）：既不触发也不自动恢复
                pendingSince.remove(pendKey);
                continue;
            }
            boolean breached = compare(Values.str(rule.get("OPERATOR")), val, rule.get("THRESHOLD"));
            if (!breached) {
                pendingSince.remove(pendKey);
                if (autoResolve) {
                    autoResolve(ruleId, instanceId, metric, val);
                }
                continue;
            }
            long durMin = rule.get("DURATION") == null
                    ? cfg.getLong("alert.evaluation.default_duration_min", 0) : Values.toLong(rule.get("DURATION"), 0);
            long durationMs = Math.max(0, durMin) * 60_000L;
            long since = pendingSince.computeIfAbsent(pendKey, k -> now);
            if (now - since < durationMs) {
                continue;
            }
            if (hasActiveAlert(ruleId, instanceId)) {
                continue;
            }
            String scope = (instanceIp == null || instanceIp.isBlank() ? instanceName : instanceIp)
                    + (tbsHit == null ? "" : "/" + tbsHit);
            String content = String.format("%s: [%s] %s=%s (%s %s)", rule.get("RULE_NAME"), scope, metric, fmt(val),
                    rule.get("OPERATOR"), rule.get("THRESHOLD"));
            Long alertId = insertAlert(ruleId, Values.str(rule.get("RULE_NAME")), instanceId, instanceName,
                    Values.str(rule.get("SEVERITY"), "P3"), Values.truncate(content, 1024), tbsHit, instanceIp);
            if (alertId != null) {
                policies.applyForNewAlert(alertId);
            }
            fired.add(Values.str(rule.get("RULE_NAME")));
        }
        return fired;
    }

    /** 按规则里的表空间名（逗号分隔、大小写不敏感、支持前缀通配符 ABC*）取该表空间的指标值 */
    private static Map<String, Double> matchTablespaceValues(Map<String, Double> values, String filter) {
        Map<String, Double> out = new LinkedHashMap<>();
        if (values == null || filter == null) {
            return out;
        }
        List<String> wanted = new ArrayList<>();
        for (String part : filter.split("[,，;；\\s]+")) {
            String n = part.trim().toUpperCase(Locale.ROOT);
            if (!n.isEmpty()) {
                wanted.add(n);
            }
        }
        for (Map.Entry<String, Double> e : values.entrySet()) {
            String k = e.getKey();
            if (k == null || !k.startsWith(TABLESPACE_METRIC_PREFIX) || e.getValue() == null) {
                continue;
            }
            String ts = k.substring(TABLESPACE_METRIC_PREFIX.length()).toUpperCase(Locale.ROOT);
            for (String w : wanted) {
                boolean match = w.endsWith("*") ? ts.startsWith(w.substring(0, w.length() - 1))
                        : ts.equals(w);
                if (match) {
                    out.put(ts, e.getValue());
                    break;
                }
            }
        }
        return out;
    }

    /** 新列（v6）存在时写入维度；旧库自动降级为原 INSERT，不阻断告警 */
    private Long insertAlert(long ruleId, String ruleName, long instanceId, String instanceName,
                             String severity, String content, String tbsHit, String hostIp) {
        try {
            return db.insertReturningId("INSERT INTO ALERT_RECORD (RULE_ID, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, "
                            + "SEVERITY, CONTENT, TABLESPACE_NAME, HOST_IP, STATUS, TRIGGER_TIME) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', SYSTIMESTAMP)", "ALERT_ID",
                    ruleId, ruleName, instanceId, instanceName, severity, content, tbsHit, hostIp);
        } catch (RuntimeException e) {
            if (!com.dbops.common.Db.isMissingColumn(e)) {
                throw e;
            }
            return db.insertReturningId("INSERT INTO ALERT_RECORD (RULE_ID, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, "
                            + "SEVERITY, CONTENT, STATUS, TRIGGER_TIME) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', SYSTIMESTAMP)", "ALERT_ID",
                    ruleId, ruleName, instanceId, instanceName, severity, content);
        }
    }

    private boolean hasActiveAlert(long ruleId, long instanceId) {
        return db.count("SELECT COUNT(*) FROM ALERT_RECORD WHERE RULE_ID = ? AND NVL(INSTANCE_ID, -1) = ? "
                + "AND STATUS IN ('OPEN','ACKNOWLEDGED','SILENCED','SUPPRESSED')", ruleId, instanceId) > 0;
    }

    private void autoResolve(long ruleId, long instanceId, String metric, double val) {
        try {
            List<Map<String, Object>> active = db.query("SELECT ALERT_ID FROM ALERT_RECORD WHERE RULE_ID = ? AND NVL(INSTANCE_ID, -1) = ? "
                    + "AND STATUS IN ('OPEN','ACKNOWLEDGED','SILENCED','SUPPRESSED')", ruleId, instanceId);
            for (Map<String, Object> a : active) {
                Object id = a.get("ALERT_ID");
                int n = db.update("UPDATE ALERT_RECORD SET STATUS='RESOLVED', RESOLVE_TIME=SYSTIMESTAMP, RESOLVE_BY='SYSTEM', "
                        + "DETAIL=? WHERE ALERT_ID=? AND STATUS <> 'RESOLVED'", "指标已恢复: " + metric + "=" + fmt(val), id);
                if (n > 0) {
                    policies.releaseSuppressedChildren(id);
                }
            }
        } catch (Exception e) {
            log.warn("[alert-eval] auto resolve rule={} inst={}: {}", ruleId, instanceId, e.getMessage());
        }
    }

    public void forgetInstance(long instanceId) {
        String suffix = "|" + instanceId;
        pendingSince.keySet().removeIf(k -> k.endsWith(suffix));
    }

    private static String fmt(double v) {
        return v == Math.rint(v) && Math.abs(v) < 1e15 ? String.valueOf((long) v) : String.format("%.2f", v);
    }
}
