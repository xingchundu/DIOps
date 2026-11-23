package com.dbops.platform.notify;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 阶段1：定时扫描 OPEN 告警并外发（不改 AlertEvaluator）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Component
public class NotifyScheduler {

    private static final Logger log = LoggerFactory.getLogger(NotifyScheduler.class);

    private final NotifyProperties props;
    private final NotifyService notify;

    public NotifyScheduler(NotifyProperties props, NotifyService notify) {
        this.props = props;
        this.notify = notify;
    }

    @Scheduled(fixedDelayString = "${notify.fixed-delay-ms:30000}", initialDelay = 45_000L)
    public void tick() {
        if (!props.deliveryEnabled()) {
            return;
        }
        if (!notify.tablesReady()) {
            return;
        }
        try {
            int enq = notify.enqueueRecentOpenAlerts(24);
            var flush = notify.flushPending(20);
            if (enq > 0 || flush.getOrDefault("sent", 0) > 0 || flush.getOrDefault("failed", 0) > 0) {
                log.info("[phase1-notify] enqueued={}, sent={}, failed={}", enq, flush.get("sent"), flush.get("failed"));
            }
        } catch (Exception e) {
            log.warn("[phase1-notify] tick: {}", e.getMessage());
        }
    }
}
