package com.dbops.platform.health;

import com.dbops.platform.PlatformProperties;
import com.dbops.common.Db;
import com.dbops.common.Values;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

/**
 * 自监控阈值超标时写入平台级 ALERT_RECORD（独立规则名，不走 AlertEvaluator）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class PlatformHealthAlertService {

    private static final Logger log = LoggerFactory.getLogger(PlatformHealthAlertService.class);

    private final Db db;
    private final PlatformProperties props;

    public PlatformHealthAlertService(Db db, PlatformProperties props) {
        this.db = db;
        this.props = props;
    }

    public void evaluate(List<Map<String, Object>> metrics) {
        if (!props.healthEnabled()) {
            return;
        }
        for (Map<String, Object> m : metrics) {
            String key = Values.str(m.get("key"));
            if ("collect_success_pct".equals(key)) {
                Double dv = Values.toDouble(m.get("value"));
                double pct = dv == null ? 100 : dv;
                if (pct < props.collectWarnPct()) {
                    raise("PLATFORM_COLLECT_RATE", "P2",
                            "平台采集成功率降至 " + pct + "%（阈值 " + props.collectWarnPct() + "%）",
                            Values.str(m.get("detail")));
                }
            } else if ("notify_outbox_pending".equals(key)) {
                long n = Values.toLong(m.get("value"), 0);
                if (n > props.outboxWarn()) {
                    raise("PLATFORM_NOTIFY_BACKLOG", "P2",
                            "告警外发队列积压 " + n + " 条", Values.str(m.get("detail")));
                }
            } else if ("backup_fail_24h".equals(key)) {
                long n = Values.toLong(m.get("value"), 0);
                if (n > props.backupFailWarn()) {
                    raise("PLATFORM_BACKUP_FAIL", "P1",
                            "近24小时备份失败 " + n + " 次", Values.str(m.get("detail")));
                }
            } else if ("sqlinsight_open_count".equals(key)) {
                long n = Values.toLong(m.get("value"), 0);
                if (n > props.sqlInsightOpenWarn()) {
                    raise("PLATFORM_SQLINSIGHT_BACKLOG", "P2",
                            "SQL洞察 OPEN 项 " + n + " 条", Values.str(m.get("detail")));
                }
            }
        }
    }

    private void raise(String ruleName, String severity, String content, String detail) {
        try {
            Map<String, Object> open = db.one(
                    "SELECT ALERT_ID FROM ALERT_RECORD WHERE RULE_NAME=? AND STATUS='OPEN' "
                            + "AND TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(6, 'HOUR') FETCH FIRST 1 ROWS ONLY",
                    ruleName);
            if (open != null) {
                return;
            }
            String body = content + (detail == null || detail.isEmpty() ? "" : " — " + detail);
            db.insertReturningId(
                    "INSERT INTO ALERT_RECORD (RULE_NAME, INSTANCE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME) "
                            + "VALUES (?, '平台', ?, ?, 'OPEN', SYSTIMESTAMP)",
                    "ALERT_ID", ruleName, severity, body);
        } catch (Exception e) {
            log.debug("[phase3-health-alert] {}: {}", ruleName, e.getMessage());
        }
    }
}
