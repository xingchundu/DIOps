package com.dbops.platform.notify;

import com.dbops.common.Db;
import com.dbops.common.Values;
import com.dbops.sqlinsight.store.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 告警 → 外发队列 → Webhook（阶段1，独立于 AlertEvaluator）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Service
public class NotifyService {

    private static final Logger log = LoggerFactory.getLogger(NotifyService.class);

    private final Db db;
    private final WebhookSender webhook;

    public NotifyService(Db db, WebhookSender webhook) {
        this.db = db;
        this.webhook = webhook;
    }

    /** 将近期 OPEN 告警写入外发表（每条告警×渠道一条，幂等） */
    public int enqueueRecentOpenAlerts(int lookbackHours) {
        List<Map<String, Object>> channels = listEnabledChannels();
        if (channels.isEmpty()) {
            return 0;
        }
        int h = Math.max(1, Math.min(lookbackHours, 72));
        List<Map<String, Object>> alerts = db.query(
                "SELECT ALERT_ID, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME "
                        + "FROM ALERT_RECORD WHERE STATUS = 'OPEN' AND TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(?, 'HOUR') "
                        + "ORDER BY TRIGGER_TIME DESC FETCH FIRST 200 ROWS ONLY", h);
        int n = 0;
        for (Map<String, Object> a : alerts) {
            long alertId = Values.toLong(a.get("ALERT_ID"), 0);
            String sev = Values.str(a.get("SEVERITY"), "P2");
            for (Map<String, Object> ch : channels) {
                if (!NotifySeverityRank.matches(sev, Values.str(ch.get("MIN_SEVERITY"), "P2"))) {
                    continue;
                }
                long chId = Values.toLong(ch.get("CHANNEL_ID"), 0);
                if (existsOutbox(alertId, chId)) {
                    continue;
                }
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("source", "DIOps-Phase1");
                payload.put("alertId", alertId);
                payload.put("ruleName", a.get("RULE_NAME"));
                payload.put("instanceId", a.get("INSTANCE_ID"));
                payload.put("instanceName", a.get("INSTANCE_NAME"));
                payload.put("severity", sev);
                payload.put("content", a.get("CONTENT"));
                payload.put("status", a.get("STATUS"));
                payload.put("triggerTime", Values.str(a.get("TRIGGER_TIME")));
                payload.put("channelId", chId);
                payload.put("channelName", ch.get("CHANNEL_NAME"));
                String json = Json.write(payload);
                db.update("INSERT INTO NOTIFY_OUTBOX (ALERT_ID, CHANNEL_ID, STATUS, PAYLOAD) VALUES (?, ?, 'PENDING', ?)",
                        alertId, chId, json);
                n++;
            }
        }
        return n;
    }

    /** 发送 PENDING 外发项 */
    public Map<String, Integer> flushPending(int batch) {
        int b = Math.max(1, Math.min(batch, 50));
        List<Map<String, Object>> rows = db.query(
                "SELECT o.OUTBOX_ID, o.ALERT_ID, o.CHANNEL_ID, o.PAYLOAD, o.ATTEMPT_COUNT, "
                        + "c.CHANNEL_TYPE, c.ENDPOINT_URL, c.SECRET_HEADER, c.SECRET_TOKEN "
                        + "FROM NOTIFY_OUTBOX o JOIN NOTIFY_CHANNEL c ON c.CHANNEL_ID = o.CHANNEL_ID "
                        + "WHERE o.STATUS = 'PENDING' AND c.ENABLED = 1 ORDER BY o.CREATED_AT FETCH FIRST " + b + " ROWS ONLY");
        int sent = 0, failed = 0;
        for (Map<String, Object> r : rows) {
            long outboxId = Values.toLong(r.get("OUTBOX_ID"), 0);
            String type = Values.str(r.get("CHANNEL_TYPE"), "WEBHOOK");
            String body = Values.str(r.get("PAYLOAD"), "{}");
            int attempts = Values.toInt(r.get("ATTEMPT_COUNT")) + 1;
            try {
                if ("WEBHOOK".equalsIgnoreCase(type)) {
                    webhook.send(Values.str(r.get("ENDPOINT_URL")), Values.str(r.get("SECRET_HEADER")),
                            Values.str(r.get("SECRET_TOKEN")), body);
                } else {
                    throw new IllegalArgumentException("不支持的渠道类型: " + type);
                }
                db.update("UPDATE NOTIFY_OUTBOX SET STATUS='SENT', ATTEMPT_COUNT=?, SENT_AT=SYSTIMESTAMP, LAST_ERROR=NULL WHERE OUTBOX_ID=?",
                        attempts, outboxId);
                sent++;
            } catch (Exception e) {
                String err = Values.truncate(e.getMessage(), 900);
                db.update("UPDATE NOTIFY_OUTBOX SET STATUS='FAILED', ATTEMPT_COUNT=?, LAST_ERROR=? WHERE OUTBOX_ID=?",
                        attempts, err, outboxId);
                failed++;
                log.warn("[phase1-notify] outbox {}: {}", outboxId, err);
            }
        }
        return Map.of("sent", sent, "failed", failed, "batch", rows.size());
    }

    public List<Map<String, Object>> listEnabledChannels() {
        try {
            return db.query("SELECT * FROM NOTIFY_CHANNEL WHERE ENABLED = 1 ORDER BY CHANNEL_ID");
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return List.of();
            }
            throw e;
        }
    }

    public List<Map<String, Object>> listChannels() {
        return db.query("SELECT * FROM NOTIFY_CHANNEL ORDER BY CHANNEL_ID");
    }

    public void saveChannel(Map<String, Object> body, String username) {
        Long id = Values.toLong(body.get("channelId"), 0);
        String name = Values.str(body.get("channelName"), "").trim();
        String type = Values.str(body.get("channelType"), "WEBHOOK").toUpperCase();
        if (name.isEmpty()) {
            throw new IllegalArgumentException("渠道名称必填");
        }
        int en = Values.truthy(body.get("enabled")) ? 1 : 0;
        String minSev = Values.str(body.get("minSeverity"), "P2");
        if (id != null && id > 0) {
            db.update("UPDATE NOTIFY_CHANNEL SET CHANNEL_NAME=?, CHANNEL_TYPE=?, ENDPOINT_URL=?, SECRET_HEADER=?, "
                            + "SECRET_TOKEN=?, ENABLED=?, MIN_SEVERITY=?, UPDATED_BY=?, UPDATED_AT=SYSTIMESTAMP WHERE CHANNEL_ID=?",
                    name, type, Values.str(body.get("endpointUrl")), Values.str(body.get("secretHeader"), "X-Webhook-Token"),
                    Values.str(body.get("secretToken")), en, minSev, username, id);
        } else {
            db.insertReturningId("INSERT INTO NOTIFY_CHANNEL (CHANNEL_NAME, CHANNEL_TYPE, ENDPOINT_URL, SECRET_HEADER, SECRET_TOKEN, "
                            + "ENABLED, MIN_SEVERITY, UPDATED_BY, UPDATED_AT) VALUES (?,?,?,?,?,?,?,?,SYSTIMESTAMP)",
                    "CHANNEL_ID", name, type, Values.str(body.get("endpointUrl")), Values.str(body.get("secretHeader"), "X-Webhook-Token"),
                    Values.str(body.get("secretToken")), en, minSev, username);
        }
    }

    public void deleteChannel(long id) {
        db.update("DELETE FROM NOTIFY_CHANNEL WHERE CHANNEL_ID=?", id);
    }

    public void testChannel(long id) throws Exception {
        Map<String, Object> ch = db.one("SELECT * FROM NOTIFY_CHANNEL WHERE CHANNEL_ID=?", id);
        if (ch == null) {
            throw new IllegalArgumentException("渠道不存在");
        }
        Map<String, Object> demo = new LinkedHashMap<>();
        demo.put("source", "DIOps-Phase1-Test");
        demo.put("alertId", 0);
        demo.put("ruleName", "连通性测试");
        demo.put("severity", "P2");
        demo.put("content", "阶段1外发测试消息（dxc 2026-11-12）");
        demo.put("channelName", ch.get("CHANNEL_NAME"));
        webhook.send(Values.str(ch.get("ENDPOINT_URL")), Values.str(ch.get("SECRET_HEADER")),
                Values.str(ch.get("SECRET_TOKEN")), Json.write(demo));
    }

    private boolean existsOutbox(long alertId, long channelId) {
        return db.one("SELECT 1 X FROM NOTIFY_OUTBOX WHERE ALERT_ID=? AND CHANNEL_ID=?", alertId, channelId) != null;
    }

    public Map<String, Object> outboxPage(String page, String size) {
        return db.queryPage("SELECT o.*, c.CHANNEL_NAME, c.CHANNEL_TYPE FROM NOTIFY_OUTBOX o "
                + "LEFT JOIN NOTIFY_CHANNEL c ON c.CHANNEL_ID = o.CHANNEL_ID ORDER BY o.CREATED_AT DESC",
                new ArrayList<>(), page, size);
    }

    /** 告警详情：该告警在各渠道的外发记录 */
    public List<Map<String, Object>> outboxByAlert(long alertId) {
        if (alertId <= 0) {
            return List.of();
        }
        try {
            return db.query(
                    "SELECT o.OUTBOX_ID, o.ALERT_ID, o.CHANNEL_ID, o.STATUS, o.ATTEMPT_COUNT, o.LAST_ERROR, "
                            + "o.CREATED_AT, o.SENT_AT, c.CHANNEL_NAME, c.CHANNEL_TYPE "
                            + "FROM NOTIFY_OUTBOX o LEFT JOIN NOTIFY_CHANNEL c ON c.CHANNEL_ID = o.CHANNEL_ID "
                            + "WHERE o.ALERT_ID = ? ORDER BY o.CREATED_AT DESC",
                    alertId);
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return List.of();
            }
            throw e;
        }
    }

    public List<Map<String, Object>> backupRetentionLogs(int limit) {
        int n = Math.max(1, Math.min(limit, 200));
        try {
            return db.query("SELECT * FROM BACKUP_RETENTION_LOG ORDER BY CREATED_AT DESC FETCH FIRST " + n + " ROWS ONLY");
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return List.of();
            }
            throw e;
        }
    }

    public boolean tablesReady() {
        try {
            db.query("SELECT 1 FROM NOTIFY_CHANNEL WHERE 1=0");
            return true;
        } catch (Exception e) {
            if (Db.isMissingTable(e)) {
                return false;
            }
            throw e instanceof RuntimeException re ? re : new RuntimeException(e);
        }
    }
}
