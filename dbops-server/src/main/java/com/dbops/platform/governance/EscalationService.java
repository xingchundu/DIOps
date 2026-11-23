package com.dbops.platform.governance;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.platform.notify.NotifyService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

/**
 * 未认领 OPEN 告警升级（阶段2，旁路于告警评估）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class EscalationService {

    private static final Logger log = LoggerFactory.getLogger(EscalationService.class);

    private final Db db;
    private final GovernanceProperties props;
    private final NotifyService notify;

    public EscalationService(Db db, GovernanceProperties props, NotifyService notify) {
        this.db = db;
        this.props = props;
        this.notify = notify;
    }

    public int runEscalation() {
        if (!tablesReady()) {
            return 0;
        }
        long min = props.escalationAckTimeoutMin();
        List<Map<String, Object>> alerts = db.query(
                "SELECT ALERT_ID, SEVERITY, RULE_NAME, INSTANCE_NAME, CONTENT, TRIGGER_TIME FROM ALERT_RECORD "
                        + "WHERE STATUS = 'OPEN' AND ACK_TIME IS NULL AND TRIGGER_TIME < SYSTIMESTAMP - NUMTODSINTERVAL(?, 'MINUTE') "
                        + "AND NOT EXISTS (SELECT 1 FROM ALERT_ESCALATION_LOG e WHERE e.ALERT_ID = ALERT_RECORD.ALERT_ID "
                        + "  AND e.CREATED_AT > SYSTIMESTAMP - NUMTODSINTERVAL(?, 'MINUTE')) "
                        + "ORDER BY TRIGGER_TIME FETCH FIRST 100 ROWS ONLY", min, min);
        int n = 0;
        for (Map<String, Object> a : alerts) {
            long id = Values.toLong(a.get("ALERT_ID"), 0);
            String from = Values.str(a.get("SEVERITY"), "P2");
            String to = bump(from);
            if (props.bumpSeverity() && !from.equals(to)) {
                db.update("UPDATE ALERT_RECORD SET SEVERITY = ? WHERE ALERT_ID = ? AND STATUS = 'OPEN'", to, id);
            }
            db.update("INSERT INTO ALERT_ESCALATION_LOG (ALERT_ID, FROM_SEVERITY, TO_SEVERITY, ESCALATION_LEVEL, REASON) "
                            + "VALUES (?, ?, ?, 1, ?)",
                    id, from, to, "超过 " + min + " 分钟未认领");
            try {
                if (notify.tablesReady()) {
                    notify.enqueueRecentOpenAlerts(1);
                    notify.flushPending(10);
                }
            } catch (Exception e) {
                log.warn("[phase2-escalation] notify alert {}: {}", id, e.getMessage());
            }
            n++;
        }
        return n;
    }

    private static String bump(String sev) {
        return switch (Values.str(sev, "P2").toUpperCase()) {
            case "P3", "INFO", "WARNING" -> "P2";
            case "P2" -> "P1";
            default -> sev;
        };
    }

    public boolean tablesReady() {
        try {
            db.query("SELECT 1 FROM ALERT_ESCALATION_LOG WHERE 1=0");
            return true;
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return false;
            }
            throw e instanceof RuntimeException re ? re : new RuntimeException(e);
        }
    }

    public List<Map<String, Object>> recentLogs(int limit) {
        int n = Math.max(1, Math.min(limit, 200));
        try {
            return db.query("SELECT e.*, a.RULE_NAME, a.INSTANCE_NAME FROM ALERT_ESCALATION_LOG e "
                    + "LEFT JOIN ALERT_RECORD a ON a.ALERT_ID = e.ALERT_ID "
                    + "ORDER BY e.CREATED_AT DESC FETCH FIRST " + n + " ROWS ONLY");
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return List.of();
            }
            throw e;
        }
    }

    public List<Map<String, Object>> logsByAlert(long alertId) {
        if (alertId <= 0) {
            return List.of();
        }
        try {
            return db.query("SELECT * FROM ALERT_ESCALATION_LOG WHERE ALERT_ID = ? ORDER BY CREATED_AT DESC",
                    alertId);
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return List.of();
            }
            throw e;
        }
    }
}
