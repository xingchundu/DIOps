package com.dbops.platform.health;

import com.dbops.platform.PlatformProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 阶段3自监控定时采集。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Component
public class PlatformHealthScheduler {

    private static final Logger log = LoggerFactory.getLogger(PlatformHealthScheduler.class);

    private final PlatformProperties props;
    private final PlatformHealthCollector health;
    private final PlatformHealthAlertService alerts;

    public PlatformHealthScheduler(PlatformProperties props, PlatformHealthCollector health, PlatformHealthAlertService alerts) {
        this.props = props;
        this.health = health;
        this.alerts = alerts;
    }

    @Scheduled(fixedDelay = 120_000L, initialDelay = 45_000L)
    public void healthTick() {
        if (!props.healthEnabled()) {
            return;
        }
        try {
            List<Map<String, Object>> m = health.collectAndPersist();
            alerts.evaluate(m);
        } catch (Exception e) {
            log.warn("[phase3-health] {}", e.getMessage());
        }
    }
}
