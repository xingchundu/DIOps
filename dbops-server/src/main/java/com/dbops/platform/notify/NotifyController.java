package com.dbops.platform.notify;

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

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 阶段1交付 HTTP API（/api/platform/notify/**，独立模块）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@RestController
@RequestMapping("/api/platform/notify")
public class NotifyController {

    private final NotifyService notify;
    private final NotifyProperties props;
    private final AuditService audit;

    public NotifyController(NotifyService notify, NotifyProperties props, AuditService audit) {
        this.notify = notify;
        this.props = props;
        this.audit = audit;
    }

    @GetMapping("/status")
    public Map<String, Object> status(CurrentUser u) {
        u.require("ADMIN", "DBA", "OPS");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("deliveryEnabled", props.deliveryEnabled());
        m.put("tablesReady", notify.tablesReady());
        m.put("channelCount", notify.listEnabledChannels().size());
        return R.ok(m);
    }

    @GetMapping("/channels")
    public Map<String, Object> channels(CurrentUser u) {
        u.require("ADMIN", "DBA");
        return R.ok(notify.listChannels());
    }

    @PostMapping("/channels")
    public Map<String, Object> createChannel(CurrentUser u, @RequestBody Map<String, Object> body) {
        u.require("ADMIN", "DBA");
        notify.saveChannel(body, u.username());
        audit.log(u, "PHASE1_CHANNEL_SAVE", "NOTIFY_CHANNEL", Values.str(body.get("channelName")), "SUCCESS", null);
        return R.msg("已保存");
    }

    @PutMapping("/channels/{id}")
    public Map<String, Object> updateChannel(CurrentUser u, @PathVariable long id, @RequestBody Map<String, Object> body) {
        u.require("ADMIN", "DBA");
        body.put("channelId", id);
        notify.saveChannel(body, u.username());
        audit.log(u, "PHASE1_CHANNEL_SAVE", "NOTIFY_CHANNEL", String.valueOf(id), "SUCCESS", null);
        return R.msg("已保存");
    }

    @DeleteMapping("/channels/{id}")
    public Map<String, Object> deleteChannel(CurrentUser u, @PathVariable long id) {
        u.require("ADMIN", "DBA");
        notify.deleteChannel(id);
        audit.log(u, "PHASE1_CHANNEL_DELETE", "NOTIFY_CHANNEL", String.valueOf(id), "SUCCESS", null);
        return R.msg("已删除");
    }

    @PostMapping("/channels/{id}/test")
    public Map<String, Object> testChannel(CurrentUser u, @PathVariable long id) throws Exception {
        u.require("ADMIN", "DBA");
        notify.testChannel(id);
        audit.log(u, "PHASE1_CHANNEL_TEST", "NOTIFY_CHANNEL", String.valueOf(id), "SUCCESS", null);
        return R.msg("测试消息已发送");
    }

    @GetMapping("/outbox")
    public Map<String, Object> outbox(CurrentUser u,
                                      @RequestParam(required = false, defaultValue = "1") String page,
                                      @RequestParam(required = false, defaultValue = "20") String size) {
        u.require("ADMIN", "DBA", "OPS");
        return R.ok(notify.outboxPage(page, size));
    }

    @GetMapping("/outbox/by-alert/{alertId}")
    public Map<String, Object> outboxByAlert(CurrentUser u, @PathVariable long alertId) {
        u.require("ADMIN", "DBA", "OPS", "VIEWER");
        return R.ok(notify.outboxByAlert(alertId));
    }

    @PostMapping("/notify/run-once")
    public Map<String, Object> runOnce(CurrentUser u) {
        u.require("ADMIN", "DBA");
        int enq = notify.enqueueRecentOpenAlerts(24);
        Map<String, Integer> flush = notify.flushPending(50);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("enqueued", enq);
        data.putAll(flush);
        audit.log(u, "NOTIFY_RUN", "NOTIFY_OUTBOX", null, "SUCCESS", String.valueOf(data));
        return R.ok(data, "执行完成");
    }

    @GetMapping("/backup-retention/logs")
    public Map<String, Object> backupLogs(CurrentUser u, @RequestParam(required = false, defaultValue = "50") String limit) {
        u.require("ADMIN", "DBA", "OPS");
        return R.ok(notify.backupRetentionLogs(Values.toInt(limit, 50)));
    }
}
