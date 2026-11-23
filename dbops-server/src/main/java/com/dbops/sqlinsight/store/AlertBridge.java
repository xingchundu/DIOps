package com.dbops.sqlinsight.store;

import com.dbops.alert.AlertPolicyService;
import com.dbops.common.Db;
import com.dbops.common.Values;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * SQL 洞察 → 告警中心（ALERT_RECORD）。挂在 ALERT_RULE 的「SQL问题」「SQL异常波动」两条规则下：
 * 规则停用即不再推送；生成后走现有静默/抑制/聚合策略；事件恢复时自动恢复告警。
 * 取代原来写 FAULT_EXEC_LOG 的做法（那条路径进不了告警中心）。
 */
@Component
public class AlertBridge {

    public static final String RULE_PROBLEM = "SQL问题";
    public static final String RULE_ANOMALY = "SQL异常波动";

    private static final Logger log = LoggerFactory.getLogger(AlertBridge.class);

    private final Db db;
    private final AlertPolicyService policies;

    public AlertBridge(Db db, AlertPolicyService policies) {
        this.db = db;
        this.policies = policies;
    }

    /** @return ALERT_ID；规则不存在/停用返回 null */
    public Long fire(String ruleName, long instanceId, String instanceName, String severity, String content) {
        try {
            Map<String, Object> rule = db.one("SELECT RULE_ID, SEVERITY FROM ALERT_RULE WHERE RULE_NAME=? AND NVL(ENABLED, 1) = 1 "
                    + "FETCH FIRST 1 ROWS ONLY", ruleName);
            if (rule == null) {
                return null;
            }
            String level = switch (Values.str(severity, "WARNING").toUpperCase()) {
                // ERROR 原来落到 default 映射为 P3，比 WARNING(P2) 还低
                case "CRITICAL" -> "P1";
                case "ERROR", "HIGH" -> "P1".equals(Values.str(rule.get("SEVERITY"))) ? "P1" : "P2";
                case "WARNING" -> Values.str(rule.get("SEVERITY"), "P2");
                default -> "P3";
            };
            Long id = db.insertReturningId("INSERT INTO ALERT_RECORD (RULE_ID, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME) "
                            + "VALUES (?, ?, ?, ?, ?, ?, 'OPEN', SYSTIMESTAMP)", "ALERT_ID",
                    rule.get("RULE_ID"), ruleName, instanceId, instanceName, level, Values.truncate(content, 1024));
            if (id != null) {
                policies.applyForNewAlert(id);
            }
            return id;
        } catch (Exception e) {
            log.warn("[sqlinsight] fire alert failed: {}", e.getMessage());
            return null;
        }
    }

    public void resolve(Object alertId, String detail) {
        Long id = Values.toLong(alertId);
        if (id == null) {
            return;
        }
        try {
            int n = db.update("UPDATE ALERT_RECORD SET STATUS='RESOLVED', RESOLVE_TIME=SYSTIMESTAMP, RESOLVE_BY='SYSTEM', DETAIL=? "
                    + "WHERE ALERT_ID=? AND STATUS <> 'RESOLVED'", Values.truncate(detail, 1000), id);
            if (n > 0) {
                policies.releaseSuppressedChildren(id);
            }
        } catch (Exception e) {
            log.warn("[sqlinsight] resolve alert {} failed: {}", id, e.getMessage());
        }
    }
}
